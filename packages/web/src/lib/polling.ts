/**
 * Shared client polling loop (U9).
 *
 * `use-run-aggregate` and `use-intervention-queue` share one polling contract
 * (DESIGN.md §6): each tick refetches projected state; a failed tick reports
 * `ok: false` (the hook flips `reconnecting` true and keeps the last good data
 * on screen) and the next successful tick recovers. This helper owns the
 * timer/cleanup scaffolding so both hooks state only their per-tick work.
 */

/**
 * Start a self-rescheduling poll loop. `tick` performs one poll and throws on
 * failure; it receives `isActive` so it can skip state updates after cleanup
 * (an in-flight fetch that resolves post-unmount must not set state).
 * `onSettled(ok)` reports each completed tick while still active. Returns the
 * cleanup function for the owning effect.
 */
export function startPollLoop(options: {
  readonly intervalMs: number;
  readonly tick: (isActive: () => boolean) => Promise<void>;
  readonly onSettled: (ok: boolean) => void;
}): () => void {
  const { intervalMs, tick, onSettled } = options;
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

  timer = setTimeout(() => void poll(), intervalMs);
  return () => {
    active = false;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
}

/** The shared poll cadence for live run/intervention views. */
export const POLL_INTERVAL_MS = 1500;
