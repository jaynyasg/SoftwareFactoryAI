/**
 * Shared helpers for run-scoped routes.
 *
 * Consolidates three patterns the run, research, workspace, and execution
 * route modules previously repeated independently:
 *
 *  - `notFound` — the uniform 404 response for an unknown run id,
 *  - `guardRunCommand` — the guard-then-existence check every run-scoped
 *    mutation performs (guard denial FIRST so blocked attempts are audited
 *    even for unknown runs, then 404 for an empty ledger), and
 *  - `refreshBuildContract` — the derive+emit build-contract chain (X3):
 *    re-derive from the current projections and append digest-idempotently,
 *    so the recorded contract always reflects the plan/research/workspace
 *    state execution would run against.
 */
import {
  deriveBuildContract,
  emitBuildContract,
  projectResearch,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { FactoryEvent, RunProjection } from '@software-factory/core';
import { projectWorkspace, workspaceContractEvidence } from '@software-factory/worker';
import type { ApiResponse, RouteContext } from '../app';
import { asRecord, num } from './parse';

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
