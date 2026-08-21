import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  projectResearch,
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

function research(type: AppendableEvent['type'], payload: unknown, runId = RUN): AppendableEvent {
  return {
    runId,
    type,
    actor: { kind: 'researcher', id: 'res-1' },
    subject: { kind: 'research', id: runId },
    severity: 'info',
    payload,
  } as AppendableEvent;
}

function runLifecycle(type: AppendableEvent['type'], payload: unknown): AppendableEvent {
  return {
    runId: RUN,
    type,
    actor: { kind: 'system', id: 'sys' },
    subject: { kind: 'run', id: RUN },
    severity: 'info',
    payload,
  } as AppendableEvent;
}

/** A full happy-path research pass: request -> sources -> findings/assumption/gap -> brief. */
async function buildHappyPath(store: EventStore): Promise<void> {
  await append(
    store,
    runLifecycle('run.created', { prompt: 'build a marketplace' }),
    research('research.requested', {
      objective: 'ground the marketplace build in real constraints',
      requestedSources: ['repo_scan', 'documentation'],
      budget: { maxSources: 5, maxDurationMs: 60_000 },
    }),
    research('research.source_found', {
      sourceId: 's-1',
      kind: 'documentation',
      title: 'Next.js maxDuration',
      locator: 'https://nextjs.org/docs/maxDuration',
      summary: 'Route handlers cap execution time',
    }),
    research('research.source_found', {
      sourceId: 's-2',
      kind: 'repo_scan',
      locator: 'packages/web/src/server',
      summary: 'Existing server layout',
    }),
    {
      ...research('research.source_read', {
        sourceId: 's-1',
        summary: 'maxDuration is deployment-controlled',
        contentDigest: 'sha256:abc',
      }),
      evidence: [{ label: 'fetched page', href: 'https://nextjs.org/docs/maxDuration' }],
    },
    {
      ...research('research.finding_recorded', {
        findingId: 'f-1',
        statement: 'Long builds must not be owned by request lifetimes',
        classification: 'verified_fact',
        confidence: 0.9,
        sourceIds: ['s-1'],
      }),
      evidence: [{ label: 'source excerpt', ref: 's-1#maxDuration' }],
    },
    research('research.assumption_recorded', {
      assumptionId: 'a-1',
      statement: 'Single-instance deployment is acceptable for V1.5',
      reason: 'No horizontal scaling requirement yet',
      sourceIds: ['s-2'],
    }),
    research('research.gap_recorded', {
      gapId: 'g-1',
      question: 'Which external search provider will be configured?',
      impact: 'Research breadth is limited to repo/PRD sources until configured',
      blocking: false,
    }),
    research('research.gap_recorded', {
      gapId: 'g-2',
      question: 'What is the deploy target region?',
    }),
    research('research.finding_recorded', {
      findingId: 'f-2',
      statement: 'Provider selection is configuration-dependent',
      classification: 'inference',
      resolvesGapId: 'g-1',
    }),
    {
      ...research('research.brief_completed', {
        summary: 'Enriched brief: constraints grounded, one open gap',
        briefRef: 'artifacts/brief.md',
      }),
      evidence: [{ label: 'brief', ref: 'artifacts/brief.md' }],
    },
  );
}

