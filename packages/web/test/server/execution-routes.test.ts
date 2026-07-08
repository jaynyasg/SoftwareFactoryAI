/**
 * Execution command routes (full-factory U5) — exercised through the
 * framework-agnostic app with a REAL (unstarted) execution daemon so route
 * behavior is deterministic: routes enqueue/mutate ledger state and tests
 * drive the daemon manually via `tick()`.
 *
 * The four execution-note scenarios (duplicate start, stale-version rejection,
 * daemon singleton, abandoned lease recovery) are split across this file,
 * execution-daemon.test.ts, and execution-queue.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  projectRun,
  type EventStore,
  type RunProjection,
} from '@software-factory/core';
import {
  createApp,
  type ApiRequest,
  type ApiResponse,
  type App,
  type RunResearcher,
} from '../../src/server/app';
import {
  createExecutionDaemon,
  type ExecutionDaemon,
  type TicketExecutionContext,
  type TicketExecutionResult,
  type TicketExecutor,
} from '../../src/server/execution/daemon';
import { projectExecutionQueue } from '../../src/server/execution/queue';
import { projectInterventions } from '../../src/server/execution/interventions';
import type { PreflightRunner } from '../../src/server/execution/preflight';
import { handleMcpRequest } from '../../src/server/mcp';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

const MARKETPLACE_PROMPT =
  'Build an AI services marketplace with providers, proposals, and customer requests';

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

/** Timers that never fire — tests drive the daemon manually via `tick()`. */
function noopTimers() {
  return {
    setInterval: () => null,
    clearInterval: () => undefined,
  };
}

interface MakeExecAppResult {
  readonly app: App;
  readonly store: EventStore;
  readonly daemon: ExecutionDaemon;
}

function makeExecApp(
  options: {
    executor?: TicketExecutor;
    preflight?: PreflightRunner | null;
    researcher?: RunResearcher | null;
    maxAttempts?: number;
  } = {},
): MakeExecAppResult {
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
    executor: options.executor,
    timers: noopTimers(),
    config: options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : undefined,
  });
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    preflight: options.preflight,
    researcher: options.researcher,
  });
  return { app, store, daemon };
}

/**
 * A deterministic stub researcher (same shape as run-routes.test.ts): one
 * source, one finding, a completed brief.
 */
function stubResearcher(): RunResearcher {
  return async (store, runId) => {
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
      type: 'research.finding_recorded',
      payload: { findingId: 'f-1', statement: 'Stub finding.', classification: 'verified_fact' },
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

async function createPlannedRun(app: App, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.handle(
    req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT, ...body }),
  );
  expect(res.status).toBe(201);
  const runId = record(res).runId as string;
  expect(((record(res).run as RunProjection) ?? {}).status).toBe('planned');
  return runId;
}

async function types(store: EventStore, runId: string): Promise<string[]> {
  return (await store.readRun(runId)).map((event) => event.type);
}

/* ----------------------------------------------------------------------------
 * Scenario 1 (execution note): duplicate start
 * ------------------------------------------------------------------------- */

describe('POST /api/runs/:id/start — duplicate start protection', () => {
  it('starts a planned run once and does not double-enqueue on retry', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);

    const first = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(first.status).toBe(202);
    expect(record(first).queued).toBe(true);

    const afterFirst = await store.readRun(runId);
    expect(afterFirst.filter((e) => e.type === 'queue.enqueued')).toHaveLength(1);
    expect(afterFirst.some((e) => e.type === 'preflight.passed')).toBe(true);

    // A client retry of the start command must NOT enqueue a second job.
    const second = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(second.status).toBe(200);
    expect(record(second).alreadyQueued).toBe(true);

    const afterSecond = await store.readRun(runId);
    expect(afterSecond.filter((e) => e.type === 'queue.enqueued')).toHaveLength(1);
    // Preflight is not re-run for an already-queued run either.
    expect(afterSecond.filter((e) => e.type === 'preflight.started')).toHaveLength(1);

    const queue = projectExecutionQueue(afterSecond, runId);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].status).toBe('queued');
    expect(queue.jobs[0].attempt).toBe(1);

    // The run projects the honest queue state — never a fake start.
    expect(projectRun(afterSecond, runId).executionState).toBe('queued');
    expect(afterSecond.some((e) => e.type === 'run.started')).toBe(false);
  });
});

