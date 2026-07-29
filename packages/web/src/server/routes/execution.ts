/**
 * Execution command routes (full-factory U5).
 *
 *   POST /api/runs/:id/start        (guarded) — dry-run preflight, then enqueue
 *                                    the run-execution job. NEVER runs workers
 *                                    in the request: the daemon owns execution
 *                                    (E1); the route returns projected state.
 *   POST /api/runs/:id/pause        (guarded) — stop new worker starts.
 *   POST /api/runs/:id/resume       (guarded) — resume a paused execution.
 *   POST /api/runs/:id/retry        (guarded) — re-enqueue a terminal
 *                                    (failed/blocked/abandoned) execution job,
 *                                    optionally focused on one ticket.
 *   POST /api/runs/:id/gates/rerun  (guarded) — enqueue a gate re-run job.
 *   GET  /api/runs/:id/execution    (read-only) — projected execution state:
 *                                    queue job, preflight, open interventions.
 *   GET  /api/interventions         (read-only) — the operator intervention
 *                                    queue (X4), filterable by run, kind,
 *                                    severity, blocking stage, and action.
 *   POST /api/interventions/:id/resolve (guarded) — resolve one intervention.
 *   GET  /api/execution             (read-only) — factory-wide execution
 *                                    state: whether the drain gate is held
 *                                    plus cross-run queued/leased job counts.
 *   GET  /api/floor                 (read-only) — combined floor status: the
 *                                    /api/execution overview PLUS the full
 *                                    intervention queue from ONE ledger read,
 *                                    so the Factory Floor polls one endpoint
 *                                    per tick instead of two readAll folds.
 *   POST /api/execution/resume      (guarded) — release the drain gate so
 *                                    queued work starts (the daemon boots
 *                                    HELD: nothing runs on open until this).
 *   POST /api/execution/hold        (guarded) — re-engage the drain gate:
 *                                    stop claiming NEW work factory-wide.
 *   POST /api/execution/new-session (guarded) — the atomic New Session command
 *                                    (session lifecycle U3, flow F2): snapshot
 *                                    the run set, hold the gate, cancel active
 *                                    runs, clear queued work, archive every
 *                                    visible run, and append the
 *                                    `session.started` marker on the reserved
 *                                    'factory' stream. Asks once when active
 *                                    runs exist (`confirmActive`).
 *
 * All mutations pass the command guard first (token/origin/CSRF/stale-version)
 * and are idempotent: duplicate starts return the existing queue state instead
 * of double-enqueueing (queue appends are keyed per job+attempt).
 */
import { INTERVENTION_KINDS, isVisibleRun, projectRun } from '@software-factory/core';
import type {
  EventSeverity,
  FactoryEvent,
  InterventionKind,
  RunProjection,
} from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, str } from './parse';
import {
  appendArchive,
  guardRunCommand,
  notFound,
  refreshBuildContract,
  resolveInterventionsForArchivedRun,
  resolveInterventionsForCancelledRun,
} from './shared';
import {
  countJobFailures,
  enqueueJob,
  executionJobId,
  gateRerunJobId,
  isActiveJobStatus,
  projectExecutionQueue,
} from '../execution/queue';
import type { QueueJobView } from '../execution/queue';
import {
  filterInterventions,
  projectInterventions,
  resolveIntervention,
} from '../execution/interventions';
import type {
  InterventionFilter,
  InterventionQueueProjection,
  InterventionView,
} from '../execution/interventions';
import type { PreflightRunResult } from '../execution/preflight';
import { projectPreflight } from '../execution/preflight';

const EXECUTION_DISABLED: ApiResponse = {
  status: 503,
  body: {
    error: 'execution_disabled',
    message: 'Execution controls are not enabled on this server instance.',
  },
};

/** Compact execution summary attached to command responses. */
function executionSummary(run: RunProjection): { state: string; reason?: string } {
  return { state: run.executionState, reason: run.executionReason };
}

/* ----------------------------------------------------------------------------
 * Shared start/retry flow (also used by run creation for
 * `research-plan-and-start` — the recorded U3 start request).
 * ------------------------------------------------------------------------- */

