/**
 * Review route.
 *
 *   POST /api/runs/:id/review (mutating, guarded) — record a review decision.
 *
 * The command guard enforces auth/origin/CSRF and rejects STALE decisions
 * (a decision made against an outdated projected version). The autonomous-gate
 * decision metadata is derived from SERVER state only — the run's `reviewMode`
 * (from the `run.created` event) and the highest projected ticket risk tier — so
 * a client cannot relax the gate by posting `mode:'human'` or `riskTier:'low'`.
 * Autonomous mode no longer stops for any risk tier; human mode reports approval
 * requirements only for high-risk work. Appends `review.decided`.
 *
 * STAGE RESUME (U7): when the approved decision closes a pending stage review
 * (`review.requested` with `stage: gates|execution`, requested by a blocked
 * gate stage or an exhausted repair loop), the route resolves the stage's open
 * approval-resolvable interventions and re-enqueues the CORRECT job — the
 * gate-rerun job for `gates`, an execution retry for `execution`. KTD6 holds
 * in every mode: `canReviewUnblock` never admits `policy_block` (or
 * setup-class) interventions, so a policy-blocked action cannot be approved
 * through this route — not even in autonomous mode — and nothing is
 * re-enqueued when only unresolvable blocks are open.
 */
import {
  DEFAULT_REVIEW_MODE,
  canReviewUnblock,
  projectRun,
  projectTickets,
  resolveReview,
} from '@software-factory/core';
import type { ReviewDecision, ReviewMode, RiskTier } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, str } from './parse';
import { deriveReviews, highestTicketRisk } from '../../lib/run-view';
import {
  countJobFailures,
  enqueueJob,
  gateRerunJobId,
  isActiveJobStatus,
  projectExecutionQueue,
} from '../execution/queue';
import {
  filterInterventions,
  projectInterventions,
  resolveIntervention,
} from '../execution/interventions';
import { requestExecutionStart } from './execution';

function isRiskTier(value: unknown): value is RiskTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isDecision(value: unknown): value is ReviewDecision {
  return value === 'approved' || value === 'rejected';
}

/** Outcome of a stage resume attempted by an approved review decision. */
export interface StageResumeResult {
  readonly stage: 'gates' | 'execution';
  /** Interventions resolved by the approval (approval-resolvable kinds only). */
  readonly resolvedInterventions: readonly string[];
  /** Whether the stage's job is (re-)queued after the approval. */
  readonly queued: boolean;
  /**
   * Whether the factory drain gate is engaged: a queued job WAITS instead of
   * running until the operator resumes execution. Absent when nothing queued.
   */
  readonly held?: boolean;
  readonly note?: string;
}

/**
 * Re-enqueue the blocked stage's job and resolve its approval-resolvable
 * interventions. KTD6: interventions whose kind fails `canReviewUnblock`
 * (policy blocks, missing setup) are NEVER resolved here, and when none are
 * resolvable the approval resumes nothing.
 *
 * ENQUEUE FEASIBILITY IS CHECKED FIRST: interventions are resolved only once
 * the stage's job is actually (re-)queued. A refused re-enqueue (retry budget
 * exhausted, execution controls disabled, preflight failed) leaves the
 * blocking interventions OPEN so the run never sits blocked with an empty
 * intervention queue.
 */
async function resumeBlockedStage(
  ctx: RouteContext,
  runId: string,
  stage: 'gates' | 'execution',
): Promise<StageResumeResult> {
  const events = await ctx.reader.readRun(runId);
  const open = filterInterventions(projectInterventions(events), {
    runId,
    blockingStage: stage,
    openOnly: true,
  });
  const resolvable = open.filter((item) => canReviewUnblock(item.kind));
  if (resolvable.length === 0) {
    return {
      stage,
      resolvedInterventions: [],
      queued: false,
      note:
        open.length > 0
          ? 'No approval-resolvable intervention is open for this stage (policy/setup blocks require their recorded action, not an approval).'
          : 'No open intervention blocks this stage.',
    };
  }

  const resolveAll = async (): Promise<readonly string[]> => {
    for (const intervention of resolvable) {
      await resolveIntervention(ctx.store, intervention, {
        resolution: 'approved',
        note: 'Review approval resumed the blocked stage.',
      });
    }
    return resolvable.map((item) => item.interventionId);
  };

  const daemon = ctx.executionDaemon;
  if (daemon === null) {
    return {
      stage,
      resolvedInterventions: [],
      queued: false,
      note: 'Execution controls are disabled on this instance; nothing was re-enqueued and the blocking interventions stay open.',
    };
  }

  if (stage === 'gates') {
    const jobId = gateRerunJobId(runId);
    const existing = projectExecutionQueue(events, runId).byJobId[jobId];
    if (existing !== undefined && isActiveJobStatus(existing.status)) {
      return { stage, resolvedInterventions: await resolveAll(), queued: true, held: daemon.held };
    }
    const attempt = (existing?.attempt ?? 0) + 1;
    // Ledger-derived failure budget (failed/blocked releases), so safe yields
    // never consume the gate re-run budget — mirrors the execution retry path.
    const failures = countJobFailures(events, jobId);
    if (failures >= daemon.config.maxAttempts) {
      return {
        stage,
        resolvedInterventions: [],
        queued: false,
        note: `Gate re-run attempt ${failures + 1} exceeds the retry budget (${daemon.config.maxAttempts}); the blocking interventions stay open.`,
      };
    }
    await enqueueJob(ctx.store, {
      runId,
      jobId,
      jobKind: 'gate-rerun',
      attempt,
      reason: 'review approval resumed the gate stage',
    });
    daemon.notify();
    return { stage, resolvedInterventions: await resolveAll(), queued: true, held: daemon.held };
  }

  const outcome = await requestExecutionStart(ctx, runId, {
    command: 'retry',
    reason: 'review approval resumed execution',
  });
  const queued = outcome.kind === 'queued' || outcome.kind === 'already_active';
  return {
    stage,
    // A refused retry (budget exhausted, preflight failed, …) resolves
    // NOTHING: the blocking interventions stay open and actionable.
    resolvedInterventions: queued ? await resolveAll() : [],
    queued,
    ...(queued ? { held: daemon.held } : {}),
    note: queued ? undefined : outcome.kind,
  };
}