/* ----------------------------------------------------------------------------
 * Scenario 2 (execution note): stale-version rejection
 * ------------------------------------------------------------------------- */

describe('execution commands — stale-version rejection', () => {
  it('rejects a stale start command with 409 and enqueues nothing', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/start`, authedHeaders(), { expectedVersion: 1 }),
    );
    expect(res.status).toBe(409);
    expect(record(res).error).toBe('stale_subject_version');

    const seen = await types(store, runId);
    expect(seen).toContain('security.command_rejected');
    expect(seen).not.toContain('queue.enqueued');
    expect(seen.some((t) => t.startsWith('preflight.'))).toBe(false);
    expect(seen.some((t) => t.startsWith('execution.'))).toBe(false);
  });

  it('rejects a stale retry command with 409 and enqueues nothing new', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    const before = (await store.readRun(runId)).filter((e) => e.type === 'queue.enqueued').length;

    const res = await app.handle(
      req('POST', `/api/runs/${runId}/retry`, authedHeaders(), { expectedVersion: 1 }),
    );
    expect(res.status).toBe(409);
    expect(record(res).error).toBe('stale_subject_version');
    const after = (await store.readRun(runId)).filter((e) => e.type === 'queue.enqueued').length;
    expect(after).toBe(before);
  });
});

/* ----------------------------------------------------------------------------
 * Preflight gates start (X2)
 * ------------------------------------------------------------------------- */

describe('preflight blocks start (X2)', () => {
  it('a failed preflight blocks start with actionable interventions and no enqueue', async () => {
    const { app, store } = makeExecApp();
    // A repo-sourced run whose workspace was never materialized.
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });

    const res = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(res.status).toBe(422);
    expect(record(res).error).toBe('preflight_failed');

    const preflight = record(res).preflight as { ok: boolean; failedChecks: string[] };
    expect(preflight.ok).toBe(false);
    expect(preflight.failedChecks).toContain('workspace');

    // Actionable intervention entries, not partial worker execution.
    const interventions = record(res).interventions as {
      kind: string;
      blockingStage: string;
      requiredAction: string;
      status: string;
    }[];
    expect(interventions.length).toBeGreaterThan(0);
    expect(interventions.every((i) => i.blockingStage === 'preflight')).toBe(true);
    expect(interventions.every((i) => i.requiredAction.length > 0)).toBe(true);

    const seen = await types(store, runId);
    expect(seen).toContain('preflight.failed');
    expect(seen).not.toContain('queue.enqueued');
    expect(seen).not.toContain('run.started');
    expect(seen).not.toContain('worker.started');
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('blocked');
  });
});

/* ----------------------------------------------------------------------------
 * Pause / resume / cancel semantics
 * ------------------------------------------------------------------------- */

describe('pause, resume, and cancel', () => {
  it('pause stops new worker starts; resume lets the daemon claim again', async () => {
    let executed = 0;
    const { app, store, daemon } = makeExecApp({
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const paused = await app.handle(req('POST', `/api/runs/${runId}/pause`, authedHeaders(), {}));
    expect(paused.status).toBe(200);
    expect((record(paused).execution as { state: string }).state).toBe('paused');

    // The daemon must NOT claim queued work for a paused run.
    const tickWhilePaused = await daemon.tick();
    expect(tickWhilePaused.claimed).toBe(0);
    expect(executed).toBe(0);

    const resumed = await app.handle(
      req('POST', `/api/runs/${runId}/resume`, authedHeaders(), {}),
    );
    expect(resumed.status).toBe(200);

    const tickAfterResume = await daemon.tick();
    expect(tickAfterResume.claimed).toBe(1);
    expect(executed).toBe(1);
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('completed');
  });

  it('pause rejects runs with no active execution', async () => {
    const { app } = makeExecApp();
    const runId = await createPlannedRun(app);
    const res = await app.handle(req('POST', `/api/runs/${runId}/pause`, authedHeaders(), {}));
    expect(res.status).toBe(422);
    expect(record(res).error).toBe('execution_not_active');
  });

  it('cancel propagates to queued work', async () => {
    const { app, store, daemon } = makeExecApp();
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const cancel = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'operator stop' }),
    );
    expect(cancel.status).toBe(200);

    const events = await store.readRun(runId);
    const released = events.find((e) => e.type === 'queue.released');
    expect(released).toBeDefined();
    expect((released?.payload as { outcome?: string }).outcome).toBe('cancelled');
    expect(projectRun(events, runId).executionState).toBe('cancelled');

    // The daemon never claims work for the cancelled run.
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);
  });

  it('cancel propagates to ACTIVE (in-flight) work via the abort signal', async () => {
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const { app, store, daemon } = makeExecApp({
      executor: (ctx): Promise<TicketExecutionResult> =>
        new Promise((resolve) => {
          startedResolve?.();
          ctx.signal.addEventListener('abort', () =>
            resolve({ status: 'yielded', reason: 'aborted mid-flight' }),
          );
        }),
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const tickPromise = daemon.tick(); // claims and blocks inside the executor
    await started;
    const cancel = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'stop now' }),
    );
    expect(cancel.status).toBe(200);
    await tickPromise;

    const events = await store.readRun(runId);
    const releases = events.filter((e) => e.type === 'queue.released');
    expect(releases.length).toBeGreaterThan(0);
    expect(
      releases.some((e) => (e.payload as { outcome?: string }).outcome === 'cancelled'),
    ).toBe(true);
    expect(projectRun(events, runId).executionState).toBe('cancelled');
  });
});

/* ----------------------------------------------------------------------------
 * Retry, budget, and abandoned-lease resolution
 * ------------------------------------------------------------------------- */

describe('retry command', () => {
  it('re-enqueues a failed execution and enforces the bounded retry budget', async () => {
    let attempts = 0;
    const { app, store, daemon } = makeExecApp({
      maxAttempts: 2,
      executor: (): Promise<TicketExecutionResult> => {
        attempts += 1;
        return Promise.resolve({ status: 'failed', reason: `attempt ${attempts} exploded` });
      },
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    await daemon.tick();

    let run = projectRun(await store.readRun(runId), runId);
    expect(run.executionState).toBe('failed');
    expect(run.executionReason).toContain('attempt 1 exploded');

    const retry = await app.handle(req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}));
    expect(retry.status).toBe(202);
    expect((record(retry).job as { attempt: number }).attempt).toBe(2);
    await daemon.tick();
    expect(attempts).toBe(2);

    // Attempt 3 exceeds maxAttempts=2: rejected, nothing enqueued.
    const exhausted = await app.handle(
      req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}),
    );
    expect(exhausted.status).toBe(422);
    expect(record(exhausted).error).toBe('retry_budget_exhausted');
    const enqueues = (await store.readRun(runId)).filter((e) => e.type === 'queue.enqueued');
    expect(enqueues).toHaveLength(2);
  });

  it('retry after an abandoned lease resolves the retry_choice intervention and resumes', async () => {
    let executed = 0;
    const { app, store, daemon } = makeExecApp({
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'recovered' });
      },
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    // Simulate a previous incarnation that claimed the job and crashed: an
    // expired lease from a different owner.
    await store.append({
      runId,
      type: 'queue.claimed',
      actor: { kind: 'system', id: 'daemon-old' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: {
        jobId: `${runId}:execution`,
        jobKind: 'run-execution',
        attempt: 1,
        leaseId: 'lease-crashed',
        ownerId: 'daemon-old',
        leaseExpiresAt: 0, // long expired
      },
    });

    const tick = await daemon.tick();
    expect(tick.abandoned).toBe(1);
    expect(executed).toBe(0);
    let open = projectInterventions(await store.readRun(runId)).open;
    expect(open.some((i) => i.kind === 'retry_choice')).toBe(true);

    const retry = await app.handle(req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}));
    expect(retry.status).toBe(202);

    // The retry IS the operator's decision: the intervention is resolved.
    open = projectInterventions(await store.readRun(runId)).open;
    expect(open.some((i) => i.kind === 'retry_choice')).toBe(false);

    await daemon.tick();
    expect(executed).toBe(1);
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('completed');
  });
});

/* ----------------------------------------------------------------------------
 * research-plan-and-start consumes the recorded start request (U3 -> U5)
 * ------------------------------------------------------------------------- */

describe('run mode research-plan-and-start with execution enabled', () => {
  it('preflights and enqueues execution at creation instead of deferring', async () => {
    const { app, store } = makeExecApp({ researcher: stubResearcher() });
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'research-plan-and-start',
      }),
    );
    expect(res.status).toBe(201);
    expect(record(res).execution).toMatchObject({ state: 'queued' });

    const runId = record(res).runId as string;
    const seen = await types(store, runId);
    expect(seen).toContain('preflight.passed');
    expect(seen).toContain('queue.enqueued');
    // No defer decision and no fake start.
    const defer = (await store.readRun(runId)).find(
      (e) =>
        e.type === 'supervisor.decision' &&
        (e.payload as { decision?: string }).decision === 'defer-execution',
    );
    expect(defer).toBeUndefined();
    expect(seen).not.toContain('run.started');
  });

  it('idempotent re-create does not double-enqueue the recorded start request', async () => {
    const { app, store } = makeExecApp({ researcher: stubResearcher() });
    const body = {
      prompt: MARKETPLACE_PROMPT,
      mode: 'research-plan-and-start',
      idempotencyKey: 'k-exec-1',
    };
    const first = await app.handle(req('POST', '/api/runs', authedHeaders(), body));
    const second = await app.handle(req('POST', '/api/runs', authedHeaders(), body));
    expect(second.status).toBe(200);
    expect(record(second).deduplicated).toBe(true);

    const runId = record(first).runId as string;
    const events = await store.readRun(runId);
    expect(events.filter((e) => e.type === 'queue.enqueued')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'preflight.started')).toHaveLength(1);
  });
});

/* ----------------------------------------------------------------------------
 * Intervention queue routes (X4)
 * ------------------------------------------------------------------------- */

describe('intervention queue routes', () => {
  it('lists open interventions filterable by run/stage and resolves them (guarded)', async () => {
    const { app } = makeExecApp();
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const list = await app.handle(
      req('GET', '/api/interventions', {}, undefined),
    );
    expect(list.status).toBe(200);
    const all = record(list).interventions as { interventionId: string; runId: string }[];
    expect(all.length).toBeGreaterThan(0);
    const target = all[0];

    // Resolving requires the command guard.
    const denied = await app.handle(
      req(
        'POST',
        `/api/interventions/${encodeURIComponent(target.interventionId)}/resolve`,
        { origin: ORIGIN, 'x-csrf-token': CSRF },
        { resolution: 'approved' },
      ),
    );
    expect(denied.status).toBe(401);

    const resolved = await app.handle(
      req(
        'POST',
        `/api/interventions/${encodeURIComponent(target.interventionId)}/resolve`,
        authedHeaders(),
        { resolution: 'approved', note: 'checked manually' },
      ),
    );
    expect(resolved.status).toBe(200);
    expect((record(resolved).intervention as { status: string }).status).toBe('resolved');

    // Resolving again is a no-op.
    const again = await app.handle(
      req(
        'POST',
        `/api/interventions/${encodeURIComponent(target.interventionId)}/resolve`,
        authedHeaders(),
        { resolution: 'approved' },
      ),
    );
    expect(again.status).toBe(200);
    expect(record(again).alreadyResolved).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * GET /api/runs/:id/execution
 * ------------------------------------------------------------------------- */

describe('GET /api/runs/:id/execution', () => {
  it('returns the projected execution state, queue job, preflight, and open interventions', async () => {
    const { app } = makeExecApp();
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const res = await app.handle(req('GET', `/api/runs/${runId}/execution`, {}));
    expect(res.status).toBe(200);
    expect(record(res).execution).toMatchObject({ state: 'queued' });
    expect((record(res).job as { jobKind: string }).jobKind).toBe('run-execution');
    expect((record(res).preflight as { status: string }).status).toBe('passed');
    expect(record(res).interventions).toEqual([]);
  });

  it('404s for an unknown run', async () => {
    const { app } = makeExecApp();
    const res = await app.handle(req('GET', '/api/runs/missing/execution', {}));
    expect(res.status).toBe(404);
  });
});

/* ----------------------------------------------------------------------------
 * MCP execution tools (authorized hosted callers)
 * ------------------------------------------------------------------------- */

describe('MCP execution tools', () => {
  function mcpDeps(app: App): {
    app: App;
    getSession: () => Promise<{ operatorToken: string; csrfToken: string }>;
  } {
    return {
      app,
      getSession: () => Promise.resolve({ operatorToken: TOKEN, csrfToken: CSRF }),
    };
  }

  async function callTool(
    app: App,
    name: string,
    args: Record<string, unknown>,
    token = TOKEN,
  ): Promise<{ isError?: boolean; body: Record<string, unknown> }> {
    const res = await handleMcpRequest(
      {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        },
        headers: { authorization: `Bearer ${token}` },
      },
      mcpDeps(app),
    );
    const rpc = res.body as { result: { isError?: boolean; content: { text: string }[] } };
    return {
      isError: rpc.result.isError,
      body: JSON.parse(rpc.result.content[0].text) as Record<string, unknown>,
    };
  }

  it('lists the execution lifecycle tools', async () => {
    const { app } = makeExecApp();
    const res = await handleMcpRequest(
      { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: {} },
      mcpDeps(app),
    );
    const body = res.body as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((tool) => tool.name);
    for (const expected of [
      'software_factory_start_run',
      'software_factory_pause_run',
      'software_factory_resume_run',
      'software_factory_retry_run',
      'software_factory_rerun_gates',
      'software_factory_get_execution',
      'software_factory_list_interventions',
      'software_factory_resolve_intervention',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('authorized callers can start, inspect, and cancel execution', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);

    const started = await callTool(app, 'software_factory_start_run', { runId });
    expect(started.isError).toBe(false);
    expect(started.body.queued).toBe(true);

    const inspected = await callTool(app, 'software_factory_get_execution', { runId });
    expect(inspected.isError).toBe(false);
    expect((inspected.body.execution as { state: string }).state).toBe('queued');

    const run = projectRun(await store.readRun(runId), runId);
    const cancelled = await callTool(app, 'software_factory_cancel_run', {
      runId,
      expectedVersion: run.lastSequence,
    });
    expect(cancelled.isError).toBe(false);
    expect(
      projectRun(await store.readRun(runId), runId).executionState,
    ).toBe('cancelled');
  });

  it('rejects unauthorized execution commands before side effects', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);
    const before = (await store.readRun(runId)).length;

    const res = await callTool(app, 'software_factory_start_run', { runId }, 'wrong-token');
    expect(res.isError).toBe(true);

    expect((await store.readRun(runId)).length).toBe(before);
  });
});

/* ----------------------------------------------------------------------------
 * ChatGPT Action schema carries the same control verbs
 * ------------------------------------------------------------------------- */

describe('ChatGPT Action schema (integrations/chatgpt/actions.openai.yaml)', () => {
  const yaml = readFileSync(
    new URL('../../../../integrations/chatgpt/actions.openai.yaml', import.meta.url),
    'utf8',
  );

  it('declares the execution lifecycle operations', () => {
    for (const operationId of [
      'startRun',
      'pauseRun',
      'resumeRun',
      'retryRun',
      'rerunGates',
      'getExecution',
      'listInterventions',
      'resolveIntervention',
    ]) {
      expect(yaml, `missing operationId ${operationId}`).toContain(`operationId: ${operationId}`);
    }
    expect(yaml).toContain('/api/runs/{runId}/start');
    expect(yaml).toContain('/api/runs/{runId}/pause');
    expect(yaml).toContain('/api/runs/{runId}/resume');
    expect(yaml).toContain('/api/runs/{runId}/retry');
    expect(yaml).toContain('/api/runs/{runId}/gates/rerun');
    expect(yaml).toContain('/api/runs/{runId}/execution');
    expect(yaml).toContain('/api/interventions');
  });

  it('exposes run modes on run creation', () => {
    expect(yaml).toContain('research-plan-and-start');
  });
});
