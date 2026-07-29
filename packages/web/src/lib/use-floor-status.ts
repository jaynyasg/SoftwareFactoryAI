'use client';

/**
 * Live combined floor polling (TODOS P2 poll consolidation): ONE loop feeds
 * both the factory command bar (drain gate + job counts) and the intervention
 * queue, replacing the floor's separate /api/execution and /api/interventions
 * loops — one request and one server-side ledger read per tick instead of two.
 *
 * Shared polling contract (see `usePolledResource`): a failed tick flips
 * `reconnecting` true and keeps the last good data on screen until the next
 * tick recovers. `refresh()` forces an immediate re-poll after a mutation
 * (resume/hold/cancel-all/resolve) succeeds.
 */
import { fetchFloorStatus } from './api-client';
import { usePolledResource } from './polling';
import type { FloorStatus } from './types';

export interface LiveFloorStatus {
  readonly floor: FloorStatus;
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a mutation succeeds). */
  readonly refresh: () => void;
}

export function useFloorStatus(initial: FloorStatus): LiveFloorStatus {
  const polled = usePolledResource<FloorStatus>({
    initial,
    fetchNext: () => fetchFloorStatus(),
  });
  return { floor: polled.data, reconnecting: polled.reconnecting, refresh: polled.refresh };
}
