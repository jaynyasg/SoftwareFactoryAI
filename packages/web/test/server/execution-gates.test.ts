/**
 * Gates, repair loops, and review approvals in the run lifecycle (U7).
 *
 * Exercises the scheduler-backed executor + daemon with INJECTED deterministic
 * gate stages (no real lint/test subprocesses):
 *  - passing post-run gates advance the run to run.completed,
 *  - failing post-run gates BLOCK with evidence (no run.completed), raise a
 *    retry_choice intervention on the `gates` stage, and request a stage
 *    review,
 *  - gate-rerun queue jobs execute REAL gate runs (the U5 placeholder is
 *    gone) and complete the run once gates pass,
 *  - review approval resumes the CORRECT blocked stage (gate re-run, not a
 *    fresh execution attempt),
 *  - post-ticket gate failures repair with compiled feedback and exhaustion
 *    escalates to an intervention instead of looping,
 *  - policy blocks cannot be approved through review in autonomous mode
 *    (KTD6), and
 *  - a process restart replays the blocked gate state and does not re-run
 *    completed tickets when gates finally pass.
 */
import { describe, expect, it } from 'vitest';
import {
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { AdapterTask, EventStore, ExecutionAdapter } from '@software-factory/core';
import type { Gate, GateResult, Sandbox } from '@software-factory/worker';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { createExecutionDaemon, type ExecutionDaemon } from '../../src/server/execution/daemon';
import { createSchedulerTicketExecutor } from '../../src/server/execution/ticket-executor';
import type { ExecutorGateStages } from '../../src/server/execution/gate-stages';
import {
  executionJobId,
  gateRerunJobId,
  projectExecutionQueue,
} from '../../src/server/execution/queue';
import { projectInterventions } from '../../src/server/execution/interventions';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';
const FRESH_ROOT = '/virtual/workspaces';

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

function noopTimers() {
  return { setInterval: () => null, clearInterval: () => undefined };
}

function authedHeaders(): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN };
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

/* ----------------------------------------------------------------------------
 * Deterministic fakes: adapter, gates, gate stages
 * ------------------------------------------------------------------------- */

interface RecordingAdapter extends ExecutionAdapter {
  readonly tasks: readonly AdapterTask[];
  readonly executions: ReadonlyMap<string, number>;
}

function immediateAdapter(executions = new Map<string, number>()): RecordingAdapter {
  const tasks: AdapterTask[] = [];
  return {
    id: 'fake-exec',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 10 }),
    execute: (task) => {
      tasks.push(task);
      executions.set(task.ticketId, (executions.get(task.ticketId) ?? 0) + 1);
      return Promise.resolve({ ok: true, output: `done:${task.ticketId}`, artifacts: [] });
    },
    reportCapacity: () => 10,
    tasks,
    executions,
  };
}

/** A sandbox stub — fake gates never execute commands through it. */
const SANDBOX_STUB: Sandbox = {
  mode: 'local-fallback',
  reducedTrust: true,
  run: () =>
    Promise.resolve({
      ok: true,
      denied: false,
      reducedTrust: true,
      mode: 'local-fallback',
      stdout: '',
      stderr: '',
      violations: [],
    }),
};

interface ControllableGate {
  readonly gate: Gate;
  setPassing(passing: boolean): void;
  readonly runs: () => number;
}

function controllableGate(name: string, passing = true): ControllableGate {
  let pass = passing;
  let runs = 0;
  return {
    gate: {
      name,
      run(): Promise<GateResult> {
        runs += 1;
        if (pass) {
          return Promise.resolve({
            gate: name,
            passed: true,
            summary: `${name} clean`,
            evidence: [],
          });
        }
        return Promise.resolve({
          gate: name,
          passed: false,
          reason: `${name} found problems`,
          evidence: [{ label: `${name}:failure`, detail: 'deterministic failure', ref: 'exit:1' }],
        });
      },
    },
    setPassing(next: boolean): void {
      pass = next;
    },
    runs: () => runs,
  };
}

interface FakeStageOptions {
  readonly postRun?: readonly Gate[];
  readonly postTicket?: (ticketId: string) => readonly Gate[];
  readonly maxRepairAttempts?: number;
}

