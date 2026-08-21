/**
 * Ordered read helpers over an `EventStore`.
 *
 * Reads are defensively sorted by sequence, and `tail` supports incremental
 * consumption (e.g. SSE / CLI resume with a `last_sequence` cursor).
 */
import { compareEventsBySequence } from './event-types';
import type { FactoryEvent } from './event-types';
import type { EventStore } from './event-store';

export interface EventReader {
  /** All events for a run, ordered by sequence. */
  readRun(runId: string): Promise<FactoryEvent[]>;
  /** All events across every run, ordered by sequence. */
  readAll(): Promise<FactoryEvent[]>;
  /** The distinct run ids known to the store. */
  listRuns(): Promise<string[]>;
  /** Events for a run with `sequence` strictly greater than `afterSequence`. */
  tail(runId: string, afterSequence: number): Promise<FactoryEvent[]>;
}

export function createEventReader(store: EventStore): EventReader {
  return {
    async readRun(runId) {
      return (await store.readRun(runId)).sort(compareEventsBySequence);
    },
    async readAll() {
      return (await store.readAll()).sort(compareEventsBySequence);
    },
    listRuns() {
      return store.listRuns();
    },
    async tail(runId, afterSequence) {
      const events = await store.readRun(runId);
      return events.filter((event) => event.sequence > afterSequence).sort(compareEventsBySequence);
    },
  };
}
