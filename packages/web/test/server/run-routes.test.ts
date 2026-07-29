import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  projectRun,
  type EventStore,
  type ExecutionAdapter,
  type ResearchProjection,
  type RunProjection,
} from '@software-factory/core';
import {
  createApp,
  type ApiRequest,
  type ApiResponse,
  type App,
  type RunPlanner,
  type RunResearcher,
} from '../../src/server/app';
import { createExecutionDaemon, type ExecutionDaemon } from '../../src/server/execution/daemon';
import { projectInterventions } from '../../src/server/execution/interventions';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

function makeAppWith(
  planner?: RunPlanner | null,
  researcher?: RunResearcher | null,
): { app: App; store: EventStore } {
  const store = createInMemoryEventStore(deterministic());
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    planner,
    researcher,
  });
  return { app, store };
}

function makeApp(): { app: App; store: EventStore } {
  // `undefined` planner -> the default genome planner (the real run flow).
  return makeAppWith(undefined);
}

/**
 * A deterministic stub researcher: appends a small research pass (requested ->
 * source found/read -> finding -> brief) straight to the ledger and reports a
 * completed pass. Counted appends make "did research re-run?" assertions exact.
 */
function stubResearcher(counters?: { passes: number }): RunResearcher {
  return async (store, runId) => {
    if (counters !== undefined) {
      counters.passes += 1;
    }
    const base = {
      runId,
      actor: { kind: 'researcher' as const, id: 'stub' },
      subject: { kind: 'research', id: runId },
      severity: 'info' as const,
    };
    await store.append({
      ...base,
      type: 'research.requested',
      payload: { objective: 'stub objective' },
    });
    await store.append({
      ...base,
      type: 'research.source_found',
      payload: { sourceId: 's-1', kind: 'model_synthesis', title: 'stub source' },
    });
    await store.append({
      ...base,
      type: 'research.source_read',
      payload: { sourceId: 's-1', summary: 'read stub source' },
    });
    await store.append({
      ...base,
      type: 'research.finding_recorded',
      payload: {
        findingId: 'f-1',
        statement: 'Stub research finding.',
        classification: 'verified_fact',
        confidence: 0.9,
        sourceIds: ['s-1'],
      },
    });
    await store.append({
      ...base,
      type: 'research.brief_completed',
      payload: { summary: 'Stub research brief.' },
    });
    return {
      status: 'completed' as const,
      briefSummary: 'Stub research brief.',
      sourcesFound: 1,
      sourcesRead: 1,
      findingCount: 1,
      assumptionCount: 0,
      gapCount: 0,
      seededKnowledgeCount: 0,
      recordedKnowledgeEntryIds: [],
      budgetStops: [],
    };
  };
}

/** A researcher that explodes — the app must record the failure on the ledger. */
function explodingResearcher(): RunResearcher {
  return () => Promise.reject(new Error('search provider melted down'));
}

const MARKETPLACE_PROMPT =
  'Build an AI services marketplace with providers, proposals, and customer requests';

function authedHeaders(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN, ...extra };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
  body?: unknown,
): ApiRequest {
  return { method, path, query: {}, headers, body };
}

function record(res: ApiResponse): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

