/**
 * Research routes (full-factory U2) — the guarded research trigger, the
 * projected research view, and the knowledge-index query surface, exercised
 * through the framework-agnostic app with the REAL research runner behind
 * deterministic fake adapters (no network, no real providers).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
} from '@software-factory/core';
import { runResearch } from '@software-factory/worker';
import type {
  DiscoveredSource,
  ResearchAdapterSetup,
  ResearchSourceAdapter,
  SourceReadResult,
} from '@software-factory/worker';
import {
  createApp,
  type ApiRequest,
  type ApiResponse,
  type App,
  type RunResearcher,
} from '../../src/server/app';
import { createRuntimeResearcher } from '../../src/server/research/runtime-researcher';
import type { RuntimeConfig } from '../../src/server/runtime';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

/** A deterministic fake adapter: one source, one reusable + one sensitive finding. */
function fakeAdapter(): ResearchSourceAdapter {
  const setup: ResearchAdapterSetup = {
    configured: true,
    requiresCredentials: false,
    credentialsPresent: true,
  };
  const source: DiscoveredSource = {
    sourceId: 'fake:1',
    kind: 'model_synthesis',
    title: 'fake source',
    locator: 'fake://1',
  };
  const result: SourceReadResult = {
    summary: 'read the fake source',
    contentDigest: 'digest-1',
    findings: [
      {
        statement: 'Public reusable fact.',
        classification: 'verified_fact',
        confidence: 0.9,
        reusable: true,
        tags: ['route-test'],
      },
      {
        statement: 'Sensitive reusable fact.',
        classification: 'verified_fact',
        confidence: 0.8,
        reusable: true,
        sensitivity: 'sensitive',
        tags: ['route-test'],
      },
      {
        // Stale immediately: freshness horizon of 1ms.
        statement: 'Short-lived reusable fact.',
        classification: 'inference',
        confidence: 0.4,
        reusable: true,
        freshForMs: 1,
        tags: ['route-test'],
      },
    ],
  };
  return {
    id: 'fake',
    kind: 'model_synthesis',
    detectSetup: () => Promise.resolve(setup),
    discover: () => Promise.resolve([source]),
    read: () => Promise.resolve(result),
  };
}

/** A researcher wired to the REAL runner with the fake adapter. */
function fakeResearcher(clock: () => number): RunResearcher {
  return (store, runId, input) =>
    runResearch(
      { runId, objective: input.objective ?? 'route-test objective' },
      {
        store,
        adapters: [fakeAdapter()],
        budget: input.budget,
        clock,
      },
    );
}

interface TestApp {
  readonly app: App;
  readonly store: EventStore;
}

function makeApp(researcher?: RunResearcher | null): TestApp {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    clock: det.clock,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    planner: null,
    researcher: researcher === undefined ? fakeResearcher(det.clock) : researcher,
  });
  return { app, store };
}

function authedHeaders(): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
  body?: unknown,
  query: Record<string, string | undefined> = {},
): ApiRequest {
  return { method, path, query, headers, body };
}

function record(res: ApiResponse): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

async function createRun(
  app: App,
  body: Record<string, unknown> = { prompt: 'x' },
): Promise<string> {
  const res = await app.handle(req('POST', '/api/runs', authedHeaders(), body));
  expect(res.status).toBe(201);
  return record(res).runId as string;
}

