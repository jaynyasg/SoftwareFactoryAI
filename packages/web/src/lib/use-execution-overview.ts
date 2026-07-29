'use client';

/**
 * Live factory-wide execution state polling (drain gate + job counts).
 *
 * Shared polling contract (see `usePolledResource`): each tick refetches the
 * projected state; a failed tick flips `reconnecting` true and keeps the last
 * good data on screen until the next tick recovers. `refresh()` forces an
 * immediate re-poll after a mutation (resume/hold/cancel-all) succeeds.
 *
 * Used by the run-detail surface, which needs ONLY the execution overview.
 * The Factory Floor polls the combined floor status instead
 * (`use-floor-status`), so one tab never runs this loop AND the floor loop.
 */
import { fetchExecutionOverview } from './api-client';
import { usePolledResource } from './polling';
import type { ExecutionOverview } from './types';

export interface LiveExecutionOverview {
  readonly overview: ExecutionOverview;
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a mutation succeeds). */
  readonly refresh: () => void;
}

export function useExecutionOverview(initial: ExecutionOverview): LiveExecutionOverview {
  const polled = usePolledResource<ExecutionOverview>({
    initial,
    fetchNext: fetchExecutionOverview,
  });
  return { overview: polled.data, reconnecting: polled.reconnecting, refresh: polled.refresh };
}
