import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  projectArtifacts,
  projectOperator,
  projectRun,
  projectTickets,
  type AppendableEvent,
  type EventStore,
  type FactoryEvent,
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

const SCRIPT: AppendableEvent[] = [
  {
    runId: RUN,
    type: 'run.created',
    actor: { kind: 'operator', id: 'op' },
    subject: { kind: 'run', id: RUN, version: 0 },
    severity: 'info',
    payload: { prompt: 'build it', requestedWorkerCap: 4, reviewMode: 'human' },
  },
  {
    runId: RUN,
    type: 'run.planned',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'run', id: RUN },
    severity: 'info',
    payload: { ticketCount: 2 },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'ticket.created',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'ticket', id: 't-1' },
    severity: 'info',
    payload: { title: 'scaffold', riskTier: 'low', dependsOn: [] },
  },
  {
    runId: RUN,
    ticketId: 't-2',
    type: 'ticket.created',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'ticket', id: 't-2' },
    severity: 'info',
    payload: { title: 'data model', riskTier: 'medium', dependsOn: ['t-1'] },
  },
  {
    runId: RUN,
    type: 'supervisor.decision',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'run', id: RUN },
    severity: 'info',
    payload: { decision: 'plan-marketplace', rationale: 'known path', confidence: 0.82 },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'worker.started',
    actor: { kind: 'worker', id: 'w-1' },
    subject: { kind: 'ticket', id: 't-1' },
    severity: 'info',
    payload: { adapterId: 'codex-cli' },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'gate.failed',
    actor: { kind: 'gate', id: 'lint' },
    subject: { kind: 'ticket', id: 't-1' },
    severity: 'error',
    evidence: [{ label: 'lint.log', href: 'file:///lint.log' }],
    payload: { gate: 'lint', reason: 'unused var' },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'worker.retry',
    actor: { kind: 'worker', id: 'w-1' },
    subject: { kind: 'ticket', id: 't-1' },
    severity: 'warn',
    payload: { attempt: 2, reason: 'gate failed' },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'worker.completed',
    actor: { kind: 'worker', id: 'w-1' },
    subject: { kind: 'ticket', id: 't-1' },
    severity: 'success',
    payload: { summary: 'done' },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'artifact.created',
    actor: { kind: 'worker', id: 'w-1' },
    subject: { kind: 'artifact', id: 'a-1' },
    severity: 'info',
    payload: { artifactId: 'a-1', kind: 'repo', path: 'out/app' },
  },
  {
    runId: RUN,
    ticketId: 't-1',
    type: 'artifact.confidence_computed',
    actor: { kind: 'system', id: 'conf' },
    subject: { kind: 'artifact', id: 'a-1' },
    severity: 'info',
    payload: { artifactId: 'a-1', confidence: 0.7, factors: { gates: 0.5, provenance: 1 } },
  },
  {
    runId: RUN,
    type: 'operator.health_sample',
    actor: { kind: 'system', id: 'metrics' },
    subject: { kind: 'run', id: RUN },
    severity: 'info',
    payload: { metric: 'worker_capacity', value: 4, status: 'ok' },
  },
  {
    runId: RUN,
    type: 'run.completed',
    actor: { kind: 'supervisor', id: 'sup' },
    subject: { kind: 'run', id: RUN },
    severity: 'success',
    payload: { summary: 'all green' },
  },
];

async function loadScript(store: EventStore): Promise<FactoryEvent[]> {
  for (const event of SCRIPT) {
    await store.append(event);
  }
  return store.readAll();
}

describe('replay projections', () => {
  it('produces identical projections when the same log is replayed twice', async () => {
    const events = await loadScript(createInMemoryEventStore(deterministic()));

    expect(projectRun(events)).toEqual(projectRun(events));
    expect(projectTickets(events)).toEqual(projectTickets(events));
    expect(projectArtifacts(events)).toEqual(projectArtifacts(events));
    expect(projectOperator(events)).toEqual(projectOperator(events));
  });

  it('produces identical projections from two independently built logs', async () => {
    const a = await loadScript(createInMemoryEventStore(deterministic()));
    const b = await loadScript(createInMemoryEventStore(deterministic()));
    expect(projectRun(a)).toEqual(projectRun(b));
    expect(projectTickets(a)).toEqual(projectTickets(b));
  });

  it('sorts out-of-order reads by sequence before projecting', async () => {
    const events = await loadScript(createInMemoryEventStore(deterministic()));
    const shuffled = [...events].reverse();

    const projection = projectRun(shuffled);
    const sequences = projection.ledger.map((row) => row.sequence);
    expect(sequences).toEqual([...sequences].sort((x, y) => x - y));
    // Lifecycle is resolved by sequence, not input order.
    expect(projection.status).toBe('completed');
  });

  it('surfaces a diagnostic for a missing sequence (gap) without throwing', async () => {
    const events = await loadScript(createInMemoryEventStore(deterministic()));
    const withGap = events.filter((event) => event.sequence !== 3);

    const projection = projectRun(withGap);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'sequence_gap', sequence: 3, runId: RUN }),
    );
    // Valid events still project.
    expect(projection.status).toBe('completed');
  });

  it('surfaces diagnostics for corrupt and unknown events without throwing', async () => {
    const events = await loadScript(createInMemoryEventStore(deterministic()));
    const polluted: unknown[] = [
      ...events,
      { not: 'an event' },
      {
        version: 1,
        eventId: 'x-1',
        runId: RUN,
        type: 'mystery.event',
        sequence: 999,
        timestamp: 1,
        severity: 'info',
        actor: { kind: 'system', id: 's' },
        subject: { kind: 'run', id: RUN },
        payload: {},
      },
    ];

    const projection = projectRun(polluted);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'corrupt_event' }),
    );
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'unknown_event_type', detail: 'mystery.event' }),
    );
    expect(projection.status).toBe('completed');
  });

  it('flows severity and evidence through into ledger rows', async () => {
    const events = await loadScript(createInMemoryEventStore(deterministic()));
    const projection = projectRun(events);

    const gateRow = projection.ledger.find((row) => row.type === 'gate.failed');
    expect(gateRow?.severity).toBe('error');
    expect(gateRow?.evidence?.[0]?.label).toBe('lint.log');
    expect(gateRow?.detail).toBe('unused var');
  });

  it('reflects folded ticket and artifact state', async () => {
    const events = await loadScript(createInMemoryEventStore(deterministic()));

    const tickets = projectTickets(events);
    expect(tickets.byId['t-1']?.state).toBe('completed');
    expect(tickets.byId['t-1']?.attempts).toBe(2);
    expect(tickets.byId['t-2']?.state).toBe('created');
    expect(tickets.byId['t-2']?.dependsOn).toEqual(['t-1']);

    const artifacts = projectArtifacts(events);
    expect(artifacts.byId['a-1']?.kind).toBe('repo');
    expect(artifacts.byId['a-1']?.confidence).toBe(0.7);
    expect(artifacts.byId['a-1']?.confidenceFactors).toEqual({ gates: 0.5, provenance: 1 });
  });
});