export type StartExecutionOutcome =
  | { readonly kind: 'execution_disabled' }
  | { readonly kind: 'preflight_disabled' }
  | { readonly kind: 'not_planned'; readonly status: string }
  | { readonly kind: 'nothing_to_retry' }
  | { readonly kind: 'run_cancelled' }
  | { readonly kind: 'already_active'; readonly job: QueueJobView }
  | { readonly kind: 'retry_budget_exhausted'; readonly attempt: number; readonly max: number }
  | { readonly kind: 'preflight_failed'; readonly preflight: PreflightRunResult }
  | {
      readonly kind: 'queued';
      readonly job: QueueJobView;
      readonly preflight: PreflightRunResult;
    };

export interface StartExecutionOptions {
  readonly command: 'start' | 'retry';
  readonly reason?: string;
  readonly ticketId?: string;
}

/**
 * Preflight-gated enqueue of the run-execution job. Duplicate calls converge
 * on the existing active job; preflight failure blocks the enqueue entirely
 * (no partial worker execution); retries respect the bounded attempt budget.
 */
export async function requestExecutionStart(
  ctx: RouteContext,
  runId: string,
  options: StartExecutionOptions,
): Promise<StartExecutionOutcome> {
  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    return { kind: 'execution_disabled' };
  }

  const events = await ctx.reader.readRun(runId);
  const run = projectRun(events, runId);
  const queue = projectExecutionQueue(events, runId);
  const job = queue.byJobId[executionJobId(runId)];

  if (job !== undefined && isActiveJobStatus(job.status)) {
    return { kind: 'already_active', job };
  }
  if (run.status === 'cancelled') {
    return { kind: 'run_cancelled' };
  }
  if (options.command === 'start' && run.status !== 'planned' && run.status !== 'running') {
    return { kind: 'not_planned', status: run.status };
  }
  if (options.command === 'retry') {
    if (job === undefined) {
      return { kind: 'nothing_to_retry' };
    }
  }

  const attempt = (job?.attempt ?? 0) + 1;
  // The retry budget is ledger-derived FAILURE evidence (queue.released with a
  // failed/blocked outcome), never the raw attempt number: safe yields (pause,
  // graceful shutdown) requeue with attempt+1 and must not consume the
  // operator's retry budget.
  const failures = countJobFailures(events, executionJobId(runId));
  if (failures >= daemon.config.maxAttempts) {
    return {
      kind: 'retry_budget_exhausted',
      attempt: failures + 1,
      max: daemon.config.maxAttempts,
    };
  }

  // Build contract before execution (X3): derive from current projections and
  // emit digest-idempotently, so the recorded contract always reflects the
  // plan/research/workspace state execution would run against.
  await refreshBuildContract(ctx, runId, { workspaceEvidence: true });

  // Dry-run rehearsal (X2): REQUIRED before a normal start enqueues execution.
  const preflight = await ctx.runPreflight(runId);
  if (preflight === null) {
    return { kind: 'preflight_disabled' };
  }
  if (!preflight.ok) {
    return { kind: 'preflight_failed', preflight };
  }

  await enqueueJob(ctx.store, {
    runId,
    jobId: executionJobId(runId),
    jobKind: 'run-execution',
    attempt,
    reason: options.reason,
    ticketId: options.ticketId,
  });

  // One post-enqueue read serves both the retry-resolution scan and the
  // response projection (perf: no second readRun for the same state).
  const finalEvents = await ctx.reader.readRun(runId);

  if (options.command === 'retry') {
    // A retry IS the operator's retry decision: resolve open retry_choice
    // interventions for this run's execution stage instead of leaving stale
    // entries in the queue.
    const open = filterInterventions(projectInterventions(finalEvents), {
      runId,
      kind: 'retry_choice',
      blockingStage: 'execution',
      openOnly: true,
    });
    for (const intervention of open) {
      await resolveIntervention(ctx.store, intervention, {
        resolution: 'retry',
        note: `Operator retried execution (attempt ${attempt}).`,
      });
    }
  }

  daemon.notify();

  const finalJob = projectExecutionQueue(finalEvents, runId).byJobId[executionJobId(runId)];
  return { kind: 'queued', job: finalJob, preflight };
}