describe('POST /api/runs/:id/research', () => {
  it('runs bounded research and returns the projected research view', async () => {
    const { app, store } = makeApp();
    const runId = await createRun(app);

    const res = await app.handle(req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}));
    expect(res.status).toBe(201);
    const body = record(res);
    expect(body.alreadyResearched).toBe(false);
    const research = body.research as { status: string; findings: unknown[]; sourceCount: number };
    expect(research.status).toBe('completed');
    expect(research.sourceCount).toBe(1);
    expect(research.findings.length).toBeGreaterThan(0);

    const types = (await store.readRun(runId)).map((event) => event.type);
    expect(types).toContain('research.requested');
    expect(types).toContain('research.source_read');
    expect(types).toContain('research.brief_completed');
    expect(types).toContain('knowledge.entry_recorded');
  });

  it('is idempotent: a second trigger returns existing research without re-running', async () => {
    const { app, store } = makeApp();
    const runId = await createRun(app);

    await app.handle(req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}));
    const second = await app.handle(
      req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}),
    );

    expect(second.status).toBe(200);
    expect(record(second).alreadyResearched).toBe(true);
    const requested = (await store.readRun(runId)).filter(
      (event) => event.type === 'research.requested',
    );
    expect(requested).toHaveLength(1);
  });

  it('re-runs research when force is set', async () => {
    const { app, store } = makeApp();
    const runId = await createRun(app);

    await app.handle(req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}));
    const forced = await app.handle(
      req('POST', `/api/runs/${runId}/research`, authedHeaders(), { force: true }),
    );

    expect(forced.status).toBe(201);
    const requested = (await store.readRun(runId)).filter(
      (event) => event.type === 'research.requested',
    );
    expect(requested).toHaveLength(2);
  });

  it('rejects unauthenticated triggers with a single security event and no research', async () => {
    const { app, store } = makeApp();
    const runId = await createRun(app);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/research`, { origin: ORIGIN }, {}),
    );

    expect(res.status).toBe(401);
    const events = await store.readRun(runId);
    // Missing-token denials append exactly one `security.block` event.
    expect(events.filter((event) => event.type === 'security.block')).toHaveLength(1);
    expect(events.some((event) => event.type.startsWith('research.'))).toBe(false);
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('POST', '/api/runs/ghost/research', authedHeaders(), {}));
    expect(res.status).toBe(404);
  });

  it('returns 503 when research is disabled on the instance', async () => {
    const { app } = makeApp(null);
    const runId = await createRun(app);
    const res = await app.handle(req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}));
    expect(res.status).toBe(503);
    expect(record(res).error).toBe('research_disabled');
  });

  it('honors request budgets (bounded pass records a budget gap)', async () => {
    const det = deterministic();
    const store = createInMemoryEventStore(det);
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
    });
    const manySources: ResearchSourceAdapter = {
      id: 'many',
      kind: 'model_synthesis',
      detectSetup: () =>
        Promise.resolve({ configured: true, requiresCredentials: false, credentialsPresent: true }),
      discover: (_context, options) =>
        Promise.resolve(
          Array.from({ length: Math.min(options.limit, 5) }, (_unused, index) => ({
            sourceId: `many:${index + 1}`,
            kind: 'model_synthesis' as const,
          })),
        ),
      read: (source) => Promise.resolve({ summary: `read ${source.sourceId}`, findings: [] }),
    };
    const app = createApp({
      store,
      operatorToken: provider,
      clock: det.clock,
      idGenerator: () => 'run-1',
      config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
      planner: null,
      researcher: (s, runId, input) =>
        runResearch(
          { runId, objective: 'bounded' },
          { store: s, adapters: [manySources], budget: input.budget, clock: det.clock },
        ),
    });
    const runId = await createRun(app);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/research`, authedHeaders(), {
        budget: { maxSources: 1 },
      }),
    );

    expect(res.status).toBe(201);
    const research = record(res).research as {
      readSourceCount: number;
      gaps: { gapId: string }[];
    };
    expect(research.readSourceCount).toBe(1);
    expect(research.gaps.some((gap) => gap.gapId === 'g-budget-max_sources')).toBe(true);
  });
});

describe('GET /api/runs/:id/research', () => {
  it('returns the projected research view', async () => {
    const { app } = makeApp();
    const runId = await createRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}));

    const res = await app.handle(req('GET', `/api/runs/${runId}/research`, {}));
    expect(res.status).toBe(200);
    const research = record(res).research as { status: string; briefSummary?: string };
    expect(research.status).toBe('completed');
    expect(research.briefSummary).toContain('Research brief');
  });

  it('reports status none for a run without research (planning-only compatible)', async () => {
    const { app } = makeApp();
    const runId = await createRun(app);
    const res = await app.handle(req('GET', `/api/runs/${runId}/research`, {}));
    expect(res.status).toBe(200);
    expect((record(res).research as { status: string }).status).toBe('none');
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('GET', '/api/runs/ghost/research', {}));
    expect(res.status).toBe(404);
  });
});

describe('GET /api/knowledge', () => {
  async function researchedApp(): Promise<TestApp & { runId: string }> {
    const made = makeApp();
    const runId = await createRun(made.app);
    await made.app.handle(req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}));
    return { ...made, runId };
  }

  it('returns recorded knowledge entries with age and staleness context', async () => {
    const { app } = await researchedApp();
    const res = await app.handle(req('GET', '/api/knowledge', {}, undefined, {}));
    expect(res.status).toBe(200);
    const body = record(res) as {
      count: number;
      matches: { stale: boolean; ageMs: number; entry: { title: string; confidence: number } }[];
    };
    expect(body.count).toBeGreaterThan(0);
    for (const match of body.matches) {
      expect(match.ageMs).toBeGreaterThanOrEqual(0);
      expect(typeof match.entry.confidence).toBe('number');
    }
    // The non-stale public entry is returned; confidence stays visible.
    expect(body.matches.some((match) => match.entry.title.includes('Public reusable fact'))).toBe(
      true,
    );
  });

  it('never returns sensitive entries without the explicit opt-in', async () => {
    const { app } = await researchedApp();

    const withoutOptIn = await app.handle(req('GET', '/api/knowledge', {}, undefined, {}));
    const normal = record(withoutOptIn) as { matches: { entry: { sensitivity: string } }[] };
    expect(normal.matches.every((match) => match.entry.sensitivity !== 'sensitive')).toBe(true);

    const withOptIn = await app.handle(
      req('GET', '/api/knowledge', {}, undefined, { includeSensitive: '1' }),
    );
    const optedIn = record(withOptIn) as { matches: { entry: { sensitivity: string } }[] };
    expect(optedIn.matches.some((match) => match.entry.sensitivity === 'sensitive')).toBe(true);
  });

  it('excludes stale entries unless includeStale is set, then flags them', async () => {
    const { app } = await researchedApp();

    const fresh = record(await app.handle(req('GET', '/api/knowledge', {}, undefined, {}))) as {
      matches: { stale: boolean; entry: { title: string } }[];
    };
    expect(fresh.matches.every((match) => !match.stale)).toBe(true);
    expect(fresh.matches.some((match) => match.entry.title.includes('Short-lived'))).toBe(false);

    const withStale = record(
      await app.handle(req('GET', '/api/knowledge', {}, undefined, { includeStale: '1' })),
    ) as { matches: { stale: boolean; entry: { title: string } }[] };
    const staleMatch = withStale.matches.find((match) => match.entry.title.includes('Short-lived'));
    expect(staleMatch).toBeDefined();
    expect(staleMatch?.stale).toBe(true);
  });

  it('filters by minConfidence and text', async () => {
    const { app } = await researchedApp();
    const res = record(
      await app.handle(
        req('GET', '/api/knowledge', {}, undefined, {
          minConfidence: '0.85',
          text: 'public',
          includeSensitive: '1',
        }),
      ),
    ) as { count: number; matches: { entry: { title: string } }[] };
    expect(res.count).toBe(1);
    expect(res.matches[0]?.entry.title).toContain('Public reusable fact');
  });
});

