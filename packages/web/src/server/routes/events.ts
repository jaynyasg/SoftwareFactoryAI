/**
 * Read-only run inspection routes (no command guard, per policy).
 *
 *   GET /api/runs/:id/events — the ordered event log for a run.
 *   GET /api/runs/:id        — the replayed run projection.
 *
 * These let an operator reload current state after a stale-command rejection.
 * Streaming (SSE) is deferred to U8; simple JSON is sufficient here.
 *
 * Multi-user (U5): both reads are owner-scoped — a run the caller cannot see
 * answers the same 404 as a run that does not exist (never confirming another
 * user's run ids). Admins see every run.
 */
import { projectRun } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { readOwnedRun } from './shared';

async function getRunEvents(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const owned = await readOwnedRun(ctx, runId);
  if (owned.response !== null) {
    return owned.response;
  }
  return { status: 200, body: { runId, events: owned.events } };
}

async function getRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const owned = await readOwnedRun(ctx, runId);
  if (owned.response !== null) {
    return owned.response;
  }
  return { status: 200, body: { run: projectRun(owned.events, runId) } };
}

export function eventRoutes(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/api/runs/:id/events', access: 'owner-scoped', handler: getRunEvents },
    { method: 'GET', pattern: '/api/runs/:id', access: 'owner-scoped', handler: getRun },
  ];
}