function fakeGateStages(options: FakeStageOptions): ExecutorGateStages {
  return {
    postTicket: (ctx) => options.postTicket?.(ctx.ticketId) ?? [],
    postRun: () => options.postRun ?? [],
    context: (ctx) => ({
      runId: ctx.runId,
      ticketId: ctx.ticketId,
      workspaceDir: ctx.workspaceDir,
      sandbox: SANDBOX_STUB,
      signal: ctx.signal,
    }),
    maxRepairAttempts: options.maxRepairAttempts,
  };
}

/* ----------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------- */

interface Harness {
  readonly app: App;
  readonly store: EventStore;
  readonly daemon: ExecutionDaemon;
  makeDaemon(ownerId: string, adapter: ExecutionAdapter): ExecutionDaemon;
}

function makeHarness(
  adapter: ExecutionAdapter,
  gateStages: ExecutorGateStages,
  options: { readonly maxAttempts?: number } = {},
): Harness {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;

  const makeDaemon = (ownerId: string, ownAdapter: ExecutionAdapter): ExecutionDaemon =>
    createExecutionDaemon({
      store,
      clock: det.clock,
      idGenerator: () => `lease-${(leaseSeq += 1)}`,
      ownerId,
      timers: noopTimers(),
      config: options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : undefined,
      executor: createSchedulerTicketExecutor({
        adapters: createAdapterCatalog([ownAdapter]),
        freshWorkspaceRoot: FRESH_ROOT,
        ensureWorkspaceDir: () => Promise.resolve(),
        clock: det.clock,
        gateStages,
      }),
    });

  const daemon = makeDaemon('daemon-g1', adapter);
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    adapterCatalog: createAdapterCatalog([adapter]),
  });
  return { app, store, daemon, makeDaemon };
}

async function createPlannedRun(app: App, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.handle(
    req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT, ...body }),
  );
  expect(res.status).toBe(201);
  return record(res).runId as string;
}

async function startRun(app: App, runId: string): Promise<ApiResponse> {
  return app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
}

async function types(store: EventStore, runId: string): Promise<string[]> {
  return (await store.readRun(runId)).map((event) => event.type);
}

/* ----------------------------------------------------------------------------
 * 1. Passing gates advance the run
 * ------------------------------------------------------------------------- */

describe('U7: passing gates advance the run', () => {
  it('runs post-run gates after all tickets and emits run.completed only after they pass', async () => {
    const secretScan = controllableGate('secret-scan', true);
    const { app, store, daemon } = makeHarness(
      immediateAdapter(),
      fakeGateStages({ postRun: [secretScan.gate] }),
    );
    const runId = await createPlannedRun(app);
    expect((await startRun(app, runId)).status).toBe(202);

    const tick = await daemon.tick();
    expect(tick.completed).toBe(1);
    expect(secretScan.runs()).toBe(1);

    const events = await store.readRun(runId);
    const seen = events.map((event) => event.type);
    expect(seen).toContain('gate.started');
    expect(seen).toContain('gate.passed');
    expect(seen).toContain('run.completed');
    // Gate events carry the post_run stage.
    const passed = events.find((event) => event.type === 'gate.passed');
    expect((passed?.payload as { stage?: string }).stage).toBe('post_run');
    // run.completed comes AFTER the gate pass (gates gate completion).
    const gateSeq = events.find((e) => e.type === 'gate.passed')?.sequence ?? 0;
    const doneSeq = events.find((e) => e.type === 'run.completed')?.sequence ?? 0;
    expect(doneSeq).toBeGreaterThan(gateSeq);
    expect(projectRun(events, runId).status).toBe('completed');
    expect(projectRun(events, runId).executionState).toBe('completed');
  });
});

/* ----------------------------------------------------------------------------
 * 2. Failing gates pause the run with evidence (no opaque ending)
 * ------------------------------------------------------------------------- */