describe('POST /api/runs', () => {
  // The run flow (U10) plans the run into the SAME store right after run.created:
  // a marketplace prompt yields the full 12-ticket DAG + run.planned capstone.
  it('creates a run, plans the ticket DAG, and returns the planned run', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: 'Build an AI services marketplace with providers, proposals, and customer requests',
      }),
    );

    expect(res.status).toBe(201);
    expect(record(res).runId).toBe('run-1');
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('planned');
    expect(run.plannedTicketCount).toBe(12);

    const events = await store.readRun('run-1');
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('supervisor.decision');
    expect(types).toContain('run.planned');
    expect(events.filter((e) => e.type === 'ticket.created')).toHaveLength(12);
  });

  it('records the caller family on run.created for nested-agent provenance', async () => {
    const { app, store } = makeApp();
    await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', callerFamily: 'codex' }),
    );
    const created = (await store.readRun('run-1')).find((e) => e.type === 'run.created');
    expect(created?.type).toBe('run.created');
    expect((created?.payload as { callerFamily?: string }).callerFamily).toBe('codex');
  });

  it('records local destination and runtime controls on run.created', async () => {
    const { app, store } = makeApp();
    await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: 'x',
        prdRef: 'docs/PRD.md',
        prdText: 'PRD body from the browser file picker',
        localFolder: 'C:\\repo\\app',
        githubRepo: 'octo/app',
        selectedAdapter: 'codex-cli',
        modelProfile: 'codex-default',
        reasoningEffort: 'extra high',
        requestedWorkerCap: 10,
      }),
    );
    const created = (await store.readRun('run-1')).find((e) => e.type === 'run.created');
    expect(created?.type).toBe('run.created');
    expect(created?.payload).toMatchObject({
      prdRef: 'docs/PRD.md',
      prdText: 'PRD body from the browser file picker',
      localFolder: 'C:\\repo\\app',
      githubRepo: 'octo/app',
      selectedAdapter: 'codex-cli',
      modelProfile: 'codex-default',
      reasoningEffort: 'extra high',
      requestedWorkerCap: 10,
    });
  });

  it('does not re-create or re-plan a run for a duplicate idempotency key', async () => {
    const { app, store } = makeApp();
    const first = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', idempotencyKey: 'k1' }),
    );
    const second = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', idempotencyKey: 'k1' }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(record(second).deduplicated).toBe(true);
    expect(record(first).runId).toBe(record(second).runId);

    expect(await store.listRuns()).toEqual(['run-1']);
    const events = await store.readRun('run-1');
    expect(events.filter((e) => e.type === 'run.created')).toHaveLength(1);
    // emitPlan is idempotent: the second create re-plans but appends no dupes.
    expect(events.filter((e) => e.type === 'run.planned')).toHaveLength(1);
  });

  it('guard failure emits the security event and starts nothing', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', { origin: ORIGIN, 'x-csrf-token': CSRF }, { prompt: 'x' }),
    );
    expect(res.status).toBe(401);

    const events = await store.readRun('run-1');
    expect(events.map((e) => e.type)).toEqual(['security.block']);
    expect(events.some((e) => e.type === 'run.created' || e.type === 'worker.started')).toBe(false);
  });
});

describe('GET /api/runs (read-only)', () => {
  it('returns projected runs without requiring auth', async () => {
    const { app } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'a' }));

    const res = await app.handle(req('GET', '/api/runs', {}));
    expect(res.status).toBe(200);
    const runs = record(res).runs as RunProjection[];
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-1');
    expect(runs[0].status).toBe('planned');
  });
});

describe('read-only run inspection routes', () => {
  it('returns the ordered event log and the planned run projection', async () => {
    const { app } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'a' }));

    const eventsRes = await app.handle(req('GET', '/api/runs/run-1/events', {}));
    expect(eventsRes.status).toBe(200);
    const events = record(eventsRes).events as { type: string }[];
    expect(events[0].type).toBe('run.created');
    expect(events.map((e) => e.type)).toContain('run.planned');

    const runRes = await app.handle(req('GET', '/api/runs/run-1', {}));
    expect(runRes.status).toBe(200);
    expect((record(runRes).run as RunProjection).status).toBe('planned');
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('GET', '/api/runs/missing/events', {}));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/runs/:id/cancel', () => {
  it('cancels a run with valid auth', async () => {
    const { app, store } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'a' }));

    const res = await app.handle(
      req('POST', '/api/runs/run-1/cancel', authedHeaders(), { reason: 'operator stop' }),
    );
    expect(res.status).toBe(200);
    expect((record(res).run as RunProjection).status).toBe('cancelled');

    const events = await store.readRun('run-1');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('run.planned');
    expect(types[types.length - 1]).toBe('run.cancelled');
  });
});

describe('GET /api/setup (read-only)', () => {
  it('reports operator-token presence and real deploy readiness (U8)', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('GET', '/api/setup', {}));
    expect(res.status).toBe(200);
    const body = record(res);
    expect(body.operatorToken).toEqual({ present: true });
    // No deploy runtime config injected here: the U8 readiness check reports
    // required and NAMES the missing setup instead of a bare placeholder.
    expect(body.deploy).toMatchObject({ status: 'required' });
    expect(Array.isArray((body.deploy as { missing: unknown }).missing)).toBe(true);
  });
});

