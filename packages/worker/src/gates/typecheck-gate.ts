/**
 * Typecheck gate: runs the generated app's typecheck command through the sandbox
 * and maps a non-zero exit to a blocking failure with command + output evidence.
 */
import { createCommandGate } from './command-gate';
import type { Gate } from './command-gate';

/** Options for the typecheck gate (defaults to `pnpm typecheck`). */
export interface TypecheckGateOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the typecheck gate. */
export function createTypecheckGate(options: TypecheckGateOptions = {}): Gate {
  return createCommandGate({
    name: 'typecheck',
    command: options.command ?? 'pnpm',
    args: options.args ?? ['typecheck'],
    timeoutMs: options.timeoutMs,
  });
}
