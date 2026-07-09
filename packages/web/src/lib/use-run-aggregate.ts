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
 * `key={runId}` (see FactoryFloor), but the hook does NOT rely on that: when
 * `runId` changes across renders it resets the snapshot, rows, and cursor to
 * the new `initial` before polling, so a reused instance can never poll with
 * the previous run's cursor or mix ledger rows across runs.
 */
import { useEffect, useRef, useState } from 'react';
import type { LedgerRow } from '@software-factory/core';
import { fetchAggregate } from './api-client';
import { POLL_INTERVAL_MS, startPollLoop } from './polling';
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

export interface LiveRun {
  readonly snapshot: RunAggregate;
  readonly rows: readonly LedgerRow[];
  readonly reconnecting: boolean;
  /** Force an immediate refresh (used after a mutation succeeds). */
  readonly refresh: () => void;
}

export function useRunAggregate(runId: string, initial: RunAggregate): LiveRun {
  const [snapshot, setSnapshot] = useState<RunAggregate>(initial);
  const [rows, setRows] = useState<readonly LedgerRow[]>(initial.run.ledger);
  const [reconnecting, setReconnecting] = useState(false);
  const [nonce, setNonce] = useState(0);
  const lastSequence = useRef<number>(initial.lastSequence);

  // Run-identity reset (see the module header): if the hook instance is reused
  // for a different run (no key remount), drop the previous run's accumulated
  // rows and cursor BEFORE the next poll — sequences are run-relative, so the
  // old cursor/rows would cross-contaminate the new run's ledger. Adjusting
  // state during render is React's documented derived-state pattern; the
  // render restarts immediately with the reset values.
  const boundRunId = useRef(runId);
  if (boundRunId.current !== runId) {
    boundRunId.current = runId;
    lastSequence.current = initial.lastSequence;
    setSnapshot(initial);
    setRows(initial.run.ledger);
    setReconnecting(false);
    setNonce(0);
  }

  useEffect(
    () =>
      startPollLoop({
        intervalMs: POLL_INTERVAL_MS,
        // A refresh() restart confirms a just-issued command: poll right away
        // instead of letting the confirmation lag one full interval.
        immediateFirst: nonce > 0,
        tick: async (isActive) => {
          const aggregate = await fetchAggregate(runId, lastSequence.current);
          if (!isActive()) {
            return;
          }
          setSnapshot(aggregate);
          if (aggregate.tail.length > 0) {
            setRows((prev) => mergeRows(prev, aggregate.tail));
          }
          lastSequence.current = Math.max(lastSequence.current, aggregate.lastSequence);
        },
        onSettled: (ok) => setReconnecting(!ok),
      }),
    [runId, nonce],
  );

  return { snapshot, rows, reconnecting, refresh: () => setNonce((n) => n + 1) };
}
