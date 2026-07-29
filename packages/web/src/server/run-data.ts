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
  canReviewUnblock,
  computeOperatorMetrics,
  computeRunDiagnostics,
  isRealRun,
  projectArtifacts,
  projectOperator,
  projectResearch,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { FactoryEvent, RunProjection } from '@software-factory/core';
import { getApp } from './instance';
import type { ApiResponse } from './app';
import { filterInterventions, projectInterventions } from './execution/interventions';
import { executionJobId, projectExecutionQueue } from './execution/queue';
import { projectPreflight } from './execution/preflight';
import { parseExecutionOverview } from '../lib/execution-overview';
import { parseInterventionQueue } from '../lib/intervention-queue';
import {
  deriveDeploy,
  deriveGateOutcomes,
  derivePackage,
  derivePreview,
  deriveRepairSummaries,
  deriveReviews,
} from '../lib/run-view';
import type { BlockedStageView } from '../lib/run-view';
import type {
  ExecutionOverview,
  FloorStatus,
  OperatorAggregate,
  RunAggregate,
  SetupStatus,
} from '../lib/types';

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
  const research = projectResearch(events, runId);
  const preflight = projectPreflight(events, runId);
  const executionJob = projectExecutionQueue(events, runId).byJobId[executionJobId(runId)] ?? null;
  const preview = derivePreview(events);
  const deploy = deriveDeploy(events);
  const packageView = derivePackage(events);
  const reviews = deriveReviews(events);
  const gates = deriveGateOutcomes(events);
  const repairs = deriveRepairSummaries(events);
  // OPEN interventions for the run, with approvability computed here from the
  // CORE review policy (KTD6) so the client never re-implements it.
  const interventions: BlockedStageView[] = filterInterventions(projectInterventions(events), {
    runId,
    openOnly: true,
  }).map((item) => ({
    interventionId: item.interventionId,
    kind: item.kind,
    blockingStage: item.blockingStage,
    severity: item.severity,
    reason: item.reason,
    requiredAction: item.requiredAction,
    approvable: canReviewUnblock(item.kind),
  }));
  const tail = run.ledger.filter((row) => row.sequence > afterSequence);
  return {
    run,
    tickets,
    artifacts,
    operator,
    research,
    preflight,
    executionJob,
    preview,
    deploy,
    packageView,
    reviews,
    gates,
    repairs,
    interventions,
    lastSequence: run.lastSequence,
    tail,
  };
}

/**
 * Load the combined floor payload (execution overview + intervention queue)
 * through the same GET /api/floor route the client polls, so the initial
 * render and every poll see identical state — and the SSR path pays ONE
 * ledger read for both halves, exactly like a client tick. Both halves go
 * through the SAME shared structural parsers the browser client uses
 * (execution-overview.ts / intervention-queue.ts), so first paint and every
 * subsequent poll can never diverge on validation or degrade semantics.
 */
export async function loadFloorStatus(): Promise<FloorStatus> {
  const res = await getApp().handle({ method: 'GET', path: '/api/floor', query: {}, headers: {} });
  const body = bodyOf(res);
  return {
    overview: parseExecutionOverview(body),
    queue: parseInterventionQueue(body),
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

/**
 * Load the factory-wide execution state (drain gate + cross-run job counts)
 * through the same GET /api/execution route the client polls, so the initial
 * render and every poll see identical state.
 */
export async function loadExecutionOverview(): Promise<ExecutionOverview> {
  const res = await getApp().handle({
    method: 'GET',
    path: '/api/execution',
    query: {},
    headers: {},
  });
  return parseExecutionOverview(bodyOf(res));
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
    runtime: {
      mode: String((body.runtime as { mode?: string })?.mode ?? 'local'),
      publicBaseUrl:
        typeof (body.runtime as { publicBaseUrl?: unknown })?.publicBaseUrl === 'string'
          ? String((body.runtime as { publicBaseUrl?: string }).publicBaseUrl)
          : undefined,
      factoryDir:
        typeof (body.runtime as { factoryDir?: unknown })?.factoryDir === 'string'
          ? String((body.runtime as { factoryDir?: string }).factoryDir)
          : undefined,
      operatorTokenSource:
        typeof (body.runtime as { operatorTokenSource?: unknown })?.operatorTokenSource === 'string'
          ? String((body.runtime as { operatorTokenSource?: string }).operatorTokenSource)
          : undefined,
    },
  };
}
