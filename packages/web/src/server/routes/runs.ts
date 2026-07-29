/**
 * Run routes.
 *
 *   POST /api/runs            (mutating, guarded) — create a run; idempotent via
 *                             an optional idempotency key. Appends `run.created`,
 *                             then (per the requested run mode) research events,
 *                             the supervisor plan, and a build contract.
 *   GET  /api/runs            (read-only) — list projected runs. Archived runs
 *                             are excluded by default (session lifecycle U2);
 *                             pass `?includeArchived=1` for the history view.
 *   POST /api/runs/cancel-all (mutating, guarded) — cancel every cancellable
 *                             run: appends `run.cancelled` per run FIRST, then
 *                             propagates the whole batch to queued/in-flight
 *                             execution in one daemon call.
 *   POST /api/runs/:id/cancel (mutating, guarded) — append `run.cancelled`.
 *                             Optional `archive: true` in the body performs
 *                             cancel-then-archive as ONE command (R10 parity).
 *   POST /api/runs/:id/archive   (mutating, guarded) — append `run.archived`.
 *                             A NON-TERMINAL run is cancelled first (R16):
 *                             cancel + queue release + archive in one command,
 *                             one daemon `cancelRun` call — there is no
 *                             "archived but still executing" state. Archiving
 *                             resolves the run's open interventions so the
 *                             operator queue never pins hidden runs.
 *   POST /api/runs/:id/unarchive (mutating, guarded) — append `run.unarchived`.
 *                             Restores VISIBILITY only; execution state is
 *                             never revived (cancelled stays terminal — R13).
 *   POST /api/runs/:id/workspace (mutating, guarded) — materialize (or retry
 *                             materializing) the run workspace (full-factory
 *                             U4). Separate from execution so setup failures
 *                             can be inspected and retried; retries converge
 *                             instead of duplicating evidence. On success the
 *                             build contract (when one exists) is re-derived
 *                             with the materialization evidence.
 *   GET  /api/runs/:id/workspace (read-only) — the projected workspace state.
 *   GET  /api/runs/:id/outputs   (read-only) — the run artifact contract
 *                             (full-factory U10): the SAME `buildRunOutputs`
 *                             shape the CLI returns — package path, handoff,
 *                             provenance ref, gate evidence, deploy state, and
 *                             a hosted URL only after hosted health passed.
 *
 * Run modes (full-factory U3):
 *   - `plan-only` (DEFAULT)        — identical to the V1 flow: create + plan.
 *   - `research-and-plan`          — bounded research runs BEFORE planning; the
 *     enriched brief feeds the planner and a build contract is generated.
 *   - `research-plan-and-start`    — as above, plus the start request is
 *     recorded on the run and (U5) consumed: when an execution daemon is wired
 *     the run is preflighted and its execution job enqueued; on instances
 *     without execution controls the run projects `executionState: 'pending'`
 *     and a `defer-execution` supervisor decision instead of pretending to
 *     start. Explicit controls live in ./execution.ts (start/pause/resume/
 *     retry/gates).
 *
 * Mutations pass through `ctx.guardMutation` first; on denial the guard has
 * already appended the security event and we return its response unchanged
 * (starting nothing).
 */
import {
  DEFAULT_RUN_MODE,
  RUN_MODES,
  isRealRun,
  isRunMode,
  isVisibleRun,
  projectResearch,
  projectRun,
  researchPlanContext,
} from '@software-factory/core';
import type {
  AppendableEvent,
  CallerFamily,
  EventStore,
  FactoryEvent,
  PlannerResearchContext,
  ResearchProjection,
  RunCreatedPayload,
  RunMode,
  RunProjection,
} from '@software-factory/core';
import { projectWorkspace } from '@software-factory/worker';
// Subpath import: pulls ONLY the caller-agnostic artifact-contract module
// (run-outputs + core projections), not the CLI command surface.
import { buildRunOutputs } from '@software-factory/cli/run-outputs';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, reviewMode, str } from './parse';
import { requestExecutionStart } from './execution';
import {
  filterInterventions,
  projectInterventions,
  resolveIntervention,
} from '../execution/interventions';
import { guardRunCommand, notFound, refreshBuildContract } from './shared';

function callerFamily(value: unknown): CallerFamily | undefined {
  return value === 'claude' || value === 'codex' || value === 'api' ? value : undefined;
}

