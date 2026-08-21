/**
 * Ergonomic append helpers over an `EventStore`.
 *
 * The writer is a thin facade: it delegates sequencing, idempotency, and id /
 * timestamp assignment to the store. `forRun` binds a `runId` so callers (the
 * supervisor, worker runner, etc.) avoid repeating it on every append.
 */
import type { AppendableEvent } from './event-types';
import type { AppendResult, EventStore } from './event-store';

/** Distribute `Omit` across each member of a union (preserves discriminants). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An appendable event with `runId` supplied by the run-scoped writer. */
export type RunScopedInput = DistributiveOmit<AppendableEvent, 'runId'>;

export interface RunScopedWriter {
  readonly runId: string;
  append(event: RunScopedInput): Promise<AppendResult>;
}

export interface EventWriter {
  /** Append a fully-specified event. */
  append(event: AppendableEvent): Promise<AppendResult>;
  /** A writer bound to a single run. */
  forRun(runId: string): RunScopedWriter;
}

export function createEventWriter(store: EventStore): EventWriter {
  return {
    append(event) {
      return store.append(event);
    },
    forRun(runId) {
      return {
        runId,
        append(event) {
          return store.append({ ...event, runId } as AppendableEvent);
        },
      };
    },
  };
}
