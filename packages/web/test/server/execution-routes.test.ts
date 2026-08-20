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
import { describe, expect, it, vi } from 'vitest';
import {
  AdapterError,
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  projectRun,
  type EventStore,
  type ExecutionAdapter,
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
  type TicketExecutionResult,
  type TicketExecutor,
} from '../../src/server/execution/daemon';
import { projectExecutionQueue } from '../../src/server/execution/queue';
import { projectInterventions } from '../../src/server/execution/interventions';
import type { PreflightRunner } from '../../src/server/execution/preflight';
import type { RunWorkspaceMaterializer } from '../../src/server/workspace/runtime-materializer';
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

interface MakeExecAppResult {
  readonly app: App;
  readonly store: EventStore;
  readonly daemon: ExecutionDaemon;
}

/** An app with NO execution daemon wired (execution disabled on this instance). */
function makeDaemonlessApp(): { app: App; store: EventStore } {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: null,
  });
  return { app, store };
}

function makeExecApp(
  options: {
    executor?: TicketExecutor;
    preflight?: PreflightRunner | null;
    researcher?: RunResearcher | null;
    /** Workspace materializer (start auto-materializes; default null so unit
     * tests never reach the real runtime materializer / the network). */
    materializer?: RunWorkspaceMaterializer | null;
    maxAttempts?: number;
    autoStart?: boolean;
    /** Wrap the shared store (e.g. to inject targeted append failures). */
    wrapStore?: (store: EventStore) => EventStore;
  } = {},
): MakeExecAppResult {
  const det = deterministic();
  const baseStore = createInMemoryEventStore(det);
  const store = options.wrapStore === undefined ? baseStore : options.wrapStore(baseStore);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;
  // Build the partial config without spreading `undefined` values (a spread
  // would override the daemon's static defaults with undefined).
  const execConfig: { maxAttempts?: number; autoStart?: boolean } = {};
  if (options.maxAttempts !== undefined) {
    execConfig.maxAttempts = options.maxAttempts;
  }
  if (options.autoStart !== undefined) {
    execConfig.autoStart = options.autoStart;
  }
  const daemon = createExecutionDaemon({
    store,
    clock: det.clock,
    idGenerator: () => `lease-${(leaseSeq += 1)}`,
    ownerId: 'daemon-test',
    executor: options.executor,
    timers: noopTimers(),
    config: Object.keys(execConfig).length > 0 ? execConfig : undefined,
  });
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    preflight: options.preflight,
    researcher: options.researcher,
    materializer: options.materializer ?? null,
    // Deterministic ready catalog: these route tests exercise queue/daemon
    // semantics, not real CLI setup probing (covered by execution-worker tests).
    adapterCatalog: createAdapterCatalog([readyFakeAdapter()]),
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

  it('start auto-materializes a requested-but-unready source workspace first', async () => {
    const materialized: string[] = [];
    const { app } = makeExecApp({
      materializer: (store, runId) => {
        materialized.push(runId);
        return Promise.resolve({
          ok: false,
          outcome: 'checkout_failed',
          reason: 'fake',
          attempt: 1,
        });
      },
    });

    // A repo-sourced run: Start must trigger materialization before preflight.
    const sourced = await createPlannedRun(app, { githubRepo: 'octo/app' });
    await app.handle(req('POST', `/api/runs/${sourced}/start`, authedHeaders(), {}));
    expect(materialized).toEqual([sourced]);

    // A prompt-only run (fresh generated workspace) never materializes.
    const promptOnly = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${promptOnly}/start`, authedHeaders(), {}));
    expect(materialized).toEqual([sourced]);
  });

  it('a repeated rehearsal supersedes prior attempts — one open entry per failing check', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });

    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const projection = projectInterventions(await store.readRun(runId));
    const preflightItems = projection.interventions.filter(
      (item) => item.blockingStage === 'preflight',
    );
    const openItems = preflightItems.filter((item) => item.status === 'open');

    // Attempt 2 raised fresh entries; attempt 1's were auto-resolved as
    // superseded — the queue mirrors the LATEST rehearsal, never a pile-up.
    const openChecks = openItems.map((item) => item.interventionId.split(':')[2]);
    expect(new Set(openChecks).size).toBe(openChecks.length);
    expect(openItems.every((item) => item.interventionId.endsWith(':2'))).toBe(true);

    const superseded = preflightItems.filter((item) => item.status === 'resolved');
    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded.every((item) => item.interventionId.endsWith(':1'))).toBe(true);
    expect(superseded.every((item) => /Superseded/.test(item.resolution ?? ''))).toBe(true);
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

    const resumed = await app.handle(req('POST', `/api/runs/${runId}/resume`, authedHeaders(), {}));
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

  it('rejects cancel on a terminal (completed) run instead of flipping it retroactively', async () => {
    const { app, store, daemon } = makeExecApp({
      executor: (): Promise<TicketExecutionResult> =>
        Promise.resolve({ status: 'completed', summary: 'done' }),
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    await daemon.tick();
    // The executor completed the queue job; record the run's own completion
    // (the scheduler executor emits this in production).
    await store.append({
      runId,
      type: 'run.completed',
      actor: { kind: 'system', id: 'ticket-executor' },
      subject: { kind: 'run', id: runId },
      severity: 'success',
      idempotencyKey: `${runId}:run.completed`,
      payload: { summary: 'all done' },
    });

    const res = await app.handle(req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), {}));
    expect(res.status).toBe(422);
    expect(record(res).error).toBe('run_terminal');
    const events = await store.readRun(runId);
    expect(events.some((e) => e.type === 'run.cancelled')).toBe(false);
    expect(projectRun(events, runId).status).toBe('completed');
  });

  it('repeat cancel is idempotent: one run.cancelled event, alreadyCancelled response', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);

    const first = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'operator stop' }),
    );
    expect(first.status).toBe(200);
    expect((record(first).run as RunProjection).status).toBe('cancelled');

    const second = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'again' }),
    );
    expect(second.status).toBe(200);
    expect(record(second).alreadyCancelled).toBe(true);

    const events = await store.readRun(runId);
    expect(events.filter((e) => e.type === 'run.cancelled')).toHaveLength(1);
  });

  it('cancel resolves the run’s open interventions so the queue drops them', async () => {
    const { app, store } = makeExecApp();
    // A repo-sourced run with no workspace: the failed preflight leaves OPEN
    // interventions blocking the run.
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });
    const blocked = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(blocked.status).toBe(422);
    const openBefore = projectInterventions(await store.readRun(runId)).open;
    expect(openBefore.length).toBeGreaterThan(0);

    const cancel = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'operator stop' }),
    );
    expect(cancel.status).toBe(200);

    // A cancelled run never resumes: its interventions must not sit
    // 'open'/'blocking' on the factory floor forever.
    const projection = projectInterventions(await store.readRun(runId));
    expect(projection.open).toHaveLength(0);
    for (const { interventionId } of openBefore) {
      expect(projection.byId[interventionId]?.status).toBe('resolved');
      expect(projection.byId[interventionId]?.resolution).toBe('cancelled');
    }

    // The cross-run queue's open count drops with them.
    const list = await app.handle(req('GET', '/api/interventions', {}, undefined));
    expect(record(list).openCount).toBe(0);
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
    expect(releases.some((e) => (e.payload as { outcome?: string }).outcome === 'cancelled')).toBe(
      true,
    );
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

    const run = projectRun(await store.readRun(runId), runId);
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

  it('safe yields (pause/shutdown requeues) never consume the operator retry budget', async () => {
    // maxAttempts=2, but the job yields safely THREE times before its first
    // real failure: raw attempt numbers blow past the budget while ledger
    // failure evidence stays at zero. The operator must still be able to
    // retry after the first real failure.
    const script: TicketExecutionResult[] = [
      { status: 'yielded', reason: 'graceful shutdown 1' },
      { status: 'yielded', reason: 'graceful shutdown 2' },
      { status: 'yielded', reason: 'graceful shutdown 3' },
      { status: 'failed', reason: 'first real failure' },
      { status: 'completed', summary: 'finally done' },
    ];
    const { app, store, daemon } = makeExecApp({
      maxAttempts: 2,
      executor: (): Promise<TicketExecutionResult> =>
        Promise.resolve(script.shift() ?? { status: 'completed' }),
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    // Three safe yields: each requeues the SAME work at attempt+1.
    await daemon.tick();
    await daemon.tick();
    await daemon.tick();
    const requeued = projectExecutionQueue(await store.readRun(runId), runId).jobs[0];
    expect(requeued.status).toBe('queued');
    expect(requeued.attempt).toBe(4); // raw attempts already exceed maxAttempts=2

    // First REAL failure (failure evidence = 1).
    await daemon.tick();
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('failed');

    // The retry budget is ledger-derived failure evidence, not the raw
    // attempt number: this retry MUST be accepted (1 failure < 2 budget).
    const retry = await app.handle(req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}));
    expect(retry.status).toBe(202);
    await daemon.tick();
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('completed');
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

    const list = await app.handle(req('GET', '/api/interventions', {}, undefined));
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
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('cancelled');
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
 * Factory-wide execution controls (drain gate) + cancel-all
 * ------------------------------------------------------------------------- */

describe('factory-wide execution controls', () => {
  it('GET /api/execution reports the drain gate state and cross-run job counts', async () => {
    const { app, daemon } = makeExecApp({ autoStart: false });
    expect(daemon.held).toBe(true);

    const runId = await createPlannedRun(app);
    const started = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    // A queued start while the gate is engaged says so: the job WAITS.
    expect(started.status).toBe(202);
    expect(record(started).queued).toBe(true);
    expect(record(started).held).toBe(true);

    const res = await app.handle(req('GET', '/api/execution', {}));
    expect(res.status).toBe(200);
    expect(record(res).execution).toMatchObject({ enabled: true, held: true });
    expect(record(res).queue).toMatchObject({ queued: 1, leased: 0 });
  });

  it('GET /api/execution without a daemon still reports LEDGER queue counts', async () => {
    // Execution disabled on THIS instance, but queued work exists on the
    // ledger (e.g. enqueued by an instance that HAS a daemon): the overview
    // must report the real cross-run counts, never hardcoded zeros.
    const { app, store } = makeDaemonlessApp();
    await store.append({
      runId: 'run-q',
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: 'run-q:execution' },
      severity: 'info',
      payload: { jobId: 'run-q:execution', jobKind: 'run-execution', attempt: 1 },
    });

    const res = await app.handle(req('GET', '/api/execution', {}));
    expect(res.status).toBe(200);
    expect(record(res).execution).toEqual({ enabled: false, held: false, running: false });
    expect(record(res).queue).toEqual({ queued: 1, leased: 0 });
  });

  it('resume requires the command guard, releases the gate, and is idempotent', async () => {
    let executed = 0;
    const { app, store, daemon } = makeExecApp({
      autoStart: false,
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    const runId = await createPlannedRun(app);
    // Leftover queued work from BEFORE this process booted: on the ledger, but
    // no explicit operator start command was issued in THIS process, so the
    // boot drain gate applies (explicit starts bypass it — see the next test).
    await store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });

    // The held daemon runs NOTHING it was not explicitly told to start.
    const heldTick = await daemon.tick();
    expect(heldTick.claimed).toBe(0);
    expect(executed).toBe(0);

    // Unauthorized resume is rejected before any side effects.
    const denied = await app.handle(
      req('POST', '/api/execution/resume', { origin: ORIGIN, 'x-csrf-token': CSRF }, {}),
    );
    expect(denied.status).toBe(401);
    expect(daemon.held).toBe(true);

    const resumed = await app.handle(req('POST', '/api/execution/resume', authedHeaders(), {}));
    expect(resumed.status).toBe(200);
    expect(record(resumed).resumed).toBe(true);
    // `running` rides along so a caller can spot a released gate on a daemon
    // whose loop is not draining (these tests drive tick() manually, so the
    // loop is honestly not running).
    expect(record(resumed).running).toBe(false);
    expect(daemon.held).toBe(false);

    await daemon.tick();
    expect(executed).toBe(1);

    // Repeat resume converges instead of erroring.
    const again = await app.handle(req('POST', '/api/execution/resume', authedHeaders(), {}));
    expect(again.status).toBe(200);
    expect(record(again).alreadyActive).toBe(true);
    expect(record(again).running).toBe(false);
  });

  it('mode plan-and-start enqueues execution at creation and runs it even while boot-held', async () => {
    let executed = 0;
    const { app, store, daemon } = makeExecApp({
      autoStart: false,
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    expect(daemon.held).toBe(true);

    // ONE operator action: create with plan-and-start. Planning completes and
    // the execution job is preflighted + enqueued in the same request.
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        mode: 'plan-and-start',
      }),
    );
    expect(res.status).toBe(201);
    const runId = record(res).runId as string;
    expect(record(res).execution).toMatchObject({ state: 'queued' });

    // The explicit create-with-start is attended intent: the boot drain gate
    // does not demand a second confirmation for this run.
    await daemon.tick();
    expect(executed).toBe(1);
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('completed');
  });

  it('an explicit operator start bypasses the boot drain gate for THAT run only', async () => {
    let executed = 0;
    const { app, store, daemon } = makeExecApp({
      autoStart: false,
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    expect(daemon.held).toBe(true);

    // Leftover work from a previous process: queued on the ledger, never
    // explicitly started in THIS process — must stay behind the gate.
    const leftoverRunId = await createPlannedRun(app);
    await store.append({
      runId: leftoverRunId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${leftoverRunId}:execution` },
      severity: 'info',
      payload: { jobId: `${leftoverRunId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });

    // An explicit authenticated Start is attended operator intent: the gate
    // exists to stop unattended boot-time drain, not to demand a second
    // confirmation, so THIS run executes immediately even while held.
    const startedRunId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${startedRunId}/start`, authedHeaders(), {}));
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);
    expect(executed).toBe(1);
    expect(daemon.held).toBe(true);

    // The leftover job is untouched: still queued, still waiting for an
    // operator resume (or its own explicit start).
    const leftoverQueue = projectExecutionQueue(await store.readRun(leftoverRunId), leftoverRunId);
    expect(leftoverQueue.jobs[0].status).toBe('queued');

    // An explicit factory hold revokes earlier per-run grants: a run started
    // BEFORE the hold no longer bypasses the gate afterwards.
    const revokedRunId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${revokedRunId}/start`, authedHeaders(), {}));
    await app.handle(req('POST', '/api/execution/hold', authedHeaders(), {}));
    const gatedTick = await daemon.tick();
    expect(gatedTick.claimed).toBe(0);
    expect(executed).toBe(1);
  });

  it('hold re-engages the gate so no NEW work is claimed (and is idempotent)', async () => {
    let executed = 0;
    const { app, daemon } = makeExecApp({
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    expect(daemon.held).toBe(false);
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const held = await app.handle(req('POST', '/api/execution/hold', authedHeaders(), {}));
    expect(held.status).toBe(200);
    expect(record(held).held).toBe(true);
    expect(record(held).running).toBe(false);
    expect(daemon.held).toBe(true);

    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);
    expect(executed).toBe(0);

    const again = await app.handle(req('POST', '/api/execution/hold', authedHeaders(), {}));
    expect(again.status).toBe(200);
    expect(record(again).alreadyHeld).toBe(true);
    expect(record(again).running).toBe(false);
  });

  it('resume and hold fail closed with execution_disabled when no daemon is wired', async () => {
    const { app } = makeDaemonlessApp();
    // Authed + guard-passing requests still 503: there is no gate to operate.
    for (const path of ['/api/execution/resume', '/api/execution/hold']) {
      const res = await app.handle(req('POST', path, authedHeaders(), {}));
      expect(res.status).toBe(503);
      expect(record(res)).toEqual({
        error: 'execution_disabled',
        message: 'Execution controls are not enabled on this server instance.',
      });
    }
  });

  it('a run-level resume never lets queued work bypass the factory drain gate', async () => {
    let executed = 0;
    const { app, store, daemon } = makeExecApp({
      autoStart: false,
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    const runId = await createPlannedRun(app);
    // Leftover queued work from a previous process: no explicit start command
    // was issued in THIS process, so the boot drain gate applies to it.
    await store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });

    // Pause then resume the RUN: the run-level gate reopens (and the route
    // notifies the daemon), but the FACTORY gate is still engaged — a
    // run-level resume is NOT a start command and never grants a gate bypass.
    await app.handle(req('POST', `/api/runs/${runId}/pause`, authedHeaders(), {}));
    const resumed = await app.handle(req('POST', `/api/runs/${runId}/resume`, authedHeaders(), {}));
    expect(resumed.status).toBe(200);
    expect(record(resumed).resumed).toBe(true);

    // The job stays queued and NOTHING executes while the factory is held.
    const tickWhileHeld = await daemon.tick();
    expect(tickWhileHeld.claimed).toBe(0);
    expect(executed).toBe(0);
    const queueHeld = projectExecutionQueue(await store.readRun(runId), runId);
    expect(queueHeld.jobs[0].status).toBe('queued');

    // Only the operator's FACTORY resume releases the waiting job.
    const factoryResume = await app.handle(
      req('POST', '/api/execution/resume', authedHeaders(), {}),
    );
    expect(factoryResume.status).toBe(200);
    await daemon.tick();
    expect(executed).toBe(1);
    expect(projectRun(await store.readRun(runId), runId).executionState).toBe('completed');
  });
});

describe('POST /api/runs/cancel-all', () => {
  it('cancels every cancellable run, converges on cancelled ones, and skips terminal ones', async () => {
    const { app, store, daemon } = makeExecApp();
    const active = await createPlannedRun(app); // planned, never started
    const queued = await createPlannedRun(app); // planned + queued execution
    await app.handle(req('POST', `/api/runs/${queued}/start`, authedHeaders(), {}));
    const preCancelled = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${preCancelled}/cancel`, authedHeaders(), {}));
    const failed = await createPlannedRun(app);
    await store.append({
      runId: failed,
      type: 'run.failed',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: failed },
      severity: 'error',
      payload: { reason: 'exploded before cancel-all' },
    });

    const res = await app.handle(
      req('POST', '/api/runs/cancel-all', authedHeaders(), { reason: 'operator cancel-all' }),
    );
    expect(res.status).toBe(200);
    const body = record(res) as {
      cancelled: string[];
      alreadyCancelled: string[];
      skippedTerminal: string[];
      cancelledCount: number;
    };
    expect(body.cancelled.sort()).toEqual([active, queued].sort());
    expect(body.alreadyCancelled).toEqual([preCancelled]);
    expect(body.skippedTerminal).toEqual([failed]);
    expect(body.cancelledCount).toBe(2);

    // Every cancelled run projects cancelled; the queued job was released.
    for (const runId of [active, queued, preCancelled]) {
      expect(projectRun(await store.readRun(runId), runId).status).toBe('cancelled');
    }
    const queuedEvents = await store.readRun(queued);
    const released = queuedEvents.find((e) => e.type === 'queue.released');
    expect((released?.payload as { outcome?: string } | undefined)?.outcome).toBe('cancelled');
    // The terminal run keeps its recorded outcome.
    expect(projectRun(await store.readRun(failed), failed).status).toBe('failed');

    // The daemon has nothing left to claim.
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);

    // Repeat cancel-all converges: everything is already cancelled/terminal.
    const again = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    expect(again.status).toBe(200);
    expect((record(again) as { cancelledCount: number }).cancelledCount).toBe(0);
  });

  it('cancel-all with no runs at all returns the honest all-empty result', async () => {
    const { app } = makeExecApp();
    const res = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    // Nothing cancelled, nothing skipped, and no phantom `errors` key.
    expect(record(res)).toEqual({
      cancelled: [],
      alreadyCancelled: [],
      skippedTerminal: [],
      cancelledCount: 0,
    });
  });

  it('cancel-all without a daemon still cancels runs on the ledger (no propagation)', async () => {
    const { app, store } = makeDaemonlessApp();
    const runId = await createPlannedRun(app);

    const res = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    const body = record(res) as {
      cancelled: string[];
      cancelledCount: number;
      errors?: unknown;
    };
    expect(body.cancelled).toEqual([runId]);
    expect(body.cancelledCount).toBe(1);
    // No daemon means no propagation attempt — and no phantom error entry.
    expect(body.errors).toBeUndefined();

    const events = await store.readRun(runId);
    expect(events.some((e) => e.type === 'run.cancelled')).toBe(true);
    expect(projectRun(events, runId).status).toBe('cancelled');
    // Nothing was enqueued and nothing needed releasing on this instance.
    expect(events.some((e) => e.type.startsWith('queue.'))).toBe(false);
  });

  it('requires the command guard before cancelling anything', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);

    const denied = await app.handle(
      req('POST', '/api/runs/cancel-all', { origin: ORIGIN, 'x-csrf-token': CSRF }, {}),
    );
    expect(denied.status).toBe(401);
    expect(projectRun(await store.readRun(runId), runId).status).toBe('planned');
    expect((await store.readRun(runId)).some((e) => e.type === 'run.cancelled')).toBe(false);
  });

  it('cancel-all aborts ACTIVE in-flight work via the abort signal', async () => {
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const { app, store, daemon } = makeExecApp({
      executor: (ctx): Promise<TicketExecutionResult> =>
        new Promise((resolve) => {
          startedResolve?.();
          ctx.signal.addEventListener('abort', () =>
            resolve({ status: 'yielded', reason: 'aborted by cancel-all' }),
          );
        }),
    });
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));

    const tickPromise = daemon.tick(); // claims and blocks inside the executor
    await started;
    const res = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect((record(res) as { cancelled: string[] }).cancelled).toEqual([runId]);
    await tickPromise;

    const events = await store.readRun(runId);
    expect(
      events.some(
        (e) =>
          e.type === 'queue.released' &&
          (e.payload as { outcome?: string }).outcome === 'cancelled',
      ),
    ).toBe(true);
    expect(projectRun(events, runId).executionState).toBe('cancelled');
  });

  it('cancel-all with work across TWO runs aborts in-flight work promptly and never executes the later run', async () => {
    // The daemon drains sequentially, so run A's executor is in-flight while
    // run B's job waits queued behind it. The OLD per-run chained cancel
    // deadlocked here: aborting A let the pass continue into B's executor,
    // whose abort would never come. The two-phase cancel appends BOTH
    // run.cancelled events first, aborts every in-flight controller before
    // any chained pass, and the post-claim cancellation gate stops B's
    // executor from ever starting.
    const abortedRuns: string[] = [];
    const executedRuns: string[] = [];
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const { app, store, daemon } = makeExecApp({
      executor: (ctx): Promise<TicketExecutionResult> =>
        new Promise((resolve) => {
          executedRuns.push(ctx.runId);
          startedResolve?.();
          ctx.signal.addEventListener('abort', () => {
            abortedRuns.push(ctx.runId);
            resolve({ status: 'yielded', reason: 'aborted by cancel-all' });
          });
        }),
    });
    const first = await createPlannedRun(app);
    const second = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${first}/start`, authedHeaders(), {}));
    await app.handle(req('POST', `/api/runs/${second}/start`, authedHeaders(), {}));

    const tickPromise = daemon.tick(); // claims one run, blocks in its executor
    await started;
    // Exactly ONE executor is in-flight; the other run's job waits queued.
    expect(executedRuns).toHaveLength(1);
    const inFlightRun = executedRuns[0];

    const res = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect((record(res) as { cancelled: string[] }).cancelled.sort()).toEqual(
      [first, second].sort(),
    );
    await tickPromise;

    // The in-flight executor was aborted; the OTHER run's executor NEVER ran.
    expect(abortedRuns).toEqual([inFlightRun]);
    expect(executedRuns).toEqual([inFlightRun]);
    for (const runId of [first, second]) {
      const events = await store.readRun(runId);
      expect(
        events.some(
          (e) =>
            e.type === 'queue.released' &&
            (e.payload as { outcome?: string }).outcome === 'cancelled',
        ),
        `run ${runId} released as cancelled`,
      ).toBe(true);
      expect(projectRun(events, runId).executionState).toBe('cancelled');
    }
  });

  it('an append failure for one run still cancels the others and reports errors', async () => {
    // The wrapped store refuses run-2's `run.cancelled` append; every other
    // write (queue, interventions, the other runs' cancels) works normally.
    const { app, store } = makeExecApp({
      wrapStore: (base) => ({
        ...base,
        append: (event) =>
          event.type === 'run.cancelled' && event.runId === 'run-2'
            ? Promise.reject(new Error('ledger write refused'))
            : base.append(event),
      }),
    });
    const first = await createPlannedRun(app); // run-1
    const failing = await createPlannedRun(app); // run-2
    const last = await createPlannedRun(app); // run-3
    expect(failing).toBe('run-2');

    const res = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    // The batch reports 200 with the failure COLLECTED, never a 500 with the
    // earlier cancellations already committed.
    expect(res.status).toBe(200);
    const body = record(res) as {
      cancelled: string[];
      cancelledCount: number;
      errors?: { runId: string; message: string }[];
    };
    expect(body.cancelled.sort()).toEqual([first, last].sort());
    expect(body.cancelledCount).toBe(2);
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0].runId).toBe(failing);
    expect(body.errors?.[0].message).toContain('ledger write refused');

    for (const runId of [first, last]) {
      expect(projectRun(await store.readRun(runId), runId).status).toBe('cancelled');
    }
    expect(projectRun(await store.readRun(failing), failing).status).toBe('planned');
  });

  it('cancel-all resolves every cancelled run’s open interventions', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app, { githubRepo: 'octo/app' });
    const blocked = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
    expect(blocked.status).toBe(422);
    expect(projectInterventions(await store.readRun(runId)).open.length).toBeGreaterThan(0);

    const res = await app.handle(req('POST', '/api/runs/cancel-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect((record(res) as { cancelled: string[] }).cancelled).toEqual([runId]);

    const projection = projectInterventions(await store.readRun(runId));
    expect(projection.open).toHaveLength(0);
    const list = await app.handle(req('GET', '/api/interventions', {}, undefined));
    expect(record(list).openCount).toBe(0);
  });

  it('a denied cancel-all lands an audit record on the reserved factory stream', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { app, store } = makeExecApp();
      await createPlannedRun(app);

      const denied = await app.handle(
        req('POST', '/api/runs/cancel-all', { origin: ORIGIN, 'x-csrf-token': CSRF }, {}),
      );
      expect(denied.status).toBe(401);

      // Factory-scoped commands have no run of their own: the denial is
      // durable on the reserved 'factory' stream…
      const audit = await store.readRun('factory');
      expect(audit).toHaveLength(1);
      expect(audit[0].type.startsWith('security.')).toBe(true);
      expect(audit[0].subject).toMatchObject({ kind: 'factory', id: 'runs' });
      // …and logged, since no run page will ever surface it.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('run.cancel_all'));

      // The phantom 'factory' stream never surfaces as a run (isRealRun).
      const runs = await app.handle(req('GET', '/api/runs', {}));
      const listed = (record(runs).runs as { runId: string }[]).map((run) => run.runId);
      expect(listed).not.toContain('factory');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('POST /api/runs/clear-all', () => {
  it('cancels active runs, deletes every terminal run ledger, and keeps live evidence', async () => {
    const { app, store, daemon } = makeExecApp();
    const active = await createPlannedRun(app); // cancellable → cancelled → deleted
    const preCancelled = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${preCancelled}/cancel`, authedHeaders(), {}));
    const failed = await createPlannedRun(app);
    await store.append({
      runId: failed,
      type: 'run.failed',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: failed },
      severity: 'error',
      payload: { reason: 'exploded before clear-all' },
    });

    const res = await app.handle(
      req('POST', '/api/runs/clear-all', authedHeaders(), { reason: 'operator clear-all' }),
    );
    expect(res.status).toBe(200);
    const body = record(res) as {
      cleared: string[];
      clearedCount: number;
      cancelled: string[];
      skipped: { runId: string; status: string }[];
      errors?: unknown;
    };
    expect(body.cancelled).toEqual([active]);
    expect(body.cleared.sort()).toEqual([active, failed, preCancelled].sort());
    expect(body.clearedCount).toBe(3);
    expect(body.skipped).toEqual([]);
    expect(body.errors).toBeUndefined();

    // The ledgers are GONE, not just projected differently.
    for (const runId of [active, preCancelled, failed]) {
      expect(await store.readRun(runId)).toEqual([]);
    }
    const runs = await app.handle(req('GET', '/api/runs', {}));
    expect(record(runs).runs).toEqual([]);
    // The queue overview holds no phantom jobs from the deleted runs.
    const overview = await app.handle(req('GET', '/api/execution', {}));
    expect(record(overview).queue).toEqual({ queued: 0, leased: 0 });

    // The daemon's next pass sees a clean ledger.
    const tick = await daemon.tick();
    expect(tick.claimed).toBe(0);

    // Repeat clear-all converges on the empty ledger.
    const again = await app.handle(req('POST', '/api/runs/clear-all', authedHeaders(), {}));
    expect(again.status).toBe(200);
    expect((record(again) as { clearedCount: number }).clearedCount).toBe(0);
  });

  it('clears a stale leased job by deleting its cancelled run (the fixture-lease purge)', async () => {
    // A leased job with a FAR-FUTURE lease from a dead owner: the reconciler
    // must respect the unexpired lease forever, so clear-all is the only
    // operator remedy once its run is terminal.
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);
    await store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'daemon-ghost' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });
    await store.append({
      runId,
      type: 'queue.claimed',
      actor: { kind: 'system', id: 'daemon-ghost' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: {
        jobId: `${runId}:execution`,
        jobKind: 'run-execution',
        attempt: 1,
        leaseId: 'ghost-lease',
        ownerId: 'daemon-ghost',
        leaseExpiresAt: 4_100_000_000_000,
      },
    });
    const before = await app.handle(req('GET', '/api/execution', {}));
    expect(record(before).queue).toMatchObject({ leased: 1 });

    const res = await app.handle(req('POST', '/api/runs/clear-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect((record(res) as { cleared: string[] }).cleared).toEqual([runId]);

    const after = await app.handle(req('GET', '/api/execution', {}));
    expect(record(after).queue).toEqual({ queued: 0, leased: 0 });
  });

  it('never deletes a run that survives the cancel phase non-terminal', async () => {
    // The wrapped store refuses the run.cancelled append, so the run stays
    // planned through the cancel phase — clear-all must keep its ledger.
    const { app, store } = makeExecApp({
      wrapStore: (base) => ({
        ...base,
        append: (event) =>
          event.type === 'run.cancelled'
            ? Promise.reject(new Error('ledger write refused'))
            : base.append(event),
      }),
    });
    const runId = await createPlannedRun(app);

    const res = await app.handle(req('POST', '/api/runs/clear-all', authedHeaders(), {}));
    expect(res.status).toBe(200);
    const body = record(res) as {
      cleared: string[];
      skipped: { runId: string; status: string }[];
      errors?: { runId: string }[];
    };
    expect(body.cleared).toEqual([]);
    expect(body.skipped).toEqual([{ runId, status: 'planned' }]);
    expect(body.errors?.[0]?.runId).toBe(runId);
    expect((await store.readRun(runId)).length).toBeGreaterThan(0);
  });

  it('requires the command guard before clearing anything', async () => {
    const { app, store } = makeExecApp();
    const runId = await createPlannedRun(app);
    await app.handle(req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), {}));

    const denied = await app.handle(
      req('POST', '/api/runs/clear-all', { origin: ORIGIN, 'x-csrf-token': CSRF }, {}),
    );
    expect(denied.status).toBe(401);
    expect((await store.readRun(runId)).length).toBeGreaterThan(0);
  });
});

// NOTE: the ChatGPT Action schema assertions that previously lived here were
// upgraded to REAL OpenAPI 3.1 validation in chatgpt-action-schema.test.ts
// (full-factory U10).
