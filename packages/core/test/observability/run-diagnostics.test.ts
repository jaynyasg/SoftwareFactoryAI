import { describe, expect, it } from 'vitest';
import {
  FAILURE_REGISTRY,
  computeRunDiagnostics,
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

const RUN = 'run-diag';

async function append(store: EventStore, ...events: AppendableEvent[]): Promise<void> {
  for (const event of events) {
    await store.append(event);
  }
}

function ev(
  type: AppendableEvent['type'],
  severity: AppendableEvent['severity'],
  payload: Record<string, unknown>,
  ticketId?: string,
): AppendableEvent {
  return {
    runId: RUN,
    type,
    actor: { kind: 'system', id: 'system' },
    subject: ticketId ? { kind: 'ticket', id: ticketId } : { kind: 'run', id: RUN },
    severity,
    payload,
    ticketId,
  } as AppendableEvent;
}

describe('computeRunDiagnostics — recovery + reduced trust', () => {
  it('excludes resolved failures and keeps the reduced-trust fallback active', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      ev('run.created', 'info', { prompt: 'x' }),
      ev('ticket.created', 'info', { title: 'A', dependsOn: [] }, 'a'),
      ev('run.started', 'info', {}),
      ev('worker.started', 'info', {}, 'a'),
      ev('sandbox.fallback', 'warn', { reason: 'docker down', reducedTrust: true }),
      ev('gate.failed', 'error', { gate: 'unit-test', reason: 'red' }, 'a'),
      ev('worker.retry', 'warn', { attempt: 1, reason: 'gate failed' }, 'a'),
      ev('gate.passed', 'success', { gate: 'unit-test' }, 'a'),
      ev('worker.completed', 'success', { summary: 'ok' }, 'a'),
      ev('run.completed', 'success', { summary: 'done' }),
    );

    const report = computeRunDiagnostics(await store.readAll());
    const activeTypes = report.activeFailures.map((failure) => failure.type);

    expect(activeTypes).toContain('sandbox.fallback');
    expect(activeTypes).not.toContain('gate.failed');
    expect(activeTypes).not.toContain('worker.retry');
    expect(report.blockingFailures).toHaveLength(0);
    expect(report.reducedTrust).toBe(true);
    expect(report.projectionDiagnostics).toHaveLength(0);
    expect(report.stalled).toBe(false);
    expect(report.healthy).toBe(true);
  });

  it('joins active failures to their failure-registry rescue action', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      ev('run.created', 'info', { prompt: 'x' }),
      ev('run.started', 'info', {}),
      ev('sandbox.fallback', 'warn', { reason: 'docker down', reducedTrust: true }),
    );
    const report = computeRunDiagnostics(await store.readAll());
    const fallback = report.activeFailures.find((failure) => failure.type === 'sandbox.fallback');
    expect(fallback).toBeDefined();
    expect(fallback?.rescueAction).toBe(FAILURE_REGISTRY['sandbox.fallback'].rescueAction);
    expect(fallback?.blocking).toBe(false);
    expect(fallback?.runbook).toContain('failure-taxonomy.md');
  });
});

describe('computeRunDiagnostics — blocked dependency + stall', () => {
  it('flags tickets blocked by a failed dependency and detects the stall', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      ev('run.created', 'info', { prompt: 'x' }),
      ev('ticket.created', 'info', { title: 'A', dependsOn: [] }, 'a'),
      ev('ticket.created', 'info', { title: 'B', dependsOn: ['a'] }, 'b'),
      ev('run.started', 'info', {}),
      ev('worker.started', 'info', {}, 'a'),
      ev('worker.failed', 'error', { reason: 'boom' }, 'a'),
      ev('ticket.dead_lettered', 'error', { reason: 'retry budget exhausted' }, 'a'),
    );

    const report = computeRunDiagnostics(await store.readAll());

    expect(report.blockedByFailedDependency).toEqual([
      { ticketId: 'b', state: 'created', blockedBy: ['a'] },
    ]);
    const activeTypes = report.activeFailures.map((failure) => failure.type);
    expect(activeTypes).toContain('ticket.dead_lettered');
    expect(report.blockingFailures.length).toBeGreaterThan(0);
    expect(report.stalled).toBe(true);
    expect(report.stallReason).toMatch(/blocked by a failed dependency/i);
    expect(report.healthy).toBe(false);
  });
});

describe('computeRunDiagnostics — projection integrity', () => {
  it('surfaces a sequence gap as a projection diagnostic and marks unhealthy', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      ev('run.created', 'info', { prompt: 'x' }),
      ev('run.started', 'info', {}),
      ev('run.completed', 'success', { summary: 'done' }),
    );
    const events = (await store.readAll()).filter((event) => event.sequence !== 2);

    const report = computeRunDiagnostics(events);
    expect(report.projectionDiagnostics.some((diag) => diag.code === 'sequence_gap')).toBe(true);
    expect(report.healthy).toBe(false);
  });
});