async function startOutcomeResponse(
  ctx: RouteContext,
  runId: string,
  outcome: StartExecutionOutcome,
): Promise<ApiResponse> {
  const events = await ctx.reader.readRun(runId);
  const run = projectRun(events, runId);
  switch (outcome.kind) {
    case 'execution_disabled':
      return EXECUTION_DISABLED;
    case 'preflight_disabled':
      return {
        status: 503,
        body: {
          error: 'preflight_disabled',
          message: 'Preflight is not enabled on this server instance; start is fail-closed.',
        },
      };
    case 'not_planned':
      return {
        status: 422,
        body: {
          error: 'run_not_planned',
          message: `Run ${runId} is "${outcome.status}"; only planned runs can start execution.`,
          run,
        },
      };
    case 'run_cancelled':
      return {
        status: 422,
        body: { error: 'run_cancelled', message: `Run ${runId} is cancelled.`, run },
      };
    case 'nothing_to_retry':
      return {
        status: 422,
        body: {
          error: 'nothing_to_retry',
          message: `Run ${runId} has no execution job to retry; use start instead.`,
          run,
        },
      };
    case 'retry_budget_exhausted':
      return {
        status: 422,
        body: {
          error: 'retry_budget_exhausted',
          message: `Attempt ${outcome.attempt} exceeds the execution retry budget (${outcome.max}).`,
          run,
        },
      };
    case 'already_active':
      return {
        status: 200,
        body: {
          runId,
          alreadyQueued: true,
          job: outcome.job,
          execution: executionSummary(run),
          run,
        },
      };
    case 'preflight_failed':
      return {
        status: 422,
        body: {
          error: 'preflight_failed',
          message: `Preflight failed: ${outcome.preflight.failedChecks.join(', ')}. Start did not enqueue execution.`,
          runId,
          preflight: outcome.preflight,
          interventions: filterInterventions(projectInterventions(events), {
            runId,
            blockingStage: 'preflight',
            openOnly: true,
          }),
          execution: executionSummary(run),
          run,
        },
      };
    case 'queued':
      return {
        status: 202,
        body: {
          runId,
          queued: true,
          alreadyQueued: false,
          // Honest queue semantics: while the factory drain gate is engaged a
          // queued job WAITS for the operator's resume instead of running.
          held: ctx.executionDaemon?.held ?? false,
          job: outcome.job,
          preflight: outcome.preflight,
          execution: executionSummary(run),
          run,
        },
      };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/* ----------------------------------------------------------------------------
 * Route handlers
 * ------------------------------------------------------------------------- */

async function startRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const guarded = await guardRunCommand(ctx, runId, 'execution.start');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const outcome = await requestExecutionStart(ctx, runId, {
    command: 'start',
    reason: str(asRecord(ctx.request.body).reason) ?? 'operator start',
  });
  return startOutcomeResponse(ctx, runId, outcome);
}

async function retryRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const guarded = await guardRunCommand(ctx, runId, 'execution.retry');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const body = asRecord(ctx.request.body);
  const outcome = await requestExecutionStart(ctx, runId, {
    command: 'retry',
    reason: str(body.reason) ?? 'operator retry',
    ticketId: str(body.ticketId),
  });
  return startOutcomeResponse(ctx, runId, outcome);
}

async function pauseRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const guarded = await guardRunCommand(ctx, runId, 'execution.pause');
  if (guarded.response !== null) {
    return guarded.response;
  }
  if (ctx.executionDaemon === null) {
    return EXECUTION_DISABLED;
  }
  const run = guarded.run;
  if (run.executionState === 'paused') {
    return {
      status: 200,
      body: { runId, alreadyPaused: true, execution: executionSummary(run), run },
    };
  }
  if (run.executionState !== 'queued' && run.executionState !== 'started') {
    return {
      status: 422,
      body: {
        error: 'execution_not_active',
        message: `Execution is "${run.executionState}"; only queued or started execution can pause.`,
        run,
      },
    };
  }
  await ctx.writer.append({
    runId,
    type: 'execution.paused',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: run.lastSequence },
    severity: 'warn',
    payload: { reason: str(asRecord(ctx.request.body).reason) },
  });
  const after = projectRun(await ctx.reader.readRun(runId), runId);
  return {
    status: 200,
    body: { runId, paused: true, execution: executionSummary(after), run: after },
  };
}

