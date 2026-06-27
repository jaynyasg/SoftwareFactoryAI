import { describe, expect, it } from 'vitest';
import {
  computeOperatorMetrics,
  createInMemoryEventStore,
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

const RUN = 'run-metrics';

async function append(store: EventStore, ...events: AppendableEvent[]): Promise<void> {
  for (const event of events) {
    await store.append(event);
  }
}

function ev(
  type: AppendableEvent['type'],
  severity: AppendableEvent['severity'],
  payload: Record<string, unknown>,
  extras: { ticketId?: string; subjectKind?: string; subjectId?: string } = {},
): AppendableEvent {
  return {
    runId: RUN,
    type,
    actor: { kind: 'system', id: 'system' },
    subject: { kind: extras.subjectKind ?? 'run', id: extras.subjectId ?? RUN },
    severity,
    payload,
    ticketId: extras.ticketId,
  } as AppendableEvent;
}

function ticketExtras(id: string) {
  return { ticketId: id, subjectKind: 'ticket', subjectId: id };
}

async function buildRun(store: EventStore): Promise<void> {
  await append(
    store,
    ev('run.created', 'info', { prompt: 'x', requestedWorkerCap: 5 }),
    ev('adapter.setup_required', 'warn', { action: 'Authenticate the CLI' }),
    ev('adapter.auth_failed', 'error', { reason: 'not logged in' }),
    ev('adapter.selected', 'info', { adapterId: 'codex-cli', family: 'codex' }),
    ev('adapter.capacity_changed', 'warn', { capacity: 3, previousCapacity: 5, reason: 'cpu' }),
    ev('ticket.created', 'info', { title: 'T1', dependsOn: [] }, ticketExtras('t1')),
    ev('ticket.created', 'info', { title: 'T2', dependsOn: [] }, ticketExtras('t2')),
    ev('ticket.created', 'info', { title: 'T3', dependsOn: [] }, ticketExtras('t3')),
    ev('run.started', 'info', {}),
    ev('worker.started', 'info', { adapterId: 'codex-cli' }, ticketExtras('t1')),
    ev('sandbox.fallback', 'warn', { reason: 'docker down', reducedTrust: true }),
    ev('gate.started', 'info', { gate: 'unit-test' }, ticketExtras('t1')),
    ev('gate.failed', 'error', { gate: 'unit-test', reason: 'red' }, ticketExtras('t1')),
    ev('worker.retry', 'warn', { attempt: 1, reason: 'gate failed' }, ticketExtras('t1')),
    ev('gate.passed', 'success', { gate: 'unit-test' }, ticketExtras('t1')),
    ev('worker.started', 'info', { adapterId: 'codex-cli' }, ticketExtras('t3')),
    ev('worker.completed', 'success', { summary: 'done' }, ticketExtras('t3')),
    ev('operator.health_sample', 'info', { metric: 'queue_wait', value: 150, unit: 'ms', status: 'ok' }),
    ev('deploy.setup_required', 'warn', { action: 'connect github' }),
    ev('deploy.provider_failed', 'error', { reason: 'build failed' }),
    ev('deploy.health_pending', 'info', {}),
    ev('deploy.health_failed', 'error', { reason: '503' }),
    ev('deploy.health_pending', 'info', {}),
    ev('deploy.hosted_ready', 'success', { url: 'https://app.example.com' }),
  );
}

describe('computeOperatorMetrics', () => {
  it('derives worker capacity (active vs cap) with throttle', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const metrics = computeOperatorMetrics(await store.readAll());

    // t1 retrying (active), t2 created (queued), t3 completed (done).
    expect(metrics.workers.active).toBe(1);
    expect(metrics.workers.queued).toBe(1);
    expect(metrics.workers.requestedCap).toBe(5);
    expect(metrics.workers.adapterCapacity).toBe(3);
    expect(metrics.workers.effectiveCap).toBe(3);
    expect(metrics.workers.throttled).toBe(true);
  });

  it('derives adapter setup/auth/capacity occurrences and availability', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const metrics = computeOperatorMetrics(await store.readAll());

    expect(metrics.adapter.setupRequired).toBe(1);
    expect(metrics.adapter.authFailures).toBe(1);
    expect(metrics.adapter.errors).toBe(0);
    expect(metrics.adapter.available).toBe(false);
    expect(metrics.adapter.throttled).toBe(true);
    expect(metrics.adapter.capacity).toBe(3);
    expect(metrics.adapter.previousCapacity).toBe(5);
  });

  it('derives sandbox fallback, gate retries/failures, and queue wait', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const metrics = computeOperatorMetrics(await store.readAll());

    expect(metrics.sandbox.fallback).toBe(true);
    expect(metrics.gates.retries).toBe(1);
    expect(metrics.gates.failures).toBe(1);
    expect(metrics.gates.passed).toBe(1);
    expect(metrics.queue.waitMs).toBe(150);
  });

  it('derives deploy failure occurrences, folded phase, and hosted health (url only when ready)', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const metrics = computeOperatorMetrics(await store.readAll());

    expect(metrics.deploy.setupRequired).toBe(1);
    expect(metrics.deploy.providerFailed).toBe(1);
    expect(metrics.deploy.healthFailed).toBe(1);
    expect(metrics.deploy.configInvalid).toBe(0);
    expect(metrics.deploy.migrationFailed).toBe(0);
    expect(metrics.deploy.failures).toBe(2);
    expect(metrics.deploy.status).toBe('hosted_ready');
    expect(metrics.deploy.hostedUrl).toBe('https://app.example.com');
    expect(metrics.hostedHealth).toBe('ready');
  });

  it('computes event lag from a supplied clock and is zero when none given', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const events = await store.readAll();
    const last = events[events.length - 1].timestamp;

    const withClock = computeOperatorMetrics(events, { now: last + 5000 });
    expect(withClock.lag.eventLagMs).toBe(5000);
    expect(withClock.lag.lastEventTimestamp).toBe(last);

    const noClock = computeOperatorMetrics(events);
    expect(noClock.lag.eventLagMs).toBeUndefined();
  });

  it('reports projection lag for a log with a sequence gap', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const events = (await store.readAll()).filter((event) => event.sequence !== 5);

    const metrics = computeOperatorMetrics(events);
    expect(metrics.lag.sequenceGaps).toBeGreaterThanOrEqual(1);
    expect(metrics.lag.projectionLagEvents).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic across replays for a fixed clock', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildRun(store);
    const events = await store.readAll();
    expect(computeOperatorMetrics(events, { now: 1 })).toEqual(
      computeOperatorMetrics(events, { now: 1 }),
    );
  });
});