describe('U7: failing post-run gates block with evidence', () => {
  it('blocks the run, raises a gates-stage intervention, and requests a stage review', async () => {
    const unitTest = controllableGate('unit-test', false);
    const { app, store, daemon } = makeHarness(
      immediateAdapter(),
      fakeGateStages({ postRun: [unitTest.gate] }),
    );
    const runId = await createPlannedRun(app);
    await startRun(app, runId);

    const tick = await daemon.tick();
    expect(tick.blocked).toBe(1);

    const events = await store.readRun(runId);
    const seen = events.map((event) => event.type);
    expect(seen).toContain('gate.failed');
    expect(seen).toContain('execution.blocked');
    expect(seen).not.toContain('run.completed');

    // Evidence rides on the gate.failed event.
    const failed = events.find((event) => event.type === 'gate.failed');
    expect(failed?.evidence?.length ?? 0).toBeGreaterThan(0);
    expect((failed?.payload as { stage?: string }).stage).toBe('post_run');

    // Every ticket finished — the GATE stage is what blocks the run.
    for (const ticket of projectTickets(events, runId).tickets) {
      expect(ticket.state).toBe('completed');
    }
    const run = projectRun(events, runId);
    expect(run.executionState).toBe('blocked');
    expect(run.executionReason).toContain('unit-test');

    // Actionable: an open retry_choice intervention on the gates stage plus a
    // pending stage review the operator can approve.
    const open = projectInterventions(events).open;
    expect(
      open.some((item) => item.kind === 'retry_choice' && item.blockingStage === 'gates'),
    ).toBe(true);
    const review = events.find((event) => event.type === 'review.requested');
    expect((review?.payload as { stage?: string }).stage).toBe('gates');
  });
});

/* ----------------------------------------------------------------------------
 * 3. Gate-rerun queue jobs execute REAL gate runs
 * ------------------------------------------------------------------------- */

describe('U7: gate-rerun jobs execute real gate runs', () => {
  it('re-runs the post-run stage and completes the run once gates pass', async () => {
    const unitTest = controllableGate('unit-test', false);
    const executions = new Map<string, number>();
    const { app, store, daemon } = makeHarness(
      immediateAdapter(executions),
      fakeGateStages({ postRun: [unitTest.gate] }),
    );
    const runId = await createPlannedRun(app);
    await startRun(app, runId);
    await daemon.tick(); // blocked on the failing gate
    expect(unitTest.runs()).toBe(1);

    // Operator "fixes" the cause, then re-runs gates.
    unitTest.setPassing(true);
    const rerun = await app.handle(
      req('POST', `/api/runs/${runId}/gates/rerun`, authedHeaders(), {}),
    );
    expect(rerun.status).toBe(202);

    const tick = await daemon.tick();
    expect(tick.completed).toBe(1);
    expect(unitTest.runs()).toBe(2); // the gate REALLY ran again

    const events = await store.readRun(runId);
    expect(events.map((e) => e.type)).toContain('run.completed');
    expect(projectRun(events, runId).status).toBe('completed');
    const rerunJob = projectExecutionQueue(events, runId).byJobId[gateRerunJobId(runId)];
    expect(rerunJob?.status).toBe('completed');
    // No ticket was re-executed by the gate re-run.
    for (const [ticketId, count] of executions) {
      expect(count, `ticket ${ticketId}`).toBe(1);
    }
    // The successful re-run resolved the gates-stage interventions: the
    // operator queue carries no stale "gates blocked" entries for a run whose
    // gates now pass.
    expect(
      projectInterventions(events).open.filter((item) => item.blockingStage === 'gates'),
    ).toHaveLength(0);
  });
});

/* ----------------------------------------------------------------------------
 * 4. Review approval resumes the CORRECT blocked stage
 * ------------------------------------------------------------------------- */

