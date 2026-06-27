/**
 * Unit-test gate: runs the generated app's test command through the sandbox and
 * maps a non-zero exit to a blocking failure with command + output evidence.
 */
import { createCommandGate } from './command-gate';
import type { Gate } from './command-gate';

/** Options for the unit-test gate (defaults to `pnpm test`). */
export interface TestGateOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the unit-test gate. */
export function createTestGate(options: TestGateOptions = {}): Gate {
  return createCommandGate({
    name: 'unit-test',
    command: options.command ?? 'pnpm',
    args: options.args ?? ['test'],
    timeoutMs: options.timeoutMs,
  });
}
