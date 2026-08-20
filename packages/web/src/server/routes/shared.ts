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
import type { EventActor, FactoryEvent, RunProjection } from '@software-factory/core';
import { projectWorkspace, workspaceContractEvidence } from '@software-factory/worker';
import type { ApiResponse, RouteContext } from '../app';
import { asRecord, num } from './parse';

/** The uniform 404 response for a run id with no ledger events. */
export function notFound(runId: string): ApiResponse {
  return { status: 404, body: { error: 'not_found', message: `Run ${runId} does not exist.` } };
}

/**
 * The operator actor for a route-issued event (G16 attribution). Multi-user
 * callers record their OWN account id — an admin acting on a user's run is
 * recorded as the admin, never masqueraded as the owner. Single-tenant
 * instances keep the historical literal `operator`, byte-identical.
 */
export function operatorActor(ctx: RouteContext): EventActor {
  return { kind: 'operator', id: ctx.identity?.userId ?? 'operator' };
}

/**
 * Owner-or-admin visibility over a projected run (U5).
 *
 * Single-tenant: everyone is the implicit admin — always visible. Multi-user:
 * admins see everything; users see runs whose recorded `ownerId` is theirs.
 * A run WITHOUT an ownerId (legacy/pre-multi-user ledger) is admin-owned by
 * definition (G5), so it is invisible to non-admin users.
 */
export function canSeeRun(ctx: RouteContext, run: Pick<RunProjection, 'ownerId'>): boolean {
  if (!ctx.multiUser) {
    return true;
  }
  if (ctx.identity === null) {
    // The dispatcher never routes an anonymous caller here; fail closed anyway.
    return false;
  }
  return ctx.identity.role === 'admin' || run.ownerId === ctx.identity.userId;
}

export interface OwnedRunRead {
  /** Non-null when the read may not proceed (unknown OR not visible → 404). */
  readonly response: ApiResponse | null;
  readonly run: RunProjection;
  readonly events: readonly FactoryEvent[];
}

/**
 * Existence + visibility check shared by every owner-scoped run READ. A run
 * the caller cannot see answers the SAME 404 as a run that does not exist —
 * read surfaces never confirm another user's run ids (R16).
 */
export async function readOwnedRun(ctx: RouteContext, runId: string): Promise<OwnedRunRead> {
  const events = await ctx.reader.readRun(runId);
  const run = projectRun(events, runId);
  if (events.length === 0 || !canSeeRun(ctx, run)) {
    return { response: notFound(runId), run, events };
  }
  return { response: null, run, events };
}

export interface GuardedRunContext {
  /** Non-null when the command may not proceed (guard denial or unknown run). */
  readonly response: ApiResponse | null;
  readonly run: RunProjection;
  /** The run's ledger events as read for the guard (reusable by the caller). */
  readonly events: readonly FactoryEvent[];
}

/**
 * Guard + existence + ownership check shared by every run-scoped mutating
 * command. Order matters: the command guard runs FIRST so blocked attempts
 * are audited even for unknown runs; an unknown run then 404s; and (U5) a
 * caller mutating a run they do not own is rejected 403 with a
 * `security.command_rejected` audit event on the run's ledger. Admins pass the
 * ownership check on every run (G16 — their actor id records who acted).
 */
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
  const notOwner = await rejectIfNotOwner(ctx, runId, command, run);
  if (notOwner !== null) {
    return { response: notOwner, run, events };
  }
  return { response: null, run, events };
}

/**
 * The U5 ownership rejection for run mutations: a caller acting on a run they
 * do not own gets 403 and the attempt is audited on the run's ledger as
 * `security.command_rejected` (reason `not_owner`). Returns `null` when the
 * caller may proceed.
 */
export async function rejectIfNotOwner(
  ctx: RouteContext,
  runId: string,
  command: string,
  run: Pick<RunProjection, 'ownerId'>,
): Promise<ApiResponse | null> {
  if (canSeeRun(ctx, run)) {
    return null;
  }
  await ctx.writer.append({
    runId,
    type: 'security.command_rejected',
    actor: operatorActor(ctx),
    subject: { kind: 'run', id: runId },
    severity: 'warn',
    payload: { reason: 'not_owner', command },
  });
  return {
    status: 403,
    body: {
      error: 'not_owner',
      message: `Run ${runId} belongs to another account; only its owner or the admin can ${command}.`,
    },
  };
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