describe('createRuntimeResearcher (default wiring)', () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'sf-research-web-'));
    await writeFile(join(workspace, 'README.md'), '# Local Workspace', 'utf8');
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  function runtimeConfig(mode: 'local' | 'cloud', allowNetwork = false): RuntimeConfig {
    return {
      mode,
      host: '127.0.0.1',
      port: 3000,
      factoryDir: '.factory',
      allowedOrigins: [ORIGIN],
      operatorTokenSource: 'file',
      research: {
        allowNetwork,
        documentationUrls: [],
        searchCredentialsPresent: false,
        maxSources: 12,
        maxDurationMs: 120_000,
      },
    };
  }

  it('reads local PRD + folder sources and records web search as a policy gap when network is off', async () => {
    const det = deterministic();
    const store = createInMemoryEventStore(det);
    const researcher = createRuntimeResearcher({
      runtime: runtimeConfig('local'),
      clock: det.clock,
    });

    await store.append({
      runId: 'run-1',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-1', version: 0 },
      severity: 'info',
      payload: {
        prompt: 'build it',
        prdText: '# PRD\n## Scope',
        localFolder: workspace,
      },
    });

    const result = await researcher(store, 'run-1', {});
    expect(result.status).toBe('completed');
    // PRD text + local README were read; web search was refused BEFORE any I/O.
    expect(result.sourcesRead).toBeGreaterThanOrEqual(2);
    const events = await store.readRun('run-1');
    const gaps = events.filter((event) => event.type === 'research.gap_recorded');
    expect(
      gaps.some((gap) => {
        const payload = gap.payload as { gapId?: string };
        return payload.gapId === 'g-policy-web-search';
      }),
    ).toBe(true);
    // E5: no credential values anywhere.
    expect(JSON.stringify(events)).not.toMatch(/SF_RESEARCH_SEARCH_API_KEY\s*[:=]\s*\S/);
  });

  it('fails closed with setup-required when network is allowed but no search provider exists', async () => {
    const det = deterministic();
    const store = createInMemoryEventStore(det);
    const researcher = createRuntimeResearcher({
      runtime: runtimeConfig('local', true),
      clock: det.clock,
    });

    await store.append({
      runId: 'run-1',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-1', version: 0 },
      severity: 'info',
      payload: { prompt: 'build it' },
    });

    const result = await researcher(store, 'run-1', {});
    expect(result.status).toBe('completed');
    expect(result.findingCount).toBe(0); // nothing fabricated
    const events = await store.readRun('run-1');
    const types = events.map((event) => event.type);
    expect(types).toContain('adapter.setup_required');
    const gaps = events.filter((event) => event.type === 'research.gap_recorded');
    expect(
      gaps.some((gap) => {
        const payload = gap.payload as { gapId?: string };
        return payload.gapId === 'g-setup-web-search';
      }),
    ).toBe(true);
  });

  it('treats laptop-local folders as unavailable in cloud mode (KTD5)', async () => {
    const det = deterministic();
    const store = createInMemoryEventStore(det);
    const researcher = createRuntimeResearcher({
      runtime: runtimeConfig('cloud'),
      clock: det.clock,
    });

    await store.append({
      runId: 'run-1',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-1', version: 0 },
      severity: 'info',
      payload: { prompt: 'build it', localFolder: 'C:\\Users\\someone\\laptop-only' },
    });

    const result = await researcher(store, 'run-1', {});
    expect(result.status).toBe('completed');
    const events = await store.readRun('run-1');
    // No local files were read — the folder source is honestly unavailable.
    expect(events.some((event) => event.type === 'research.source_read')).toBe(false);
    const gaps = events.filter((event) => event.type === 'research.gap_recorded');
    expect(
      gaps.some((gap) => JSON.stringify(gap.payload).includes('not readable from the cloud')),
    ).toBe(true);
  });
});