describe('projectResearch', () => {
  it('projects status none for an empty ledger (planning-only V1 compatibility)', () => {
    const projection = projectResearch([]);
    expect(projection.runId).toBeNull();
    expect(projection.status).toBe('none');
    expect(projection.sources).toEqual([]);
    expect(projection.findings).toEqual([]);
    expect(projection.assumptions).toEqual([]);
    expect(projection.gaps).toEqual([]);
    expect(projection.unresolvedGapCount).toBe(0);
    expect(projection.diagnostics).toEqual([]);
  });

  it('does not invent research state for a run without research events', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      runLifecycle('run.created', { prompt: 'x' }),
      runLifecycle('run.planned', { ticketCount: 2 }),
    );
    const projection = projectResearch(await store.readAll());
    expect(projection.runId).toBe(RUN);
    expect(projection.status).toBe('none');
    expect(projection.sourceCount).toBe(0);
    expect(projection.briefSummary).toBeUndefined();
  });

  it('folds a full research pass into a completed brief view', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildHappyPath(store);
    const projection = projectResearch(await store.readAll());

    expect(projection.status).toBe('completed');
    expect(projection.objective).toBe('ground the marketplace build in real constraints');
    expect(projection.requestedSources).toEqual(['repo_scan', 'documentation']);
    expect(projection.budget).toEqual({ maxSources: 5, maxDurationMs: 60_000 });
    expect(projection.requestedAt).toBeTypeOf('number');
    expect(projection.completedAt).toBeTypeOf('number');

    expect(projection.sourceCount).toBe(2);
    expect(projection.readSourceCount).toBe(1);
    expect(projection.findings).toHaveLength(2);
    expect(projection.assumptions).toHaveLength(1);
    expect(projection.gaps).toHaveLength(2);
    expect(projection.unresolvedGapCount).toBe(1);

    expect(projection.briefSummary).toBe('Enriched brief: constraints grounded, one open gap');
    expect(projection.briefRef).toBe('artifacts/brief.md');
    expect(projection.briefEvidence).toEqual([{ label: 'brief', ref: 'artifacts/brief.md' }]);
  });

  it('carries source summaries and evidence links through projection', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildHappyPath(store);
    const projection = projectResearch(await store.readAll());

    const s1 = projection.sources.find((s) => s.sourceId === 's-1');
    expect(s1?.kind).toBe('documentation');
    expect(s1?.title).toBe('Next.js maxDuration');
    expect(s1?.locator).toBe('https://nextjs.org/docs/maxDuration');
    // The read summary supersedes the found summary.
    expect(s1?.summary).toBe('maxDuration is deployment-controlled');
    expect(s1?.read).toBe(true);
    expect(s1?.contentDigest).toBe('sha256:abc');
    expect(s1?.evidence).toContainEqual({
      label: 'fetched page',
      href: 'https://nextjs.org/docs/maxDuration',
    });

    const f1 = projection.findings.find((f) => f.findingId === 'f-1');
    expect(f1?.classification).toBe('verified_fact');
    expect(f1?.confidence).toBe(0.9);
    expect(f1?.sourceIds).toEqual(['s-1']);
    expect(f1?.evidence).toContainEqual({ label: 'source excerpt', ref: 's-1#maxDuration' });
  });

  it('marks gaps resolved by findings and counts only unresolved gaps', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildHappyPath(store);
    const projection = projectResearch(await store.readAll());

    const resolved = projection.gaps.find((g) => g.gapId === 'g-1');
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolvedByFindingId).toBe('f-2');

    const open = projection.gaps.find((g) => g.gapId === 'g-2');
    expect(open?.resolved).toBe(false);
    expect(open?.blocking).toBe(false);
    expect(projection.unresolvedGapCount).toBe(1);
  });

  it('replays into the same projected brief on repeated projection (determinism)', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildHappyPath(store);
    const events = await store.readAll();

    expect(projectResearch(events)).toEqual(projectResearch(events));

    // Two independently built, identical logs project identically.
    const other = createInMemoryEventStore(deterministic());
    await buildHappyPath(other);
    expect(projectResearch(await other.readAll())).toEqual(projectResearch(events));

    // Input order does not matter: the fold sorts by sequence first.
    expect(projectResearch([...events].reverse())).toEqual(projectResearch(events));
  });

  it('keeps useful partial findings and gaps when research fails mid-stream', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      runLifecycle('run.created', { prompt: 'x' }),
      research('research.requested', { objective: 'scope the work' }),
      research('research.source_found', {
        sourceId: 's-1',
        kind: 'repo_scan',
        locator: 'packages/core',
      }),
      research('research.finding_recorded', {
        findingId: 'f-1',
        statement: 'Core already has an event ledger',
        classification: 'verified_fact',
        sourceIds: ['s-1'],
      }),
      research('research.gap_recorded', {
        gapId: 'g-1',
        question: 'No web search credentials configured',
        blocking: true,
      }),
      {
        ...research('research.failed', { reason: 'search provider credentials missing' }),
        severity: 'error',
      },
    );

    const projection = projectResearch(await store.readAll());
    expect(projection.status).toBe('failed');
    expect(projection.failureReason).toBe('search provider credentials missing');
    expect(projection.completedAt).toBeTypeOf('number');
    // Partial output survives the failure.
    expect(projection.findings).toHaveLength(1);
    expect(projection.gaps).toHaveLength(1);
    expect(projection.gaps[0]?.blocking).toBe(true);
    expect(projection.unresolvedGapCount).toBe(1);
    expect(projection.sourceCount).toBe(1);
    expect(projection.briefSummary).toBeUndefined();
  });

  it('tolerates unknown event order without inventing source metadata', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      runLifecycle('run.created', { prompt: 'x' }),
      // A read observed without (or before) its source_found event.
      research('research.source_read', { sourceId: 's-9', summary: 'read first' }),
      // A finding resolving a gap that is recorded later.
      research('research.finding_recorded', {
        findingId: 'f-1',
        statement: 'answer arrives before the question',
        classification: 'inference',
        resolvesGapId: 'g-late',
      }),
      research('research.gap_recorded', { gapId: 'g-late', question: 'late gap' }),
    );

    const projection = projectResearch(await store.readAll());
    const source = projection.sources.find((s) => s.sourceId === 's-9');
    expect(source?.read).toBe(true);
    expect(source?.kind).toBeUndefined(); // never invented
    expect(projection.status).toBe('in_progress');

    const gap = projection.gaps.find((g) => g.gapId === 'g-late');
    expect(gap?.resolved).toBe(true);
    expect(gap?.resolvedByFindingId).toBe('f-1');
    expect(projection.unresolvedGapCount).toBe(0);
  });

  it('keeps terminal status when stray progress events follow completion', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      runLifecycle('run.created', { prompt: 'x' }),
      research('research.requested', { objective: 'o' }),
      research('research.brief_completed', { summary: 'done' }),
      research('research.finding_recorded', {
        findingId: 'f-late',
        statement: 'late addendum',
        classification: 'inference',
      }),
    );

    const projection = projectResearch(await store.readAll());
    expect(projection.status).toBe('completed');
    expect(projection.findings).toHaveLength(1);
  });

  it('scopes to a single run when events span multiple runs', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      runLifecycle('run.created', { prompt: 'a' }),
      research('research.requested', { objective: 'run-1 objective' }),
      {
        runId: 'run-2',
        type: 'run.created',
        actor: { kind: 'system', id: 'sys' },
        subject: { kind: 'run', id: 'run-2' },
        severity: 'info',
        payload: { prompt: 'b' },
      },
      research('research.requested', { objective: 'run-2 objective' }, 'run-2'),
      research('research.brief_completed', { summary: 'run-2 brief' }, 'run-2'),
    );

    const projection = projectResearch(await store.readAll(), 'run-2');
    expect(projection.runId).toBe('run-2');
    expect(projection.objective).toBe('run-2 objective');
    expect(projection.status).toBe('completed');

    const first = projectResearch(await store.readAll(), RUN);
    expect(first.status).toBe('requested');
  });

  it('surfaces sequence gaps as diagnostics without throwing', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildHappyPath(store);
    const events = (await store.readAll()).filter((event) => event.sequence !== 3);

    const projection = projectResearch(events);
    expect(projection.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'sequence_gap', sequence: 3 }),
    );
    expect(projection.status).toBe('completed');
  });

  it('coexists with the run projection without disturbing run lifecycle state', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildHappyPath(store);
    await append(store, runLifecycle('run.planned', { ticketCount: 3 }));

    const events = await store.readAll();
    const run = projectRun(events);
    // Research events never change run lifecycle status.
    expect(run.status).toBe('planned');
    expect(run.plannedTicketCount).toBe(3);
    // But they are visible on the ledger with human-facing detail.
    const requestedRow = run.ledger.find((row) => row.type === 'research.requested');
    expect(requestedRow?.detail).toBe('ground the marketplace build in real constraints');
    const gapRow = run.ledger.find((row) => row.type === 'research.gap_recorded');
    expect(gapRow?.detail).toBeDefined();
  });
});
