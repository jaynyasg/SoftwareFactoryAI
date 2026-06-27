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
 */
import {
  DEFAULT_REVIEW_MODE,
  projectRun,
  projectTickets,
  resolveReview,
} from '@software-factory/core';
import type { ReviewDecision, ReviewMode, RiskTier, TicketView } from '@software-factory/core';
import type { ApiResponse, RouteContext, RouteDef } from '../app';
import { asRecord, num, str } from './parse';

function isRiskTier(value: unknown): value is RiskTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isDecision(value: unknown): value is ReviewDecision {
  return value === 'approved' || value === 'rejected';
}

const RISK_RANK: Readonly<Record<RiskTier, number>> = { low: 0, medium: 1, high: 2 };

/** The highest risk tier across a run's projected tickets, if any carry one. */
function highestTicketRisk(tickets: readonly TicketView[]): RiskTier | undefined {
  let highest: RiskTier | undefined;
  for (const ticket of tickets) {
    const tier = ticket.riskTier;
    if (tier === undefined) {
      continue;
    }
    if (highest === undefined || RISK_RANK[tier] > RISK_RANK[highest]) {
      highest = tier;
    }
  }
  return highest;
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
