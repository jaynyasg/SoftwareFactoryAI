/**
 * Run routes.
 *
 *   POST /api/runs            (mutating, guarded) — create a run; idempotent via
 *                             an optional idempotency key. Appends `run.created`,
 *                             then (per the requested run mode) research events,
 *                             the supervisor plan, and a build contract.
 *   GET  /api/runs            (read-only) — list projected runs.
 *   POST /api/runs/:id/cancel (mutating, guarded) — append `run.cancelled`.
 *
 * Run modes (full-factory U3):
 *   - `plan-only` (DEFAULT)        — identical to the V1 flow: create + plan.
 *   - `research-and-plan`          — bounded research runs BEFORE planning; the
 *     enriched brief feeds the planner and a build contract is generated.
 *   - `research-plan-and-start`    — as above, plus the start request is
 *     recorded on the run. Execution controls (start/queue/daemon) are U5 and
 *     DO NOT exist yet, so the run projects `executionState: 'pending'` and a
 *     `defer-execution` supervisor decision instead of pretending to start.
 *
 * Mutations pass through `ctx.guardMutation` first; on denial the guard has
 * already appended the security event and we return its response unchanged
 * (starting nothing).
 */
import {
  DEFAULT_RUN_MODE,
  RUN_MODES,
  deriveBuildContract,
  emitBuildContract,
  isRealRun,
  isRunMode,
  projectResearch,
  projectRun,
  projectTickets,
  researchPlanContext,
} from '@software-factory/core';
import type {
  AppendableEvent,
  CallerFamily,
  PlannerResearchContext,
  ResearchProjection,
  RunCreatedPayload,
  RunMode,
  RunProjection,
} from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, reviewMode, str } from './parse';

function callerFamily(value: unknown): CallerFamily | undefined {
  return value === 'claude' || value === 'codex' || value === 'api' ? value : undefined;
}

/** Explicit "start requested but not yet possible" block for API responses. */
const EXECUTION_PENDING = {
  state: 'pending' as const,
  reason:
    'Execution controls are not yet available; the requested start is recorded on the run ' +
    'and will be acted on once execution controls exist.',
};

/**
 * Ensure research exists for a research-enabled run: runs one bounded pass on
 * first creation and reuses the existing projected research on idempotent
 * re-creates (never re-running or duplicating research events). Returns the
 * up-to-date research projection.
 */
async function ensureResearch(ctx: RouteContext, runId: string): Promise<ResearchProjection> {
  const existing = projectResearch(await ctx.reader.readRun(runId), runId);
  if (existing.status === 'none') {
    const result = await ctx.runResearch(runId, {});
    const failureReason =
      result === null
        ? 'Research is not enabled on this server instance.'
        : result.status === 'failed'
          ? (result.failureReason ?? 'research pass failed')
          : undefined;
    if (failureReason !== undefined) {
      // The runner/app normally record `research.failed` themselves; this
      // idempotent append covers a researcher that reported failure without
      // touching the ledger, so the failure is NEVER silent.
      const afterRun = projectResearch(await ctx.reader.readRun(runId), runId);
      if (afterRun.status !== 'failed') {
        await ctx.writer.append({
          runId,
          type: 'research.failed',
          actor: { kind: 'researcher', id: 'research-runner' },
          subject: { kind: 'research', id: runId },
          severity: 'error',
          idempotencyKey: `${runId}:research.failed:create`,
          payload: { reason: failureReason },
        });
      }
    }
  }
  return projectResearch(await ctx.reader.readRun(runId), runId);
}

/**
 * Mark a research-enabled run as failed because its research pass failed. The
 * idempotency key keeps retried creates from stacking duplicate `run.failed`
 * events. The run stays fully explainable: `research.failed` (with the causal
 * reason) plus a terminal `run.failed` are both on the ledger.
 */