describe('POST /api/runs/:id/review policy is server-authoritative', () => {
  // A planner that marks the run's only ticket HIGH risk, so the authoritative
  // gate input comes from server state (not the client body).
  const highRiskPlanner: RunPlanner = async (sink, runId) => {
    await sink.append({
      runId,
      type: 'ticket.created',
      actor: { kind: 'supervisor', id: 'supervisor' },
      subject: { kind: 'ticket', id: 'risky', version: 0 },
      ticketId: 'risky',
      severity: 'info',
      payload: { title: 'Risky migration', riskTier: 'high' },
    });
  };

  it('allows autonomous high-risk approval while preserving server risk metadata', async () => {
    const { app, store } = makeAppWith(highRiskPlanner);
    // The run opts into AUTONOMOUS mode (recorded on run.created server-side).
    const created = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', reviewMode: 'autonomous' }),
    );
    expect(created.status).toBe(201);

    const res = await app.handle(
      req('POST', '/api/runs/run-1/review', authedHeaders(), {
        decision: 'approved',
        // The client LIES about the gate inputs — the server must ignore both.
        riskTier: 'low',
        mode: 'human',
      }),
    );

    expect(res.status).toBe(200);
    expect(record(res).riskTier).toBe('high');
    expect(record(res).requiredApprovals).toBe(0);
    const types = (await store.readRun('run-1')).map((e) => e.type);
    expect(types).toContain('review.decided');
  });
});

describe('POST /api/runs when planning fails', () => {
  it('still returns 201, marks the run failed on the ledger, and emits no run.planned', async () => {
    const explodingPlanner: RunPlanner = () => Promise.reject(new Error('genome load exploded'));
    const { app, store } = makeAppWith(explodingPlanner);

    const res = await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'x' }));
    // Run creation succeeds (run.created is durable) even though planning failed.
    expect(res.status).toBe(201);
    expect((record(res).run as RunProjection).status).toBe('failed');

    const types = (await store.readRun('run-1')).map((e) => e.type);
    expect(types).toContain('run.created');
    expect(types).toContain('run.failed');
    expect(types).not.toContain('run.planned');
  });
});