async function resumeRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const guarded = await guardRunCommand(ctx, runId, 'execution.resume');
  if (guarded.response !== null) {
    return guarded.response;
  }
  if (ctx.executionDaemon === null) {
    return EXECUTION_DISABLED;
  }
  const run = guarded.run;
  if (run.executionState !== 'paused') {
    return {
      status: 422,
      body: {
        error: 'execution_not_paused',
        message: `Execution is "${run.executionState}"; only paused execution can resume.`,
        run,
      },
    };
  }
  await ctx.writer.append({
    runId,
    type: 'execution.resumed',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: run.lastSequence },
    severity: 'info',
    payload: { reason: str(asRecord(ctx.request.body).reason) },
  });
  ctx.executionDaemon.notify();
  const after = projectRun(await ctx.reader.readRun(runId), runId);
  return {
    status: 200,
    body: { runId, resumed: true, execution: executionSummary(after), run: after },
  };
}

async function rerunGates(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const guarded = await guardRunCommand(ctx, runId, 'gates.rerun');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    return EXECUTION_DISABLED;
  }
  if (guarded.run.status === 'cancelled') {
    return {
      status: 422,
      body: { error: 'run_cancelled', message: `Run ${runId} is cancelled.`, run: guarded.run },
    };
  }
  const events = await ctx.reader.readRun(runId);
  const jobId = gateRerunJobId(runId);
  const existing = projectExecutionQueue(events, runId).byJobId[jobId];
  if (existing !== undefined && isActiveJobStatus(existing.status)) {
    return { status: 200, body: { runId, alreadyQueued: true, job: existing } };
  }
  await enqueueJob(ctx.store, {
    runId,
    jobId,
    jobKind: 'gate-rerun',
    attempt: (existing?.attempt ?? 0) + 1,
    reason: str(asRecord(ctx.request.body).reason) ?? 'operator gate re-run',
  });
  daemon.notify();
  const job = projectExecutionQueue(await ctx.reader.readRun(runId), runId).byJobId[jobId];
  // `held` mirrors the start/retry queued responses: a queued gate re-run
  // waits behind the drain gate until the operator resumes execution.
  return { status: 202, body: { runId, queued: true, held: daemon.held, job } };
}

/* ----------------------------------------------------------------------------
 * Factory-wide execution controls (operator autostart/hold surface).
 *
 * The daemon boots HELD by default (`autoStart` off): opening the factory
 * never runs queued work automatically. These routes expose the gate to the
 * operator — status is read-only; resume/hold are guarded mutations on the
 * process daemon (deliberately NOT ledger events: every fresh process starts
 * held again by design, so persisting the gate would defeat it).
 * ------------------------------------------------------------------------- */

/**
 * Cross-run queued/leased job counts for the overview. PERF: without a runId,
 * `projectExecutionQueue` folds ONLY `queue.*` event types (enqueued/claimed/
 * heartbeat/released/lease_abandoned — see queue.ts; the runId-scoped alias
 * resolution that reads other events never applies here), so pre-filtering to
 * that family keeps the fold linear in queue traffic instead of total ledger
 * size. The queue tests pin that the fold ignores everything else.
 */
function countQueueJobs(events: readonly FactoryEvent[]): { queued: number; leased: number } {
  const queue = projectExecutionQueue(events.filter((event) => event.type.startsWith('queue.')));
  let queued = 0;
  let leased = 0;
  for (const job of queue.jobs) {
    if (job.status === 'queued') {
      queued += 1;
    } else if (job.status === 'leased') {
      leased += 1;
    }
  }
  return { queued, leased };
}

