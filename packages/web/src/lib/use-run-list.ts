'use client';

/**
 * Live run-list polling (session lifecycle U5, R14): the floor's strip and
 * board stay truthful without a manual reload — runs started from CLI/MCP
 * appear within one poll interval, and a run archived from another surface
 * leaves the visible list so the floor can refocus honestly.
 *
 * Shared polling contract (see `usePolledResource`): a failed tick flips
 * `reconnecting` true and keeps the last good list on screen until the next
 * tick recovers — the list never collapses to empty on a bad tick, so focus
 * is never stolen by a transient failure. `refresh()` forces an immediate
 * re-poll after a mutation (e.g. a lifecycle command) succeeds.
 */
import type { RunProjection } from '@software-factory/core';
import { fetchRunList } from './api-client';
import { usePolledResource } from './polling';

export interface LiveRunList {
  /** Visible runs, newest first (same order as the SSR `loadRunList`). */
  readonly runs: readonly RunProjection[];
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a mutation succeeds). */
  readonly refresh: () => void;
}

export function useRunList(initial: readonly RunProjection[]): LiveRunList {
  const polled = usePolledResource<readonly RunProjection[]>({
    initial,
    // Explicitly VISIBLE-only: the shared poller never flips to
    // includeArchived — the history view uses its own one-shot fetch (U6).
    fetchNext: () => fetchRunList(),
  });
  return { runs: polled.data, reconnecting: polled.reconnecting, refresh: polled.refresh };
}
