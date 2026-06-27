/**
 * The default, Node `child_process`-backed `CommandRunner`.
 *
 * This is the ONLY place the adapter layer touches the OS process API. It is the
 * production default for the local CLI adapters; tests never use it (they inject
 * a fake `CommandRunner`). It collects stdout/stderr, streams chunks through
 * `onOutput`, and honors both an `AbortSignal` and a hard `timeoutMs` — a process
 * that overruns is killed and the promise rejects with a timeout-shaped error so
 * `normalizeAdapterError` maps it to `timeout`.
 */
import { spawn } from 'node:child_process';
import type { CommandResult, CommandRunOptions, CommandRunner } from './execution-adapter';

class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Grace period after SIGTERM before escalating to SIGKILL on abort/timeout. */
const SIGKILL_GRACE_MS = 5000;

/** Create the production `CommandRunner` backed by `child_process.spawn`. */
export function createNodeCommandRunner(): CommandRunner {
  return {
    run(command, args, options: CommandRunOptions = {}): Promise<CommandResult> {
      return new Promise<CommandResult>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(makeAbortError());
          return;
        }

        // `replaceEnv` makes `env` the EXCLUSIVE child environment (no host merge),
        // so the sandbox can withhold host secrets from untrusted code; the
        // default merges `process.env` as before. The cast is required only for
        // the replace branch: it intentionally builds a restricted env that need
        // not carry framework-required vars (e.g. an augmented `NODE_ENV`).
        const spawnEnv: NodeJS.ProcessEnv =
          options.replaceEnv === true
            ? ({ ...(options.env ?? {}) } as NodeJS.ProcessEnv)
            : options.env !== undefined
              ? { ...process.env, ...options.env }
              : process.env;

        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: spawnEnv,
          shell: false,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let childExited = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let killTimer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (options.signal !== undefined) {
            options.signal.removeEventListener('abort', onAbort);
          }
        };

        // After SIGTERM, escalate to SIGKILL if the child has not actually exited
        // within the grace period — so a child that ignores SIGTERM is not leaked.
        // The promise still rejects promptly; this only governs the OS process.
        const escalateKill = (): void => {
          if (killTimer !== undefined) {
            return;
          }
          killTimer = setTimeout(() => {
            if (!childExited) {
              child.kill('SIGKILL');
            }
          }, SIGKILL_GRACE_MS);
          killTimer.unref?.();
        };

        const finishResolve = (result: CommandResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(result);
        };

        const finishReject = (error: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };

        const onAbort = (): void => {
          child.kill('SIGTERM');
          escalateKill();
          finishReject(makeAbortError());
        };

        if (options.signal !== undefined) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            child.kill('SIGTERM');
            escalateKill();
            finishReject(new TimeoutError(`Command timed out after ${options.timeoutMs}ms.`));
          }, options.timeoutMs);
        }

        child.stdout?.on('data', (data: Buffer) => {
          const chunk = data.toString('utf8');
          stdout += chunk;
          options.onOutput?.('stdout', chunk);
        });
        child.stderr?.on('data', (data: Buffer) => {
          const chunk = data.toString('utf8');
          stderr += chunk;
          options.onOutput?.('stderr', chunk);
        });

        child.on('error', (error) => {
          childExited = true;
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
          }
          finishReject(error);
        });
        child.on('close', (code) => {
          childExited = true;
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
          }
          finishResolve({ code: code ?? 0, stdout, stderr });
        });

        if (options.input !== undefined && child.stdin !== null) {
          child.stdin.write(options.input);
          child.stdin.end();
        }
      });
    },
  };
}

function makeAbortError(): Error {
  const error = new Error('The command was aborted.');
  error.name = 'AbortError';
  return error;
}
