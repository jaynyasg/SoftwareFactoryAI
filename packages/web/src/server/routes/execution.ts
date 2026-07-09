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
 *
 * All mutations pass the command guard first (token/origin/CSRF/stale-version)
 * and are idempotent: duplicate starts return the existing queue state instead
 * of double-enqueueing (queue appends are keyed per job+attempt).
 */
import { INTERVENTION_KINDS, projectRun } from '@software-factory/core';
import type { EventSeverity, InterventionKind, RunProjection } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, str } from './parse';
import { guardRunCommand, notFound, refreshBuildContract } from './shared';
import {
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
import type { InterventionView } from '../execution/interventions';
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
  if (attempt > daemon.config.maxAttempts) {
    return { kind: 'retry_budget_exhausted', attempt, max: daemon.config.maxAttempts };
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

  if (options.command === 'retry') {
    // A retry IS the operator's retry decision: resolve open retry_choice
    // interventions for this run's execution stage instead of leaving stale
    // entries in the queue.
    const all = await ctx.reader.readRun(runId);
    const open = filterInterventions(projectInterventions(all), {
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

  const finalEvents = await ctx.reader.readRun(runId);
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
  return { status: 202, body: { runId, queued: true, job } };
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

function interventionKind(value: string | undefined): InterventionKind | undefined {
  return (INTERVENTION_KINDS as readonly string[]).includes(value ?? '')
    ? (value as InterventionKind)
    : undefined;
}

const SEVERITY_VALUES: readonly EventSeverity[] = ['info', 'success', 'warn', 'error', 'critical'];

function severity(value: string | undefined): EventSeverity | undefined {
  return (SEVERITY_VALUES as readonly string[]).includes(value ?? '')
    ? (value as EventSeverity)
    : undefined;
}

async function listInterventions(ctx: RouteContext): Promise<ApiResponse> {
  const query = ctx.request.query;
  const projection = projectInterventions(await ctx.reader.readAll());
  const interventions = filterInterventions(projection, {
    runId: str(query.runId),
    kind: interventionKind(query.kind),
    severity: severity(query.severity),
    blockingStage: str(query.blockingStage) ?? str(query.stage),
    requiredActionText: str(query.action),
    openOnly: query.open === '1' || query.open === 'true',
  });
  return {
    status: 200,
    body: { interventions, openCount: projection.open.length },
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
  const updated = projectInterventions(await ctx.reader.readAll()).byId[interventionId];
  return { status: 200, body: { alreadyResolved: false, intervention: updated } };
}

export function executionRoutes(): RouteDef[] {
  return [
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