describe('U7: review approval resumes the blocked stage', () => {
  it('approving the pending gates-stage review resolves the intervention and re-queues the gate re-run', async () => {
    const unitTest = controllableGate('unit-test', false);
    const { app, store, daemon } = makeHarness(
      immediateAdapter(),
      fakeGateStages({ postRun: [unitTest.gate] }),
    );
    const runId = await createPlannedRun(app);
    await startRun(app, runId);
    await daemon.tick(); // blocked on gates

    unitTest.setPassing(true);
    const res = await app.handle(
      req('POST', `/api/runs/${runId}/review`, authedHeaders(), {
        decision: 'approved',
        rationale: 'gate failure reviewed; safe to re-run',
      }),
    );
    expect(res.status).toBe(200);
    const resumed = record(res).resumed as {
      stage: string;
      resolvedInterventions: string[];
      queued: boolean;
    };
    expect(resumed.stage).toBe('gates');
    expect(resumed.queued).toBe(true);
    expect(resumed.resolvedInterventions.length).toBeGreaterThan(0);

    const events = await store.readRun(runId);
    // The CORRECT stage was resumed: the gate-rerun job is queued; the
    // run-execution job was NOT retried (still on attempt 1).
    const queue = projectExecutionQueue(events, runId);
    expect(queue.byJobId[gateRerunJobId(runId)]?.status).toBe('queued');
    expect(queue.byJobId[executionJobId(runId)]?.attempt).toBe(1);
    // The gates-stage intervention is resolved.
    expect(
      projectInterventions(events).open.filter((item) => item.blockingStage === 'gates'),
    ).toHaveLength(0);

    const tick = await daemon.tick();
    expect(tick.completed).toBe(1);
    const final = projectRun(await store.readRun(runId), runId);
    expect(final.status).toBe('completed');
    expect(final.executionState).toBe('completed');
  });

  it('a retried approval never resumes the stage twice (duplicate decide is inert)', async () => {
    const unitTest = controllableGate('unit-test', false);
    const { app, store, daemon } = makeHarness(
      immediateAdapter(),
      fakeGateStages({ postRun: [unitTest.gate] }),
    );
    const runId = await createPlannedRun(app);
    await startRun(app, runId);
    await daemon.tick(); // blocked on gates (pending gates-stage review)

    unitTest.setPassing(true);
    const body = { decision: 'approved', rationale: 'safe to re-run' };

    // First approval closes the pending review and re-queues the gate re-run.
    const first = await app.handle(req('POST', `/api/runs/${runId}/review`, authedHeaders(), body));
    expect(first.status).toBe(200);
    expect((record(first).resumed as { queued: boolean }).queued).toBe(true);

    // A retried approval (no pending review remains) is INERT: it resumes
    // NOTHING and never enqueues a second gate-rerun job, so the FIFO pairing's
    // duplicate can never double-drive the pipeline.
    const second = await app.handle(
      req('POST', `/api/runs/${runId}/review`, authedHeaders(), body),
    );
    expect(second.status).toBe(200);
    expect(record(second).resumed).toBeNull();

    const events = await store.readRun(runId);
    const rerunEnqueues = events.filter(
      (e) => e.type === 'queue.enqueued' && e.payload.jobId === gateRerunJobId(runId),
    );
    expect(rerunEnqueues).toHaveLength(1);
  });

  it('a refused re-enqueue (budget exhausted) leaves the blocking interventions OPEN', async () => {
    const unitTest = controllableGate('unit-test', false); // never passes
    const { app, store, daemon } = makeHarness(
      immediateAdapter(),
      fakeGateStages({ postRun: [unitTest.gate] }),
      { maxAttempts: 1 },
    );
    const runId = await createPlannedRun(app);
    await startRun(app, runId);
    await daemon.tick(); // blocked on gates (failure evidence 1 on the run job)

    // Burn the gate-rerun budget: one re-run that blocks again.
    const rerun = await app.handle(
      req('POST', `/api/runs/${runId}/gates/rerun`, authedHeaders(), {}),
    );
    expect(rerun.status).toBe(202);
    await daemon.tick(); // gate-rerun blocks -> failure evidence 1 on the rerun job

    const openBefore = projectInterventions(await store.readRun(runId)).open.filter(
      (item) => item.blockingStage === 'gates',
    );
    expect(openBefore.length).toBeGreaterThan(0);

    // Approving the stage review now cannot re-enqueue (budget exhausted):
    // the approval must NOT resolve the interventions, or the run would sit
    // blocked with an EMPTY intervention queue and no recorded way forward.
    const res = await app.handle(
      req('POST', `/api/runs/${runId}/review`, authedHeaders(), {
        decision: 'approved',
        rationale: 'attempting to resume past the budget',
      }),
    );
    expect(res.status).toBe(200);
    const resumed = record(res).resumed as {
      queued: boolean;
      resolvedInterventions: string[];
      note?: string;
    };
    expect(resumed.queued).toBe(false);
    expect(resumed.resolvedInterventions).toEqual([]);
    expect(resumed.note).toMatch(/retry budget/i);

    const openAfter = projectInterventions(await store.readRun(runId)).open.filter(
      (item) => item.blockingStage === 'gates',
    );
    expect(openAfter.length).toBe(openBefore.length);
    // Nothing was re-enqueued.
    const rerunJob = projectExecutionQueue(await store.readRun(runId), runId).byJobId[
      gateRerunJobId(runId)
    ];
    expect(rerunJob?.status).toBe('blocked');
  });
});

