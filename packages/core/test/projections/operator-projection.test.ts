import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  projectOperator,
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

function healthSample(
  metric: string,
  value: number,
  status: 'ok' | 'degraded' | 'down',
  unit?: string,
): AppendableEvent {
  return {
    runId: RUN,
    type: 'operator.health_sample',
    actor: { kind: 'system', id: 'metrics' },
    subject: { kind: 'run', id: RUN },
    severity: 'info',
    payload: { metric, value, status, unit },
  };
}

async function buildOperatorRun(store: EventStore): Promise<void> {
  await append(
    store,
    {
      runId: RUN,
      type: 'run.created',
      actor: { kind: 'operator', id: 'op' },
      subject: { kind: 'run', id: RUN },
      severity: 'info',
      payload: { prompt: 'x' },
    },
    healthSample('cpu', 0.5, 'ok'),
    healthSample('cpu', 0.9, 'degraded'),
    healthSample('queue_wait', 12, 'ok', 'ms'),
    {
      runId: RUN,
      type: 'adapter.capacity_changed',
      actor: { kind: 'adapter', id: 'codex' },
      subject: { kind: 'adapter', id: 'codex' },
      severity: 'info',
      payload: { capacity: 3, previousCapacity: 10, reason: 'cpu pressure' },
    },
    {
      runId: RUN,
      type: 'sandbox.fallback',
      actor: { kind: 'sandbox', id: 'sbx' },
      subject: { kind: 'run', id: RUN },
      severity: 'warn',
      payload: { reason: 'docker unavailable', reducedTrust: true },
    },
    {
      runId: RUN,
      ticketId: 't-1',
      type: 'gate.failed',
      actor: { kind: 'gate', id: 'test' },
      subject: { kind: 'ticket', id: 't-1' },
      severity: 'error',
      payload: { gate: 'test', reason: 'flaky spec' },
    },
  );
}

describe('projectOperator', () => {
  it('reflects health/metric samples with a latest-by-metric view', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildOperatorRun(store);

    const projection = projectOperator(await store.readAll());
    expect(projection.health).toHaveLength(3);
    expect(projection.latestByMetric.cpu?.value).toBe(0.9);
    expect(projection.latestByMetric.cpu?.status).toBe('degraded');
    expect(projection.latestByMetric.queue_wait?.value).toBe(12);
    expect(projection.latestByMetric.queue_wait?.unit).toBe('ms');
  });

  it('reflects diagnostic events: capacity, fallback, and severity alerts', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildOperatorRun(store);

    const projection = projectOperator(await store.readAll());
    expect(projection.adapterCapacity).toBe(3);
    expect(projection.sandboxFallback).toBe(true);
    expect(projection.counts).toEqual({ warn: 1, error: 1, critical: 0 });

    expect(projection.alerts).toContainEqual(
      expect.objectContaining({
        type: 'sandbox.fallback',
        severity: 'warn',
        message: 'docker unavailable',
      }),
    );
    expect(projection.alerts).toContainEqual(
      expect.objectContaining({ type: 'gate.failed', severity: 'error', message: 'flaky spec' }),
    );
  });

  it('surfaces projection gaps as diagnostics', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildOperatorRun(store);
    const events = (await store.readAll()).filter((event) => event.sequence !== 3);

    const projection = projectOperator(events);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'sequence_gap', sequence: 3 }),
    );
  });

  it('is deterministic across replays', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildOperatorRun(store);
    const events = await store.readAll();
    expect(projectOperator(events)).toEqual(projectOperator(events));
  });
});