/** Explicit "start requested but not possible HERE" block for API responses. */
const EXECUTION_PENDING = {
  state: 'pending' as const,
  reason:
    'Execution controls are not enabled on this server instance; the requested start is ' +
    'recorded on the run and will be acted on by an instance with an execution daemon.',
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
    if (research.status === 'requested' || research.status === 'in_progress') {
      // Research is REQUESTED/IN PROGRESS (e.g. an idempotent re-create raced
      // an in-flight research pass): planning now would run from a partial
      // brief. Return the honest projected state; the ORIGINAL in-flight flow
      // completes planning when its research pass finishes.
      const pendingRun = projectRun(await ctx.reader.readRun(runId), runId);
      return {
        status,
        body: {
          runId,
          deduplicated: result.deduplicated,
          run: pendingRun,
          research,
          researchInProgress: true,
        },
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
    const planned = await refreshBuildContract(ctx, runId);
    if (planned && effectiveMode === 'research-plan-and-start') {
      if (ctx.executionDaemon === null) {
        // Execution controls are disabled on THIS instance. Record an
        // explicit, idempotent "execution deferred" decision so the pending
        // state is on the ledger — never a fake `run.started`.
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
              'not available on this instance. The start request is recorded on the run; ' +
              'execution stays pending until an execution daemon acts on it.',
            confidence: 1,
          },
        });
      } else {
        // U5: consume the recorded start request — preflight, then enqueue.
        // Idempotent on re-create: an already-active job is returned, not
        // re-enqueued; a failed preflight records blocked state plus
        // interventions instead of partial worker execution.
        await requestExecutionStart(ctx, runId, {
          command: 'start',
          reason: 'run mode research-plan-and-start',
        });
      }
    }
  }

  const finalEvents = await ctx.reader.readRun(runId);
  const finalRun = projectRun(finalEvents, runId);
  return {
    status,
    body: {
      runId,
      deduplicated: result.deduplicated,
      run: finalRun,
      ...(effectiveWantsResearch ? { research: projectResearch(finalEvents, runId) } : {}),
      ...(effectiveMode === 'research-plan-and-start'
        ? {
            execution:
              ctx.executionDaemon === null
                ? EXECUTION_PENDING
                : { state: finalRun.executionState, reason: finalRun.executionReason },
          }
        : {}),
    },
  };
}

/** Truthy query-flag values accepted for boolean list options. */
function queryFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

async function listRunsHandler(ctx: RouteContext): Promise<ApiResponse> {
  // Archived runs leave the DEFAULT list (session lifecycle U2): archive is a
  // visibility lifecycle, so hidden runs stay on disk and replayable but never
  // clutter the floor. `includeArchived=1` opts back in (history view, R7).
  const includeArchived = queryFlag(ctx.request.query.includeArchived);
  const ids = await ctx.reader.listRuns();
  const runs: RunProjection[] = [];
  for (const id of ids) {
    const run = projectRun(await ctx.reader.readRun(id), id);
    // Drop phantom runs: a runId minted only by a guard denial (a lone security
    // event) or with an empty ledger never reached `run.created`.
    if (includeArchived ? isRealRun(run) : isVisibleRun(run)) {
      runs.push(run);
    }
  }
  return { status: 200, body: { runs } };
}

/**
 * Resolve every OPEN intervention on a run that is leaving the operator's
 * view (cancelled or archived). Leaving them 'open'/'blocking' would pin dead
 * entries on the factory floor forever. The resolution event matches the
 * operator resolve route's shape (`intervention.resolved`, actor operator) and
 * `resolveIntervention` is idempotent per interventionId, so a repeated
 * command appends nothing new. `events` is the run's ledger as read BEFORE the
 * lifecycle append — neither cancellation nor archiving opens interventions,
 * so the pre-command snapshot is the complete open set.
 */
async function resolveOpenInterventionsForRun(
  store: EventStore,
  events: readonly unknown[],
  runId: string,
  input: { readonly resolution: string; readonly note: string },
): Promise<void> {
  const open = filterInterventions(projectInterventions(events), { runId, openOnly: true });
  for (const intervention of open) {
    await resolveIntervention(store, intervention, input);
  }
}

/** The cancel flavor: a cancelled run never resumes, so its interventions die. */
function resolveInterventionsForCancelledRun(
  store: EventStore,
  events: readonly unknown[],
  runId: string,
): Promise<void> {
  return resolveOpenInterventionsForRun(store, events, runId, {
    resolution: 'cancelled',
    note: 'Run was cancelled; the intervention no longer blocks any pending work.',
  });
}