describe('POST /api/runs — run modes (full-factory U3)', () => {
  it('plan-only stays the default and matches the V1 ledger exactly (no research, no contract)', async () => {
    const { app, store } = makeAppWith(undefined, stubResearcher());
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT }),
    );
    expect(res.status).toBe(201);

    const run = record(res).run as RunProjection;
    expect(run.mode).toBe('plan-only');
    expect(run.executionState).toBe('not_requested');
    expect(run.buildContract).toBeUndefined();
    expect(record(res).research).toBeUndefined();
    expect(record(res).execution).toBeUndefined();

    // The exact V1 ledger shape: created -> decisions -> tickets -> planned.
    const types = (await store.readRun('run-1')).map((e) => e.type);
    expect(types).toEqual([
      'run.created',
      'supervisor.decision',
      'supervisor.decision',
      ...Array.from({ length: 12 }, () => 'ticket.created'),
      'run.planned',
    ]);
    expect(types.some((t) => t.startsWith('research.'))).toBe(false);
    expect(types).not.toContain('contract.generated');
  });

  it('rejects an unknown mode with 400 and no side effects', async () => {
    const { app, store } = makeAppWith(undefined, stubResearcher());
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', mode: 'yolo-start' }),
    );
    expect(res.status).toBe(400);
    expect(record(res).error).toBe('invalid_mode');
    expect(await store.listRuns()).toEqual([]);
  });

  it('fails closed with 503 (and no run) when a research mode is requested but research is disabled', async () => {
    const { app, store } = makeAppWith(undefined, null);
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', mode: 'research-and-plan' }),
    );
    expect(res.status).toBe(503);
    expect(record(res).error).toBe('research_disabled');
    const events = await store.readAll();
    expect(events.some((e) => e.type === 'run.created')).toBe(false);
  });

  it('research-and-plan appends research events BEFORE supervisor/ticket events', async () => {
    const { app, store } = makeAppWith(undefined, stubResearcher());
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'research-and-plan',
      }),
    );
    expect(res.status).toBe(201);

    const events = await store.readRun('run-1');
    const types = events.map((e) => e.type);
    const lastResearch = Math.max(
      ...types.flatMap((t, i) => (t.startsWith('research.') ? [i] : [])),
    );
    const firstSupervisor = types.findIndex(
      (t) => t === 'supervisor.decision' || t === 'ticket.created',
    );
    expect(types[0]).toBe('run.created');
    expect(lastResearch).toBeGreaterThan(0);
    expect(firstSupervisor).toBeGreaterThan(lastResearch);
    expect(types).toContain('run.planned');

    // The response surfaces the projected research view alongside the run.
    const research = record(res).research as ResearchProjection;
    expect(research.status).toBe('completed');
    expect(research.findings.map((f) => f.findingId)).toEqual(['f-1']);
  });

  it('feeds the enriched brief into planning: research-backed rationale + finding ids on run.planned', async () => {
    const { app, store } = makeAppWith(undefined, stubResearcher());
    await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'research-and-plan',
      }),
    );

    const events = await store.readRun('run-1');
    const decisions = events.filter((e) => e.type === 'supervisor.decision');
    const research = decisions.find(
      (e) => (e.payload as { decision?: string }).decision === 'incorporate-research',
    );
    expect(research).toBeDefined();
    expect((research?.payload as { rationale: string }).rationale).toContain('f-1');

    const planned = events.find((e) => e.type === 'run.planned');
    expect(planned?.payload).toMatchObject({ influencingFindingIds: ['f-1'] });
  });

  it('generates a build contract after research + planning', async () => {
    const { app, store } = makeAppWith(undefined, stubResearcher());
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'research-and-plan',
      }),
    );

    const run = record(res).run as RunProjection;
    expect(run.buildContract).toBeDefined();
    expect(run.buildContract?.researchBacked).toBe(true);
    expect(run.buildContract?.influencingFindingIds).toEqual(['f-1']);
    expect(run.buildContract?.scope).toContain('12 planned ticket(s)');
    expect(run.buildContract?.deployTarget).toContain('Render');

    const types = (await store.readRun('run-1')).map((e) => e.type);
    expect(types.filter((t) => t === 'contract.generated')).toHaveLength(1);
  });

  it('research-plan-and-start records the start request and projects execution pending (U5 seam)', async () => {
    const { app, store } = makeAppWith(undefined, stubResearcher());
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'research-plan-and-start',
      }),
    );
    expect(res.status).toBe(201);

    // No pretend-start: the run settles at planned with an EXPLICIT pending state.
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('planned');
    expect(run.mode).toBe('research-plan-and-start');
    expect(run.executionState).toBe('pending');
    expect(record(res).execution).toMatchObject({ state: 'pending' });

    const events = await store.readRun('run-1');
    expect(events.some((e) => e.type === 'run.started')).toBe(false);
    const defer = events.find(
      (e) =>
        e.type === 'supervisor.decision' &&
        (e.payload as { decision?: string }).decision === 'defer-execution',
    );
    expect(defer).toBeDefined();
    // The start request itself is durable on run.created for U5 to act on.
    const created = events.find((e) => e.type === 'run.created');
    expect((created?.payload as { mode?: string }).mode).toBe('research-plan-and-start');
    // The contract names the recorded start approval.
    expect(run.buildContract?.operatorApprovals.join(' ')).toContain('start request recorded');
  });

  it('repeated creates with the same idempotency key duplicate NO research, plan, or contract events', async () => {
    const counters = { passes: 0 };
    const { app, store } = makeAppWith(undefined, stubResearcher(counters));
    const body = {
      prompt: MARKETPLACE_PROMPT,
      mode: 'research-plan-and-start',
      idempotencyKey: 'k-research-1',
    };

    const first = await app.handle(req('POST', '/api/runs', authedHeaders(), body));
    const second = await app.handle(req('POST', '/api/runs', authedHeaders(), body));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(record(second).deduplicated).toBe(true);
    expect(record(first).runId).toBe(record(second).runId);
    expect(counters.passes).toBe(1); // research ran exactly once

    const events = await store.readRun(record(first).runId as string);
    const count = (type: string): number => events.filter((e) => e.type === type).length;
    expect(count('run.created')).toBe(1);
    expect(count('research.requested')).toBe(1);
    expect(count('research.brief_completed')).toBe(1);
    expect(count('run.planned')).toBe(1);
    expect(count('ticket.created')).toBe(12);
    expect(count('contract.generated')).toBe(1);
    expect(
      events.filter(
        (e) =>
          e.type === 'supervisor.decision' &&
          (e.payload as { decision?: string }).decision === 'defer-execution',
      ),
    ).toHaveLength(1);
  });

  it('a dedup re-create racing an IN-FLIGHT research pass returns honestly without planning', async () => {
    // A researcher that records `research.requested` and then BLOCKS until the
    // test releases it — the shape of a concurrent create still mid-research.
    let releaseResearch: (() => void) | undefined;
    const researchGate = new Promise<void>((resolve) => {
      releaseResearch = resolve;
    });
    let requestedRecorded: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      requestedRecorded = resolve;
    });
    const blockingResearcher: RunResearcher = async (store, runId) => {
      await store.append({
        runId,
        actor: { kind: 'researcher', id: 'stub' },
        subject: { kind: 'research', id: runId },
        severity: 'info',
        type: 'research.requested',
        payload: { objective: 'slow objective' },
      });
      requestedRecorded?.();
      await researchGate;
      await store.append({
        runId,
        actor: { kind: 'researcher', id: 'stub' },
        subject: { kind: 'research', id: runId },
        severity: 'info',
        type: 'research.brief_completed',
        payload: { summary: 'Slow research brief.' },
      });
      return {
        status: 'completed' as const,
        briefSummary: 'Slow research brief.',
        sourcesFound: 0,
        sourcesRead: 0,
        findingCount: 0,
        assumptionCount: 0,
        gapCount: 0,
        seededKnowledgeCount: 0,
        recordedKnowledgeEntryIds: [],
        budgetStops: [],
      };
    };

    const { app, store } = makeAppWith(undefined, blockingResearcher);
    const body = {
      prompt: MARKETPLACE_PROMPT,
      mode: 'research-and-plan',
      idempotencyKey: 'k-inflight-1',
    };

    // First create: starts research and blocks inside it.
    const firstPromise = app.handle(req('POST', '/api/runs', authedHeaders(), body));
    await requested;

    // Duplicate create while research is requested-but-not-terminal: it must
    // NOT plan from the partial brief — no supervisor/ticket events.
    const second = await app.handle(req('POST', '/api/runs', authedHeaders(), body));
    expect(second.status).toBe(200);
    expect(record(second).deduplicated).toBe(true);
    expect(record(second).researchInProgress).toBe(true);
    expect((record(second).research as ResearchProjection).status).toBe('requested');
    const midEvents = await store.readRun('run-1');
    const midTypes = midEvents.map((e) => e.type);
    expect(midTypes).not.toContain('supervisor.decision');
    expect(midTypes).not.toContain('ticket.created');
    expect(midTypes).not.toContain('run.planned');
    expect(midTypes).not.toContain('contract.generated');

    // The ORIGINAL in-flight flow completes planning once research finishes.
    releaseResearch?.();
    const first = await firstPromise;
    expect(first.status).toBe(201);
    const events = await store.readRun('run-1');
    const count = (type: string): number => events.filter((e) => e.type === type).length;
    expect(count('research.requested')).toBe(1);
    expect(count('run.planned')).toBe(1);
    expect(count('ticket.created')).toBe(12);
  });

  it('research failure leaves the run failed and explainable — no plan, no silent success', async () => {
    const { app, store } = makeAppWith(undefined, explodingResearcher());
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'research-and-plan',
      }),
    );

    // Creation itself succeeds (run.created is durable); the run is FAILED.
    expect(res.status).toBe(201);
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('failed');
    expect(run.failureReason).toContain('research failed');
    const research = record(res).research as ResearchProjection;
    expect(research.status).toBe('failed');

    const types = (await store.readRun('run-1')).map((e) => e.type);
    expect(types).toContain('research.failed');
    expect(types).toContain('run.failed');
    expect(types).not.toContain('run.planned');
    expect(types).not.toContain('ticket.created');
    expect(types).not.toContain('contract.generated');
  });

  it('a failed-research run stays failed on an idempotent re-create (no duplicate failure events)', async () => {
    const { app, store } = makeAppWith(undefined, explodingResearcher());
    const body = {
      prompt: MARKETPLACE_PROMPT,
      mode: 'research-and-plan',
      idempotencyKey: 'k-fail-1',
    };
    await app.handle(req('POST', '/api/runs', authedHeaders(), body));
    const second = await app.handle(req('POST', '/api/runs', authedHeaders(), body));

    expect(second.status).toBe(200);
    expect((record(second).run as RunProjection).status).toBe('failed');
    const events = await store.readRun('run-1');
    expect(events.filter((e) => e.type === 'run.failed')).toHaveLength(1);
    expect(events.some((e) => e.type === 'run.planned')).toBe(false);
  });
});

