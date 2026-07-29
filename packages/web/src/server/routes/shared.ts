/**
 * Shared helpers for run-scoped routes.
 *
 * Consolidates patterns the run, research, workspace, and execution route
 * modules previously repeated independently:
 *
 *  - `notFound` — the uniform 404 response for an unknown run id,
 *  - `guardRunCommand` — the guard-then-existence check every run-scoped
 *    mutation performs (guard denial FIRST so blocked attempts are audited
 *    even for unknown runs, then 404 for an empty ledger),
 *  - `refreshBuildContract` — the derive+emit build-contract chain (X3):
 *    re-derive from the current projections and append digest-idempotently,
 *    so the recorded contract always reflects the plan/research/workspace
 *    state execution would run against, and
 *  - the run-lifecycle append helpers (`appendArchive`, `appendRunCancellation`,
 *    `resolveInterventionsForCancelledRun`) and the batch cancel core
 *    (`batchCancelRuns`) shared by the per-run archive/cancel routes (runs.ts),
 *    the cancel-all batch (runs.ts), and the factory New Session command
 *    (execution.ts). They live HERE because runs.ts already imports from
 *    execution.ts — an execution.ts -> runs.ts import would create a module
 *    cycle.
 */
import {
  deriveBuildContract,
  emitBuildContract,
  projectResearch,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { EventStore, FactoryEvent, RunProjection } from '@software-factory/core';
import { projectWorkspace, workspaceContractEvidence } from '@software-factory/worker';
import type { ApiResponse, RouteContext } from '../app';
import { asRecord, num } from './parse';
import {
  filterInterventions,
  projectInterventions,
  resolveIntervention,
} from '../execution/interventions';

/** The uniform 404 response for a run id with no ledger events. */
export function notFound(runId: string): ApiResponse {
  return { status: 404, body: { error: 'not_found', message: `Run ${runId} does not exist.` } };
}

export interface GuardedRunContext {
  /** Non-null when the command may not proceed (guard denial or unknown run). */
  readonly response: ApiResponse | null;
  readonly run: RunProjection;
  /** The run's ledger events as read for the guard (reusable by the caller). */
  readonly events: readonly FactoryEvent[];
}

/** Guard + existence check shared by every run-scoped mutating command. */
export async function guardRunCommand(
  ctx: RouteContext,
  runId: string,
  command: string,
): Promise<GuardedRunContext> {
  const body = asRecord(ctx.request.body);
  const events = await ctx.reader.readRun(runId);
  const run = projectRun(events, runId);

  const denial = await ctx.guardMutation({
    subject: { kind: 'run', id: runId, version: num(body.expectedVersion) },
    currentVersion: run.lastSequence,
    command,
  });
  if (denial !== null) {
    return { response: denial, run, events };
  }
  if (run.ledger.length === 0) {
    return { response: notFound(runId), run, events };
  }
  return { response: null, run, events };
}

/**
 * Re-derive and emit the build contract (X3) for a PLANNED run from its
 * current projections. `emitBuildContract` is idempotent on the contract
 * digest, so this appends only when the underlying research/plan/workspace
 * state changed. Returns `true` when the run was planned (contract emitted).
 */
export async function refreshBuildContract(
  ctx: RouteContext,
  runId: string,
  options: { readonly workspaceEvidence?: boolean } = {},
): Promise<boolean> {
  const events = await ctx.reader.readRun(runId);
  const run = projectRun(events, runId);
  if (run.status !== 'planned') {
    return false;
  }
  const contract = deriveBuildContract(
    run,
    projectTickets(events, runId),
    projectResearch(events, runId),
    options.workspaceEvidence === true
      ? workspaceContractEvidence(projectWorkspace(events, runId))
      : undefined,
  );
  await emitBuildContract(ctx.writer, runId, contract);
  return true;
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
export function resolveInterventionsForCancelledRun(
  store: EventStore,
  events: readonly unknown[],
  runId: string,
): Promise<void> {
  return resolveOpenInterventionsForRun(store, events, runId, {
    resolution: 'cancelled',
    note: 'Run was cancelled; the intervention no longer blocks any pending work.',
  });
}

/** The archive flavor: a hidden run must never need operator attention. */
export function resolveInterventionsForArchivedRun(
  store: EventStore,
  events: readonly unknown[],
  runId: string,
): Promise<void> {
  return resolveOpenInterventionsForRun(store, events, runId, {
    resolution: 'archived',
    note: 'Run was archived; the intervention no longer needs operator attention.',
  });
}

/**
 * Append `run.archived` for a run whose guard already passed. The idempotency
 * key carries the command-time subject version: a RETRY of the same command
 * dedups, while a re-archive AFTER an unarchive (a higher version) appends a
 * fresh toggle — a fixed `${runId}:run.archived` key would permanently block
 * re-archiving because store idempotency is global and survives restarts.
 */
export function appendArchive(
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

/**
 * The cancellation pair every cancel flavor shares: append `run.cancelled`
 * (idempotency-keyed so repeats converge), then resolve the run's open
 * interventions — a cancelled run's blocking entries are dead and must never
 * pin the operator queue. `events` is the run's ledger as read BEFORE the
 * append (the pre-command snapshot is the complete open set). Daemon
 * propagation is deliberately NOT here: single-run cancel propagates one
 * `cancelRun`, the batch commands propagate once for the whole batch.
 */
export async function appendRunCancellation(
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
  await resolveInterventionsForCancelledRun(ctx.store, events, runId);
}

/** One run's snapshot handed to `batchCancelRuns`. */
export interface BatchCancelEntry {
  readonly runId: string;
  readonly run: RunProjection;
  readonly events: readonly FactoryEvent[];
}

export interface BatchCancelOutcome {
  /** Runs whose cancellation pair landed (in entry order). */
  readonly cancelled: string[];
  /** Per-run failures, collected instead of aborting the batch mid-way. */
  readonly errors: { runId: string; message: string }[];
  /** Runs whose cancellation failed (callers must not archive these — R16). */
  readonly failedCancels: ReadonlySet<string>;
}

/**
 * The two-phase batch cancel core shared by cancel-all (runs.ts) and New
 * Session (execution.ts): every `run.cancelled` is appended FIRST (per-run
 * failures are collected into `errors`, never a mid-batch 500 with earlier
 * cancellations already committed), then ONE daemon `cancelRuns` call
 * propagates the whole batch — aborting every in-flight executor before the
 * single chained release pass. `propagateRunIds` defaults to the successfully
 * cancelled runs; New Session passes EVERY snapshot stream so stale queued
 * work on terminal or archived runs is released too. A propagation failure is
 * reported in `errors` (runId 'factory'), not thrown: the `run.cancelled`
 * events are already durable and the daemon's reconcile/drain passes release
 * cancelled work anyway.
 */
export async function batchCancelRuns(
  ctx: RouteContext,
  entries: readonly BatchCancelEntry[],
  options: { readonly reason?: string; readonly propagateRunIds?: readonly string[] } = {},
): Promise<BatchCancelOutcome> {
  const cancelled: string[] = [];
  const errors: { runId: string; message: string }[] = [];
  const failedCancels = new Set<string>();
  for (const { runId, run, events } of entries) {
    try {
      await appendRunCancellation(ctx, runId, run, events, options.reason);
      cancelled.push(runId);
    } catch (error) {
      // One run's failure must not abort the batch with earlier cancellations
      // already committed: record it and keep cancelling.
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runId, message });
      failedCancels.add(runId);
    }
  }

  const propagateRunIds = options.propagateRunIds ?? cancelled;
  if (ctx.executionDaemon !== null && propagateRunIds.length > 0) {
    try {
      await ctx.executionDaemon.cancelRuns(propagateRunIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ runId: 'factory', message: `daemon cancel propagation failed: ${message}` });
    }
  }

  return { cancelled, errors, failedCancels };
}