/**
 * Daemon-dependent gate flags. The queue counts are LEDGER truth either way:
 * even with no daemon on this instance, real cross-run counts beat hardcoded
 * zeros — only these enabled/held/running flags depend on the daemon.
 */
function executionFlags(daemon: RouteContext['executionDaemon']): {
  enabled: boolean;
  held: boolean;
  running: boolean;
} {
  return daemon === null
    ? { enabled: false, held: false, running: false }
    : { enabled: true, held: daemon.held, running: daemon.running };
}

async function getExecutionOverview(ctx: RouteContext): Promise<ApiResponse> {
  return {
    status: 200,
    body: {
      execution: executionFlags(ctx.executionDaemon),
      queue: countQueueJobs(await ctx.reader.readAll()),
    },
  };
}

/**
 * Cross-run intervention projection for the poll routes. PERF: same trick as
 * countQueueJobs — the fold only reads `intervention.*` events, so
 * pre-filtering keeps it linear in intervention traffic instead of total
 * ledger size (these routes run every 1.5s per open tab).
 */
function projectInterventionQueue(events: readonly FactoryEvent[]): InterventionQueueProjection {
  return projectInterventions(events.filter((event) => event.type.startsWith('intervention.')));
}

/**
 * The wire body both intervention reads share: GET /api/interventions
 * (optionally filtered) and the interventions half of GET /api/floor. One
 * builder means the two routes cannot drift on shape — the same treatment
 * `executionFlags` gives the overview half.
 */
function interventionQueueBody(
  projection: InterventionQueueProjection,
  filter: InterventionFilter = {},
): { interventions: InterventionView[]; openCount: number } {
  return {
    interventions: filterInterventions(projection, filter),
    openCount: projection.open.length,
  };
}

/**
 * Combined floor status (TODOS P2 poll consolidation): the /api/execution
 * overview PLUS the unfiltered /api/interventions queue, folded from ONE
 * `readAll`. The body is the FLAT key-level union of those two GET bodies so
 * the client reuses the same parsers on each half — which requires the two
 * standalone bodies' top-level keys to stay disjoint (execution/queue vs
 * interventions/openCount); a colliding key would silently shadow one half.
 * Either legacy endpoint remains available for connectors and run detail.
 */
async function getFloorStatus(ctx: RouteContext): Promise<ApiResponse> {
  const events = await ctx.reader.readAll();
  return {
    status: 200,
    body: {
      execution: executionFlags(ctx.executionDaemon),
      queue: countQueueJobs(events),
      ...interventionQueueBody(projectInterventionQueue(events)),
    },
  };
}

/**
 * Audit record for a SUCCESSFUL factory-scoped gate command. The drain gate
 * is deliberately process-local (never a ledger event — every fresh process
 * boots held again by design), and no existing core event type describes an
 * operator factory command without overloading a projection-bearing family,
 * so the audit record is a structured server log line rather than an invented
 * event type. Guard DENIALS of these commands DO land on the reserved
 * 'factory' ledger stream (see `guardMutation` in app.ts).
 */
function auditFactoryCommand(command: string): void {
  console.info(
    JSON.stringify({
      audit: 'software-factory.command',
      command,
      actor: 'operator',
      timestamp: Date.now(),
    }),
  );
}

async function resumeAllExecution(ctx: RouteContext): Promise<ApiResponse> {
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'execution' },
    command: 'execution.resume_all',
  });
  if (denial !== null) {
    return denial;
  }
  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    return EXECUTION_DISABLED;
  }
  // `running` rides on both bodies so the caller can tell "gate released"
  // apart from "gate released but the daemon loop is not running" — a resumed
  // gate on a stopped daemon still drains nothing.
  if (!daemon.held) {
    return { status: 200, body: { alreadyActive: true, held: false, running: daemon.running } };
  }
  daemon.resume();
  auditFactoryCommand('execution.resume_all');
  return { status: 200, body: { resumed: true, held: daemon.held, running: daemon.running } };
}

