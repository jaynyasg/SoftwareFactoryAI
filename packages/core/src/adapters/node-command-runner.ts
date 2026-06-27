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

/** Create the production `CommandRunner` backed by `child_process.spawn`. */
export function createNodeCommandRunner(): CommandRunner {
  return {
    run(command, args, options: CommandRunOptions = {}): Promise<CommandResult> {
      return new Promise<CommandResult>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(makeAbortError());
          return;
        }

        const child = spawn(command, [...args], {
          cwd: options.cwd,
          env: options.env !== undefined ? { ...process.env, ...options.env } : process.env,
          shell: false,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          if (options.signal !== undefined) {
            options.signal.removeEventListener('abort', onAbort);
          }
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
          finishReject(makeAbortError());
        };

        if (options.signal !== undefined) {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            child.kill('SIGTERM');
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
          finishReject(error);
        });
        child.on('close', (code) => {
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
