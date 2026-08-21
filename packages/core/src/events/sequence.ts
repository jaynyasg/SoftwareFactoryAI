/**
 * Per-run monotonic sequence assignment.
 *
 * Each run gets its own strictly-increasing counter starting at 1. The
 * allocator can `observe` sequences loaded from a backing store so appends
 * continue correctly after a restart (high-water-mark continuation).
 */
export interface SequenceAllocator {
  /** Allocate and return the next sequence for a run (>= 1). */
  next(runId: string): number;
  /** Raise the high-water mark from an observed (e.g. persisted) sequence. */
  observe(runId: string, sequence: number): void;
  /** Current high-water mark for a run (0 when none seen). */
  peek(runId: string): number;
  /** Clear one run's counter, or all when no runId is given. */
  reset(runId?: string): void;
}

export function createSequenceAllocator(): SequenceAllocator {
  const highWater = new Map<string, number>();

  return {
    next(runId) {
      const nextSequence = (highWater.get(runId) ?? 0) + 1;
      highWater.set(runId, nextSequence);
      return nextSequence;
    },
    observe(runId, sequence) {
      if (!Number.isFinite(sequence)) {
        return;
      }
      if (sequence > (highWater.get(runId) ?? 0)) {
        highWater.set(runId, sequence);
      }
    },
    peek(runId) {
      return highWater.get(runId) ?? 0;
    },
    reset(runId) {
      if (runId === undefined) {
        highWater.clear();
      } else {
        highWater.delete(runId);
      }
    },
  };
}