/* ----------------------------------------------------------------------------
 * Cancellation racing the post-run stage: cancelled is terminal
 * ------------------------------------------------------------------------- */

describe('cancellation during the post-run gate stage', () => {
  it('yields instead of emitting run.completed when a cancel lands mid-stage', async () => {
    let cancelPromise: Promise<ApiResponse> | undefined;
    // The gate needs the app it is created BEFORE — a mutable ref bridges the
    // construction order.
    const ref: { app?: App; runId?: string } = {};
    // A gate that fires the operator cancel while the post-run stage runs,
    // waits for the abort to land, then PASSES: the executor must yield
    // before run.completed instead of completing a cancelled run.
    const cancelDuringStage: Gate = {
      name: 'cancel-racer',
      run: (context) =>
        new Promise<GateResult>((resolve) => {
          const finish = (): void =>
            resolve({
              gate: 'cancel-racer',
              passed: true,
              summary: 'passed while the cancel landed',
              evidence: [],
            });
          // Do NOT await the route here: its cancel propagation waits for the
          // daemon pass this gate is running inside (awaiting would deadlock).
          cancelPromise = ref.app?.handle(
            req('POST', `/api/runs/${ref.runId ?? ''}/cancel`, authedHeaders(), {
              reason: 'operator stop mid-stage',
            }),
          );
          if (context.signal?.aborted === true) {
            finish();
            return;
          }
          context.signal?.addEventListener('abort', finish, { once: true });
        }),
    };
    const harness = makeHarness(
      immediateAdapter(),
      fakeGateStages({ postRun: [cancelDuringStage] }),
    );
    const { app, store, daemon } = harness;
    ref.app = app;
    const cancelRunId = await createPlannedRun(app);
    ref.runId = cancelRunId;
    await startRun(app, cancelRunId);

    await daemon.tick();
    await cancelPromise;

    const events = await store.readRun(cancelRunId);
    const seen = events.map((event) => event.type);
    // The stage PASSED, but the cancel wins: no run.completed was recorded.
    expect(seen).toContain('gate.passed');
    expect(seen).not.toContain('run.completed');
    const run = projectRun(events, cancelRunId);
    expect(run.status).toBe('cancelled');
    expect(run.executionState).toBe('cancelled');
    const job = projectExecutionQueue(events, cancelRunId).byJobId[executionJobId(cancelRunId)];
    expect(job?.status).toBe('cancelled');
  });
});

/* ----------------------------------------------------------------------------
 * 5. Post-ticket repair loop + retry-budget escalation
 * ------------------------------------------------------------------------- */

describe('U7: repair loops and retry-budget escalation', () => {
  it('repairs a failing post-ticket gate with compiled feedback, then escalates on exhaustion', async () => {
    const dataModelGate = controllableGate('unit-test', false); // never passes
    const executions = new Map<string, number>();
    const adapter = immediateAdapter(executions);
    const { app, store, daemon } = makeHarness(
      adapter,
      fakeGateStages({
        postTicket: (ticketId) => (ticketId === 'data-model' ? [dataModelGate.gate] : []),
        maxRepairAttempts: 1,
      }),
    );
    const runId = await createPlannedRun(app);
    await startRun(app, runId);

    const tick = await daemon.tick();
    // ESCALATED to a blocked state — not a plain failure, and never a loop.
    expect(tick.blocked).toBe(1);
    expect(tick.failed).toBe(0);

    // Bounded: initial run + exactly one repair attempt.
    expect(executions.get('data-model')).toBe(2);
    const repaired = adapter.tasks.filter((task) => task.ticketId === 'data-model');
    expect(repaired[0].context.gateFeedback).toEqual([]);
    expect(repaired[1].context.gateFeedback).toEqual([
      { gate: 'unit-test', reason: 'unit-test found problems', attempt: 1 },
    ]);

    const events = await store.readRun(runId);
    const seen = events.map((event) => event.type);
    expect(seen).toContain('repair.started');
    expect(seen).toContain('repair.failed');
    expect(seen).toContain('execution.blocked');
    expect(seen).not.toContain('run.completed');

    const run = projectRun(events, runId);
    expect(run.executionState).toBe('blocked');
    expect(run.executionReason).toContain('Repair budget exhausted');
    expect(run.executionReason).toContain('data-model');

    const open = projectInterventions(events).open;
    expect(
      open.some((item) => item.kind === 'retry_choice' && item.blockingStage === 'execution'),
    ).toBe(true);
    const review = events.find((event) => event.type === 'review.requested');
    expect((review?.payload as { stage?: string }).stage).toBe('execution');
  });
});

