/**
 * A scripted, in-memory `CommandRunner` for the adapter contract tests.
 *
 * It lets a test declare, per command + leading argument, what the fake process
 * should do: return a `{ code, stdout, stderr }`, or throw (e.g. an ENOENT to
 * simulate a missing executable). This is how the CLI adapters are exercised
 * WITHOUT the real CLI being installed.
 */
import type { CommandResult, CommandRunOptions, CommandRunner } from '@software-factory/core';

export type ScriptedResponse = CommandResult | (() => never) | Error;

export interface FakeRunnerScript {
  /** Keyed by `"<command> <firstArg>"`, falling back to `"<command>"`. */
  readonly responses?: Readonly<Record<string, ScriptedResponse>>;
  /** Default when no key matches (defaults to exit 0, empty output). */
  readonly fallback?: ScriptedResponse;
}

export interface FakeCommandRunner extends CommandRunner {
  /** Every invocation, in order, for assertions. */
  readonly calls: readonly { command: string; args: readonly string[] }[];
}

function enoent(command: string): Error {
  const error = new Error(`spawn ${command} ENOENT`);
  return Object.assign(error, { code: 'ENOENT' });
}

export function createFakeRunner(script: FakeRunnerScript): FakeCommandRunner {
  const calls: { command: string; args: readonly string[] }[] = [];

  const responses = script.responses ?? {};
  const resolveResponse = (command: string, args: readonly string[]): ScriptedResponse => {
    const withArg = args.length > 0 ? `${command} ${args[0]}` : command;
    return (
      responses[withArg] ??
      responses[command] ??
      script.fallback ?? { code: 0, stdout: '', stderr: '' }
    );
  };

  return {
    calls,
    run(command, args, _options?: CommandRunOptions): Promise<CommandResult> {
      calls.push({ command, args: [...args] });
      const response = resolveResponse(command, args);
      if (typeof response === 'function') {
        try {
          response();
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (response instanceof Error) {
        return Promise.reject(response);
      }
      return Promise.resolve(response as CommandResult);
    },
  };
}

/** A runner whose executable is missing (every probe throws ENOENT). */
export function createMissingRunner(command: string): FakeCommandRunner {
  return createFakeRunner({ fallback: enoent(command) });
}
