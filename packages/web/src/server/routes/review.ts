/**
 * Review route.
 *
 *   POST /api/runs/:id/review (mutating, guarded) — record a review decision.
 *
 * The command guard enforces auth/origin/CSRF and rejects STALE decisions
 * (a decision made against an outdated projected version). The review policy
 * decides whether autonomous mode may auto-pass the risk tier; medium/high
 * always require human review. Appends `review.decided`.
 */
import { projectRun, resolveReview } from '@software-factory/core';
import type { ReviewDecision, ReviewMode, RiskTier } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRiskTier(value: unknown): value is RiskTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isDecision(value: unknown): value is ReviewDecision {
  return value === 'approved' || value === 'rejected';
}

function reviewMode(value: unknown): ReviewMode | undefined {
  return value === 'autonomous' || value === 'human' ? value : undefined;
}

async function decideReview(ctx: RouteContext): Promise<ApiResponse> {
  const runId = ctx.params.id;
  const body = asRecord(ctx.request.body);
  const current = projectRun(await ctx.reader.readRun(runId), runId);

  if (!isDecision(body.decision)) {
    return {
      status: 400,
      body: { error: 'invalid_decision', message: "decision must be 'approved' or 'rejected'." },
    };
  }
  if (!isRiskTier(body.riskTier)) {
    return {
      status: 400,
      body: { error: 'invalid_risk_tier', message: "riskTier must be 'low', 'medium', or 'high'." },
    };
  }
  const decision = body.decision;
  const riskTier = body.riskTier;

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

  // Policy: autonomous mode may not auto-approve medium/high risk.
  const mode = reviewMode(body.mode) ?? current.reviewMode ?? 'human';
  const resolution = resolveReview(riskTier, mode);
  if (mode === 'autonomous' && decision === 'approved' && !resolution.autoApprove) {
    return {
      status: 422,
      body: { error: 'human_review_required', message: resolution.humanReviewReason },
    };
  }

  await ctx.writer.append({
    runId,
    type: 'review.decided',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: current.lastSequence },
    severity: decision === 'approved' ? 'success' : 'warn',
    payload: { riskTier, decision, rationale: str(body.rationale) },
  });
  const run = projectRun(await ctx.reader.readRun(runId), runId);
  return {
    status: 200,
    body: { runId, decision, riskTier, requiredApprovals: resolution.requiredApprovals, run },
  };
}

export function reviewRoutes(): RouteDef[] {
  return [{ method: 'POST', pattern: '/api/runs/:id/review', handler: decideReview }];
}
