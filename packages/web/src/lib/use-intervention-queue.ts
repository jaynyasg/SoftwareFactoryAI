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
import type { InterventionQueueSnapshot } from './types';

const POLL_INTERVAL_MS = 1500;

export interface LiveInterventionQueue {
  readonly snapshot: InterventionQueueSnapshot;
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a resolve succeeds). */
  readonly refresh: () => void;
}

export function useInterventionQueue(
  initial: InterventionQueueSnapshot,
): LiveInterventionQueue {
  const [snapshot, setSnapshot] = useState<InterventionQueueSnapshot>(initial);
  const [reconnecting, setReconnecting] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      try {
        const next = await fetchInterventions();
        if (!active) {
          return;
        }
        setSnapshot(next);
        setReconnecting(false);
      } catch {
        if (active) {
          setReconnecting(true);
        }
      } finally {
        if (active) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    }

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      active = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [nonce]);

  return { snapshot, reconnecting, refresh: () => setNonce((n) => n + 1) };
}
