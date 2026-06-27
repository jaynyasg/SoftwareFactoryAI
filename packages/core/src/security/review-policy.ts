/**
 * Review policy: risk tier -> required human approvals and autonomous gating.
 *
 * Human review is the DEFAULT. Autonomous mode may only auto-pass LOW-risk
 * work; MEDIUM and HIGH always require human review (1 and 2 approvers
 * respectively, per the Ash SWF model). Every function here is pure.
 */
import type { ReviewMode, RiskTier } from '../events/event-types';

/** Human review is the default unless a run explicitly opts into autonomy. */
export const DEFAULT_REVIEW_MODE: ReviewMode = 'human';

/** Human approvers required to pass review at each risk tier. */
export const REQUIRED_APPROVALS: Readonly<Record<RiskTier, number>> = {
  low: 1,
  medium: 1,
  high: 2,
};

/** Number of human approvers required to pass review at `riskTier`. */
export function requiredApprovals(riskTier: RiskTier): number {
  return REQUIRED_APPROVALS[riskTier];
}

/** Whether autonomous mode is ever permitted to auto-pass this tier. */
export function isAutonomousAllowed(riskTier: RiskTier): boolean {
  return riskTier === 'low';
}

/** Whether a command may auto-approve without a human under the given mode. */
export function canAutoApprove(riskTier: RiskTier, mode: ReviewMode): boolean {
  return mode === 'autonomous' && isAutonomousAllowed(riskTier);
}

/** The static review requirement for a risk tier. */
export interface ReviewRequirement {
  readonly riskTier: RiskTier;
  readonly requiredApprovals: number;
  /** Whether autonomous mode may auto-pass this tier. */
  readonly autonomousAllowed: boolean;
}

export function reviewRequirement(riskTier: RiskTier): ReviewRequirement {
  return {
    riskTier,
    requiredApprovals: requiredApprovals(riskTier),
    autonomousAllowed: isAutonomousAllowed(riskTier),
  };
}

/** The resolved decision for a (riskTier, mode) pair. */
export interface ReviewResolution {
  readonly riskTier: RiskTier;
  readonly mode: ReviewMode;
  /** True only when autonomous mode may pass without a human (low risk). */
  readonly autoApprove: boolean;
  /** Human approvers still required (0 when `autoApprove`). */
  readonly requiredApprovals: number;
  /** Why human review is required, when it is. */
  readonly humanReviewReason?: string;
}

/**
 * Resolve how a tier is handled under a mode. Autonomous + low risk auto-passes
 * with zero human approvers; everything else falls back to human review with
 * the tier's required approver count.
 */
export function resolveReview(riskTier: RiskTier, mode: ReviewMode): ReviewResolution {
  if (canAutoApprove(riskTier, mode)) {
    return { riskTier, mode, autoApprove: true, requiredApprovals: 0 };
  }
  const humanReviewReason =
    mode === 'autonomous'
      ? `Autonomous mode cannot auto-pass ${riskTier}-risk work; human review required.`
      : 'Human review is the default mode.';
  return {
    riskTier,
    mode,
    autoApprove: false,
    requiredApprovals: requiredApprovals(riskTier),
    humanReviewReason,
  };
}
