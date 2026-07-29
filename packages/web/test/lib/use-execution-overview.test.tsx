// @vitest-environment jsdom
/**
 * useExecutionOverview polling tests (mirrors use-run-aggregate): the hook
 * trusts the server-rendered initial overview until the FIRST interval tick
 * (no double-fetch on mount), refresh() confirms a just-issued command within
 * one round trip, and a failing tick flips `reconnecting` while keeping the
 * last good overview on screen until the next tick recovers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useExecutionOverview } from '../../src/lib/use-execution-overview';
import { POLL_INTERVAL_MS } from '../../src/lib/polling';
import type { ExecutionOverview } from '../../src/lib/types';

const HELD: ExecutionOverview = {
  execution: { enabled: true, held: true, running: true },
  queue: { queued: 2, leased: 0 },
  resetGeneration: 0,
};
const ACTIVE: ExecutionOverview = {
  execution: { enabled: true, held: false, running: true },
  queue: { queued: 0, leased: 1 },
  resetGeneration: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useExecutionOverview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('trusts the initial overview and does not fetch before the first interval elapses', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(ACTIVE)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useExecutionOverview(HELD));
    expect(result.current.overview).toEqual(HELD);

    // The server-rendered overview is fresh: no immediate re-fetch on mount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // The first full interval polls and adopts the live state.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/execution', expect.anything());
    expect(result.current.overview).toEqual(ACTIVE);
  });

  it('refresh() polls immediately instead of waiting a full interval', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(ACTIVE)));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useExecutionOverview(HELD));
    expect(fetchMock).not.toHaveBeenCalled();

    // A resume/hold/cancel-all just succeeded: the confirmation must arrive
    // within one round trip — the fake 1.5s interval NEVER advances here.
    await act(async () => {
      result.current.refresh();
    });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.overview).toEqual(ACTIVE);
  });

  it('a failing tick flips reconnecting and keeps the last good overview until recovery', async () => {
    vi.useFakeTimers();
    let fail = true;
    const fetchMock = vi.fn(() =>
      fail ? Promise.reject(new Error('network down')) : Promise.resolve(jsonResponse(ACTIVE)),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useExecutionOverview(HELD));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.reconnecting).toBe(true);
    // The last good overview stays on screen — never a blank/disabled flash.
    expect(result.current.overview).toEqual(HELD);

    fail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.reconnecting).toBe(false);
    expect(result.current.overview).toEqual(ACTIVE);
  });
});
