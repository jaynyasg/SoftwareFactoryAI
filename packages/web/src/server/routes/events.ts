/**
 * Read-only run inspection routes (no command guard, per policy).
 *
 *   GET /api/runs/:id/events — the ordered event log for a run.
 *   GET /api/runs/:id        — the replayed run projection.
 *
 * These let an operator reload current state after a stale-command rejection.
 * Streaming (SSE) is deferred to U8; simple JSON is sufficient here.
 */
import { projectRun } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';

function notFound(runId: string): ApiResponse {
  return { status: 404, body: { error: 'not_found', message: `Run ${runId} does not exist.` } };
}

async function getRunEvents(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const events = await ctx.reader.readRun(runId);
  if (events.length === 0) {
    return notFound(runId);
  }
  return { status: 200, body: { runId, events } };
}

async function getRun(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const events = await ctx.reader.readRun(runId);
  if (events.length === 0) {
    return notFound(runId);
  }
  return { status: 200, body: { run: projectRun(events, runId) } };
}

export function eventRoutes(): RouteDef[] {
  return [
    { method: 'GET', pattern: '/api/runs/:id/events', handler: getRunEvents },
    { method: 'GET', pattern: '/api/runs/:id', handler: getRun },
  ];
}