async function failRunForResearch(
  ctx: RouteContext,
  runId: string,
  research: ResearchProjection,
): Promise<void> {
  await ctx.writer.append({
    runId,
    type: 'run.failed',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId },
    severity: 'error',
    idempotencyKey: `${runId}:run.failed:research`,
    payload: {
      reason: `research failed: ${research.failureReason ?? 'research pass did not complete'}`,
    },
  });
}

async function createRun(ctx: RouteContext): Promise<ApiResponse> {
  const body = asRecord(ctx.request.body);

  // Validate the requested mode BEFORE any side effects: an unknown mode is a
  // client error, not a silent fall back to plan-only.
  const rawMode: unknown = body.mode;
  if (rawMode !== undefined && !isRunMode(rawMode)) {
    return {
      status: 400,
      body: {
        error: 'invalid_mode',
        message: `mode must be one of: ${RUN_MODES.join(', ')}.`,
      },
    };
  }
  const mode: RunMode = isRunMode(rawMode) ? rawMode : DEFAULT_RUN_MODE;
  const wantsResearch = mode !== 'plan-only';

  const candidateRunId = ctx.idGenerator();
  const denial = await ctx.guardMutation({
    subject: { kind: 'run', id: candidateRunId },
    command: 'run.create',
  });
  if (denial !== null) {
    return denial;
  }

  // Fail closed BEFORE minting a run that can never satisfy its mode (KTD2).
  if (wantsResearch && !ctx.researchEnabled) {
    return {
      status: 503,
      body: {
        error: 'research_disabled',
        message: `Run mode "${mode}" requires research, but research is not enabled on this server instance.`,
      },
    };
  }

  const payload: RunCreatedPayload = {
    prompt: str(body.prompt),
    prdRef: str(body.prdRef),
    prdText: str(body.prdText),
    title: str(body.title),
    localFolder: str(body.localFolder),
    githubRepo: str(body.githubRepo),
    selectedAdapter: str(body.selectedAdapter),
    modelProfile: str(body.modelProfile),
    reasoningEffort: str(body.reasoningEffort),
    requestedWorkerCap: num(body.requestedWorkerCap),
    reviewMode: reviewMode(body.reviewMode),
    callerFamily: callerFamily(body.callerFamily),
    // The normalized mode is recorded durably — this is the U5 seam: a
    // `research-plan-and-start` run carries its start request in run state.
    mode,
  };
  const created: AppendableEvent = {
    runId: candidateRunId,
    type: 'run.created',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: candidateRunId, version: 0 },
    severity: 'info',
    idempotencyKey: str(body.idempotencyKey),
    payload,
  };
  const result = await ctx.writer.append(created);
  const runId = result.event.runId;
  const status = result.deduplicated ? 200 : 201;

  // Idempotency: on a dedup re-create the ORIGINALLY recorded mode governs the
  // rest of the flow, so a retry with a drifted body cannot change what the run
  // does (or duplicate research/plan/contract events).
  const effectiveMode: RunMode =
    result.deduplicated && result.event.type === 'run.created'
      ? (result.event.payload.mode ?? DEFAULT_RUN_MODE)
      : mode;
  const effectiveWantsResearch = effectiveMode !== 'plan-only';

  // Research runs BEFORE planning for research-enabled modes, so research
  // events always precede supervisor/ticket events on the ledger. On a dedup
  // re-create the existing research is reused, never re-run.
  let research: ResearchProjection | undefined;
  if (effectiveWantsResearch) {
    research = await ensureResearch(ctx, runId);
    if (research.status === 'failed') {
      // Explainable terminal state: the caller asked for research-backed
      // planning and research failed — do NOT plan as if nothing happened.
      await failRunForResearch(ctx, runId, research);
      const failedRun = projectRun(await ctx.reader.readRun(runId), runId);
      return {
        status,
        body: { runId, deduplicated: result.deduplicated, run: failedRun, research },
      };
    }
  }

  // Plan the run into the SAME store so the CLI and UI both see a ticket DAG.
  // A dedup re-create carries the same idempotency key (hence the same request),
  // so re-planning from `payload` is correct; `emitPlan` is idempotent and dupes
  // nothing. The enriched brief (when research ran) feeds the planner.
  const researchContext: PlannerResearchContext | undefined =
    research !== undefined ? researchPlanContext(research) : undefined;
  await ctx.planRun(runId, {
    prompt: payload.prompt,
    prdRef: payload.prdRef,
    prdText: payload.prdText,
    title: payload.title,
    requestedWorkerCap: payload.requestedWorkerCap,
    reviewMode: payload.reviewMode,
    mode: effectiveMode,
    research: researchContext,
  });

  // Build contract (X3): generated after research + planning for research-
  // enabled modes. `emitBuildContract` is idempotent on the contract digest, so
  // it appends a new event only when the underlying research or plan changed.
  // Plan-only runs stay byte-identical to the V1 ledger shape (no contract).
  if (effectiveWantsResearch) {
    const events = await ctx.reader.readRun(runId);
    const plannedRun = projectRun(events, runId);
    if (plannedRun.status === 'planned') {
      const contract = deriveBuildContract(
        plannedRun,
        projectTickets(events, runId),
        projectResearch(events, runId),
      );
      await emitBuildContract(ctx.writer, runId, contract);

      if (effectiveMode === 'research-plan-and-start') {
        // U5 seam: no queue/daemon exists yet. Record an explicit, idempotent
        // "execution deferred" decision so the pending state is on the ledger
        // (and in the operator UI) — never a fake `run.started`.
        await ctx.writer.append({
          runId,
          type: 'supervisor.decision',
          actor: { kind: 'supervisor', id: 'supervisor' },
          subject: { kind: 'run', id: runId },
          severity: 'warn',
          idempotencyKey: `${runId}:supervisor.decision:defer-execution`,
          payload: {
            decision: 'defer-execution',
            rationale:
              'Start was requested (mode research-plan-and-start), but execution controls are ' +
              'not yet available. The start request is recorded on the run; execution stays ' +
              'pending until the execution queue and daemon exist.',
            confidence: 1,
          },
        });
      }
    }
  }

  const finalEvents = await ctx.reader.readRun(runId);
  return {
    status,
    body: {
      runId,
      deduplicated: result.deduplicated,
      run: projectRun(finalEvents, runId),
      ...(effectiveWantsResearch ? { research: projectResearch(finalEvents, runId) } : {}),
      ...(effectiveMode === 'research-plan-and-start' ? { execution: EXECUTION_PENDING } : {}),
    },
  };
}

