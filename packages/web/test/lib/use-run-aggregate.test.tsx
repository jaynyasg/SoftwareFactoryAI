// @vitest-environment jsdom
/**
 * useRunAggregate run-identity tests: rows and the `last_sequence` cursor are
 * per run, so a hook instance that is reused across run ids (no key remount)
 * must reset both — the old cursor would resume the wrong run's ledger and
 * merged rows would cross-contaminate two runs' events.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  buildFullFactoryRunEvents,
  buildMarketplaceRunEvents,
} from '../../../../tests/fixtures/marketplace-run';
import { aggregateFromEvents } from '../_helpers/aggregate';
import { useRunAggregate } from '../../src/lib/use-run-aggregate';
import { POLL_INTERVAL_MS } from '../../src/lib/polling';
import type { RunAggregate } from '../../src/lib/types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useRunAggregate run-identity reset', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('resets rows and the cursor when runId changes — no cross-run contamination', async () => {
    vi.useFakeTimers();
    const aggregateA = aggregateFromEvents(buildFullFactoryRunEvents('run-a'), 'run-a');
    const aggregateB = aggregateFromEvents(buildMarketplaceRunEvents('run-b'), 'run-b');

    // Run A's poll returns one NEW tail row past its cursor, advancing it.
    const tailRow = { ...aggregateA.run.ledger[0], sequence: aggregateA.lastSequence + 1 };
    const polledA: RunAggregate = {
      ...aggregateA,
      tail: [tailRow],
      lastSequence: aggregateA.lastSequence + 1,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        jsonResponse(
          String(input).startsWith('/data/runs/run-a') ? polledA : { ...aggregateB, tail: [] },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ runId, initial }: { runId: string; initial: RunAggregate }) =>
        useRunAggregate(runId, initial),
      { initialProps: { runId: 'run-a', initial: aggregateA } },
    );
    expect(result.current.rows).toHaveLength(aggregateA.run.ledger.length);

    // One poll for run A: the tail row accumulates and the cursor advances.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/data/runs/run-a?after=${aggregateA.lastSequence}`,
      expect.anything(),
    );
    expect(result.current.rows).toHaveLength(aggregateA.run.ledger.length + 1);

    // Reuse the SAME hook instance for run B (no key remount).
    rerender({ runId: 'run-b', initial: aggregateB });

    // Snapshot and rows reset to run B's initial — none of A's rows leak in.
    expect(result.current.snapshot.run.runId).toBe('run-b');
    expect(result.current.rows).toEqual(aggregateB.run.ledger);
    expect(result.current.reconnecting).toBe(false);

    // The next poll resumes from RUN B's cursor, not run A's advanced one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/data/runs/run-b?after=${aggregateB.lastSequence}`,
      expect.anything(),
    );
    expect(result.current.snapshot.run.runId).toBe('run-b');
    expect(result.current.rows).toEqual(aggregateB.run.ledger);
  });

  it('refresh() polls immediately instead of waiting a full interval', async () => {
    vi.useFakeTimers();
    const aggregateA = aggregateFromEvents(buildFullFactoryRunEvents('run-now'), 'run-now');
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ ...aggregateA, tail: [] })));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRunAggregate('run-now', aggregateA));
    expect(fetchMock).not.toHaveBeenCalled();

    // A command just succeeded: refresh must confirm within one round trip.
    await act(async () => {
      result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
