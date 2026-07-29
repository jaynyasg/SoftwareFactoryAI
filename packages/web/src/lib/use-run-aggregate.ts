'use client';

/**
 * Live run polling with `last_sequence` resume.
 *
 * We chose POLLING over SSE for V1: it is simpler, has no streaming
 * infrastructure to keep alive, and degrades gracefully on a flaky connection.
 * Each tick requests `/data/runs/:id?after=<lastSequence>`, appends the returned
 * `tail` rows to the accumulated ledger (so the trace ledger resumes exactly
 * where it left off rather than refetching the whole log), and refreshes the
 * rest of the projected snapshot. A failed tick flips `reconnecting` true and
 * keeps the last good data on screen until the next tick recovers — honest
 * reconnect behavior, never a frozen-but-pretending UI (DESIGN.md §6).
 *
 * RUN IDENTITY INVARIANT: the accumulated rows and the `last_sequence` cursor
 * are PER RUN — sequences are run-relative, so rows from two runs must never
 * meet in one accumulator. Callers typically remount the owning component with
 * `key={runId}` (see FactoryFloor), but the hook does NOT rely on that: it
 * passes `runId` as the shared hook's `resetKey`, so a reused instance resets
 * its snapshot, rows, and cursor to the new `initial` before polling and can
 * never poll with the previous run's cursor or mix ledger rows across runs.
 */
import type { LedgerRow } from '@software-factory/core';
import { fetchAggregate } from './api-client';
import { usePolledResource } from './polling';
import type { RunAggregate } from './types';

function mergeRows(prev: readonly LedgerRow[], tail: readonly LedgerRow[]): LedgerRow[] {
  const bySequence = new Map<number, LedgerRow>();
  for (const row of prev) {
    bySequence.set(row.sequence, row);
  }
  for (const row of tail) {
    bySequence.set(row.sequence, row);
  }
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

/** The per-run polled state: projected snapshot + accumulated ledger + cursor. */
interface AggregateState {
  readonly snapshot: RunAggregate;
  readonly rows: readonly LedgerRow[];
  readonly cursor: number;
}

export interface LiveRun {
  readonly snapshot: RunAggregate;
  readonly rows: readonly LedgerRow[];
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a mutation succeeds). */
  readonly refresh: () => void;
}

export function useRunAggregate(runId: string, initial: RunAggregate): LiveRun {
  const polled = usePolledResource<AggregateState>({
    initial: { snapshot: initial, rows: initial.run.ledger, cursor: initial.lastSequence },
    resetKey: runId,
    fetchNext: async (prev) => {
      const aggregate = await fetchAggregate(runId, prev.cursor);
      return {
        snapshot: aggregate,
        rows: aggregate.tail.length > 0 ? mergeRows(prev.rows, aggregate.tail) : prev.rows,
        cursor: Math.max(prev.cursor, aggregate.lastSequence),
      };
    },
  });
  const { snapshot, rows } = polled.data;
  return { snapshot, rows, reconnecting: polled.reconnecting, refresh: polled.refresh };
}