/**
 * The single-run cancel core shared by the cancel route and archive-of-a-
 * non-terminal-run (R16): append `run.cancelled`, resolve the run's open
 * interventions, and propagate ONE daemon `cancelRun` call so queued jobs are
 * released and in-flight work is aborted. `events` is the pre-cancel ledger
 * snapshot from the guard read.
 */
async function appendCancellation(
  ctx: RouteContext,
  runId: string,
  current: RunProjection,
  events: readonly FactoryEvent[],
  reason: string | undefined,
): Promise<void> {
  await ctx.writer.append({
    runId,
    type: 'run.cancelled',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: current.lastSequence },
    severity: 'warn',
    idempotencyKey: `${runId}:run.cancelled`,
    payload: { reason },
  });
  // A cancelled run's open interventions are dead: resolve them so the
  // operator queue never carries blocking entries for a run that ended.
  await resolveInterventionsForCancelledRun(ctx.store, events, runId);
  // Cancel propagates to queued and active execution work (U5): the daemon
  // aborts in-flight jobs and releases queued/abandoned ones as cancelled.
  if (ctx.executionDaemon !== null) {
    await ctx.executionDaemon.cancelRun(runId);
  }
}

/**
 * Append `run.archived` for a run whose guard already passed. The idempotency
 * key carries the command-time subject version: a RETRY of the same command
 * dedups, while a re-archive AFTER an unarchive (a higher version) appends a
 * fresh toggle — a fixed `${runId}:run.archived` key would permanently block
 * re-archiving because store idempotency is global and survives restarts.
 */
function appendArchive(
  ctx: RouteContext,
  runId: string,
  version: number,
  reason: string | undefined,
): Promise<unknown> {
  return ctx.writer.append({
    runId,
    type: 'run.archived',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version },
    severity: 'info',
    idempotencyKey: `${runId}:run.archived:${version}`,
    payload: { reason },
  });
}

async function cancelRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const guarded = await guardRunCommand(ctx, runId, 'run.cancel');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const current = guarded.run;
  // Optional cancel-and-archive as ONE command (R10): the moment the operator
  // stops a run is exactly when they may want it off the floor too, so the
  // body flag folds both into a single guarded command instead of forcing a
  // second round-trip. Without the flag the response still carries the full
  // projected run (fresh `lastSequence` for `expectedVersion`, `archived`), so
  // the UI can offer archive immediately from the cancel confirmation.
  const wantsArchive = body.archive === true;

  // Repeated cancels converge instead of stacking run.cancelled appends. With
  // `archive: true` the archive half still applies (converging like the
  // dedicated archive route would).
  if (current.status === 'cancelled') {
    if (wantsArchive && !current.archived) {
      await appendArchive(ctx, runId, current.lastSequence, str(body.reason));
      const run = projectRun(await ctx.reader.readRun(runId), runId);
      return { status: 200, body: { runId, alreadyCancelled: true, archived: true, run } };
    }
    return {
      status: 200,
      body: {
        runId,
        alreadyCancelled: true,
        ...(wantsArchive ? { alreadyArchived: true } : {}),
        run: current,
      },
    };
  }
  // Terminal runs cannot be cancelled retroactively (mirrors the pause/resume
  // state checks): a completed/failed run keeps its recorded outcome. Archiving
  // a terminal run is the dedicated archive route's job, so `archive: true`
  // never turns a rejected cancel into a partial archive.
  if (current.status === 'completed' || current.status === 'failed') {
    return {
      status: 422,
      body: {
        error: 'run_terminal',
        message: `Run ${runId} is "${current.status}"; a terminal run cannot be cancelled.`,
        run: current,
      },
    };
  }

  await appendCancellation(ctx, runId, current, guarded.events, str(body.reason));
  if (wantsArchive) {
    await appendArchive(ctx, runId, current.lastSequence, str(body.reason));
  }
  const run = projectRun(await ctx.reader.readRun(runId), runId);
  return { status: 200, body: { runId, ...(wantsArchive ? { archived: true } : {}), run } };
}

/**
 * Archive a run: append `run.archived` so the run leaves default views while
 * staying on disk, searchable, and replayable (R7). A NON-TERMINAL run is
 * cancelled first in the SAME command (R16) — cancel append, intervention
 * resolution, and one daemon `cancelRun` call — because the daemon's drain
 * check only gates on paused/cancelled: an archived-but-alive run's queued
 * jobs would execute later. Archiving a terminal run still resolves its open
 * interventions (e.g. a failed run's preflight entries) so the operator queue
 * never lists work for a hidden run. Re-archiving converges (alreadyArchived,
 * no duplicate event), mirroring the alreadyCancelled precedent.
 */
