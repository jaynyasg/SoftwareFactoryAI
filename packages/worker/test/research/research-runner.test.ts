/**
 * Bounded research runner (full-factory U2) — budgets, fail-closed credential
 * handling, source policy, redaction, prior-knowledge seeding, determinism,
 * and partial-failure behavior, all through the REAL event store + the U1
 * research/knowledge projections.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  projectKnowledgeIndex,
  projectResearch,
} from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import { runResearch } from '../../src/index';
import type { ResearchRunContext, ResearchRunResult } from '../../src/index';
import {
  createFakeAdapter,
  scriptedSource,
  steppingClock,
  steppingIds,
} from '../_helpers/research';

const CONTEXT: ResearchRunContext = {
  runId: 'run-1',
  objective: 'Understand the marketplace build request',
};

function makeStore(): EventStore {
  return createInMemoryEventStore({ clock: steppingClock(), idGenerator: steppingIds() });
}

function types(events: readonly FactoryEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('runResearch — budgets', () => {
  it('respects the max-sources budget and records an explicit gap', async () => {
    const store = makeStore();
    const adapter = createFakeAdapter({
      kind: 'model_synthesis',
      sources: [
        scriptedSource('s1', 'model_synthesis', 'fact one'),
        scriptedSource('s2', 'model_synthesis', 'fact two'),
        scriptedSource('s3', 'model_synthesis', 'fact three'),
        scriptedSource('s4', 'model_synthesis', 'fact four'),
      ],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [adapter],
      budget: { maxSources: 2 },
      clock: steppingClock(),
    });

    expect(result.status).toBe('completed');
    expect(result.sourcesRead).toBe(2);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.status).toBe('completed');
    expect(research.readSourceCount).toBe(2);
    const budgetGap = research.gaps.find((gap) => gap.gapId === 'g-budget-max_sources');
    expect(budgetGap).toBeDefined();
    expect(budgetGap?.question).toMatch(/budget exhausted/i);
    expect(budgetGap?.resolved).toBe(false);
    expect(result.budgetStops).toHaveLength(1);
  });

  it('respects the elapsed-time budget', async () => {
    const store = makeStore();
    const adapter = createFakeAdapter({
      kind: 'model_synthesis',
      sources: [
        scriptedSource('s1', 'model_synthesis', 'fact one'),
        scriptedSource('s2', 'model_synthesis', 'fact two'),
        scriptedSource('s3', 'model_synthesis', 'fact three'),
      ],
    });

    // Every clock() call advances 1000ms, so a 4s budget trips mid-pass.
    const result = await runResearch(CONTEXT, {
      store,
      adapters: [adapter],
      budget: { maxDurationMs: 4000 },
      clock: steppingClock(1_700_000_000_000, 1000),
    });

    expect(result.status).toBe('completed');
    expect(result.sourcesRead).toBeLessThan(3);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.gaps.some((gap) => gap.gapId === 'g-budget-max_duration')).toBe(true);
  });

  it('respects per-source-class budgets without stopping other classes', async () => {
    const store = makeStore();
    const synth = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [
        scriptedSource('m1', 'model_synthesis', 'synth one'),
        scriptedSource('m2', 'model_synthesis', 'synth two'),
      ],
    });
    const other = createFakeAdapter({
      id: 'other',
      kind: 'other',
      sources: [scriptedSource('o1', 'other', 'other one')],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [synth, other],
      budget: { maxSources: 10, maxSourcesPerKind: { model_synthesis: 1 } },
      clock: steppingClock(),
    });

    expect(result.sourcesRead).toBe(2); // 1 synth (capped) + 1 other
    expect(synth.readCalls).toEqual(['m1']);
    expect(other.readCalls).toEqual(['o1']);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.gaps.some((gap) => gap.gapId === 'g-budget-max_sources_per_kind')).toBe(true);
  });
});

describe('runResearch — fail-closed credentials and setup', () => {
  it('emits setup-required + gap for missing provider credentials, never fabricated findings', async () => {
    const store = makeStore();
    const search = createFakeAdapter({
      id: 'web-search',
      kind: 'web_search',
      setup: {
        configured: true,
        requiresCredentials: true,
        credentialsPresent: false,
        detail: 'SF_RESEARCH_SEARCH_API_KEY is not set.',
        setupAction: { id: 'research.search', title: 'Configure a web-search provider' },
      },
      sources: [scriptedSource('w1', 'web_search', 'would be fabricated')],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [search],
      policy: { allowNetwork: true },
      clock: steppingClock(),
    });

    expect(result.status).toBe('completed');
    expect(result.findingCount).toBe(0);
    expect(search.discoverCalls).toBe(0); // fail closed: no fetch attempted
    expect(search.readCalls).toHaveLength(0);

    const events = await store.readRun('run-1');
    expect(types(events)).toContain('adapter.setup_required');
    const research = projectResearch(events, 'run-1');
    expect(research.findings).toHaveLength(0);
    const gap = research.gaps.find((entry) => entry.gapId === 'g-setup-web-search');
    expect(gap?.question).toMatch(/requires setup/i);
    // E5: the credential VALUE never appears anywhere on the ledger.
    expect(JSON.stringify(events)).not.toMatch(/sk-|api[_-]?key\s*[:=]/i);
  });

  it('records an unconfigured adapter as a setup gap and continues with others', async () => {
    const store = makeStore();
    const unconfigured = createFakeAdapter({
      id: 'local-folder',
      kind: 'local_folder',
      setup: { configured: false, detail: 'Local folders are not readable in cloud runtime.' },
    });
    const working = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [scriptedSource('m1', 'model_synthesis', 'real fact')],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [unconfigured, working],
      clock: steppingClock(),
    });

    expect(result.status).toBe('completed');
    expect(result.findingCount).toBe(1);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.gaps.some((gap) => gap.gapId === 'g-setup-local-folder')).toBe(true);
    expect(research.findings[0]?.statement).toBe('real fact');
  });
});

describe('runResearch — source policy', () => {
  it('refuses disallowed network classes BEFORE any adapter I/O and records a gap', async () => {
    const store = makeStore();
    const docs = createFakeAdapter({
      id: 'docs',
      kind: 'documentation',
      sources: [scriptedSource('d1', 'documentation', 'network fact')],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [docs],
      policy: { allowNetwork: false },
      clock: steppingClock(),
    });

    expect(result.status).toBe('completed');
    expect(docs.detectSetupCalls).toBe(0);
    expect(docs.discoverCalls).toBe(0);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.findings).toHaveLength(0);
    const gap = research.gaps.find((entry) => entry.gapId === 'g-policy-docs');
    expect(gap?.question).toMatch(/network access/i);
  });

  it('refuses source kinds outside the allow-list', async () => {
    const store = makeStore();
    const synth = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [scriptedSource('m1', 'model_synthesis', 'fact')],
    });

    await runResearch(CONTEXT, {
      store,
      adapters: [synth],
      policy: { allowedKinds: ['uploaded_prd'] },
      clock: steppingClock(),
    });

    expect(synth.discoverCalls).toBe(0);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.gaps.some((gap) => gap.gapId === 'g-policy-synth')).toBe(true);
  });

  it('redacts secret-shaped values from summaries, findings, and knowledge entries', async () => {
    const store = makeStore();
    const leaky = createFakeAdapter({
      id: 'leaky',
      kind: 'model_synthesis',
      sources: [
        {
          source: {
            sourceId: 'l1',
            kind: 'model_synthesis',
            title: 'config API_KEY=sk-abcdef1234567890',
            summary: 'uses TOKEN=super-secret-token-value',
          },
          result: {
            summary: 'found PASSWORD=hunter2hunter2 in config',
            contentDigest: 'digest-l1',
            findings: [
              {
                statement: 'The app reads OPENAI_API_KEY=sk-verysecretvalue123 at boot.',
                classification: 'verified_fact',
                confidence: 0.9,
                reusable: true,
              },
            ],
          },
        },
      ],
    });

    await runResearch(CONTEXT, { store, adapters: [leaky], clock: steppingClock() });

    const serialized = JSON.stringify(await store.readRun('run-1'));
    expect(serialized).not.toContain('sk-abcdef1234567890');
    expect(serialized).not.toContain('super-secret-token-value');
    expect(serialized).not.toContain('hunter2hunter2');
    expect(serialized).not.toContain('sk-verysecretvalue123');
    expect(serialized).toContain('[redacted]');

    const knowledge = projectKnowledgeIndex(await store.readRun('run-1'));
    expect(knowledge.entries).toHaveLength(1);
    expect(knowledge.entries[0]?.body).toContain('[redacted]');
  });
});

describe('runResearch — knowledge normalization', () => {
  it('normalizes reusable findings with confidence, freshness, sensitivity, and run references', async () => {
    const store = makeStore();
    const adapter = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [
        {
          source: { sourceId: 's1', kind: 'model_synthesis', locator: 'fake://s1' },
          result: {
            summary: 'read s1',
            findings: [
              {
                statement: 'Reusable architectural fact.',
                classification: 'verified_fact',
                confidence: 0.85,
                reusable: true,
                knowledgeKind: 'repo_fact',
                tags: ['architecture'],
                freshForMs: 60_000,
              },
              { statement: 'Ephemeral detail.', classification: 'inference' },
            ],
          },
        },
      ],
    });

    const clock = steppingClock();
    const result = await runResearch(CONTEXT, { store, adapters: [adapter], clock });

    expect(result.recordedKnowledgeEntryIds).toHaveLength(1);
    const events = await store.readRun('run-1');
    const knowledge = projectKnowledgeIndex(events);
    expect(knowledge.entries).toHaveLength(1);
    const entry = knowledge.entries[0];
    expect(entry?.kind).toBe('repo_fact');
    expect(entry?.confidence).toBe(0.85);
    expect(entry?.sensitivity).toBe('internal');
    expect(entry?.tags).toContain('architecture');
    expect(entry?.tags).toContain('research');
    expect(entry?.sourceRunId).toBe('run-1');
    expect(entry?.freshUntil).toBeDefined();
    // The evidencing event id points at the finding event.
    const findingEvent = events.find((event) => event.type === 'research.finding_recorded');
    expect(entry?.sourceEventIds).toEqual([findingEvent?.eventId]);
  });
});

describe('runResearch — prior knowledge seeding', () => {
  it('seeds prior knowledge without hiding source age, staleness, or confidence', async () => {
    const T0 = 1_700_000_000_000;
    // Prior run recorded one fresh and one stale entry.
    const priorStore = createInMemoryEventStore({
      clock: () => T0,
      idGenerator: steppingIds('prior'),
    });
    const record = (entryId: string, freshUntil: number, confidence: number): Promise<unknown> =>
      priorStore.append({
        runId: 'run-0',
        type: 'knowledge.entry_recorded',
        actor: { kind: 'researcher', id: 'research-runner' },
        subject: { kind: 'knowledge', id: entryId },
        severity: 'info',
        payload: {
          entryId,
          kind: 'finding',
          title: `Prior ${entryId}`,
          body: `Prior body for ${entryId}`,
          confidence,
          sensitivity: 'internal',
          freshUntil,
        },
      });
    await record('fresh-entry', T0 + 10 * 24 * 3600 * 1000, 0.9);
    await record('stale-entry', T0 + 1, 0.7);

    const priorKnowledge = projectKnowledgeIndex(await priorStore.readAll());
    const store = makeStore();
    const nowClock = steppingClock(T0 + 86_400_000, 1000); // one day later

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [],
      priorKnowledge,
      clock: nowClock,
    });

    expect(result.status).toBe('completed');
    expect(result.seededKnowledgeCount).toBe(2);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    const fresh = research.findings.find((f) => f.findingId === 'prior-fresh-entry');
    const stale = research.findings.find((f) => f.findingId === 'prior-stale-entry');
    expect(fresh).toBeDefined();
    expect(stale).toBeDefined();
    // Confidence carried through, not laundered.
    expect(fresh?.confidence).toBe(0.9);
    expect(stale?.confidence).toBe(0.7);
    // Age + staleness are visible in the statement and evidence.
    expect(stale?.statement).toMatch(/STALE/);
    expect(stale?.statement).toMatch(/age \d+s/);
    expect(fresh?.statement).not.toMatch(/STALE/);
    expect(fresh?.evidence[0]?.note).toMatch(/confidence 0\.9/);
    // The brief itself surfaces the seeded provenance.
    expect(result.briefSummary).toMatch(/Seeded prior knowledge/);
    expect(result.briefSummary).toMatch(/confidence 0\.7, STALE/);
    // Seeded findings are NOT re-normalized into the index (no duplicates).
    expect(result.recordedKnowledgeEntryIds).toHaveLength(0);
  });
});

describe('runResearch — determinism and resilience', () => {
  function deterministicPass(): Promise<{ result: ResearchRunResult; events: FactoryEvent[] }> {
    const store = makeStore();
    const adapter = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [
        scriptedSource('s1', 'model_synthesis', 'alpha fact'),
        scriptedSource('s2', 'model_synthesis', 'beta fact'),
      ],
    });
    return runResearch(CONTEXT, {
      store,
      adapters: [adapter],
      budget: { maxSources: 5, maxDurationMs: 999_999 },
      clock: steppingClock(),
    }).then(async (result) => ({ result, events: await store.readRun('run-1') }));
  }

  it('produces an identical ledger and brief across repeated deterministic passes', async () => {
    const first = await deterministicPass();
    const second = await deterministicPass();
    expect(first.result).toEqual(second.result);
    expect(JSON.stringify(first.events)).toBe(JSON.stringify(second.events));
    expect(first.result.briefSummary).toContain('Research brief');
  });

  it('keeps partial findings when one source read fails, recording a gap', async () => {
    const store = makeStore();
    const adapter = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [
        {
          source: { sourceId: 'bad', kind: 'model_synthesis' },
          result: new Error('disk exploded'),
        },
        scriptedSource('good', 'model_synthesis', 'surviving fact'),
      ],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [adapter],
      clock: steppingClock(),
    });

    expect(result.status).toBe('completed');
    expect(result.findingCount).toBe(1);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.gaps.some((gap) => gap.gapId === 'g-read-bad')).toBe(true);
    expect(research.findings[0]?.statement).toBe('surviving fact');
  });

  it('records a discovery failure as a gap and continues with other adapters', async () => {
    const store = makeStore();
    const broken = createFakeAdapter({
      id: 'broken',
      kind: 'other',
      discoverError: new Error('provider timeout'),
    });
    const working = createFakeAdapter({
      id: 'synth',
      kind: 'model_synthesis',
      sources: [scriptedSource('s1', 'model_synthesis', 'fact')],
    });

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [broken, working],
      clock: steppingClock(),
    });

    expect(result.status).toBe('completed');
    expect(result.findingCount).toBe(1);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.gaps.some((gap) => gap.gapId === 'g-discover-broken')).toBe(true);
  });

  it('records research.failed on cancellation while keeping partial events replayable', async () => {
    const store = makeStore();
    const controller = new AbortController();
    controller.abort();

    const result = await runResearch(CONTEXT, {
      store,
      adapters: [
        createFakeAdapter({
          id: 'synth',
          kind: 'model_synthesis',
          sources: [scriptedSource('s1', 'model_synthesis', 'fact')],
        }),
      ],
      clock: steppingClock(),
      signal: controller.signal,
    });

    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/cancelled/i);
    const research = projectResearch(await store.readRun('run-1'), 'run-1');
    expect(research.status).toBe('failed');
  });

  it('emits research events with the researcher actor kind', async () => {
    const store = makeStore();
    await runResearch(CONTEXT, {
      store,
      adapters: [
        createFakeAdapter({
          id: 'synth',
          kind: 'model_synthesis',
          sources: [scriptedSource('s1', 'model_synthesis', 'fact')],
        }),
      ],
      clock: steppingClock(),
    });
    const events = await store.readRun('run-1');
    const researchEvents = events.filter((event) => event.type.startsWith('research.'));
    expect(researchEvents.length).toBeGreaterThan(0);
    for (const event of researchEvents) {
      expect(event.actor.kind).toBe('researcher');
    }
  });
});
