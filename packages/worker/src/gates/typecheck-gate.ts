/**
 * Typecheck gate: runs the generated app's OWN `typecheck` manifest script
 * through the sandbox (applicability-aware — see `createScriptGate`: a
 * workspace with no manifest or no typecheck script passes honestly instead
 * of letting pnpm walk up into the factory's monorepo).
 */
import { createScriptGate } from './command-gate';
import type { Gate } from './command-gate';

/** Options for the typecheck gate (defaults to the workspace's `typecheck` script). */
export interface TypecheckGateOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

/** Create the typecheck gate. */
export function createTypecheckGate(options: TypecheckGateOptions = {}): Gate {
  return createScriptGate({
    name: 'typecheck',
    script: 'typecheck',
    command: options.command,
    args: options.args,
    timeoutMs: options.timeoutMs,
  });
}
