/**
 * Server-side run view-model loader.
 *
 * The browser never imports `@software-factory/core` at runtime (its barrel
 * pulls in node:fs/node:crypto/child_process). Instead, these SERVER helpers
 * read the ledger through the singleton app's `handle()` and fold the events
 * with the SAME core projection functions the rest of the system uses. The
 * results are plain, JSON-serializable objects handed to client components as
 * props (initial render) and over the `/data/runs/:id` route (live polling).
 *
 * This is the "read-only from projections" contract: the UI only ever sees
 * projected state derived from real events — never invented state.
 */
import {
  computeOperatorMetrics,
  computeRunDiagnostics,
  isRealRun,
  projectArtifacts,
  projectOperator,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { FactoryEvent, RunProjection } from '@software-factory/core';
import { getApp } from './instance';
import type { ApiResponse } from './app';
import { deriveDeploy, derivePreview, deriveReviews } from '../lib/run-view';
import type { OperatorAggregate, RunAggregate, SetupStatus } from '../lib/types';

export type { OperatorAggregate, RunAggregate, SetupStatus } from '../lib/types';

function bodyOf(res: ApiResponse): Record<string, unknown> {
  return (res.body ?? {}) as Record<string, unknown>;
}

async function readRunEvents(runId: string): Promise<FactoryEvent[] | null> {
  const res = await getApp().handle({
    method: 'GET',
    path: `/api/runs/${encodeURIComponent(runId)}/events`,
    query: {},
    headers: {},
  });
  if (res.status !== 200) {
    return null;
  }
  return (bodyOf(res).events as FactoryEvent[]) ?? [];
}

/** Load and project one run, or `null` when the run does not exist. */
export async function loadRunAggregate(
  runId: string,
  afterSequence = 0,
): Promise<RunAggregate | null> {
  const events = await readRunEvents(runId);
  if (events === null) {
    return null;
  }
  const run = projectRun(events, runId);
  const tickets = projectTickets(events, runId).tickets;
  const artifacts = projectArtifacts(events, runId).artifacts;
  const operator = projectOperator(events, runId);
  const preview = derivePreview(events);
  const deploy = deriveDeploy(events);
  const reviews = deriveReviews(events);
  const tail = run.ledger.filter((row) => row.sequence > afterSequence);
  return {
    run,
    tickets,
    artifacts,
    operator,
    preview,
    deploy,
    reviews,
    lastSequence: run.lastSequence,
    tail,
  };
}

/**
 * Load the operator-facing aggregate for one run (or the latest run when no id
 * is given): the operator projection plus the computed operator metrics and
 * per-run diagnostics the /operator dashboard panels render. Returns `null` when
 * there is no such run. The dashboard is scoped to a run id so it stays
 * deterministic and parallel-safe (it never silently follows a newer run).
 */
export async function loadOperatorAggregate(runId?: string): Promise<OperatorAggregate | null> {
  let targetRunId = runId;
  if (targetRunId === undefined) {
    const runs = await loadRunList();
    targetRunId = runs[0]?.runId ?? undefined;
  }
  if (targetRunId === undefined) {
    return null;
  }
  const events = await readRunEvents(targetRunId);
  if (events === null) {
    return null;
  }
  const run = projectRun(events, targetRunId);
  // A run id with no events is not a real run.
  if (run.ledger.length === 0) {
    return null;
  }
  const operator = projectOperator(events, targetRunId);
  const tickets = projectTickets(events, targetRunId).tickets;
  const metrics = computeOperatorMetrics(events, { runId: targetRunId, now: Date.now() });
  const diagnostics = computeRunDiagnostics(events, { runId: targetRunId });
  return { runId: run.runId, run, operator, metrics, diagnostics, tickets };
}

/** List every projected run (most-recent first). */
export async function loadRunList(): Promise<RunProjection[]> {
  const res = await getApp().handle({ method: 'GET', path: '/api/runs', query: {}, headers: {} });
  if (res.status !== 200) {
    return [];
  }
  const runs = (bodyOf(res).runs as RunProjection[]) ?? [];
  // Defense-in-depth: drop phantom/empty runs even if the API ever returns one.
  return runs
    .filter(isRealRun)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.lastSequence - a.lastSequence);
}

/** Read the setup status that drives the blocking/actionable checklist. */
export async function loadSetup(): Promise<SetupStatus> {
  const res = await getApp().handle({ method: 'GET', path: '/api/setup', query: {}, headers: {} });
  const body = bodyOf(res);
  return {
    operatorToken: { present: Boolean((body.operatorToken as { present?: boolean })?.present) },
    sandbox: { status: String((body.sandbox as { status?: string })?.status ?? 'unknown') },
    adapters: {
      status: String((body.adapters as { status?: string })?.status ?? 'unknown'),
      detected: ((body.adapters as { detected?: readonly string[] })?.detected ??
        []) as readonly string[],
    },
    deploy: { status: String((body.deploy as { status?: string })?.status ?? 'required') },
    workspace: { root: String((body.workspace as { root?: string })?.root ?? process.cwd()) },
  };
}
