/**
 * Shared client polling loop (U9).
 *
 * The live hooks (`use-run-aggregate`, `use-floor-status`,
 * `use-execution-overview`) share one polling contract (DESIGN.md §6): each
 * tick refetches projected state; a failed tick reports `ok: false` (the hook
 * flips `reconnecting` true and keeps the last good data on screen) and the
 * next successful tick recovers. `startPollLoop` owns the timer/cleanup
 * scaffolding; `usePolledResource` owns the shared React state pattern on top
 * of it, so each hook states only its per-tick fetch.
 */
import { useEffect, useRef, useState } from 'react';

/**
 * Start a self-rescheduling poll loop. `tick` performs one poll and throws on
 * failure; it receives `isActive` so it can skip state updates after cleanup
 * (an in-flight fetch that resolves post-unmount must not set state).
 * `onSettled(ok)` reports each completed tick while still active. Returns the
 * cleanup function for the owning effect.
 *
 * `immediateFirst` fires the first tick right away instead of waiting one
 * interval — used by the hooks' `refresh()` restarts so a successful command's
 * confirmation arrives within one round trip rather than lagging a full poll
 * interval. Ticks never overlap either way: the next tick is only scheduled
 * after the current one settles.
 */
export function startPollLoop(options: {
  readonly intervalMs: number;
  readonly immediateFirst?: boolean;
  readonly tick: (isActive: () => boolean) => Promise<void>;
  readonly onSettled: (ok: boolean) => void;
}): () => void {
  const { intervalMs, immediateFirst = false, tick, onSettled } = options;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll(): Promise<void> {
    try {
      await tick(() => active);
      if (active) {
        onSettled(true);
      }
    } catch {
      if (active) {
        onSettled(false);
      }
    } finally {
      if (active) {
        timer = setTimeout(() => void poll(), intervalMs);
      }
    }
  }

  if (immediateFirst) {
    void poll();
  } else {
    timer = setTimeout(() => void poll(), intervalMs);
  }
  return () => {
    active = false;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

/** The shared poll cadence for live run/intervention views. */
export const POLL_INTERVAL_MS = 1500;

/** A live polled snapshot: current data plus honest reconnect state. */
export interface PolledResource<T> {
  readonly data: T;
  /** True after a failed tick until the next success — never a frozen UI. */
  readonly reconnecting: boolean;
  /** Force an immediate re-poll (used after a mutation succeeds). */
  readonly refresh: () => void;
}

/**
 * The shared live-polling hook: seeds from server-rendered `initial`, waits a
 * full interval before the first fetch (the SSR payload is fresh — no
 * double-fetch on mount), then adopts each successful tick. `refresh()`
 * restarts the loop with an immediate first tick so a just-issued command's
 * confirmation arrives within one round trip.
 *
 * `fetchNext` receives the PREVIOUS committed value so cursor/accumulator
 * hooks (use-run-aggregate) can resume instead of refetching everything.
 * When `resetKey` changes across renders, state snaps back to the CURRENT
 * `initial` before the next poll — the run-identity reset: a reused instance
 * must never poll with the previous key's cursor or mix data across keys.
 * The reset happens during render (React's documented derived-state pattern);
 * the render restarts immediately with the reset values.
 */
export function usePolledResource<T>(options: {
  readonly initial: T;
  readonly fetchNext: (prev: T) => Promise<T>;
  readonly resetKey?: string;
}): PolledResource<T> {
  const { initial, fetchNext, resetKey } = options;
  const [data, setData] = useState<T>(initial);
  const [reconnecting, setReconnecting] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Latest committed value for the next tick's `prev` (ticks never overlap,
  // so this is always the value the previous successful tick committed) and
  // the latest fetchNext so the loop never restarts on a re-render.
  const latest = useRef<T>(initial);
  const fetchRef = useRef(fetchNext);
  fetchRef.current = fetchNext;

  const boundKey = useRef(resetKey);
  if (boundKey.current !== resetKey) {
    boundKey.current = resetKey;
    latest.current = initial;
    setData(initial);
    setReconnecting(false);
    setNonce(0);
  }

  useEffect(
    () =>
      startPollLoop({
        intervalMs: POLL_INTERVAL_MS,
        // A refresh() restart confirms a just-issued command: poll right away
        // instead of letting the confirmation lag one full poll interval.
        immediateFirst: nonce > 0,
        tick: async (isActive) => {
          const next = await fetchRef.current(latest.current);
          if (isActive()) {
            latest.current = next;
            setData(next);
          }
        },
        onSettled: (ok) => setReconnecting(!ok),
      }),
    [resetKey, nonce],
  );

  return { data, reconnecting, refresh: () => setNonce((n) => n + 1) };
}
