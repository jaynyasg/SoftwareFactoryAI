/**
 * Shared implementation for local/BYO CLI execution adapters.
 *
 * Both the Codex and Claude Code adapters are thin configurations over this
 * factory: they differ only in the executable name, the probe arguments, how
 * execution arguments are built, and the remediation actions to surface. All of
 * the contract behavior — setup probing, streaming, cancellation, artifact
 * collection, and failure normalization — lives here so the two adapters can
 * never drift from the shared `ExecutionAdapter` contract.
 *
 * Every adapter takes an injected `CommandRunner`, so the whole thing is
 * exercisable without the real CLI being installed.
 */
import { AdapterError, isAdapterError, normalizeAdapterError } from './adapter-errors';
import { bundleEnvForFamily, composeSpawnEnv, scrubNestedSessionEnv } from './session-env';
import type { SpawnEnvBundle } from './session-env';
import type {
  AdapterArtifact,
  AdapterExecuteOptions,
  AdapterFamily,
  AdapterResult,
  AdapterSetupState,
  AdapterTask,
  CommandResult,
  CommandRunner,
  DetectSetupOptions,
  ExecutionAdapter,
  SetupAction,
} from './execution-adapter';

/** A normalized view of one probe (version or auth) for `detectSetup`. */
export interface CliProbeOutcome {
  /** `true` when the probe command exited 0 without an error signal. */
  readonly ok: boolean;
  /** Free-form detail extracted from the probe (version string, reason). */
  readonly detail?: string;
}

/** Static configuration that distinguishes one CLI adapter from another. */
export interface CliAdapterConfig {
  readonly id: string;
  readonly family: AdapterFamily;
  /** The executable to invoke, e.g. `codex` or `claude`. */
  readonly command: string;
  /** Args for the availability/version probe, e.g. `['--version']`. */
  readonly versionArgs: readonly string[];
  /** Args for the auth probe, e.g. `['auth', 'status']` or `['whoami']`. */
  readonly authArgs: readonly string[];
  /** Build the execution args for a task (prompt wiring, output format, etc.). */
  readonly buildExecArgs: (task: AdapterTask) => readonly string[];
  /**
   * Optional stdin payload for the execution command. Multi-line prompts MUST
   * ride stdin on Windows: `.cmd` shims are re-invoked through cmd.exe, whose
   * command line cannot carry newlines — an argv prompt arrives mangled/empty.
   */
  readonly buildExecInput?: (task: AdapterTask) => string | undefined;
  /** Declared local concurrency when available + authenticated (>= 1). */
  readonly capacity: number;
  /** Remediations surfaced when the CLI is missing. */
  readonly installActions: readonly SetupAction[];
  /** Remediations surfaced when the CLI is present but not authenticated. */
  readonly loginActions: readonly SetupAction[];
  /**
   * Optional per-execution progress parser factory. Called once per execute();
   * the returned (stateful) parser receives every output chunk and yields
   * human-readable progress messages, each emitted as a `progress` event —
   * the ONLY adapter event kind the worker runner records to the ledger, so
   * this is what makes a long-running ticket visibly alive in the UI.
   */
  readonly createProgressParser?: () => (
    stream: 'stdout' | 'stderr',
    chunk: string,
  ) => readonly string[];
  /**
   * Optional parser turning a successful command result into artifacts + output.
   * Defaults to: output = trimmed stdout, artifacts = [].
   */
  readonly parseSuccess?: (
    result: CommandResult,
    task: AdapterTask,
  ) => {
    readonly output: string;
    readonly artifacts: readonly AdapterArtifact[];
    readonly summary?: string;
  };
}

/** Dependencies injected into a CLI adapter (the runner is the key seam). */
export interface CliAdapterDeps {
  readonly runner: CommandRunner;
  /**
   * Per-user spawn-env bundle (multi-user U6): when present, EVERY child this
   * adapter spawns — setup probes and execution alike — runs with an
   * EXCLUSIVE environment (essentials + scrub + family-narrowed bundle,
   * `replaceEnv: true`) so server secrets never reach a worker CLI. Absent =
   * today's inherit+scrub behavior, byte-identical.
   */
  readonly spawnEnv?: SpawnEnvBundle;
}

const NOT_LOGGED_IN =
  /\b(not logged in|unauthenticated|please (?:re-?)?login|no (?:active )?session|login required)\b/i;

/** Bounded timeout for the (otherwise unbounded) setup probes, so they can't hang. */
const PROBE_TIMEOUT_MS = 10_000;

function classifyVersionProbe(result: CommandResult): CliProbeOutcome {
  if (result.code !== 0) {
    return { ok: false, detail: tail(result.stderr || result.stdout) };
  }
  return { ok: true, detail: firstLine(result.stdout) };
}

function classifyAuthProbe(result: CommandResult): CliProbeOutcome {
  const haystack = `${result.stdout}\n${result.stderr}`;
  if (result.code !== 0 || NOT_LOGGED_IN.test(haystack)) {
    return { ok: false, detail: tail(result.stderr || result.stdout) };
  }
  return { ok: true, detail: firstLine(result.stdout) };
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line !== undefined && line.length > 0 ? line : undefined;
}

function tail(text: string, max = 500): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length <= max ? trimmed : trimmed.slice(trimmed.length - max);
}

/**
 * Map a non-zero exit (a command that ran but failed) to a normalized error,
 * using stderr text for classification and falling back to `malformed_output`
 * (the tool produced an output we could not accept).
 */
