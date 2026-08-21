'use client';

/**
 * Live cross-run intervention queue polling (X4/U9).
 *
 * Same polling contract as `use-run-aggregate`: each tick refetches the
 * projected queue; a failed tick flips `reconnecting` true and keeps the last
 * good data on screen until the next tick recovers (DESIGN.md §6 —
 * reconnecting is honest, never a frozen-but-pretending UI). `refresh()`
 * forces an immediate re-poll after a mutation (resolve) succeeds.
 */
import { useEffect, useState } from 'react';
import { fetchInterventions } from './api-client';
import { POLL_INTERVAL_MS, startPollLoop } from './polling';
import type { InterventionQueueSnapshot } from './types';

export interface LiveInterventionQueue {
  readonly snapshot: InterventionQueueSnapshot;
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a resolve succeeds). */
  readonly refresh: () => void;
}

export function useInterventionQueue(initial: InterventionQueueSnapshot): LiveInterventionQueue {
  const [snapshot, setSnapshot] = useState<InterventionQueueSnapshot>(initial);
  const [reconnecting, setReconnecting] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(
    () =>
      startPollLoop({
        intervalMs: POLL_INTERVAL_MS,
        // A refresh() restart confirms a just-resolved intervention: poll right
        // away so the item flips/disappears within one round trip instead of
        // lagging one full interval.
        immediateFirst: nonce > 0,
        tick: async (isActive) => {
          const next = await fetchInterventions();
          if (isActive()) {
            setSnapshot(next);
          }
        },
        onSettled: (ok) => setReconnecting(!ok),
      }),
    [nonce],
  );

  return { snapshot, reconnecting, refresh: () => setNonce((n) => n + 1) };
}