/* ----------------------------------------------------------------------------
 * Archive / unarchive (session lifecycle U2)
 * ------------------------------------------------------------------------- */

/** A request with an explicit query (the shared `req` always sends `{}`). */
function reqQuery(
  method: string,
  path: string,
  query: Record<string, string | undefined>,
  headers: Record<string, string | undefined>,
  body?: unknown,
): ApiRequest {
  return { method, path, query, headers, body };
}

/** Mark a run completed the way the scheduler executor does in production. */
async function completeRun(store: EventStore, runId: string): Promise<void> {
  await store.append({
    runId,
    type: 'run.completed',
    actor: { kind: 'system', id: 'ticket-executor' },
    subject: { kind: 'run', id: runId },
    severity: 'success',
    idempotencyKey: `${runId}:run.completed`,
    payload: { summary: 'all done' },
  });
}

/** A deterministic, always-ready fake adapter for the preflight catalog. */
function readyFakeAdapter(id = 'fake-ready'): ExecutionAdapter {
  return {
    id,
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 4 }),
    execute: () =>
      Promise.resolve({ ok: false as const, error: AdapterError.unavailable('not used') }),
    reportCapacity: () => 4,
  };
}

/** Timers that never fire — tests drive the daemon manually via `tick()`. */
function noopTimers() {
  return {
    setInterval: () => null,
    clearInterval: () => undefined,
  };
}