function failureFromExit(result: CommandResult, command: string): AdapterError {
  const text = (result.stderr || result.stdout).trim();
  if (text.length > 0) {
    const normalized = normalizeAdapterError(new Error(text), { exitCode: result.code });
    // ENOENT-style text won't appear here; an unrecognized non-zero exit is best
    // treated as malformed output rather than a (terminal) `unavailable`.
    if (normalized.kind === 'unavailable') {
      return AdapterError.malformedOutput(`${command} exited ${result.code}: ${text}`, {
        exitCode: result.code,
        detail: tail(text),
      });
    }
    return normalized;
  }
  return AdapterError.malformedOutput(`${command} exited ${result.code} with no output.`, {
    exitCode: result.code,
  });
}

/** Build an `ExecutionAdapter` from a CLI configuration and injected runner. */
export function createCliAdapter(config: CliAdapterConfig, deps: CliAdapterDeps): ExecutionAdapter {
  const { runner } = deps;
  // Family-narrow the bundle ONCE at construction: a Claude spawn never sees
  // codex credentials and vice versa (see bundleEnvForFamily).
  const spawnBundle =
    deps.spawnEnv !== undefined ? bundleEnvForFamily(deps.spawnEnv, config.family) : undefined;

  /**
   * The ONE env seam for probes and execution (U6). Bundle present →
   * exclusive allowlisted env; absent → historical inherit+scrub.
   */
  function childEnvOptions(): {
    readonly env: Readonly<Record<string, string>>;
    readonly replaceEnv?: true;
  } {
    return spawnBundle !== undefined
      ? { env: composeSpawnEnv(spawnBundle), replaceEnv: true }
      : { env: scrubNestedSessionEnv() };
  }

  async function detectSetup(options: DetectSetupOptions = {}): Promise<AdapterSetupState> {
    // Every CLI spawn clears inherited Claude-session plumbing: a server
    // started from inside a Claude Code session would otherwise hand the
    // worker CLI a host proxy URL it cannot authenticate to (observed hang).
    const envOptions = childEnvOptions();
    let versionResult: CommandResult;
    try {
      versionResult = await runner.run(config.command, config.versionArgs, {
        signal: options.signal,
        timeoutMs: PROBE_TIMEOUT_MS,
        ...envOptions,
      });
    } catch (error) {
      // A missing executable (ENOENT) or abort surfaces here.
      const normalized = normalizeAdapterError(error);
      return {
        available: false,
        authenticated: false,
        capacity: 0,
        setupActions: config.installActions,
        detail: normalized.message,
      };
    }

    const version = classifyVersionProbe(versionResult);
    if (!version.ok) {
      return {
        available: false,
        authenticated: false,
        capacity: 0,
        setupActions: config.installActions,
        detail: version.detail,
      };
    }

    let authResult: CommandResult;
    try {
      authResult = await runner.run(config.command, config.authArgs, {
        signal: options.signal,
        timeoutMs: PROBE_TIMEOUT_MS,
        ...envOptions,
      });
    } catch (error) {
      const normalized = normalizeAdapterError(error);
      return {
        available: true,
        authenticated: false,
        capacity: 0,
        setupActions: config.loginActions,
        detail: normalized.message,
        version: version.detail,
      };
    }

    const auth = classifyAuthProbe(authResult);
    if (!auth.ok) {
      return {
        available: true,
        authenticated: false,
        capacity: 0,
        setupActions: config.loginActions,
        detail: auth.detail,
        version: version.detail,
      };
    }

    return {
      available: true,
      authenticated: true,
      capacity: Math.max(1, Math.trunc(config.capacity)),
      version: version.detail,
      detail: version.detail,
    };
  }

  async function execute(task: AdapterTask, opts: AdapterExecuteOptions): Promise<AdapterResult> {
    if (opts.signal.aborted) {
      return { ok: false, error: AdapterError.cancelled() };
    }

    opts.onEvent({ kind: 'progress', message: `Starting ${config.command} for ${task.ticketId}.` });

    const parseProgress = config.createProgressParser?.();
    let result: CommandResult;
    try {
      result = await runner.run(config.command, config.buildExecArgs(task), {
        cwd: task.workspaceDir,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        input: config.buildExecInput?.(task),
        // Same env seam as the probes: exclusive bundle env or inherit+scrub.
        ...childEnvOptions(),
        onOutput: (stream, chunk) => {
          opts.onEvent({ kind: 'log', stream, chunk });
          if (parseProgress !== undefined) {
            for (const message of parseProgress(stream, chunk)) {
              opts.onEvent({ kind: 'progress', message });
            }
          }
        },
      });
    } catch (error) {
      return { ok: false, error: normalizeAdapterError(error) };
    }

    // A late abort that resolved instead of rejecting still counts as cancelled.
    if (opts.signal.aborted) {
      return { ok: false, error: AdapterError.cancelled() };
    }

    if (result.code !== 0) {
      return { ok: false, error: failureFromExit(result, config.command) };
    }

    try {
      const parsed = config.parseSuccess
        ? config.parseSuccess(result, task)
        : { output: result.stdout.trim(), artifacts: [] as readonly AdapterArtifact[] };
      opts.onEvent({ kind: 'progress', message: `${config.command} completed.`, percent: 100 });
      return {
        ok: true,
        output: parsed.output,
        artifacts: parsed.artifacts,
        summary: parsed.summary,
      };
    } catch (error) {
      // A parser that cannot read the output is a malformed-output failure.
      return {
        ok: false,
        error: isAdapterError(error)
          ? error
          : AdapterError.malformedOutput(`Failed to parse ${config.command} output.`, {
              cause: error,
            }),
      };
    }
  }

  return {
    id: config.id,
    family: config.family,
    detectSetup,
    execute,
    reportCapacity(): number {
      return Math.max(1, Math.trunc(config.capacity));
    },
  };
}
