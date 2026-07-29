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
 *   POST /api/execution/factory-reset (guarded) — the DESTRUCTIVE wipe of
 *                                    factory-managed state (session lifecycle
 *                                    U4, flow F3). Requires the exact typed
 *                                    phrase "reset the factory" in the body's
 *                                    `confirm` field (AE3, server-enforced);
 *                                    refuses while any queue lease is active.
 *                                    Deletes ONLY the allowlisted paths under
 *                                    the factory dir, rebuilds the process
 *                                    singletons, and opens the fresh ledger
 *                                    with `factory.reset_completed` +
 *                                    `session.started`. The bumped reset
 *                                    generation rides on GET /api/execution
 *                                    and GET /api/floor for stale-tab
 *                                    detection (R15).
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
import { asRecord, flag, num, str } from './parse';
import {
  appendArchive,
  batchCancelRuns,
  guardRunCommand,
  notFound,
  refreshBuildContract,
  resolveInterventionsForArchivedRun,
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
import {
  FACTORY_RESET_PHRASE,
  FactoryResetWipeError,
  currentResetGeneration,
  enumerateFactoryReset,
  executeFactoryReset,
} from '../factory-reset';
import type { FactoryResetOutcome } from '../factory-reset';

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
  | { readonly kind: 'run_archived' }
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

  // Archived runs never (re)start execution (R16: there is no "archived but
  // still executing" state) — checked FIRST, even before the already-active
  // convergence, so a start/retry on an archived run always says "unarchive
  // first" instead of touching (or reporting) queue state.
  if (run.archived) {
    return { kind: 'run_archived' };
  }
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
    case 'run_archived':
      return {
        status: 422,
        body: {
          error: 'run_archived',
          message: `Run ${runId} is archived; unarchive it before starting or retrying execution.`,
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
  // Archived runs have no live execution to command (R16): unarchive first.
  if (run.archived) {
    return {
      status: 422,
      body: {
        error: 'run_archived',
        message: `Run ${runId} is archived; unarchive it before pausing execution.`,
        run,
      },
    };
  }
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
  // Archived runs have no live execution to command (R16): unarchive first.
  if (run.archived) {
    return {
      status: 422,
      body: {
        error: 'run_archived',
        message: `Run ${runId} is archived; unarchive it before resuming execution.`,
        run,
      },
    };
  }
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

/**
 * The wire body GET /api/execution and the execution half of GET /api/floor
 * share. ONE builder means the two routes cannot drift on shape (the same
 * treatment `interventionQueueBody` gives the intervention half).
 * `resetGeneration` (session lifecycle U4, R15) is the ledger-derived factory
 * reset generation: stale tabs compare it against the value they loaded with
 * and force a reload instead of failing silently on wiped tokens.
 */
function executionOverviewBody(
  daemon: RouteContext['executionDaemon'],
  events: readonly FactoryEvent[],
): {
  execution: { enabled: boolean; held: boolean; running: boolean };
  queue: { queued: number; leased: number };
  resetGeneration: number;
} {
  return {
    execution: executionFlags(daemon),
    queue: countQueueJobs(events),
    resetGeneration: currentResetGeneration(events),
  };
}

async function getExecutionOverview(ctx: RouteContext): Promise<ApiResponse> {
  return {
    status: 200,
    body: executionOverviewBody(ctx.executionDaemon, await ctx.reader.readAll()),
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
 * standalone bodies' top-level keys to stay disjoint
 * (execution/queue/resetGeneration vs interventions/openCount); a colliding
 * key would silently shadow one half. Either legacy endpoint remains
 * available for connectors and run detail.
 */
async function getFloorStatus(ctx: RouteContext): Promise<ApiResponse> {
  const events = await ctx.reader.readAll();
  return {
    status: 200,
    body: {
      ...executionOverviewBody(ctx.executionDaemon, events),
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
 *   1. hold the drain gate FIRST (R8: a fresh session never auto-runs
 *      leftovers) — BEFORE the snapshot read, so no new claim can start
 *      between snapshot and cancel (TOCTOU);
 *   2. snapshot the run set under the held gate — at execution time, not
 *      confirmation time, so a run created from CLI/MCP mid-confirmation is
 *      included (TOCTOU);
 *   3. ask-once gate: active runs + `confirmActive` absent -> 409 listing the
 *      actives, NOTHING changed (the gate is restored to its prior state, no
 *      events — a declined confirm never leaves the factory held);
 *   4. cancel actives with the shared `batchCancelRuns` two-phase core: every
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
 *      records that a fresh session opened). A marker append failure folds
 *      into `errors` instead of masking the batch outcome.
 *
 * A partial failure (any non-empty `errors`) returns 500 `new_session_partial`
 * with the SAME body shape, so MCP/CLI callers never read a partial batch as
 * success. The marker never disturbs run lists or the floor: the 'factory'
 * stream has no `run.created`, so `isRealRun`/`isVisibleRun` exclude it by
 * construction.
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

  // 1. Hold the gate BEFORE the snapshot read (TOCTOU): once held, no new
  // claim starts between snapshot and cancel, and any run created before the
  // hold landed is caught by the snapshot below. The prior gate state is
  // remembered so the ask-once refusal can restore it.
  const wasHeld = daemon.held;
  daemon.hold();

  // 2. Snapshot UNDER the held gate: ONE cross-run read serves every
  // projection (the cancelAllRuns pattern). Grouping preserves per-run order;
  // `projectRun` sorts defensively.
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

  // 3. Ask-once (AE1): actives require an explicit confirmation. Nothing has
  // changed — the gate returns to its prior state, so a declined confirm
  // never leaves the factory held, and the operator can abort untouched.
  const actives = visible.filter((entry) => isActiveRun(entry.run));
  if (actives.length > 0 && !confirmActive) {
    if (!wasHeld) {
      daemon.resume();
    }
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

  // 4. Cancel actives with the shared two-phase batch core: every
  // `run.cancelled` appended first (one run's failure is collected, never a
  // 500 with earlier cancels committed), then ONE daemon propagation over
  // EVERY snapshot stream — releasing queued/abandoned jobs as cancelled for
  // ALL targeted streams, including stale queued work on terminal or
  // already-archived runs (R8: the queue truly empties). The propagation is
  // awaited BEFORE any archive append so the ledger shows
  // cancel -> release -> archive -> marker in order.
  const { cancelled, errors, failedCancels } = await batchCancelRuns(ctx, actives, {
    reason,
    propagateRunIds: [...eventsByRun.keys()],
  });

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

  // 6. The session marker records what THIS command actually did (R12). A
  // marker append failure folds into `errors` (A7): the batch outcome above is
  // already durable, so the caller must see the partial state, not a throw.
  try {
    await ctx.writer.append({
      runId: 'factory',
      type: 'session.started',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'factory', id: 'session' },
      severity: 'info',
      payload: { archivedRunIds: archived, cancelledRunIds: cancelled },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ runId: 'factory', message: `session.started append failed: ${message}` });
  }

  auditFactoryCommand('session.start_new');
  // Any collected failure makes this a 500-class outcome (new_session_partial)
  // with the SAME body: MCP's isError flag and the CLI's ApiError both key off
  // the status, so a partial batch can never read as success.
  const partial = errors.length > 0;
  return {
    status: partial ? 500 : 200,
    body: {
      ...(partial
        ? {
            error: 'new_session_partial',
            message:
              'New Session completed with per-run failures; see errors for what did not land.',
          }
        : {}),
      archived,
      cancelled,
      held: daemon.held,
      ...(partial ? { errors } : {}),
    },
  };
}

/* ----------------------------------------------------------------------------
 * Factory Reset (session lifecycle U4, flow F3)
 * ------------------------------------------------------------------------- */

/**
 * The guarded DESTRUCTIVE wipe (R9/R12/R15, AE3). Layered so a reset is
 * impossible accidentally and refusals change NOTHING:
 *
 *   1. command guard (factory-scoped subject, like new-session) — denials are
 *      audited on the reserved 'factory' stream;
 *   2. fail closed (503) without a daemon or a reset runtime;
 *   3. hold the gate FIRST, then read the ledger UNDER the held gate — the
 *      lease check below cannot race a new claim (TOCTOU). Every refusal
 *      restores the prior gate state, so a refused reset leaves the gate
 *      exactly as it was;
 *   4. typed confirmation: the body's `confirm` field must be EXACTLY
 *      "reset the factory" (`FACTORY_RESET_PHRASE`) — enforced server-side,
 *      never just in UI. A mismatch returns 400 with the required phrase and
 *      the pre-flight enumeration so the confirmation UI can render what is
 *      at stake, and deletes nothing;
 *   5. refuse while any queue-job lease is active (409 listing the leases) —
 *      no force override in v1: the operator cancels first;
 *   6. only then the pinned destructive sequence (`executeFactoryReset`):
 *      hold -> stop -> seal old store -> wipe allowlist -> dispose/rebuild
 *      singletons -> fresh markers. The response carries the new generation,
 *      the enumeration of what WAS destroyed, and the paths actually deleted.
 *      A wipe failure (e.g. Windows EBUSY) still rebuilds the singletons and
 *      surfaces the PARTIAL deletion as a 500 instead of discarding it.
 */
async function factoryReset(ctx: RouteContext): Promise<ApiResponse> {
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'execution' },
    command: 'execution.factory_reset',
  });
  if (denial !== null) {
    return denial;
  }
  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    return EXECUTION_DISABLED;
  }
  const runtime = ctx.factoryReset;
  if (runtime === null) {
    return {
      status: 503,
      body: {
        error: 'factory_reset_disabled',
        message: 'Factory reset is not enabled on this server instance.',
      },
    };
  }

  // Hold FIRST, then read + check under the held gate: no new claim can slip
  // in between the lease check and the destructive sequence (TOCTOU). Every
  // refusal restores the prior gate state so a refused reset changes nothing.
  const wasHeld = daemon.held;
  daemon.hold();
  const restoreGate = (): void => {
    if (!wasHeld) {
      daemon.resume();
    }
  };

  const events = await ctx.reader.readAll();
  const enumeration = await enumerateFactoryReset(events, runtime.factoryDir);

  const confirm = str(asRecord(ctx.request.body).confirm);
  if (confirm !== FACTORY_RESET_PHRASE) {
    restoreGate();
    return {
      status: 400,
      body: {
        error: 'confirmation_mismatch',
        message:
          `Factory reset requires the exact phrase "${FACTORY_RESET_PHRASE}" in the request ` +
          `body's "confirm" field. Nothing was deleted.`,
        requiredPhrase: FACTORY_RESET_PHRASE,
        wouldDestroy: enumeration,
      },
    };
  }

  const leased = projectExecutionQueue(
    events.filter((event) => event.type.startsWith('queue.')),
  ).jobs.filter((job) => job.status === 'leased');
  if (leased.length > 0) {
    restoreGate();
    return {
      status: 409,
      body: {
        error: 'jobs_leased',
        message:
          `${leased.length} queue job(s) hold an active lease. Cancel the leased work ` +
          '(or wait for it to release) before resetting the factory. Nothing was deleted.',
        leasedJobs: leased.map((job) => ({
          jobId: job.jobId,
          runId: job.runId,
          jobKind: job.jobKind,
          attempt: job.attempt,
          ownerId: job.ownerId,
          leaseExpiresAt: job.leaseExpiresAt,
        })),
        wouldDestroy: enumeration,
      },
    };
  }

  let outcome: FactoryResetOutcome;
  try {
    outcome = await executeFactoryReset({
      daemon,
      runtime,
      store: ctx.store,
      nextGeneration: enumeration.resetGeneration + 1,
      wipedRunCount: enumeration.runCount + enumeration.archivedRunCount,
    });
  } catch (error) {
    if (error instanceof FactoryResetWipeError) {
      // The wipe failed partway (e.g. Windows EBUSY) but the singletons were
      // still rebuilt (the old store/daemon are sealed and unusable). Surface
      // the PARTIAL deletion instead of discarding it — the operator must see
      // exactly what is already gone before retrying.
      return {
        status: 500,
        body: {
          error: 'factory_reset_failed',
          message:
            `Factory reset failed while deleting factory-managed state: ${error.message}. ` +
            'The server singletons were rebuilt; the paths listed in deletedPaths were ' +
            'already removed. Retry the reset once the blocking handle is released.',
          deletedPaths: error.deletedPaths,
          wouldDestroy: enumeration,
          // A rebuilt server-runtime daemon boots held again.
          held: true,
        },
      };
    }
    throw error;
  }

  auditFactoryCommand('execution.factory_reset');
  return {
    status: 200,
    body: {
      reset: true,
      resetGeneration: enumeration.resetGeneration + 1,
      // The gate the operator owns is engaged: the pre-wipe daemon was held
      // then stopped, and a rebuilt server-runtime daemon boots held again.
      held: true,
      destroyed: enumeration,
      // The allowlisted paths that existed and were actually deleted.
      deletedPaths: outcome.deletedPaths,
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
      openOnly: flag(query.open),
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
    { method: 'POST', pattern: '/api/execution/factory-reset', handler: factoryReset },
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
