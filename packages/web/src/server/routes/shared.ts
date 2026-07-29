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
 *  - the run-lifecycle append helpers (`appendArchive`,
 *    `resolveOpenInterventionsForRun`, `resolveInterventionsForCancelledRun`)
 *    shared by the per-run archive/cancel routes (runs.ts) and the factory
 *    New Session command (execution.ts). They live HERE because runs.ts
 *    already imports from execution.ts — an execution.ts -> runs.ts import
 *    would create a module cycle.
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
export async function resolveOpenInterventionsForRun(
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
