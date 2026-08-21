import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  isKnowledgeEntryExpired,
  isKnowledgeEntryStale,
  projectKnowledgeIndex,
  queryKnowledge,
  type AppendableEvent,
  type EventStore,
  type KnowledgeEntryRecordedPayload,
} from '../../src/index';

const T0 = 1_700_000_000_000;

function deterministic() {
  let id = 0;
  let now = T0;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

async function append(store: EventStore, ...events: AppendableEvent[]): Promise<void> {
  for (const event of events) {
    await store.append(event);
  }
}

function recorded(
  runId: string,
  payload: KnowledgeEntryRecordedPayload,
  evidence?: AppendableEvent['evidence'],
): AppendableEvent {
  return {
    runId,
    type: 'knowledge.entry_recorded',
    actor: { kind: 'researcher', id: 'res-1' },
    subject: { kind: 'knowledge', id: payload.entryId },
    severity: 'info',
    evidence,
    payload,
  };
}

function redacted(runId: string, entryId: string, reason: string): AppendableEvent {
  return {
    runId,
    type: 'knowledge.entry_redacted',
    actor: { kind: 'operator', id: 'op-1' },
    subject: { kind: 'knowledge', id: entryId },
    severity: 'warn',
    payload: { entryId, reason },
  };
}

function retired(runId: string, entryId: string, reason?: string): AppendableEvent {
  return {
    runId,
    type: 'knowledge.entry_retired',
    actor: { kind: 'system', id: 'retention' },
    subject: { kind: 'knowledge', id: entryId },
    severity: 'info',
    payload: { entryId, reason },
  };
}

function entry(
  entryId: string,
  overrides: Partial<KnowledgeEntryRecordedPayload> = {},
): KnowledgeEntryRecordedPayload {
  return {
    entryId,
    kind: 'finding',
    title: `Title ${entryId}`,
    body: `Body of ${entryId}`,
    confidence: 0.8,
    sensitivity: 'internal',
    ...overrides,
  };
}

async function buildIndex(store: EventStore): Promise<void> {
  await append(
    store,
    recorded(
      'run-1',
      entry('k-source', {
        kind: 'source',
        title: 'Render background workers',
        body: 'Render supports background workers for long jobs',
        locator: 'https://render.com/docs/background-workers',
        confidence: 0.95,
        sensitivity: 'public',
        tags: ['deploy', 'render'],
        sourceEventIds: ['evt-research-9'],
        freshUntil: T0 + 30 * 86_400_000,
      }),
      [{ label: 'source', href: 'https://render.com/docs/background-workers' }],
    ),
    recorded(
      'run-1',
      entry('k-repo', {
        kind: 'repo_fact',
        title: 'Ledger is JSONL per run',
        body: 'Events persist as .factory/<runId>.jsonl',
        confidence: 0.9,
        tags: ['ledger'],
      }),
    ),
    recorded(
      'run-2',
      entry('k-lesson', {
        kind: 'gate_lesson',
        title: 'Secret scan gate redacts matches',
        body: 'Secret scan evidence never echoes full secrets',
        confidence: 0.7,
        tags: ['gates', 'security'],
        sourceRunId: 'run-2',
      }),
    ),
    recorded(
      'run-2',
      entry('k-run-ref', {
        kind: 'run_reference',
        title: 'Marketplace run completed',
        body: 'run-2 shipped the marketplace blueprint',
        confidence: 0.6,
      }),
    ),
  );
}

describe('projectKnowledgeIndex', () => {
  it('replays reusable entries from ledger evidence with E4 metadata intact', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildIndex(store);
    const index = projectKnowledgeIndex(await store.readAll());

    expect(index.entries).toHaveLength(4);
    const source = index.byId['k-source'];
    expect(source?.kind).toBe('source');
    expect(source?.locator).toBe('https://render.com/docs/background-workers');
    expect(source?.confidence).toBe(0.95);
    expect(source?.sensitivity).toBe('public');
    expect(source?.tags).toEqual(['deploy', 'render']);
    expect(source?.sourceEventIds).toEqual(['evt-research-9']);
    expect(source?.freshUntil).toBe(T0 + 30 * 86_400_000);
    expect(source?.recordedAt).toBeTypeOf('number');
    expect(source?.redacted).toBe(false);
    expect(source?.retired).toBe(false);
    expect(source?.evidence).toContainEqual({
      label: 'source',
      href: 'https://render.com/docs/background-workers',
    });
  });

  it('is cross-run by default and can scope to one run', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildIndex(store);
    const events = await store.readAll();

    const all = projectKnowledgeIndex(events);
    expect(new Set(all.entries.map((e) => e.runId))).toEqual(new Set(['run-1', 'run-2']));

    const run2 = projectKnowledgeIndex(events, { runId: 'run-2' });
    expect(run2.entries.map((e) => e.entryId).sort()).toEqual(['k-lesson', 'k-run-ref']);
  });

  it('is deterministic across replays and input orderings', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildIndex(store);
    const events = await store.readAll();

    expect(projectKnowledgeIndex(events)).toEqual(projectKnowledgeIndex(events));
    expect(projectKnowledgeIndex([...events].reverse())).toEqual(projectKnowledgeIndex(events));

    const other = createInMemoryEventStore(deterministic());
    await buildIndex(other);
    expect(projectKnowledgeIndex(await other.readAll())).toEqual(projectKnowledgeIndex(events));
  });

  it('marks entries redacted/retired and applies flags regardless of event order', async () => {
    const store = createInMemoryEventStore(deterministic());
    await buildIndex(store);
    await append(
      store,
      redacted('run-1', 'k-repo', 'contains internal paths'),
      retired('run-2', 'k-run-ref', 'superseded by run-3'),
    );
    const index = projectKnowledgeIndex(await store.readAll());
    expect(index.byId['k-repo']?.redacted).toBe(true);
    expect(index.byId['k-repo']?.redactionReason).toBe('contains internal paths');
    expect(index.byId['k-run-ref']?.retired).toBe(true);
    expect(index.byId['k-run-ref']?.retirementReason).toBe('superseded by run-3');

    // Sticky: a redaction observed before its record still redacts the entry.
    const outOfOrder = createInMemoryEventStore(deterministic());
    await append(
      outOfOrder,
      redacted('run-9', 'k-early', 'sensitive credentials mentioned'),
      recorded('run-9', entry('k-early', { sensitivity: 'internal' })),
    );
    const early = projectKnowledgeIndex(await outOfOrder.readAll());
    expect(early.byId['k-early']?.redacted).toBe(true);
    expect(early.byId['k-early']?.redactionReason).toBe('sensitive credentials mentioned');
  });

  it('does not invent an entry from a redaction or retirement alone', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(store, redacted('run-1', 'k-ghost', 'never recorded'));
    const index = projectKnowledgeIndex(await store.readAll());
    expect(index.entries).toEqual([]);
    expect(index.byId['k-ghost']).toBeUndefined();
  });
});