/**
 * An app with a REAL (unstarted) execution daemon and a ready fake adapter
 * catalog, mirroring execution-routes.test.ts — for archive scenarios that
 * need queued/in-flight execution work.
 */
function makeExecApp(): { app: App; store: EventStore; daemon: ExecutionDaemon } {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;
  const daemon = createExecutionDaemon({
    store,
    clock: det.clock,
    idGenerator: () => `lease-${(leaseSeq += 1)}`,
    ownerId: 'daemon-test',
    timers: noopTimers(),
  });
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    adapterCatalog: createAdapterCatalog([readyFakeAdapter()]),
  });
  return { app, store, daemon };
}

async function createPlannedRun(app: App, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.handle(
    req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT, ...body }),
  );
  expect(res.status).toBe(201);
  return record(res).runId as string;
}

describe('POST /api/runs/:id/archive', () => {
  it('archives a completed run: run.archived appended, hidden by default, listed with includeArchived', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);
    await completeRun(store, runId);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/archive`, authedHeaders(), { reason: 'shipping done' }),
    );
    expect(res.status).toBe(200);
    const run = record(res).run as RunProjection;
    expect(run.archived).toBe(true);
    expect(run.archivedAt).toBeDefined();
    // A terminal run is archived WITHOUT a cancel (R16 applies to live runs).
    expect(record(res).cancelled).toBeUndefined();
    expect(run.status).toBe('completed');

    const events = await store.readRun(runId);
    expect(events.filter((e) => e.type === 'run.archived')).toHaveLength(1);
    expect(events.some((e) => e.type === 'run.cancelled')).toBe(false);
    expect(events[events.length - 1].type).toBe('run.archived');

    // Default list: the archived run is GONE (R7 default-view filtering).
    const defaultList = await app.handle(req('GET', '/api/runs', {}));
    expect((record(defaultList).runs as RunProjection[]).map((r) => r.runId)).toEqual([]);

    // History opt-in: `includeArchived=1` returns it, still projected archived.
    const history = await app.handle(reqQuery('GET', '/api/runs', { includeArchived: '1' }, {}));
    const historyRuns = record(history).runs as RunProjection[];
    expect(historyRuns.map((r) => r.runId)).toEqual([runId]);
    expect(historyRuns[0].archived).toBe(true);
  });

  it('rejects a stale expectedVersion with 409 and appends no archive event', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/archive`, authedHeaders(), { expectedVersion: 1 }),
    );
    expect(res.status).toBe(409);
    expect(record(res).error).toBe('stale_subject_version');

    const types = (await store.readRun(runId)).map((e) => e.type);
    expect(types).toContain('security.command_rejected');
    expect(types).not.toContain('run.archived');
    expect(types).not.toContain('run.cancelled');
  });

  it('archives a RUNNING (queued) run by cancelling first: one command, queue released, both reported', async () => {
    const { app, store, daemon } = makeExecApp();
    const runId = await createPlannedRun(app);
    const started = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(started.status).toBe(202);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/archive`, authedHeaders(), { reason: 'clear the floor' }),
    );
    expect(res.status).toBe(200);
    // The response reports BOTH halves of the command (R16).
    expect(record(res).cancelled).toBe(true);
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('cancelled');
    expect(run.executionState).toBe('cancelled');
    expect(run.archived).toBe(true);

    const events = await store.readRun(runId);
    const types = events.map((e) => e.type);
    // Cancel lands BEFORE archive: never an "archived but still executing" run.
    expect(types.indexOf('run.cancelled')).toBeGreaterThan(-1);
    expect(types.indexOf('run.cancelled')).toBeLessThan(types.indexOf('run.archived'));
    const released = events.find((e) => e.type === 'queue.released');
    expect((released?.payload as { outcome?: string } | undefined)?.outcome).toBe('cancelled');

    // The daemon never claims work for the cancelled+archived run.
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);
  });

  it('archiving a non-terminal run resolves its open interventions (queue drops them)', async () => {
    const { app, store } = makeExecApp();
    // A repo-sourced run with no workspace: the failed preflight leaves OPEN
    // interventions blocking the run.
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });
    const blocked = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(blocked.status).toBe(422);
    const openBefore = projectInterventions(await store.readRun(runId)).open;
    expect(openBefore.length).toBeGreaterThan(0);

    const res = await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));
    expect(res.status).toBe(200);

    // Interventions must never pin a hidden run on the factory floor.
    const projection = projectInterventions(await store.readRun(runId));
    expect(projection.open).toHaveLength(0);
    for (const { interventionId } of openBefore) {
      expect(projection.byId[interventionId]?.status).toBe('resolved');
      expect(projection.byId[interventionId]?.resolution).toBe('cancelled');
    }
    const list = await app.handle(req('GET', '/api/interventions', {}));
    expect(record(list).openCount).toBe(0);
  });

  it('archiving a terminal (failed) run resolves its interventions WITHOUT cancelling', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });
    const blocked = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(blocked.status).toBe(422);
    // The run fails terminally with its preflight interventions still open.
    await store.append({
      runId,
      type: 'run.failed',
      actor: { kind: 'system', id: 'execution-daemon' },
      subject: { kind: 'run', id: runId },
      severity: 'error',
      payload: { reason: 'gave up after blocked preflight' },
    });
    const openBefore = projectInterventions(await store.readRun(runId)).open;
    expect(openBefore.length).toBeGreaterThan(0);

    const res = await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect(record(res).cancelled).toBeUndefined();

    const events = await store.readRun(runId);
    expect(events.some((e) => e.type === 'run.cancelled')).toBe(false);
    const projection = projectInterventions(events);
    expect(projection.open).toHaveLength(0);
    for (const { interventionId } of openBefore) {
      expect(projection.byId[interventionId]?.resolution).toBe('archived');
    }
    // The terminal outcome is preserved: archived, still failed.
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('failed');
    expect(run.archived).toBe(true);
  });

  it('re-archiving converges: alreadyArchived, no duplicate event (AE-idempotency)', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);
    await completeRun(store, runId);

    const first = await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));
    expect(first.status).toBe(200);
    const second = await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));
    expect(second.status).toBe(200);
    expect(record(second).alreadyArchived).toBe(true);
    expect((record(second).run as RunProjection).archived).toBe(true);

    const events = await store.readRun(runId);
    expect(events.filter((e) => e.type === 'run.archived')).toHaveLength(1);
  });

  it('a guard rejection (bad token) archives nothing', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/archive`, { origin: ORIGIN, 'x-csrf-token': CSRF }, {}),
    );
    expect(res.status).toBe(401);

    const types = (await store.readRun(runId)).map((e) => e.type);
    expect(types).toContain('security.block');
    expect(types).not.toContain('run.archived');
    expect(types).not.toContain('run.cancelled');
    // The run stays visible in the default list.
    const list = await app.handle(req('GET', '/api/runs', {}));
    expect((record(list).runs as RunProjection[]).map((r) => r.runId)).toEqual([runId]);
  });

  it('AE2: an archived run stays readable via the events and detail routes', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);
    await completeRun(store, runId);
    await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));

    const eventsRes = await app.handle(req('GET', `/api/runs/${runId}/events`, {}));
    expect(eventsRes.status).toBe(200);
    const eventTypes = (record(eventsRes).events as { type: string }[]).map((e) => e.type);
    expect(eventTypes[0]).toBe('run.created');
    expect(eventTypes).toContain('run.archived');

    const detail = await app.handle(req('GET', `/api/runs/${runId}`, {}));
    expect(detail.status).toBe(200);
    const run = record(detail).run as RunProjection;
    expect(run.archived).toBe(true);
    expect(run.status).toBe('completed');
  });
});

