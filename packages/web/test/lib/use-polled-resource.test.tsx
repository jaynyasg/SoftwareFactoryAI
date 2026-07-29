// @vitest-environment jsdom
/**
 * usePolledResource contract pins. The consumer suites (use-run-aggregate,
 * use-execution-overview, use-floor-status) cover trust-initial, refresh(),
 * and reconnect recovery through real fetches; this suite pins the two
 * contracts that belong to the SHARED hook itself and would otherwise only be
 * covered indirectly: `fetchNext` receives the PREVIOUS committed value
 * (cursor/accumulator threading), and a `resetKey` change snaps that value
 * back to the current `initial` before the next poll.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { POLL_INTERVAL_MS, usePolledResource } from '../../src/lib/polling';

describe('usePolledResource', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('threads the previous committed value into fetchNext', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const { result } = renderHook(() =>
      usePolledResource<number>({
        initial: 10,
        fetchNext: (prev) => {
          seen.push(prev);
          return Promise.resolve(prev + 1);
        },
      }),
    );
    expect(result.current.data).toBe(10);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    // Each tick sees what the previous tick committed — never a stale seed.
    expect(seen).toEqual([10, 11]);
    expect(result.current.data).toBe(12);
  });

  it('a resetKey change snaps state back to the CURRENT initial before polling', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const { result, rerender } = renderHook(
      ({ key, initial }: { key: string; initial: number }) =>
        usePolledResource<number>({
          initial,
          resetKey: key,
          fetchNext: (prev) => {
            seen.push(prev);
            return Promise.resolve(prev + 1);
          },
        }),
      { initialProps: { key: 'a', initial: 10 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.data).toBe(11);

    // Key switch: data and the threaded prev both reset to the NEW initial —
    // the old key's accumulated value must never leak into the new key's poll.
    rerender({ key: 'b', initial: 100 });
    expect(result.current.data).toBe(100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(seen).toEqual([10, 100]);
    expect(result.current.data).toBe(101);
  });

  it('a resetKey change clears reconnecting from a failed state and waits a full interval', async () => {
    vi.useFakeTimers();
    const fetchNext = vi.fn((): Promise<number> => Promise.reject(new Error('down')));
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) =>
        usePolledResource<number>({ initial: 0, resetKey: key, fetchNext }),
      { initialProps: { key: 'a' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.reconnecting).toBe(true);

    // The new key starts with a clean slate: no stale reconnect badge from
    // the old key's outage, and no immediate poll (the fresh `initial` is
    // trusted for one full interval, same as a first mount).
    rerender({ key: 'b' });
    expect(result.current.reconnecting).toBe(false);
    const calls = fetchNext.mock.calls.length;
    await act(async () => {});
    expect(fetchNext.mock.calls.length).toBe(calls);
  });
});
