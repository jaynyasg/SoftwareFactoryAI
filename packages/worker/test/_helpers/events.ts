/**
 * Shared ledger-event test helpers for worker suites.
 *
 * `deterministic()` supplies the id/clock pair the in-memory event store needs
 * for replayable sequences; `runEventAppender(runId)` builds the minimal-event
 * `append` helper the U8 packaging/provenance/deploy suites use to seed a
 * run's ledger — each suite states only the type/payload its assertions
 * depend on.
 */
import type { AppendableEvent, EventStore } from '@software-factory/core';

/** Deterministic id generator + clock for `createInMemoryEventStore`. */
export function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return { idGenerator: () => `evt-${(id += 1)}`, clock: () => (now += 1000) };
}

/** One seeded ledger event: type + payload required, envelope defaulted. */
export type SeedEvent = Partial<AppendableEvent> & Pick<AppendableEvent, 'type' | 'payload'>;

/**
 * Build an `append(store, partial)` helper bound to one run id: fills the
 * actor/subject/severity envelope so tests state only what they assert on.
 */
export function runEventAppender(
  runId: string,
): (store: EventStore, partial: SeedEvent) => Promise<void> {
  return async (store: EventStore, partial: SeedEvent): Promise<void> => {
    await store.append({
      runId,
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'run', id: runId },
      severity: 'info',
      ...partial,
    } as AppendableEvent);
  };
}