describe('POST /api/runs/:id/unarchive', () => {
  it('restores visibility only: the run re-enters the default list, execution state untouched', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);
    // Archive-of-active cancels first (R16) — the unarchived run must stay
    // cancelled (R13: visibility only, cancelled stays terminal).
    await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));
    const archived = projectRun(await store.readRun(runId), runId);
    expect(archived.archived).toBe(true);
    expect(archived.status).toBe('cancelled');

    const res = await app.handle(req('POST', `/api/runs/${runId}/unarchive`, authedHeaders(), {}));
    expect(res.status).toBe(200);
    const run = record(res).run as RunProjection;
    expect(run.archived).toBe(false);
    expect(run.archivedAt).toBeUndefined();
    expect(run.status).toBe('cancelled');
    expect(run.executionState).toBe(archived.executionState);

    const list = await app.handle(req('GET', '/api/runs', {}));
    expect((record(list).runs as RunProjection[]).map((r) => r.runId)).toEqual([runId]);
  });

  it('unarchiving a visible run converges: alreadyVisible, no event', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);

    const res = await app.handle(req('POST', `/api/runs/${runId}/unarchive`, authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect(record(res).alreadyVisible).toBe(true);
    expect((await store.readRun(runId)).some((e) => e.type === 'run.unarchived')).toBe(false);
  });

  it('archive -> unarchive -> archive appends a fresh toggle (version-scoped idempotency keys)', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);
    await completeRun(store, runId);

    await app.handle(req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}));
    await app.handle(req('POST', `/api/runs/${runId}/unarchive`, authedHeaders(), {}));
    const rearchive = await app.handle(
      req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {}),
    );
    expect(rearchive.status).toBe(200);
    expect(record(rearchive).alreadyArchived).toBeUndefined();

    const events = await store.readRun(runId);
    // A fixed idempotency key would dedup the SECOND archive silently — the
    // version-scoped key lets the toggle land as a fresh event.
    expect(events.filter((e) => e.type === 'run.archived')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'run.unarchived')).toHaveLength(1);
    expect(projectRun(events, runId).archived).toBe(true);
  });
});