async function holdAllExecution(ctx: RouteContext): Promise<ApiResponse> {
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'execution' },
    command: 'execution.hold_all',
  });
  if (denial !== null) {
    return denial;
  }
  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    return EXECUTION_DISABLED;
  }
  if (daemon.held) {
    return { status: 200, body: { alreadyHeld: true, held: true, running: daemon.running } };
  }
  daemon.hold();
  auditFactoryCommand('execution.hold_all');
  return { status: 200, body: { held: true, running: daemon.running } };
}

/* ----------------------------------------------------------------------------
 * New Session (session lifecycle U3, flow F2)
 * ------------------------------------------------------------------------- */

/** "Active" for the New Session ask-once confirmation (Key Technical Decision):
 * a run the operator would be surprised to lose without being asked. */
function isActiveRun(run: RunProjection): boolean {
  return (
    run.status === 'running' ||
    run.executionState === 'queued' ||
    run.executionState === 'started' ||
    run.executionState === 'paused' ||
    run.executionState === 'blocked'
  );
}

/** One run's per-stream state in the New Session execution-time snapshot. */
interface SessionSnapshotEntry {
  readonly runId: string;
  readonly run: RunProjection;
  readonly events: readonly FactoryEvent[];
}

/**
 * The atomic New Session command (R6/R8/R12, AE1): archive everything and
 * open a clean, HELD floor in ONE guarded factory-scoped command.
 *
 * Execution order (per the plan's sequence diagram):
 *   1. snapshot the run set NOW — at execution time, not confirmation time, so
 *      a run created from CLI/MCP mid-confirmation is included (TOCTOU);
 *   2. ask-once gate: active runs + `confirmActive` absent -> 409 listing the
 *      actives, NOTHING changed (no hold, no events);
 *   3. hold the drain gate (R8: a fresh session never auto-runs leftovers);
 *   4. cancel actives with the cancel-all two-phase shape: every
 *      `run.cancelled` appended first (per-run failures collected, never a
 *      mid-batch 500), then ONE daemon `cancelRuns` over EVERY snapshot
 *      stream — phase 2 releases queued/abandoned jobs regardless of run
 *      status, so stale queued work on terminal runs (e.g. a completed run's
 *      queued gate re-run) is cleared too, and in-flight work is aborted
 *      before any archive lands;
 *   5. append `run.archived` per visible run (version-scoped idempotency
 *      keys; already-archived runs are skipped by the `isVisibleRun`
 *      snapshot; terminal runs' open interventions resolve as 'archived');
 *   6. append the `session.started` marker on the reserved 'factory' stream
 *      (NO idempotency key: every New Session is a real, distinct session —
 *      a repeat run converges on empty archived/cancelled lists but still
 *      records that a fresh session opened).
 *
 * The marker never disturbs run lists or the floor: the 'factory' stream has
 * no `run.created`, so `isRealRun`/`isVisibleRun` exclude it by construction.
 */
