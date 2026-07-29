import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  isRealRun,
  isVisibleRun,
  projectRun,
  resolveTargetRunId,
  type AppendableEvent,
  type EventStore,
} from '../../src/index';

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

const RUN = 'run-1';

async function append(store: EventStore, ...events: AppendableEvent[]): Promise<void> {
  for (const event of events) {
    await store.append(event);
  }
}

function lifecycle(type: AppendableEvent['type'], payload: unknown): AppendableEvent {
  return {
    runId: RUN,
    type,
    actor: { kind: 'system', id: 'sys' },
    subject: { kind: 'run', id: RUN },
    severity: 'info',
    payload,
  } as AppendableEvent;
}

function forRun(runId: string, type: AppendableEvent['type'], payload: unknown): AppendableEvent {
  return {
    runId,
    type,
    actor: { kind: 'operator', id: 'op' },
    subject: { kind: 'run', id: runId },
    severity: 'info',
    payload,
  } as AppendableEvent;
}

describe('projectRun', () => {
  it('returns an empty unknown projection for no events', () => {
    const projection = projectRun([]);
    expect(projection.runId).toBeNull();
    expect(projection.status).toBe('unknown');
    expect(projection.ledger).toEqual([]);
    expect(projection.lastSequence).toBe(0);
    expect(projection.diagnostics).toEqual([]);
  });

  it('captures run intake fields and the final lifecycle status', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', {
        prompt: 'build a marketplace',
        prdRef: 'docs/PRD.md',
        prdText: 'Marketplace PRD body',
        requestedWorkerCap: 7,
        reviewMode: 'autonomous',
      }),
      lifecycle('run.planned', { ticketCount: 5 }),
      lifecycle('run.started', {}),
      lifecycle('run.completed', { summary: 'green' }),
    );

    const projection = projectRun(await store.readAll());
    expect(projection.runId).toBe(RUN);
    expect(projection.status).toBe('completed');
    expect(projection.prompt).toBe('build a marketplace');
    expect(projection.prdRef).toBe('docs/PRD.md');
    expect(projection.prdText).toBe('Marketplace PRD body');
    expect(projection.requestedWorkerCap).toBe(7);
    expect(projection.reviewMode).toBe('autonomous');
    expect(projection.plannedTicketCount).toBe(5);
    expect(projection.startedAt).toBeTypeOf('number');
    expect(projection.completedAt).toBeTypeOf('number');
    expect(projection.lastSequence).toBe(4);
  });

  it('records a failure reason and failed status', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.failed', { reason: 'planner crashed' }),
    );

    const projection = projectRun(await store.readAll());
    expect(projection.status).toBe('failed');
    expect(projection.failureReason).toBe('planner crashed');
  });

  it('collects supervisor decisions with rationale and confidence', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(store, lifecycle('run.created', { prompt: 'x' }), {
      runId: RUN,
      type: 'supervisor.decision',
      actor: { kind: 'supervisor', id: 'sup' },
      subject: { kind: 'run', id: RUN },
      severity: 'info',
      payload: { decision: 'plan', rationale: 'known path', confidence: 0.9 },
    });

    const projection = projectRun(await store.readAll());
    expect(projection.supervisorDecisions).toEqual([
      { sequence: 2, decision: 'plan', rationale: 'known path', confidence: 0.9 },
    ]);
  });

  it('treats run.cancelled as TERMINAL: a later run.completed never flips the status back', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.started', {}),
      lifecycle('run.cancelled', { reason: 'operator stop' }),
      // e.g. a post-run gate stage finishing while the cancel landed.
      lifecycle('run.completed', { summary: 'late completion' }),
    );

    const projection = projectRun(await store.readAll());
    expect(projection.status).toBe('cancelled');
    expect(projection.executionState).toBe('cancelled');
    expect(projection.failureReason).toBe('operator stop');
  });

  it('treats run.cancelled as TERMINAL: a later run.started never revives the run', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.started', {}),
      lifecycle('run.cancelled', { reason: 'operator stop' }),
      // e.g. a duplicate daemon claim racing the cancel.
      lifecycle('run.started', {}),
    );

    const projection = projectRun(await store.readAll());
    expect(projection.status).toBe('cancelled');
    expect(projection.executionState).toBe('cancelled');
  });

  it('scopes to a single run when events span multiple runs', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(store, lifecycle('run.created', { prompt: 'a' }));
    await store.append({
      runId: 'run-2',
      type: 'run.created',
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'run', id: 'run-2' },
      severity: 'info',
      payload: { prompt: 'b' },
    });

    const projection = projectRun(await store.readAll(), 'run-2');
    expect(projection.runId).toBe('run-2');
    expect(projection.prompt).toBe('b');
    expect(projection.ledger.every((row) => row.runId === 'run-2')).toBe(true);
  });
});

