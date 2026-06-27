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
  /** Declared local concurrency when available + authenticated (>= 1). */
  readonly capacity: number;
  /** Remediations surfaced when the CLI is missing. */
  readonly installActions: readonly SetupAction[];
  /** Remediations surfaced when the CLI is present but not authenticated. */
  readonly loginActions: readonly SetupAction[];
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
}

const NOT_LOGGED_IN =
  /\b(not logged in|unauthenticated|please (?:re-?)?login|no (?:active )?session|login required)\b/i;

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

  async function detectSetup(options: DetectSetupOptions = {}): Promise<AdapterSetupState> {
    let versionResult: CommandResult;
    try {
      versionResult = await runner.run(config.command, config.versionArgs, {
        signal: options.signal,
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
      authResult = await runner.run(config.command, config.authArgs, { signal: options.signal });
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

    let result: CommandResult;
    try {
      result = await runner.run(config.command, config.buildExecArgs(task), {
        cwd: task.workspaceDir,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        onOutput: (stream, chunk) => {
          opts.onEvent({ kind: 'log', stream, chunk });
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
