'use client';

/**
 * Live factory-wide execution state polling (drain gate + job counts).
 *
 * Same polling contract as `use-intervention-queue`: each tick refetches the
 * projected state; a failed tick flips `reconnecting` true and keeps the last
 * good data on screen until the next tick recovers. `refresh()` forces an
 * immediate re-poll after a mutation (resume/hold/cancel-all) succeeds.
 */
import { useEffect, useState } from 'react';
import { fetchExecutionOverview } from './api-client';
import { POLL_INTERVAL_MS, startPollLoop } from './polling';
import type { ExecutionOverview } from './types';

export interface LiveExecutionOverview {
  readonly overview: ExecutionOverview;
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a mutation succeeds). */
  readonly refresh: () => void;
}

export function useExecutionOverview(initial: ExecutionOverview): LiveExecutionOverview {
  const [overview, setOverview] = useState<ExecutionOverview>(initial);
  const [reconnecting, setReconnecting] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(
    () =>
      startPollLoop({
        intervalMs: POLL_INTERVAL_MS,
        // A refresh() restart confirms a just-issued command: poll right away
        // so the banner flips within one round trip instead of lagging one
        // full interval.
        immediateFirst: nonce > 0,
        tick: async (isActive) => {
          const next = await fetchExecutionOverview();
          if (isActive()) {
            setOverview(next);
          }
        },
        onSettled: (ok) => setReconnecting(!ok),
      }),
    [nonce],
  );

  return { overview, reconnecting, refresh: () => setNonce((n) => n + 1) };
}
