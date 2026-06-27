/**
 * Review policy: risk tier + mode -> required human approvals.
 *
 * Human review is the DEFAULT, but it only stops for HIGH-risk work. LOW and
 * MEDIUM work continue without a review stop. Autonomous mode does not stop for
 * any risk tier; separate command/security policies still block policy-blocked
 * actions. Every function here is pure.
 */
import type { ReviewMode, RiskTier } from '../events/event-types';

/** Human review is the default unless a run explicitly opts into autonomy. */
export const DEFAULT_REVIEW_MODE: ReviewMode = 'human';

/** Human approvers required to pass review at each risk tier. */
export const REQUIRED_APPROVALS: Readonly<Record<RiskTier, number>> = {
  low: 0,
  medium: 0,
  high: 2,
};

/** Number of human approvers required to pass review at `riskTier`. */
export function requiredApprovals(riskTier: RiskTier): number {
  return REQUIRED_APPROVALS[riskTier];
}

/** Whether autonomous mode is ever permitted to auto-pass this tier. */
export function isAutonomousAllowed(riskTier: RiskTier): boolean {
  return riskTier === 'low' || riskTier === 'medium' || riskTier === 'high';
}

/** Whether a command may auto-approve without a human under the given mode. */
export function canAutoApprove(riskTier: RiskTier, mode: ReviewMode): boolean {
  return mode === 'autonomous' || requiredApprovals(riskTier) === 0;
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
  /** True when the tier/mode continues without stopping for human review. */
  readonly autoApprove: boolean;
  /** Human approvers still required (0 when `autoApprove`). */
  readonly requiredApprovals: number;
  /** Why human review is required, when it is. */
  readonly humanReviewReason?: string;
}

/**
 * Resolve how a tier is handled under a mode. Autonomous mode never stops for a
 * risk tier; human mode stops only for high risk.
 */
export function resolveReview(riskTier: RiskTier, mode: ReviewMode): ReviewResolution {
  if (canAutoApprove(riskTier, mode)) {
    return { riskTier, mode, autoApprove: true, requiredApprovals: 0 };
  }
  return {
    riskTier,
    mode,
    autoApprove: false,
    requiredApprovals: requiredApprovals(riskTier),
    humanReviewReason: 'Human mode stops for high-risk work.',
  };
}
