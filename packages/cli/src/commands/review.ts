/**
 * `software-factory review <runId> --decision approved|rejected` — record a
 * review decision for a run (full-factory parity).
 *
 * Wires the existing `api-client.review()` method: an APPROVED decision that
 * closes a pending stage review unblocks the run (resolving approval-resolvable
 * interventions and re-enqueuing the blocked stage's job); a REJECTED decision
 * records the outcome and resumes nothing. The route derives the review
 * authority (mode + risk tier) SERVER-side — the CLI only submits the decision,
 * an optional rationale, and a fresh `expectedVersion` so the guard's stale-
 * version protection stays effective (pin `--expected-version` to assert against
 * a known ledger version instead).
 *
 * `--risk-tier` is optional: it is only used to record the decision payload when
 * a run has no planned ticket tier yet; the route otherwise overrides it with
 * the highest projected ticket tier, so a client cannot relax the gate.
 */
import type { ReviewDecision, RiskTier } from '@software-factory/core';
import type { ApiClient, ReviewResult } from '../api-client';
import type { CliIo } from '../cli-io';

export interface ReviewCommandArgs {
  readonly runId: string;
  readonly decision: ReviewDecision;
  /** Recorded only when the run has no planned ticket tier (route-overridden). */
  readonly riskTier?: RiskTier;
  readonly rationale?: string;
  /** Pin the stale-version check; resolved from the run when absent. */
  readonly expectedVersion?: number;
  readonly json?: boolean;
}

export interface ReviewCommandDeps {
  readonly client: ApiClient;
  readonly io: CliIo;
}

/** Type guard: a valid review decision. */
export function isReviewDecision(value: string | undefined): value is ReviewDecision {
  return value === 'approved' || value === 'rejected';
}

/** Type guard: a valid risk tier. */
export function isRiskTier(value: string | undefined): value is RiskTier {
  return value === 'low' || value === 'medium' || value === 'high';
}

export async function reviewCommand(
  args: ReviewCommandArgs,
  deps: ReviewCommandDeps,
): Promise<ReviewResult> {
  // Resolve a fresh expectedVersion (unless pinned) so the guard's stale check
  // stays effective without the caller tracking the ledger version by hand.
  const expectedVersion =
    args.expectedVersion ?? (await deps.client.getRun(args.runId)).lastSequence;
  const result = await deps.client.review(args.runId, {
    decision: args.decision,
    // The route treats this as a payload fallback only (server risk wins).
    riskTier: args.riskTier ?? 'low',
    expectedVersion,
    rationale: args.rationale,
  });

  if (args.json === true) {
    deps.io.out(JSON.stringify(result, null, 2));
    return result;
  }

  const resumed = result.resumed;
  const resumeNote =
    resumed === undefined
      ? ''
      : resumed.queued
        ? ` — resumed ${resumed.stage} stage (${resumed.resolvedInterventions.length} intervention(s) resolved)`
        : ` — ${resumed.stage} stage not resumed${resumed.note !== undefined ? `: ${resumed.note}` : ''}`;
  deps.io.out(`${args.runId}: review ${args.decision}${resumeNote}`);
  return result;
}
