/**
 * Shared wire parsing for the factory-wide execution overview (the body of
 * GET /api/execution). ONE structural parser serves the browser client
 * (api-client `fetchExecutionOverview`), the SSR loader (run-data
 * `loadExecutionOverview`), and the FactoryFloor default prop, so the three
 * can never drift on shape or defaults. Type-only imports keep this module
 * safe for both server and client bundles.
 */
import type { ExecutionOverview } from './types';

/**
 * Safe default when no execution daemon is wired (or the server provided no
 * overview): controls hidden, nothing held, nothing counted.
 */
export const DISABLED_EXECUTION_OVERVIEW: ExecutionOverview = {
  execution: { enabled: false, held: false, running: false },
  queue: { queued: 0, leased: 0 },
  resetGeneration: 0,
};

/**
 * Structurally parse an execution-overview body. Every field is checked, and
 * malformed/missing values degrade to the disabled defaults instead of
 * rendering `undefined` into the command bar. `resetGeneration` degrades to 0
 * (never-reset) so older server payloads that omit it stay parseable.
 */
export function parseExecutionOverview(body: Record<string, unknown>): ExecutionOverview {
  const execution = (body.execution ?? {}) as Record<string, unknown>;
  const queue = (body.queue ?? {}) as Record<string, unknown>;
  return {
    execution: {
      enabled: execution.enabled === true,
      held: execution.held === true,
      running: execution.running === true,
    },
    queue: {
      queued: typeof queue.queued === 'number' ? queue.queued : 0,
      leased: typeof queue.leased === 'number' ? queue.leased : 0,
    },
    resetGeneration: typeof body.resetGeneration === 'number' ? body.resetGeneration : 0,
  };
}