async function startNewSession(ctx: RouteContext): Promise<ApiResponse> {
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'execution' },
    command: 'session.start_new',
  });
  if (denial !== null) {
    return denial;
  }
  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    // Fail closed like resume/hold: without a daemon there is no gate to hold
    // and no queue to clear, so `held: true` would be a lie.
    return EXECUTION_DISABLED;
  }
  const body = asRecord(ctx.request.body);
  const confirmActive = body.confirmActive === true;
  const reason = str(body.reason) ?? 'new session';

  // 1. Snapshot: ONE cross-run read serves every projection (the cancelAllRuns
  // pattern). Grouping preserves per-run order; `projectRun` sorts defensively.
  const eventsByRun = new Map<string, FactoryEvent[]>();
  for (const event of await ctx.reader.readAll()) {
    const runEvents = eventsByRun.get(event.runId);
    if (runEvents === undefined) {
      eventsByRun.set(event.runId, [event]);
    } else {
      runEvents.push(event);
    }
  }
  const visible: SessionSnapshotEntry[] = [];
  for (const [runId, events] of eventsByRun) {
    const run = projectRun(events, runId);
    if (isVisibleRun(run)) {
      visible.push({ runId, run, events });
    }
  }

  // 2. Ask-once (AE1): actives require an explicit confirmation. Nothing has
  // changed yet — the operator can abort with the factory untouched.
  const actives = visible.filter((entry) => isActiveRun(entry.run));
  if (actives.length > 0 && !confirmActive) {
    return {
      status: 409,
      body: {
        error: 'active_runs_present',
        message:
          `${actives.length} run(s) are still active. Re-send with confirmActive: true to ` +
          'cancel and archive them, or cancel the New Session.',
        activeRuns: actives.map(({ run, runId }) => ({
          runId,
          title: run.title,
          status: run.status,
          executionState: run.executionState,
        })),
      },
    };
  }

  // 3. Hold the gate BEFORE cancelling so no new claims start mid-command.
  daemon.hold();

  // 4a. Cancel actives: batch appends first (cancel-all shape) — one run's
  // append failure is collected, never a 500 with earlier cancels committed.
  const cancelled: string[] = [];
  const errors: { runId: string; message: string }[] = [];
  const failedCancels = new Set<string>();
  for (const { runId, run, events } of actives) {
    try {
      await ctx.writer.append({
        runId,
        type: 'run.cancelled',
        actor: { kind: 'operator', id: 'operator' },
        subject: { kind: 'run', id: runId, version: run.lastSequence },
        severity: 'warn',
        idempotencyKey: `${runId}:run.cancelled`,
        payload: { reason },
      });
      await resolveInterventionsForCancelledRun(ctx.store, events, runId);
      cancelled.push(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runId, message });
      failedCancels.add(runId);
    }
  }

  // 4b. ONE daemon propagation over EVERY snapshot stream: aborts in-flight
  // executors for the (now cancelled) actives and releases queued/abandoned
  // jobs as cancelled for ALL targeted streams — including stale queued work
  // on terminal or already-archived runs (R8: the queue truly empties). This
  // is awaited BEFORE any archive append so the ledger shows
  // cancel -> release -> archive -> marker in order.
  try {
    await daemon.cancelRuns([...eventsByRun.keys()]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ runId: 'factory', message: `daemon cancel propagation failed: ${message}` });
  }

  // 5. Archive every visible run. A run whose cancel append failed is NOT
  // archived — an archived-but-alive run is exactly the state R16 forbids.
  const archived: string[] = [];
  for (const { runId, run, events } of visible) {
    if (failedCancels.has(runId)) {
      continue;
    }
    try {
      if (!isActiveRun(run)) {
        // Terminal runs' open interventions (e.g. a failed run's preflight
        // entries) must not pin the operator queue for a hidden run; actives
        // were already resolved through the cancel flavor above.
        await resolveInterventionsForArchivedRun(ctx.store, events, runId);
      }
      await appendArchive(ctx, runId, run.lastSequence, reason);
      archived.push(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runId, message });
    }
  }

  // 6. The session marker records what THIS command actually did (R12).
  await ctx.writer.append({
    runId: 'factory',
    type: 'session.started',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'factory', id: 'session' },
    severity: 'info',
    payload: { archivedRunIds: archived, cancelledRunIds: cancelled },
  });

  auditFactoryCommand('session.start_new');
  return {
    status: 200,
    body: {
      archived,
      cancelled,
      held: daemon.held,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

async function getExecution(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const events = await ctx.reader.readRun(runId);
  if (events.length === 0) {
    return notFound(runId);
  }
  const run = projectRun(events, runId);
  const queue = projectExecutionQueue(events, runId);
  return {
    status: 200,
    body: {
      runId,
      execution: executionSummary(run),
      job: queue.byJobId[executionJobId(runId)] ?? null,
      gateRerunJob: queue.byJobId[gateRerunJobId(runId)] ?? null,
      preflight: projectPreflight(events, runId),
      interventions: filterInterventions(projectInterventions(events), {
        runId,
        openOnly: true,
      }),
    },
  };
}

/** Type guard: is this query value one of the closed intervention kinds? */
function isInterventionKind(value: unknown): value is InterventionKind {
  return typeof value === 'string' && (INTERVENTION_KINDS as readonly string[]).includes(value);
}

const SEVERITY_VALUES: readonly EventSeverity[] = ['info', 'success', 'warn', 'error', 'critical'];

/** Type guard: is this query value one of the event severities? */
function isEventSeverity(value: unknown): value is EventSeverity {
  return typeof value === 'string' && (SEVERITY_VALUES as readonly string[]).includes(value);
}

async function listInterventions(ctx: RouteContext): Promise<ApiResponse> {
  const query = ctx.request.query;
  const projection = projectInterventionQueue(await ctx.reader.readAll());
  return {
    status: 200,
    body: interventionQueueBody(projection, {
      runId: str(query.runId),
      kind: isInterventionKind(query.kind) ? query.kind : undefined,
      severity: isEventSeverity(query.severity) ? query.severity : undefined,
      blockingStage: str(query.blockingStage) ?? str(query.stage),
      requiredActionText: str(query.action),
      openOnly: query.open === '1' || query.open === 'true',
    }),
  };
}

async function resolveInterventionRoute(ctx: RouteContext): Promise<ApiResponse> {
  const interventionId = ctx.params.id;
  const events = await ctx.reader.readAll();
  const projection = projectInterventions(events);
  const target: InterventionView | undefined = projection.byId[interventionId];
  const body = asRecord(ctx.request.body);

  const runForVersion =
    target !== undefined
      ? projectRun(
          events.filter(
            (event) =>
              typeof event === 'object' &&
              event !== null &&
              (event as { runId?: string }).runId === target.runId,
          ),
          target.runId,
        )
      : undefined;

  const denial = await ctx.guardMutation({
    subject: { kind: 'intervention', id: interventionId, version: num(body.expectedVersion) },
    currentVersion: runForVersion?.lastSequence,
    command: 'intervention.resolve',
    runId: target?.runId,
  });
  if (denial !== null) {
    return denial;
  }

  if (target === undefined) {
    return {
      status: 404,
      body: { error: 'not_found', message: `Intervention ${interventionId} does not exist.` },
    };
  }
  if (target.status === 'resolved') {
    return { status: 200, body: { alreadyResolved: true, intervention: target } };
  }
  const resolution = str(body.resolution);
  if (resolution === undefined) {
    return {
      status: 400,
      body: { error: 'missing_resolution', message: 'A resolution string is required.' },
    };
  }
  await resolveIntervention(ctx.store, target, { resolution, note: str(body.note) });
  // Intervention events live on the target run's ledger, so the post-write
  // read only needs that run (perf: no second cross-run readAll).
  const updated = projectInterventions(await ctx.reader.readRun(target.runId)).byId[interventionId];
  return { status: 200, body: { alreadyResolved: false, intervention: updated } };
}

export function executionRoutes(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/api/execution', handler: getExecutionOverview },
    { method: 'GET', pattern: '/api/floor', handler: getFloorStatus },
    { method: 'POST', pattern: '/api/execution/resume', handler: resumeAllExecution },
    { method: 'POST', pattern: '/api/execution/hold', handler: holdAllExecution },
    { method: 'POST', pattern: '/api/execution/new-session', handler: startNewSession },
    { method: 'POST', pattern: '/api/runs/:id/start', handler: startRun },
    { method: 'POST', pattern: '/api/runs/:id/pause', handler: pauseRun },
    { method: 'POST', pattern: '/api/runs/:id/resume', handler: resumeRun },
    { method: 'POST', pattern: '/api/runs/:id/retry', handler: retryRun },
    { method: 'POST', pattern: '/api/runs/:id/gates/rerun', handler: rerunGates },
    { method: 'GET', pattern: '/api/runs/:id/execution', handler: getExecution },
    { method: 'GET', pattern: '/api/interventions', handler: listInterventions },
    {
      method: 'POST',
      pattern: '/api/interventions/:id/resolve',
      handler: resolveInterventionRoute,
    },
  ];
}