/* ----------------------------------------------------------------------------
 * 6. KTD6: policy blocks cannot be approved through autonomous mode
 * ------------------------------------------------------------------------- */

describe('U7: policy blocks stay blocked through review approval (KTD6)', () => {
  it('an autonomous-mode approval resolves nothing and re-queues nothing on a policy block', async () => {
    const { app, store, daemon } = makeHarness(immediateAdapter(), fakeGateStages({ postRun: [] }));
    // Underspecified prompt -> triage plan (policy block), autonomous mode.
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'hi', reviewMode: 'autonomous' }),
    );
    const runId = record(res).runId as string;
    await store.append({
      runId,
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: `${runId}:execution` },
      severity: 'info',
      payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
    });
    const tick = await daemon.tick();
    expect(tick.blocked).toBe(1);

    // Even WITH a pending stage review targeting execution (worst case), an
    // autonomous approval must not resolve the policy block or resume.
    await store.append({
      runId,
      type: 'review.requested',
      actor: { kind: 'gate', id: 'gate-stage' },
      subject: { kind: 'run', id: runId },
      severity: 'warn',
      payload: { riskTier: 'low', summary: 'stage review', stage: 'execution' },
    });
    const before = projectExecutionQueue(await store.readRun(runId), runId);
    const beforeAttempt = before.byJobId[executionJobId(runId)]?.attempt;

    const approve = await app.handle(
      req('POST', `/api/runs/${runId}/review`, authedHeaders(), {
        decision: 'approved',
        riskTier: 'low',
      }),
    );
    expect(approve.status).toBe(200);
    const resumed = record(approve).resumed as {
      resolvedInterventions: string[];
      queued: boolean;
    } | null;
    expect(resumed?.resolvedInterventions).toEqual([]);
    expect(resumed?.queued).toBe(false);

    const events = await store.readRun(runId);
    // The policy_block intervention is STILL open and nothing was re-queued.
    const open = projectInterventions(events).open;
    expect(open.some((item) => item.kind === 'policy_block')).toBe(true);
    const queue = projectExecutionQueue(events, runId);
    expect(queue.byJobId[executionJobId(runId)]?.attempt).toBe(beforeAttempt);
    expect(queue.byJobId[executionJobId(runId)]?.status).toBe('blocked');
    expect(projectRun(events, runId).executionState).toBe('blocked');
  });
});

/* ----------------------------------------------------------------------------
 * 7. Restart replayability: blocked gate state survives a new daemon
 * ------------------------------------------------------------------------- */

describe('U7: gate state is replayable across a process restart', () => {
  it('a fresh daemon re-runs gates without re-running completed tickets', async () => {
    const unitTest = controllableGate('unit-test', false);
    const executions = new Map<string, number>();
    const harness = makeHarness(
      immediateAdapter(executions),
      fakeGateStages({ postRun: [unitTest.gate] }),
    );
    const runId = await createPlannedRun(harness.app);
    await startRun(harness.app, runId);
    await harness.daemon.tick(); // blocked on the failing post-run gate
    await harness.daemon.stop();

    // "Restart": a fresh daemon on the SAME store replays the blocked state.
    const daemonB = harness.makeDaemon('daemon-g2', immediateAdapter(executions));
    const idle = await daemonB.tick();
    expect(idle.claimed).toBe(0); // blocked job is terminal until an operator acts

    unitTest.setPassing(true);
    const rerun = await harness.app.handle(
      req('POST', `/api/runs/${runId}/gates/rerun`, authedHeaders(), {}),
    );
    expect(rerun.status).toBe(202);
    const tick = await daemonB.tick();
    expect(tick.completed).toBe(1);

    // Completed tickets were never re-executed after the restart.
    for (const [ticketId, count] of executions) {
      expect(count, `ticket ${ticketId}`).toBe(1);
    }
    const events = await harness.store.readRun(runId);
    expect(projectRun(events, runId).status).toBe('completed');
    expect(await types(harness.store, runId)).toContain('run.completed');
  });
});