async function archiveRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const guarded = await guardRunCommand(ctx, runId, 'run.archive');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const current = guarded.run;

  if (current.archived) {
    return { status: 200, body: { runId, alreadyArchived: true, run: current } };
  }

  const terminal =
    current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled';
  if (!terminal) {
    // Cancel-then-archive in ONE command (R16): there is no "archived but
    // still executing" state. Queued jobs are released and in-flight work is
    // aborted by the single daemon call inside the cancel core.
    await appendCancellation(
      ctx,
      runId,
      current,
      guarded.events,
      str(body.reason) ?? 'archived while active',
    );
  } else {
    await resolveOpenInterventionsForRun(ctx.store, guarded.events, runId, {
      resolution: 'archived',
      note: 'Run was archived; the intervention no longer needs operator attention.',
    });
  }

  await appendArchive(ctx, runId, current.lastSequence, str(body.reason));
  const run = projectRun(await ctx.reader.readRun(runId), runId);
  // `cancelled: true` reports the R16 side effect so surfaces can confirm both
  // halves of the command from one response.
  return { status: 200, body: { runId, ...(terminal ? {} : { cancelled: true }), run } };
}

/**
 * Unarchive a run: append `run.unarchived` so the run re-enters default views.
 * Visibility ONLY — execution state is never revived (cancelled stays
 * terminal, R13). Unarchiving a visible run converges with no event.
 */
async function unarchiveRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const guarded = await guardRunCommand(ctx, runId, 'run.unarchive');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const current = guarded.run;

  if (!current.archived) {
    return { status: 200, body: { runId, alreadyVisible: true, run: current } };
  }

  await ctx.writer.append({
    runId,
    type: 'run.unarchived',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: current.lastSequence },
    severity: 'info',
    // Version-scoped for the same reason as `run.archived` (see appendArchive):
    // retries dedup, later toggles append.
    idempotencyKey: `${runId}:run.unarchived:${current.lastSequence}`,
    payload: { reason: str(body.reason) },
  });
  const run = projectRun(await ctx.reader.readRun(runId), runId);
  return { status: 200, body: { runId, run } };
}

/**
 * Cancel EVERY cancellable run in one guarded command (the operator's
 * "cancel all tasks" control). Semantics per run match the single cancel:
 * already-cancelled runs converge, terminal (completed/failed) runs keep
 * their recorded outcome, and the batch propagates to queued and in-flight
 * execution work via the daemon. One factory-scoped guard check covers the
 * batch; no per-run stale-version check (a live factory bumps versions
 * constantly and the command is explicitly cross-run).
 *
 * TWO-PHASE SHAPE: every `run.cancelled` is appended FIRST (per-run append
 * failures are collected into `errors` instead of aborting the batch with
 * earlier cancellations already committed), then ONE `cancelRuns` call hands
 * the whole batch to the daemon — which aborts every in-flight executor
 * immediately before its single chained release pass, so cancelling run A
 * never waits behind (or keeps executing) work for run B.
 */
async function cancelAllRuns(ctx: RouteContext): Promise<ApiResponse> {
  const body = asRecord(ctx.request.body);
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'runs' },
    command: 'run.cancel_all',
  });
  if (denial !== null) {
    return denial;
  }
  const reason = str(body.reason) ?? 'operator cancel-all';

  // ONE cross-run read serves every projection in the batch (perf: no
  // readRun per run). Grouping preserves per-run order; `projectRun` sorts
  // defensively anyway.
  const eventsByRun = new Map<string, FactoryEvent[]>();
  for (const event of await ctx.reader.readAll()) {
    const runEvents = eventsByRun.get(event.runId);
    if (runEvents === undefined) {
      eventsByRun.set(event.runId, [event]);
    } else {
      runEvents.push(event);
    }
  }

  const cancelled: string[] = [];
  const alreadyCancelled: string[] = [];
  const skippedTerminal: string[] = [];
  const errors: { runId: string; message: string }[] = [];
  for (const [runId, events] of eventsByRun) {
    const run = projectRun(events, runId);
    if (!isRealRun(run)) {
      continue;
    }
    if (run.status === 'cancelled') {
      alreadyCancelled.push(runId);
      continue;
    }
    if (run.status === 'completed' || run.status === 'failed') {
      skippedTerminal.push(runId);
      continue;
    }
    let cancelAppended = false;
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
      cancelAppended = true;
      // A cancelled run's open interventions are dead: resolve them so the
      // operator queue never carries blocking entries for a run that ended.
      await resolveInterventionsForCancelledRun(ctx.store, events, runId);
    } catch (error) {
      // One run's append failure must not 500 the batch with earlier
      // cancellations already committed: record it and keep cancelling.
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runId, message });
    }
    if (cancelAppended) {
      cancelled.push(runId);
    }
  }

  // ONE daemon propagation for the whole batch (aborts every in-flight
  // executor before the single chained release pass). A propagation failure
  // is reported, not thrown: the `run.cancelled` events are already durable
  // and the daemon's reconcile/drain passes release cancelled work anyway.
  if (ctx.executionDaemon !== null && cancelled.length > 0) {
    try {
      await ctx.executionDaemon.cancelRuns(cancelled);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runId: 'factory', message: `daemon cancel propagation failed: ${message}` });
    }
  }

  return {
    status: 200,
    body: {
      cancelled,
      alreadyCancelled,
      skippedTerminal,
      cancelledCount: cancelled.length,
      ...(errors.length > 0 ? { errors } : {}),
    },
  };
}

