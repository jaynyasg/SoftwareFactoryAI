/**
 * Unit-test gate: runs the generated app's OWN `test` manifest script through
 * the sandbox (applicability-aware — see `createScriptGate`: a workspace with
 * no manifest or no test script passes honestly instead of letting pnpm walk
 * up into the factory's monorepo).
 */
import { createScriptGate } from './command-gate';
import type { Gate } from './command-gate';

/** Options for the unit-test gate (defaults to the workspace's `test` script). */
export interface TestGateOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the unit-test gate. */
export function createTestGate(options: TestGateOptions = {}): Gate {
  return createScriptGate({
    name: 'unit-test',
    script: 'test',
    command: options.command,
    args: options.args,
    timeoutMs: options.timeoutMs,
  });
}