describe('archive lifecycle (U1)', () => {
  it('archive then unarchive toggles visibility without touching status', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.completed', { summary: 'green' }),
      lifecycle('run.archived', { reason: 'new session' }),
    );

    const archived = projectRun(await store.readAll());
    expect(archived.status).toBe('completed');
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeTypeOf('number');
    expect(isRealRun(archived)).toBe(true);
    expect(isVisibleRun(archived)).toBe(false);

    await append(store, lifecycle('run.unarchived', {}));
    const restored = projectRun(await store.readAll());
    expect(restored.status).toBe('completed');
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeUndefined();
    expect(isVisibleRun(restored)).toBe(true);
  });

  it('re-archiving is idempotent and unarchiving a never-archived run is a no-op', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.archived', {}),
      lifecycle('run.archived', { reason: 'again' }),
    );

    const twice = projectRun(await store.readAll());
    expect(twice.archived).toBe(true);
    const firstArchiveAt = twice.archivedAt;

    // The FIRST archive's timestamp stands; the duplicate changes nothing.
    const events = await store.readAll();
    expect(projectRun(events).archivedAt).toBe(firstArchiveAt);
    expect(projectRun(events).diagnostics).toEqual([]);

    const fresh = createInMemoryEventStore(deterministic());
    await append(fresh, lifecycle('run.created', { prompt: 'y' }), lifecycle('run.unarchived', {}));
    const noop = projectRun(await fresh.readAll());
    expect(noop.archived).toBe(false);
    expect(noop.diagnostics).toEqual([]);
  });

  it('unarchive restores visibility only — cancelled stays terminal (R13)', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.started', {}),
      lifecycle('run.cancelled', { reason: 'new session' }),
      lifecycle('run.archived', {}),
      lifecycle('run.unarchived', {}),
    );

    const projection = projectRun(await store.readAll());
    expect(projection.archived).toBe(false);
    expect(projection.status).toBe('cancelled');
  });

  it('a late run.started after archive does not un-archive (mirror of terminal-cancel immunity)', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.archived', {}),
      lifecycle('run.started', {}),
    );

    const projection = projectRun(await store.readAll());
    expect(projection.archived).toBe(true);
  });

  it('archived runs replay identically: double projection is deep-equal with zero diagnostics (AE2)', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      lifecycle('run.created', { prompt: 'x' }),
      lifecycle('run.planned', { ticketCount: 2 }),
      lifecycle('run.completed', { summary: 'green' }),
      lifecycle('run.archived', { reason: 'session cleanup' }),
    );

    const events = await store.readAll();
    const first = projectRun(events);
    const second = projectRun(events);
    expect(second).toEqual(first);
    expect(first.diagnostics).toEqual([]);
    expect(first.archived).toBe(true);
  });

  it('resolveTargetRunId skips archived runs and picks the newest visible run', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      forRun('run-old', 'run.created', { prompt: 'old' }),
      forRun('run-newest', 'run.created', { prompt: 'newest' }),
      forRun('run-newest', 'run.archived', {}),
      forRun('run-mid', 'run.created', { prompt: 'mid' }),
    );
    // run-newest is newest by creation but archived; run-mid is the newest
    // VISIBLE run even though run-old's events sort first.
    const events = await store.readAll();
    expect(resolveTargetRunId(events)).toBe('run-mid');
    expect(resolveTargetRunId(events, 'run-newest')).toBe('run-newest');
  });

  it('falls back to the earliest event run when every run is archived (AE2 replay path)', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      forRun('run-solo', 'run.created', { prompt: 'solo' }),
      forRun('run-solo', 'run.archived', {}),
    );
    expect(resolveTargetRunId(await store.readAll())).toBe('run-solo');
  });

  it('factory-stream markers project cleanly and never look like runs', async () => {
    const store = createInMemoryEventStore(deterministic());
    await store.append({
      runId: 'factory',
      type: 'session.started',
      actor: { kind: 'operator', id: 'op' },
      subject: { kind: 'factory', id: 'session' },
      severity: 'info',
      payload: { archivedRunIds: ['run-1'], cancelledRunIds: [] },
    });
    await store.append({
      runId: 'factory',
      type: 'factory.reset_completed',
      actor: { kind: 'operator', id: 'op' },
      subject: { kind: 'factory', id: 'reset' },
      severity: 'info',
      payload: { resetGeneration: 1 },
    });

    const projection = projectRun(await store.readAll(), 'factory');
    // No run.created on the reserved stream: never a real (or visible) run.
    expect(isRealRun(projection)).toBe(false);
    expect(isVisibleRun(projection)).toBe(false);
    expect(projection.diagnostics).toEqual([]);
  });
});
