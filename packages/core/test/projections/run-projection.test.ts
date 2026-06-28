import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  projectRun,
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