describe('queryKnowledge', () => {
  const NOW = T0 + 60 * 60 * 1000;

  async function builtIndex(extra: AppendableEvent[] = []) {
    const store = createInMemoryEventStore(deterministic());
    await buildIndex(store);
    await append(store, ...extra);
    return projectKnowledgeIndex(await store.readAll());
  }

  it('returns fresh, non-redacted entries ordered by confidence then recency', async () => {
    const index = await builtIndex();
    const matches = queryKnowledge(index, { now: NOW });
    expect(matches.map((m) => m.entry.entryId)).toEqual([
      'k-source',
      'k-repo',
      'k-lesson',
      'k-run-ref',
    ]);
    expect(matches.every((m) => m.stale === false)).toBe(true);
    expect(matches.every((m) => m.ageMs > 0)).toBe(true);
  });

  it('filters by kind, tags, text, minConfidence, and limit', async () => {
    const index = await builtIndex();

    expect(
      queryKnowledge(index, { now: NOW, kinds: ['gate_lesson'] }).map((m) => m.entry.entryId),
    ).toEqual(['k-lesson']);

    expect(
      queryKnowledge(index, { now: NOW, tags: ['ledger'] }).map((m) => m.entry.entryId),
    ).toEqual(['k-repo']);

    expect(
      queryKnowledge(index, { now: NOW, text: 'BACKGROUND workers' }).map((m) => m.entry.entryId),
    ).toEqual(['k-source']);

    expect(
      queryKnowledge(index, { now: NOW, minConfidence: 0.85 }).map((m) => m.entry.entryId),
    ).toEqual(['k-source', 'k-repo']);

    expect(queryKnowledge(index, { now: NOW, limit: 1 }).map((m) => m.entry.entryId)).toEqual([
      'k-source',
    ]);
  });

  it('never returns redacted entries through normal queries', async () => {
    const index = await builtIndex([redacted('run-1', 'k-repo', 'sensitive')]);
    const matches = queryKnowledge(index, {
      now: NOW,
      includeStale: true,
      includeSensitive: true,
    });
    expect(matches.map((m) => m.entry.entryId)).not.toContain('k-repo');
    // Still replayable for audit via the projection itself.
    expect(index.byId['k-repo']?.redacted).toBe(true);
  });

  it('never returns retired entries', async () => {
    const index = await builtIndex([retired('run-2', 'k-run-ref')]);
    const matches = queryKnowledge(index, { now: NOW, includeStale: true, includeSensitive: true });
    expect(matches.map((m) => m.entry.entryId)).not.toContain('k-run-ref');
  });

  it('excludes sensitive entries unless explicitly included', async () => {
    const index = await builtIndex([
      recorded(
        'run-3',
        entry('k-secretish', {
          kind: 'repo_fact',
          title: 'Internal auth flow',
          body: 'Details about internal token handling',
          sensitivity: 'sensitive',
          confidence: 0.99,
        }),
      ),
    ]);

    const normal = queryKnowledge(index, { now: NOW });
    expect(normal.map((m) => m.entry.entryId)).not.toContain('k-secretish');

    const privileged = queryKnowledge(index, { now: NOW, includeSensitive: true });
    expect(privileged.map((m) => m.entry.entryId)).toContain('k-secretish');
  });

  it('excludes stale entries by default and flags them when included', async () => {
    const index = await builtIndex([
      recorded(
        'run-3',
        entry('k-stale', {
          title: 'Old dependency versions',
          body: 'Captured six months ago',
          freshUntil: T0 + 1, // already stale at NOW
        }),
      ),
    ]);

    const normal = queryKnowledge(index, { now: NOW });
    expect(normal.map((m) => m.entry.entryId)).not.toContain('k-stale');

    const withStale = queryKnowledge(index, { now: NOW, includeStale: true });
    const stale = withStale.find((m) => m.entry.entryId === 'k-stale');
    expect(stale?.stale).toBe(true);
    expect(stale?.ageMs).toBeGreaterThan(0);
  });

  it('never returns retention-expired entries, even with every opt-in flag', async () => {
    const index = await builtIndex([
      recorded(
        'run-3',
        entry('k-expired', {
          title: 'Expired context',
          body: 'Retention has lapsed',
          retainUntil: T0 + 1, // already expired at NOW
        }),
      ),
    ]);
    const matches = queryKnowledge(index, {
      now: NOW,
      includeStale: true,
      includeSensitive: true,
    });
    expect(matches.map((m) => m.entry.entryId)).not.toContain('k-expired');
  });

  it('is pure and deterministic for a fixed evaluation time', async () => {
    const index = await builtIndex();
    expect(queryKnowledge(index, { now: NOW })).toEqual(queryKnowledge(index, { now: NOW }));
  });
});

describe('knowledge entry freshness/retention helpers', () => {
  it('computes staleness and expiry against a supplied clock', async () => {
    const store = createInMemoryEventStore(deterministic());
    await append(
      store,
      recorded('run-1', entry('k-1', { freshUntil: T0 + 100, retainUntil: T0 + 200 })),
    );
    const view = projectKnowledgeIndex(await store.readAll()).byId['k-1'];
    expect(view).toBeDefined();
    if (view === undefined) {
      return;
    }
    expect(isKnowledgeEntryStale(view, T0 + 50)).toBe(false);
    expect(isKnowledgeEntryStale(view, T0 + 100)).toBe(true);
    expect(isKnowledgeEntryExpired(view, T0 + 150)).toBe(false);
    expect(isKnowledgeEntryExpired(view, T0 + 200)).toBe(true);
  });
});