describe('POST /api/runs/:id/cancel with archive: true (R10)', () => {
  it('cancels and archives in ONE command; queue released; single archive event', async () => {
    const { app, store, daemon } = makeExecApp();
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), {
        reason: 'operator stop',
        archive: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(record(res).archived).toBe(true);
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('cancelled');
    expect(run.archived).toBe(true);

    const events = await store.readRun(runId);
    expect(events.filter((e) => e.type === 'run.cancelled')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.archived')).toHaveLength(1);
    const released = events.find((e) => e.type === 'queue.released');
    expect((released?.payload as { outcome?: string } | undefined)?.outcome).toBe('cancelled');
    expect((await daemon.tick()).claimed).toBe(0);
  });

  it('archives an ALREADY-cancelled run when asked (converging follow-up), then converges fully', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'stop' }));

    const followUp = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { archive: true }),
    );
    expect(followUp.status).toBe(200);
    expect(record(followUp).alreadyCancelled).toBe(true);
    expect(record(followUp).archived).toBe(true);
    expect((record(followUp).run as RunProjection).archived).toBe(true);

    const again = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { archive: true }),
    );
    expect(again.status).toBe(200);
    expect(record(again).alreadyCancelled).toBe(true);
    expect(record(again).alreadyArchived).toBe(true);

    const events = await store.readRun(runId);
    expect(events.filter((e) => e.type === 'run.cancelled')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.archived')).toHaveLength(1);
  });

  it('plain cancel (no flag) archives nothing but returns the fresh run for an immediate archive offer', async () => {
    const { app, store } = makeApp();
    const runId = await createPlannedRun(app);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'stop' }),
    );
    expect(res.status).toBe(200);
    expect(record(res).archived).toBeUndefined();
    const run = record(res).run as RunProjection;
    expect(run.archived).toBe(false);
    // The response carries what the UI needs to offer archive in the same
    // moment (AE5): the projected run with a FRESH lastSequence for
    // `expectedVersion` on the follow-up archive command.
    expect(run.lastSequence).toBeGreaterThan(0);
    const archive = await app.handle(
      req('POST', `/api/runs/${runId}/archive`, authedHeaders(), {
        expectedVersion: run.lastSequence,
      }),
    );
    expect(archive.status).toBe(200);
    expect((record(archive).run as RunProjection).archived).toBe(true);
    expect((await store.readRun(runId)).filter((e) => e.type === 'run.archived')).toHaveLength(1);
  });
});
