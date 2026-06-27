/**
 * Run routes.
 *
 *   POST /api/runs            (mutating, guarded) — create a run; idempotent via
 *                             an optional idempotency key. Appends `run.created`.
 *   GET  /api/runs            (read-only) — list projected runs.
 *   POST /api/runs/:id/cancel (mutating, guarded) — append `run.cancelled`.
 *
 * Mutations pass through `ctx.guardMutation` first; on denial the guard has
 * already appended the security event and we return its response unchanged
 * (starting nothing).
 */
import { isRealRun, projectRun } from '@software-factory/core';
import type {
  AppendableEvent,
  CallerFamily,
  RunCreatedPayload,
  RunProjection,
} from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, reviewMode, str } from './parse';

function callerFamily(value: unknown): CallerFamily | undefined {
  return value === 'claude' || value === 'codex' || value === 'api' ? value : undefined;
}

async function createRun(ctx: RouteContext): Promise<ApiResponse> {
  const body = asRecord(ctx.request.body);
  const candidateRunId = ctx.idGenerator();

  const denial = await ctx.guardMutation({
    subject: { kind: 'run', id: candidateRunId },
    command: 'run.create',
  });
  if (denial !== null) {
    return denial;
  }

  const payload: RunCreatedPayload = {
    prompt: str(body.prompt),
    prdRef: str(body.prdRef),
    title: str(body.title),
    requestedWorkerCap: num(body.requestedWorkerCap),
    reviewMode: reviewMode(body.reviewMode),
    callerFamily: callerFamily(body.callerFamily),
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

  // Plan the run into the SAME store so the CLI and UI both see a ticket DAG.
  // A dedup re-create carries the same idempotency key (hence the same request),
  // so re-planning from `payload` is correct; `emitPlan` is idempotent and dupes
  // nothing.
  await ctx.planRun(runId, {
    prompt: payload.prompt,
    prdRef: payload.prdRef,
    title: payload.title,
    requestedWorkerCap: payload.requestedWorkerCap,
    reviewMode: payload.reviewMode,
  });

  const run = projectRun(await ctx.reader.readRun(runId), runId);
  return {
    status: result.deduplicated ? 200 : 201,
    body: { runId, deduplicated: result.deduplicated, run },
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
