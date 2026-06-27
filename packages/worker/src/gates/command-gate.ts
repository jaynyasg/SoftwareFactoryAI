/**
 * Shared quality-gate contracts + a command-backed gate builder.
 *
 * A `Gate` is a named, blocking check with `run(ctx): Promise<GateResult>`. The
 * gate runner (see `gate-runner`) runs gates in order, emitting `gate.started`
 * then `gate.passed` / `gate.failed` with EVIDENCE, and stops the pipeline on the
 * first blocking failure. Gates that execute a command (install / lint /
 * typecheck / test) do so THROUGH the sandbox, so the sandbox policy (host-secret
 * + path containment) applies and a policy denial is surfaced as a gate failure.
 *
 * `GateResult` carries structured evidence (command + output excerpt + detail)
 * that the runner maps onto event evidence and, on failure, into the structured
 * retry context fed back to the worker runner.
 */
import type { Sandbox, SandboxRunResult } from '../sandbox/sandbox';

/** One piece of gate evidence (command, output excerpt, or a note/ref). */
export interface GateEvidence {
  readonly label: string;
  /** The command line that produced this evidence, when applicable. */
  readonly command?: string;
  /** A trimmed, bounded excerpt of process/scan output. */
  readonly outputExcerpt?: string;
  /** Extra human-facing detail (e.g. an exit code or location). */
  readonly detail?: string;
  /** A stable reference (e.g. a URL or `exit:<code>`). */
  readonly ref?: string;
}

/** The shared context handed to every gate. */
export interface GateContext {
  readonly runId: string;
  readonly ticketId?: string;
  /** The isolated workspace the gate operates within. */
  readonly workspaceDir: string;
  /** Policy-enforcing runner for command gates. */
  readonly sandbox: Sandbox;
  readonly signal?: AbortSignal;
}

/** The outcome of one gate. */
export interface GateResult {
  readonly gate: string;
  readonly passed: boolean;
  /** Summary for `gate.passed` (present when passed). */
  readonly summary?: string;
  /** Reason for `gate.failed` (present when failed). */
  readonly reason?: string;
  /** The command line, for command-backed gates. */
  readonly command?: string;
  /** A bounded output excerpt, for command-backed gates. */
  readonly outputExcerpt?: string;
  readonly evidence: readonly GateEvidence[];
}

/** A named, blocking quality gate. */
export interface Gate {
  readonly name: string;
  run(ctx: GateContext): Promise<GateResult>;
}

/** Max characters retained from process output for an evidence excerpt. */
export const MAX_OUTPUT_EXCERPT = 600;

/** Produce a bounded, trimmed excerpt preferring stderr, then stdout. */
export function excerptOf(stdout: string, stderr: string, max = MAX_OUTPUT_EXCERPT): string {
  const source = stderr.trim().length > 0 ? stderr : stdout;
  const trimmed = source.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  // Keep the TAIL — failures usually report at the end of output.
  return `…${trimmed.slice(trimmed.length - (max - 1))}`;
}

/** Configuration for a command-backed gate. */
export interface CommandGateConfig {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  /** Working dir relative to the workspace (default `.`). */
  readonly cwd?: string;
  /** Paths the command may touch (validated by the sandbox policy). */
  readonly paths?: readonly string[];
  readonly timeoutMs?: number;
  /** Map a sandbox result to pass/fail (default: exit 0 passes). */
  readonly isSuccess?: (result: SandboxRunResult) => boolean;
}

/** Build a gate that runs a command through the sandbox and maps exit/output. */
export function createCommandGate(config: CommandGateConfig): Gate {
  return {
    name: config.name,
    async run(ctx: GateContext): Promise<GateResult> {
      const result = await ctx.sandbox.run({
        command: config.command,
        args: config.args,
        cwd: config.cwd ?? '.',
        paths: config.paths,
        timeoutMs: config.timeoutMs,
        signal: ctx.signal,
      });

      const commandLine = [config.command, ...(config.args ?? [])].join(' ');
      const excerpt = excerptOf(result.stdout, result.stderr);

      if (result.denied) {
        return {
          gate: config.name,
          passed: false,
          reason: `Sandbox policy denied ${config.name}: ${result.reason ?? 'policy violation'}`,
          command: commandLine,
          outputExcerpt: excerpt,
          evidence: [
            {
              label: `${config.name}:denied`,
              command: commandLine,
              detail: result.violations.map((v) => `${v.kind}:${v.target}`).join(', '),
              outputExcerpt: excerpt,
            },
          ],
        };
      }

      const passed = (config.isSuccess ?? ((r) => r.ok))(result);
      const exitRef = `exit:${result.code ?? 'n/a'}`;
      const trustNote = result.reducedTrust ? 'reduced-trust sandbox' : undefined;

      if (passed) {
        return {
          gate: config.name,
          passed: true,
          summary: `${config.name} passed (exit ${result.code ?? 0}).`,
          command: commandLine,
          outputExcerpt: excerpt,
          evidence: [
            {
              label: `${config.name}:command`,
              command: commandLine,
              ref: exitRef,
              outputExcerpt: excerpt,
              detail: trustNote,
            },
          ],
        };
      }

      return {
        gate: config.name,
        passed: false,
        reason: `${config.name} failed (exit ${result.code ?? 'n/a'}).`,
        command: commandLine,
        outputExcerpt: excerpt,
        evidence: [
          {
            label: `${config.name}:failure`,
            command: commandLine,
            ref: exitRef,
            outputExcerpt: excerpt,
            detail: trustNote,
          },
        ],
      };
    },
  };
}
