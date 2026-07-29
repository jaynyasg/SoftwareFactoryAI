// @vitest-environment jsdom
/**
 * useFloorStatus polling tests (mirrors use-execution-overview). The floor
 * loop is the ONLY poll feeding both the command bar and the intervention
 * queue, so its contract gets direct coverage: trust the server-rendered
 * initial until the first interval, poll /api/floor (not the standalone
 * endpoints), a failing tick flips `reconnecting` while BOTH halves of the
 * last good payload stay on screen, and a 200 with an unparseable body FAILS
 * the tick instead of replacing real data with an empty factory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFloorStatus } from '../../src/lib/use-floor-status';
import { POLL_INTERVAL_MS } from '../../src/lib/polling';
import type { FloorStatus } from '../../src/lib/types';

const HELD: FloorStatus = {
  overview: {
    execution: { enabled: true, held: true, running: true },
    queue: { queued: 2, leased: 0 },
  },
  interventionQueue: {
    interventions: [
      {
        interventionId: 'i-1',
        runId: 'run-1',
        kind: 'approval',
        severity: 'warn',
        blockingStage: 'deploy',
        reason: 'needs credentials',
        requiredAction: 'add the render credentials',
        raisedAt: 1000,
        sequence: 12,
        status: 'open',
      },
    ],
    openCount: 1,
  },
};

const ACTIVE_WIRE = {
  execution: { enabled: true, held: false, running: true },
  queue: { queued: 0, leased: 1 },
  interventions: [],
  openCount: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useFloorStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('trusts the initial payload, then polls /api/floor after one full interval', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(ACTIVE_WIRE)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFloorStatus(HELD));
    expect(result.current.floor).toEqual(HELD);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/floor', expect.anything());
    expect(result.current.floor.overview.execution.held).toBe(false);
    expect(result.current.floor.interventionQueue.openCount).toBe(0);
  });

  it('a failing tick flips reconnecting and keeps BOTH halves of the last good payload', async () => {
    vi.useFakeTimers();
    let fail = true;
    const fetchMock = vi.fn(() =>
      fail ? Promise.reject(new Error('network down')) : Promise.resolve(jsonResponse(ACTIVE_WIRE)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFloorStatus(HELD));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.reconnecting).toBe(true);
    // The operator must keep seeing the held gate AND the open intervention.
    expect(result.current.floor).toEqual(HELD);

    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.floor.overview.execution.held).toBe(false);
  });

  it('a 200 with an unparseable body fails the tick — never commits an empty factory', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('<html>proxy splash</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFloorStatus(HELD));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    // Garbage must NOT replace real data as if the factory were idle: the
    // tick fails honestly and the held gate + intervention stay on screen.
    expect(result.current.reconnecting).toBe(true);
    expect(result.current.floor).toEqual(HELD);
  });
});
