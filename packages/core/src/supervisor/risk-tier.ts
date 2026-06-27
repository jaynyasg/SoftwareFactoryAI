/**
 * Risk-tier computation from work signals.
 *
 * The factory's review policy (see `security/review-policy`) maps a `RiskTier`
 * to required human approvals and autonomous gating. This module produces that
 * tier from explicit, boolean work signals so the mapping stays auditable and
 * deterministic.
 *
 * Baseline is LOW (plain UI/scaffold/test). Work is elevated ABOVE low when it
 * changes dependencies, touches auth/security, changes deploy, or runs a data
 * migration — the classes that warrant risk-aware review. All functions are pure.
 */
import type { RiskTier } from '../events/event-types';

/** Total order over tiers, low (0) -> high (2). */
export const RISK_TIER_RANK: Readonly<Record<RiskTier, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** The tiers in ascending order of severity. */
export const RISK_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];

/** Return the more severe of two tiers. */
export function maxRiskTier(a: RiskTier, b: RiskTier): RiskTier {
  return RISK_TIER_RANK[a] >= RISK_TIER_RANK[b] ? a : b;
}

/** Compare two tiers (negative when `a` is less severe than `b`). */
export function compareRiskTier(a: RiskTier, b: RiskTier): number {
  return RISK_TIER_RANK[a] - RISK_TIER_RANK[b];
}

/** Whether `tier` is at least as severe as `floor`. */
export function riskTierAtLeast(tier: RiskTier, floor: RiskTier): boolean {
  return RISK_TIER_RANK[tier] >= RISK_TIER_RANK[floor];
}

/**
 * Boolean signals describing the nature of a unit of work. Every field is
 * optional; an empty signal set yields LOW. `hintedTier` lets a caller (e.g. a
 * genome module hint) impose a floor directly.
 */
export interface RiskSignals {
  /** Adds or changes third-party dependencies. */
  readonly dependencyChange?: boolean;
  /** Touches authentication, authorization, secrets, or other security surface. */
  readonly authOrSecurity?: boolean;
  /** Changes deploy configuration or triggers a hosted deploy. */
  readonly deployChange?: boolean;
  /** Runs a schema or data migration (potential data loss). */
  readonly dataMigration?: boolean;
  /** Calls an external network/service at build or run time. */
  readonly externalNetwork?: boolean;
  /** Performs a destructive or irreversible operation. */
  readonly destructive?: boolean;
  /** An explicit tier floor (e.g. a genome riskHint.tier). */
  readonly hintedTier?: RiskTier;
}

/**
 * Compute the risk tier for a unit of work. The result is the most severe tier
 * implied by any active signal:
 *  - dependency change / external network  -> at least MEDIUM
 *  - auth/security / deploy / data migration / destructive -> at least HIGH
 *  - an explicit `hintedTier` raises the floor to that tier.
 */
export function computeRiskTier(signals: RiskSignals): RiskTier {
  let tier: RiskTier = 'low';
  if (signals.hintedTier !== undefined) {
    tier = maxRiskTier(tier, signals.hintedTier);
  }
  if (signals.dependencyChange === true) {
    tier = maxRiskTier(tier, 'medium');
  }
  if (signals.externalNetwork === true) {
    tier = maxRiskTier(tier, 'medium');
  }
  if (signals.authOrSecurity === true) {
    tier = maxRiskTier(tier, 'high');
  }
  if (signals.deployChange === true) {
    tier = maxRiskTier(tier, 'high');
  }
  if (signals.dataMigration === true) {
    tier = maxRiskTier(tier, 'high');
  }
  if (signals.destructive === true) {
    tier = maxRiskTier(tier, 'high');
  }
  return tier;
}
