/**
 * Dependency allow-list + risk-aware review policy.
 *
 * Generated apps may declare third-party dependencies. This policy classifies
 * each declared/added dependency against an allow-list (and an optional
 * deny-list / per-package risk overrides) and produces a single
 * `DependencyDecision`:
 *   - allow-listed packages are LOW risk and pass,
 *   - explicitly denied packages are BLOCKED,
 *   - anything unknown is treated at `defaultUnknownTier` (MEDIUM by default),
 *   - any classification above LOW elevates the decision and REQUIRES review.
 *
 * The decision is what the caller turns into a `review.requested` event (using
 * `decision.riskTier`). This mirrors the supervisor risk model — a dependency
 * change is normally at least MEDIUM (see `computeRiskTier`) — but lets a curated
 * allow-list pre-approve known-safe packages as LOW. Everything here is pure.
 */
import { maxRiskTier, riskTierAtLeast } from '@software-factory/core';
import type { RiskTier } from '@software-factory/core';

/** A declared/added dependency to classify. */
export interface DeclaredDependency {
  readonly name: string;
  readonly version?: string;
  /** Whether it is a dev-only dependency (informational). */
  readonly dev?: boolean;
}

/** Configuration for dependency classification. */
export interface DependencyPolicy {
  /** Pre-approved, low-risk package names. */
  readonly allowList?: readonly string[];
  /** Always-blocked package names. */
  readonly denyList?: readonly string[];
  /** Per-package risk overrides (raises a package above its default tier). */
  readonly riskOverrides?: Readonly<Record<string, RiskTier>>;
  /** Tier applied to packages not on the allow-list (default `medium`). */
  readonly defaultUnknownTier?: RiskTier;
}

/** Per-package classification status. */
export type DependencyStatus = 'allowed' | 'needs_review' | 'blocked';

/** The classification of a single dependency. */
export interface DependencyClassification {
  readonly name: string;
  readonly version?: string;
  readonly status: DependencyStatus;
  readonly riskTier: RiskTier;
  readonly reason: string;
}

/** The aggregate decision across all declared dependencies. */
export interface DependencyDecision {
  readonly classifications: readonly DependencyClassification[];
  /** The most severe tier across all classifications. */
  readonly riskTier: RiskTier;
  /** `true` when any package is blocked or any addition is above LOW risk. */
  readonly reviewRequired: boolean;
  readonly allowed: readonly string[];
  readonly needsReview: readonly string[];
  readonly blocked: readonly string[];
  readonly summary: string;
}

/** The default tier applied to a package that is not on the allow-list. */
export const DEFAULT_UNKNOWN_DEPENDENCY_TIER: RiskTier = 'medium';

/** Classify a single dependency against the policy (pure). */
export function classifyDependency(
  policy: DependencyPolicy,
  dependency: DeclaredDependency,
): DependencyClassification {
  const { name, version } = dependency;

  if (policy.denyList?.includes(name)) {
    return {
      name,
      version,
      status: 'blocked',
      riskTier: 'high',
      reason: `"${name}" is on the dependency deny-list.`,
    };
  }

  const override = policy.riskOverrides?.[name];
  if (override !== undefined) {
    const status: DependencyStatus = riskTierAtLeast(override, 'medium')
      ? 'needs_review'
      : 'allowed';
    return {
      name,
      version,
      status,
      riskTier: override,
      reason: `"${name}" has a ${override}-risk override.`,
    };
  }

  if (policy.allowList?.includes(name)) {
    return {
      name,
      version,
      status: 'allowed',
      riskTier: 'low',
      reason: `"${name}" is allow-listed (pre-approved, low risk).`,
    };
  }

  const tier = policy.defaultUnknownTier ?? DEFAULT_UNKNOWN_DEPENDENCY_TIER;
  return {
    name,
    version,
    status: riskTierAtLeast(tier, 'medium') ? 'needs_review' : 'allowed',
    riskTier: tier,
    reason: `"${name}" is not allow-listed; treated as ${tier} risk pending review.`,
  };
}

/** Evaluate all declared dependencies into a single review decision (pure). */
export function evaluateDependencies(
  policy: DependencyPolicy,
  dependencies: readonly DeclaredDependency[],
): DependencyDecision {
  const classifications = dependencies.map((dependency) => classifyDependency(policy, dependency));

  let riskTier: RiskTier = 'low';
  const allowed: string[] = [];
  const needsReview: string[] = [];
  const blocked: string[] = [];

  for (const classification of classifications) {
    riskTier = maxRiskTier(riskTier, classification.riskTier);
    if (classification.status === 'blocked') {
      blocked.push(classification.name);
    } else if (classification.status === 'needs_review') {
      needsReview.push(classification.name);
    } else {
      allowed.push(classification.name);
    }
  }

  const reviewRequired =
    blocked.length > 0 || needsReview.length > 0 || riskTierAtLeast(riskTier, 'medium');

  const summary =
    classifications.length === 0
      ? 'No dependency additions declared.'
      : `${allowed.length} allowed, ${needsReview.length} need review, ${blocked.length} blocked (max risk: ${riskTier}).`;

  return {
    classifications,
    riskTier,
    reviewRequired,
    allowed,
    needsReview,
    blocked,
    summary,
  };
}
