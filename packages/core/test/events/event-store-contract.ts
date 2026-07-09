/**
 * EventStore CONTRACT test suite (full-factory U11).
 *
 * This is the executable side of the database migration seam: any `EventStore`
 * implementation — the JSONL filesystem store, the in-memory test store, or a
 * future database-backed (e.g. Postgres) store — must pass this suite
 * UNCHANGED. It pins the store-level guarantees every projection, idempotency
 * check, and queue-lease fold in the system relies on:
 *
 *  - APPEND ATOMICITY / SEQUENCE MONOTONICITY: per-run sequences are strictly
 *    increasing from 1 and never shared between two events of the same run.
 *  - GLOBAL IDEMPOTENCY: appending a previously-seen `idempotencyKey` returns
 *    the ORIGINAL stored event (deduplicated), across runs.
 *  - PER-RUN ORDERING: `readRun` returns events ordered by sequence; `readAll`
 *    ordering is deterministic (sequence, then eventId).
 *  - RESTART/REPLAY (persistent stores): a new store instance over the same
 *    persisted state replays identical projections, continues sequences from
 *    the high-water mark, and keeps honoring idempotency keys.
 *
 * The suite is a plain helper (not a `.test.ts` file); concrete suites invoke
 * `describeEventStoreContract` once per implementation.
 */
import { describe, expect, it } from 'vitest';
import { projectRun } from '../../src/index';
import type { AppendableEvent, EventStore } from '../../src/index';

export interface EventStoreContractHarness {
  /** Human-readable implementation name, e.g. `filesystem (JSONL)`. */
  readonly name: string;
  /** Build a fresh, EMPTY store. Called once at the start of each test. */
  create(): Promise<EventStore> | EventStore;
  /**
   * Build a NEW store instance over the SAME persisted state as the last
   * `create()` — i.e. simulate a process restart. Omit for stores without
   * durable persistence (the in-memory store); the restart/replay section is
   * skipped for those.
   */
  reopen?(): Promise<EventStore> | EventStore;
}

function runCreated(runId: string, idempotencyKey?: string): AppendableEvent {
  return {
    runId,
    type: 'run.created',
    actor: { kind: 'operator', id: 'op-1' },
    subject: { kind: 'run', id: runId, version: 0 },
    severity: 'info',
    idempotencyKey,
    payload: { prompt: 'build a marketplace' },
  };
}

function runPlanned(runId: string): AppendableEvent {
  return {
    runId,
    type: 'run.planned',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'run', id: runId },
    severity: 'info',
    payload: { ticketCount: 2 },
  };
}

function runStarted(runId: string): AppendableEvent {
  return {
    runId,
    type: 'run.started',
    actor: { kind: 'system', id: 'daemon-a' },
    subject: { kind: 'run', id: runId },
    severity: 'info',
    idempotencyKey: `${runId}:run.started`,
    payload: {},
  };
}

function runCompleted(runId: string): AppendableEvent {
  return {
    runId,
    type: 'run.completed',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'run', id: runId },
    severity: 'success',
    payload: { summary: 'all green' },
  };
}

function workerProgress(runId: string, message: string): AppendableEvent {
  return {
    runId,
    ticketId: 't-1',
    type: 'worker.progress',
    actor: { kind: 'worker', id: 'w-1' },
    subject: { kind: 'ticket', id: 't-1' },
    severity: 'info',
    payload: { message },
  };
}