/**
 * Trigger (or retry) workspace materialization for a run (full-factory U4).
 * The materializer converges on retry: an already-ready workspace is reused,
 * unchanged-unavailable evidence dedups, and new checkout attempts increment
 * an explicit attempt counter. After a successful materialization the build
 * contract (when one exists) is re-derived with the workspace evidence —
 * `emitBuildContract` is digest-idempotent, so it appends only on change.
 */
async function materializeWorkspaceRoute(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const guarded = await guardRunCommand(ctx, runId, 'workspace.materialize');
  if (guarded.response !== null) {
    return guarded.response;
  }
  const current = guarded.run;

  const result = await ctx.materializeWorkspace(runId, { branch: str(body.branch) });
  if (result === null) {
    return {
      status: 503,
      body: {
        error: 'workspace_disabled',
        message: 'Workspace materialization is not enabled on this server instance.',
      },
    };
  }

  // Reflect materialization evidence in the build contract (U3 -> U4 seam).
  // Only runs that already carry a contract are refreshed; plan-only ledgers
  // stay byte-identical to their V1 shape.
  if (result.ok && current.buildContract !== undefined) {
    await refreshBuildContract(ctx, runId, { workspaceEvidence: true });
  }

  const finalEvents = await ctx.reader.readRun(runId);
  return {
    status: result.ok && result.converged ? 200 : 201,
    body: {
      runId,
      result,
      workspace: projectWorkspace(finalEvents, runId),
      run: projectRun(finalEvents, runId),
    },
  };
}

async function getWorkspace(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const events = await ctx.reader.readRun(runId);
  if (events.length === 0) {
    return notFound(runId);
  }
  return { status: 200, body: { runId, workspace: projectWorkspace(events, runId) } };
}

/**
 * The run artifact contract (full-factory U10): expose the SAME
 * `buildRunOutputs` shape the CLI derives — every field traces to a ledger
 * event, and the hosted URL exists only after `deploy.hosted_ready`. The
 * events URL is absolute when the runtime knows its public base URL, so hosted
 * callers get a fetchable link instead of a bare path.
 */
async function getRunOutputs(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const events = await ctx.reader.readRun(runId);
  if (events.length === 0) {
    return notFound(runId);
  }
  const base = ctx.config.runtime?.publicBaseUrl?.replace(/\/+$/, '') ?? '';
  const eventsUrl = `${base}/api/runs/${encodeURIComponent(runId)}/events`;
  return { status: 200, body: { runId, outputs: buildRunOutputs(runId, events, eventsUrl) } };
}

export function runRoutes(): RouteDef[] {
  return [
    { method: 'POST', pattern: '/api/runs', handler: createRun },
    { method: 'GET', pattern: '/api/runs', handler: listRunsHandler },
    { method: 'POST', pattern: '/api/runs/cancel-all', handler: cancelAllRuns },
    { method: 'POST', pattern: '/api/runs/:id/cancel', handler: cancelRun },
    { method: 'POST', pattern: '/api/runs/:id/archive', handler: archiveRun },
    { method: 'POST', pattern: '/api/runs/:id/unarchive', handler: unarchiveRun },
    { method: 'POST', pattern: '/api/runs/:id/workspace', handler: materializeWorkspaceRoute },
    { method: 'GET', pattern: '/api/runs/:id/workspace', handler: getWorkspace },
    { method: 'GET', pattern: '/api/runs/:id/outputs', handler: getRunOutputs },
  ];
}
