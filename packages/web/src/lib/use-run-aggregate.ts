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
 */
import { useEffect, useRef, useState } from 'react';
import type { LedgerRow } from '@software-factory/core';
import { fetchAggregate } from './api-client';
import type { RunAggregate } from './types';

const POLL_INTERVAL_MS = 1500;

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

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      try {
        const aggregate = await fetchAggregate(runId, lastSequence.current);
        if (!active) {
          return;
        }
        setSnapshot(aggregate);
        if (aggregate.tail.length > 0) {
          setRows((prev) => mergeRows(prev, aggregate.tail));
        }
        lastSequence.current = Math.max(lastSequence.current, aggregate.lastSequence);
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
  }, [runId, nonce]);

  return { snapshot, rows, reconnecting, refresh: () => setNonce((n) => n + 1) };
}