/** Register the contract suite for one `EventStore` implementation. */
export function describeEventStoreContract(harness: EventStoreContractHarness): void {
  describe(`EventStore contract — ${harness.name}`, () => {
    it('assigns strictly increasing per-run sequences starting at 1', async () => {
      const store = await harness.create();
      await store.append(runCreated('run-1'));
      await store.append(workerProgress('run-1', 'a'));
      await store.append(workerProgress('run-1', 'b'));

      const events = await store.readRun('run-1');
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(events.every((e) => typeof e.eventId === 'string' && e.eventId.length > 0)).toBe(true);
      expect(events.every((e) => e.version === 1)).toBe(true);
    });

    it('keeps sequence counters independent per run and lists distinct runs', async () => {
      const store = await harness.create();
      await store.append(runCreated('run-1'));
      await store.append(runCreated('run-2'));
      await store.append(workerProgress('run-2', 'x'));

      expect((await store.readRun('run-1')).map((e) => e.sequence)).toEqual([1]);
      expect((await store.readRun('run-2')).map((e) => e.sequence)).toEqual([1, 2]);
      expect((await store.listRuns()).sort()).toEqual(['run-1', 'run-2']);
    });

    it('returns the ORIGINAL stored event for a duplicate idempotency key', async () => {
      const store = await harness.create();
      const first = await store.append(runCreated('run-1', 'create-key'));
      const second = await store.append(runCreated('run-1', 'create-key'));

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.event.eventId).toBe(first.event.eventId);
      expect(second.event.sequence).toBe(first.event.sequence);
      expect(await store.readRun('run-1')).toHaveLength(1);
    });

    it('dedupes idempotency keys GLOBALLY across runs', async () => {
      const store = await harness.create();
      const first = await store.append(runCreated('run-1', 'global-key'));
      // A retry that would otherwise mint a fresh run id is still caught.
      const second = await store.append(runCreated('run-2', 'global-key'));

      expect(second.deduplicated).toBe(true);
      expect(second.event.runId).toBe('run-1');
      expect(second.event.eventId).toBe(first.event.eventId);
      expect(await store.listRuns()).toEqual(['run-1']);
    });

    it('always appends events WITHOUT an idempotency key (heartbeat-style)', async () => {
      const store = await harness.create();
      await store.append(runCreated('run-1'));
      await store.append(workerProgress('run-1', 'same message'));
      await store.append(workerProgress('run-1', 'same message'));

      // Identical payloads are still distinct events: only keys dedupe.
      expect(await store.readRun('run-1')).toHaveLength(3);
    });

    it('reads runs ordered by sequence and readAll deterministically', async () => {
      const store = await harness.create();
      await store.append(runCreated('run-1'));
      await store.append(runCreated('run-2'));
      await store.append(workerProgress('run-1', 'a'));
      await store.append(workerProgress('run-2', 'b'));

      const run1 = await store.readRun('run-1');
      expect(run1.map((e) => e.sequence)).toEqual([1, 2]);

      const all = await store.readAll();
      expect(all).toHaveLength(4);
      // readAll ordering must be deterministic: non-decreasing by sequence.
      const sequences = all.map((e) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      // Reading twice yields the identical ordering (stable tie-break).
      expect(await store.readAll()).toEqual(all);
    });

    it('rejects malformed append input', async () => {
      const store = await harness.create();
      const bad = { type: 'run.created', payload: {} } as unknown as AppendableEvent;
      await expect(store.append(bad)).rejects.toBeInstanceOf(TypeError);
    });

    // ------------------------------------------------------------------------
    // Restart/replay — persistent stores only (U11: single-instance cloud
    // restart must replay planned/active/completed state from storage alone).
    // ------------------------------------------------------------------------
    const persistent = harness.reopen !== undefined;
    const itPersistent = persistent ? it : it.skip;

    itPersistent(
      'a restart replays planned, active, and completed run state identically',
      async () => {
        const store = await harness.create();
        // Three runs frozen mid-lifecycle, like a cloud instance at redeploy.
        await store.append(runCreated('run-planned'));
        await store.append(runPlanned('run-planned'));
        await store.append(runCreated('run-active'));
        await store.append(runPlanned('run-active'));
        await store.append(runStarted('run-active'));
        await store.append(runCreated('run-done'));
        await store.append(runPlanned('run-done'));
        await store.append(runStarted('run-done'));
        await store.append(runCompleted('run-done'));

        const before = {
          planned: projectRun(await store.readRun('run-planned'), 'run-planned'),
          active: projectRun(await store.readRun('run-active'), 'run-active'),
          done: projectRun(await store.readRun('run-done'), 'run-done'),
        };

        // "Restart": a brand-new store instance over the same persisted state.
        const restarted = await harness.reopen!();
        const after = {
          planned: projectRun(await restarted.readRun('run-planned'), 'run-planned'),
          active: projectRun(await restarted.readRun('run-active'), 'run-active'),
          done: projectRun(await restarted.readRun('run-done'), 'run-done'),
        };

        expect(after.planned.status).toBe('planned');
        expect(after.active.status).toBe('running');
        expect(after.done.status).toBe('completed');
        // Replay is exact: the restart invents or loses nothing.
        expect(after).toEqual(before);
        expect((await restarted.listRuns()).sort()).toEqual([
          'run-active',
          'run-done',
          'run-planned',
        ]);
      },
    );

    itPersistent('a restart continues sequences from the high-water mark', async () => {
      const store = await harness.create();
      await store.append(runCreated('run-1'));
      await store.append(workerProgress('run-1', 'a'));

      const restarted = await harness.reopen!();
      await restarted.append(workerProgress('run-1', 'b'));
      expect((await restarted.readRun('run-1')).map((e) => e.sequence)).toEqual([1, 2, 3]);
    });

    itPersistent('idempotency keys keep deduplicating across a restart', async () => {
      const store = await harness.create();
      const first = await store.append(runCreated('run-1', 'restart-key'));

      const restarted = await harness.reopen!();
      const dup = await restarted.append(runCreated('run-1', 'restart-key'));
      expect(dup.deduplicated).toBe(true);
      expect(dup.event.eventId).toBe(first.event.eventId);
      expect(
        (await restarted.readRun('run-1')).filter((e) => e.type === 'run.created'),
      ).toHaveLength(1);
    });
  });
}