async function listRunsHandler(ctx: RouteContext): Promise<ApiResponse> {
  const ids = await ctx.reader.listRuns();
  const runs: RunProjection[] = [];
  for (const id of ids) {
    const run = projectRun(await ctx.reader.readRun(id), id);
    // Drop phantom runs: a runId minted only by a guard denial (a lone security
    // event) or with an empty ledger never reached `run.created`.
    if (isRealRun(run)) {
      runs.push(run);
    }
  }
  return { status: 200, body: { runs } };
}

async function cancelRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const current = projectRun(await ctx.reader.readRun(runId), runId);

  const denial = await ctx.guardMutation({
    subject: { kind: 'run', id: runId, version: num(body.expectedVersion) },
    currentVersion: current.lastSequence,
    command: 'run.cancel',
  });
  if (denial !== null) {
    return denial;
  }

  if (current.ledger.length === 0) {
    return { status: 404, body: { error: 'not_found', message: `Run ${runId} does not exist.` } };
  }

  await ctx.writer.append({
    runId,
    type: 'run.cancelled',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: current.lastSequence },
    severity: 'warn',
    payload: { reason: str(body.reason) },
  });
  const run = projectRun(await ctx.reader.readRun(runId), runId);
  return { status: 200, body: { runId, run } };
}

export function runRoutes(): RouteDef[] {
  return [
    { method: 'POST', pattern: '/api/runs', handler: createRun },
    { method: 'GET', pattern: '/api/runs', handler: listRunsHandler },
    { method: 'POST', pattern: '/api/runs/:id/cancel', handler: cancelRun },
  ];
}
