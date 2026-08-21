/**
 * Lint gate: runs the generated app's OWN `lint` manifest script through the
 * sandbox (applicability-aware — see `createScriptGate`: a workspace with no
 * manifest or no lint script passes honestly instead of letting pnpm walk up
 * into the factory's monorepo).
 */
import { createScriptGate } from './command-gate';
import type { Gate } from './command-gate';

/** Options for the lint gate (defaults to the workspace's `lint` script). */
export interface LintGateOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the lint gate. */
export function createLintGate(options: LintGateOptions = {}): Gate {
  return createScriptGate({
    name: 'lint',
    script: 'lint',
    command: options.command,
    args: options.args,
    timeoutMs: options.timeoutMs,
  });
}
