/**
 * startPollLoop unit tests (fake timers): the immediateFirst refresh path, the
 * default one-interval delay, failed-tick recovery, non-overlapping ticks, and
 * cleanup silencing in-flight work — the shared polling contract both live
 * hooks (`use-run-aggregate`, `use-intervention-queue`) rely on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPollLoop } from '../../src/lib/polling';

describe('startPollLoop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits one full interval before the first tick by default', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const stop = startPollLoop({
      intervalMs: 1000,
      tick: async () => {
        ticks += 1;
      },
      onSettled: () => {},
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ticks).toBe(1);
    stop();
  });

  it('immediateFirst fires the first tick right away, then keeps the cadence', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const settled: boolean[] = [];
    const stop = startPollLoop({
      intervalMs: 1000,
      immediateFirst: true,
      tick: async () => {
        ticks += 1;
      },
      onSettled: (ok) => settled.push(ok),
    });
    // No timer advance at all: the first tick has already fired.
    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toBe(1);
    expect(settled).toEqual([true]);
    // Self-rescheduling continues at the normal interval afterwards.
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(2);
    stop();
  });

  it('recovers from a failed tick: onSettled(false) then true on the next success', async () => {
    vi.useFakeTimers();
    let fail = true;
    const settled: boolean[] = [];
    const stop = startPollLoop({
      intervalMs: 1000,
      immediateFirst: true,
      tick: async () => {
        if (fail) {
          fail = false;
          throw new Error('network down');
        }
      },
      onSettled: (ok) => settled.push(ok),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual([false]);
    // A failed tick still reschedules — and the next success recovers.
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toEqual([false, true]);
    stop();
  });

  it('never overlaps ticks: the next tick is scheduled only after the current settles', async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxConcurrent = 0;
    let ticks = 0;
    const stop = startPollLoop({
      intervalMs: 100,
      immediateFirst: true,
      tick: async () => {
        ticks += 1;
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        // Slower than the interval — an interval-based loop would overlap.
        await new Promise((resolve) => setTimeout(resolve, 350));
        running -= 1;
      },
      onSettled: () => {},
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(maxConcurrent).toBe(1);
    expect(ticks).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('cleanup stops future ticks and mutes a tick that settles afterwards', async () => {
    vi.useFakeTimers();
    const settled: boolean[] = [];
    let ticks = 0;
    const stop = startPollLoop({
      intervalMs: 100,
      immediateFirst: true,
      tick: async () => {
        ticks += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
      },
      onSettled: (ok) => settled.push(ok),
    });
    await vi.advanceTimersByTimeAsync(50); // first tick is mid-flight
    expect(ticks).toBe(1);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    // The in-flight tick settled silently and nothing was rescheduled.
    expect(ticks).toBe(1);
    expect(settled).toEqual([]);
  });
});
