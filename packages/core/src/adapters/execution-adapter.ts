/**
 * The ONE execution-adapter contract shared by every worker backend.
 *
 * A factory worker never talks to a model/CLI/service directly — it talks to an
 * `ExecutionAdapter`. The same interface is implemented by local BYO CLIs (Codex,
 * Claude Code) and by a future hosted API, so the scheduler/runner are agnostic
 * to how a ticket is actually executed. Adapters:
 *   - probe their environment (`detectSetup`) and report availability/auth/capacity,
 *   - `execute` a task while streaming progress, honoring an `AbortSignal`, and
 *   - normalize every failure to an `AdapterError` (see `adapter-errors`).
 *
 * Local CLI adapters take an injected `CommandRunner` so they are fully testable
 * WITHOUT the real CLI installed; the Node-backed runner is only the default.
 */
import type { WorkerContext } from '../genome/context-compiler';
import type { AdapterError } from './adapter-errors';

/**
 * The adapter family. The known local/hosted families are listed for
 * autocomplete; `(string & {})` keeps the type open for future families without
 * losing the literal hints.
 */
export type AdapterFamily = 'codex' | 'claude' | 'api' | (string & {});

/** One produced artifact reference collected from an execution. */
export interface AdapterArtifact {
  /** Stable key tying the artifact to a module output contract, when known. */
  readonly key?: string;
  /** Coarse kind, e.g. `code`, `diff`, `report`, `log`. */
  readonly kind: string;
  /** Workspace-relative (or absolute) path, when the artifact is a file. */
  readonly path?: string;
  /** Inline summary/value carried alongside the artifact. */
  readonly summary?: string;
  /** Content digest, when computed. */
  readonly digest?: string;
}

/** A unit of work handed to an adapter: the ticket plus its compiled context. */
export interface AdapterTask {
  readonly runId: string;
  readonly ticketId: string;
  readonly title: string;
  /** The deterministic, per-ticket context (resolved inputs + allowed tools). */
  readonly context: WorkerContext;
  /** Isolated working directory the adapter may read/write within. */
  readonly workspaceDir: string;
  /**
   * The family of the agent that invoked the factory, when known. The runner
   * uses this to record nested-agent metadata (caller family == adapter family).
   */
  readonly callerFamily?: AdapterFamily;
}

/** Streaming progress: a coarse milestone with an optional percentage. */
export interface AdapterProgressEvent {
  readonly kind: 'progress';
  readonly message: string;
  /** 0..100 when the adapter can estimate it. */
  readonly percent?: number;
}

/** Streaming log line from the underlying process/transport. */
export interface AdapterLogEvent {
  readonly kind: 'log';
  readonly stream: 'stdout' | 'stderr';
  readonly chunk: string;
}

/** Streaming notice that an artifact was produced mid-run. */
export interface AdapterArtifactEvent {
  readonly kind: 'artifact';
  readonly artifact: AdapterArtifact;
}

/** The streamed events an adapter may emit through `onEvent`. */
export type AdapterStreamEvent = AdapterProgressEvent | AdapterLogEvent | AdapterArtifactEvent;

/** Options passed to `execute`: cancellation, streaming sink, and a timeout. */
export interface AdapterExecuteOptions {
  /** Cancellation signal; the adapter MUST stop work when it aborts. */
  readonly signal: AbortSignal;
  /** Synchronous streaming callback for progress/log/artifact events. */
  readonly onEvent: (event: AdapterStreamEvent) => void;
  /** Soft per-task timeout (ms). The adapter maps an overrun to `timeout`. */
  readonly timeoutMs?: number;
}

/** Successful execution: collected artifacts plus the final output text. */
export interface AdapterSuccess {
  readonly ok: true;
  /** Final output (e.g. the agent's last message / summary text). */
  readonly output: string;
  readonly artifacts: readonly AdapterArtifact[];
  readonly summary?: string;
  /** Free-form, adapter-specific metadata (model id, token counts, etc.). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Failed execution: a single normalized error (never a raw throw). */
export interface AdapterFailure {
  readonly ok: false;
  readonly error: AdapterError;
}

/** The result of `execute`: a discriminated union on `ok`. */
export type AdapterResult = AdapterSuccess | AdapterFailure;

/** A concrete remediation the operator can take to make an adapter usable. */
export interface SetupAction {
  /** Stable id, e.g. `codex.install` or `claude.login`. */
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** A suggested shell command, e.g. `codex login`. */
  readonly command?: string;
  /** A docs/help link. */
  readonly href?: string;
}

/** The normalized environment state an adapter reports from `detectSetup`. */
export interface AdapterSetupState {
  /** The underlying tool/transport is present and runnable. */
  readonly available: boolean;
  /** Credentials are present and valid. */
  readonly authenticated: boolean;
  /** Concurrent tasks this adapter can sustain right now (>= 0). */
  readonly capacity: number;
  /** Remediations to surface when not available/authenticated. */
  readonly setupActions?: readonly SetupAction[];
  /** Human-facing detail (e.g. detected version, or why it is unavailable). */
  readonly detail?: string;
  /** Detected tool/transport version, when known. */
  readonly version?: string;
}

/** Options for a setup probe (currently just cancellation). */
export interface DetectSetupOptions {
  readonly signal?: AbortSignal;
}

/** The single contract every worker backend implements. */
export interface ExecutionAdapter {
  /** Stable adapter id (unique per configured instance). */
  readonly id: string;
  /** Adapter family (drives nested-agent detection + selection). */
  readonly family: AdapterFamily;
  /** Probe availability/auth/capacity and return normalized state. */
  detectSetup(options?: DetectSetupOptions): Promise<AdapterSetupState>;
  /** Execute a task, streaming progress and honoring `opts.signal`. */
  execute(task: AdapterTask, opts: AdapterExecuteOptions): Promise<AdapterResult>;
  /** Best-effort current concurrency this adapter can sustain (>= 0). */
  reportCapacity(): number;
}

/** Picks an adapter for a given node/ticket (for future multi-adapter runs). */
export type AdapterSelector<TNode> = (node: TNode) => ExecutionAdapter;

/* ----------------------------------------------------------------------------
 * CommandRunner — the injectable process abstraction used by CLI adapters
 * ------------------------------------------------------------------------- */

/** The terminal result of running a command. */
export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for a single command invocation. */
export interface CommandRunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * When `true`, the child is spawned with `env` as its EXCLUSIVE environment —
   * the host `process.env` is NOT merged in. Used by the sandbox so host secrets
   * never reach untrusted generated code. Default (false/undefined) merges
   * `process.env` with `env` (the original behavior all other callers rely on).
   */
  readonly replaceEnv?: boolean;
  /** Abort signal; an aborted run rejects (normalized to `cancelled`). */
  readonly signal?: AbortSignal;
  /** Hard timeout (ms); an overrun rejects (normalized to `timeout`). */
  readonly timeoutMs?: number;
  /** Incremental output sink, for streaming progress/log events. */
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Optional stdin to write to the process. */
  readonly input?: string;
}

/**
 * The process abstraction CLI adapters depend on. Tests inject a fake; the real
 * Node `child_process`-backed implementation (`createNodeCommandRunner`) is only
 * the default and is never required by tests.
 */
export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult>;
}
