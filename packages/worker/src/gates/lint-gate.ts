/**
 * Lint gate: runs the generated app's lint command through the sandbox and maps
 * a non-zero exit to a blocking failure with command + output evidence.
 */
import { createCommandGate } from './command-gate';
import type { Gate } from './command-gate';

/** Options for the lint gate (defaults to `pnpm lint`). */
export interface LintGateOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the lint gate. */
export function createLintGate(options: LintGateOptions = {}): Gate {
  return createCommandGate({
    name: 'lint',
    command: options.command ?? 'pnpm',
    args: options.args ?? ['lint'],
    timeoutMs: options.timeoutMs,
  });
}