async function decideReview(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const events = await ctx.reader.readRun(runId);
  const current = projectRun(events, runId);

  if (!isDecision(body.decision)) {
    return {
      status: 400,
      body: { error: 'invalid_decision', message: "decision must be 'approved' or 'rejected'." },
    };
  }
  const decision = body.decision;

  const denial = await ctx.guardMutation({
    subject: { kind: 'run', id: runId, version: num(body.expectedVersion) },
    currentVersion: current.lastSequence,
    command: 'review.decide',
  });
  if (denial !== null) {
    return denial;
  }

  if (current.ledger.length === 0) {
    return { status: 404, body: { error: 'not_found', message: `Run ${runId} does not exist.` } };
  }

  // A cancelled run takes NO review decisions (mirrors the cancel route's
  // terminal-state check): approving one would record `review.decided` and —
  // on the gates path — enqueue a gate re-run that instantly releases as
  // cancelled while reporting queued:true. Placed BEFORE any append so a
  // decision against a cancelled run makes zero ledger writes.
  if (current.status === 'cancelled') {
    return {
      status: 422,
      body: {
        error: 'run_cancelled',
        message: `Run ${runId} is cancelled; a cancelled run cannot take review decisions.`,
        run: current,
      },
    };
  }

  // SERVER-AUTHORITATIVE gate inputs (never trust the client body for these):
  //  - mode: the run's reviewMode from `run.created` (default human), and
  //  - riskTier: the highest projected ticket tier set by the planner. When no
  //    ticket carries a tier (e.g. a not-yet-planned run), fall back to the
  //    client-declared tier purely to record the decision payload.
  const serverRisk = highestTicketRisk(projectTickets(events, runId).tickets);
  const riskTier: RiskTier | undefined =
    serverRisk ?? (isRiskTier(body.riskTier) ? body.riskTier : undefined);
  if (riskTier === undefined) {
    return {
      status: 400,
      body: { error: 'invalid_risk_tier', message: "riskTier must be 'low', 'medium', or 'high'." },
    };
  }
  const mode: ReviewMode = current.reviewMode ?? DEFAULT_REVIEW_MODE;
  const resolution = resolveReview(riskTier, mode);

  // FIFO target: the oldest pending review this decision closes (matches
  // `deriveReviews`). Its sequence is the stable idempotency anchor — a retried
  // decide against the SAME pending review dedups instead of appending a second
  // `review.decided` that FIFO-pairing would surface as a spurious standalone
  // decision. When no review is pending (a bare operator decision) fall back to
  // the projected version, so an instantaneous double-submit still collapses.
  const pending = deriveReviews(events).find((item) => item.status === 'pending');
  const idempotencyAnchor = pending?.sequence ?? current.lastSequence;

  // A retried decide reports the SAME resume outcome as the original: `resumed`
  // is re-derived from the post-append ledger below, so a deduped append still
  // reflects the (already-applied) stage resume.
  await ctx.writer.append({
    runId,
    type: 'review.decided',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: current.lastSequence },
    severity: decision === 'approved' ? 'success' : 'warn',
    idempotencyKey: `${runId}:review.decided:${decision}:${idempotencyAnchor}`,
    payload: { riskTier, decision, rationale: str(body.rationale) },
  });

  // U7: an APPROVED decision closes the oldest pending review (same FIFO as
  // `deriveReviews`); when that review carries a blocked stage, the approval
  // resumes it. Rejections record the decision and resume nothing.
  let resumed: StageResumeResult | null = null;
  if (decision === 'approved' && pending?.stage !== undefined) {
    resumed = await resumeBlockedStage(ctx, runId, pending.stage);
  }

  const run = projectRun(await ctx.reader.readRun(runId), runId);
  return {
    status: 200,
    body: {
      runId,
      decision,
      riskTier,
      requiredApprovals: resolution.requiredApprovals,
      resumed,
      run,
    },
  };
}

export function reviewRoutes(): RouteDef[] {
  return [{ method: 'POST', pattern: '/api/runs/:id/review', handler: decideReview }];
}
