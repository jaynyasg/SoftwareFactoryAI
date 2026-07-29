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
import { useRef } from 'react';
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

/**
 * Stale-tab detection for Factory Reset (R15): a reset wipes the operator
 * token and CSRF state server-side, so a tab opened before the reset would
 * see every command rejected with unexplained guard errors. Both polled
 * overviews (`GET /api/execution` and `GET /api/floor`) carry the ledger-
 * derived `resetGeneration`; this hook captures the generation seen at mount
 * and returns true once the polled value CHANGES — the caller renders a
 * forced-reload banner and disables mutations until reload.
 *
 * Known caveat (documented, safe failure direction): a degraded-SSR mount
 * seeds the overview with the disabled default (`resetGeneration: 0`), so a
 * factory that was reset in a PREVIOUS session reads as changed on the first
 * successful poll. The banner then asks for a reload — which fixes the tab —
 * rather than ever missing a real mid-session reset.
 */
export function useResetGenerationGuard(resetGeneration: number): boolean {
  const baseline = useRef(resetGeneration);
  // The generation is monotonic (ledger-derived), so once it differs from the
  // mount value it stays different — no sticky state needed.
  return resetGeneration !== baseline.current;
}
