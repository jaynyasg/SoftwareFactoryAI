/**
 * Artifact confidence (0..1) WITH its factor breakdown.
 *
 * Confidence is a blended, evidence-based score — never a vanity number. It is a
 * weighted mean of five factors, each in 0..1 where HIGHER is better:
 *   - gatePassRate          — fraction of quality gates that passed, penalized
 *                             when the unit-test gate is missing,
 *   - provenanceCompleteness — how much of the provenance bundle is present,
 *   - dependencyRisk         — INVERTED dependency risk (low risk -> 1),
 *   - previewEvidence        — whether a local preview was inspected + healthy,
 *   - sandboxTrust           — reduced when a host-local sandbox fallback was used.
 *
 * The score MUST decrease for each negative condition (missing tests, missing
 * provenance, sandbox fallback, dependency risk, uninspected preview): because
 * every weight is positive and each condition lowers exactly one factor, the
 * weighted mean is strictly monotonic in each factor. The returned `factors`
 * record is exactly what the U8 `ArtifactConfidence` component renders.
 *
 * Pure: no clocks, randomness, or I/O — identical inputs yield identical output.
 */
import { RISK_TIER_RANK } from '../supervisor/risk-tier';
import type { RiskTier } from '../events/event-types';

/** Canonical factor keys surfaced in the breakdown (rendered by U8). */
export const ARTIFACT_CONFIDENCE_FACTOR_KEYS = [
  'gatePassRate',
  'provenanceCompleteness',
  'dependencyRisk',
  'previewEvidence',
  'sandboxTrust',
] as const;

export type ArtifactConfidenceFactorKey = (typeof ARTIFACT_CONFIDENCE_FACTOR_KEYS)[number];

/** Per-factor weights (sum to 1). Exported so callers/tests can reason about them. */
export const ARTIFACT_CONFIDENCE_WEIGHTS: Readonly<Record<ArtifactConfidenceFactorKey, number>> = {
  gatePassRate: 0.3,
  provenanceCompleteness: 0.2,
  dependencyRisk: 0.15,
  previewEvidence: 0.2,
  sandboxTrust: 0.15,
};

/** Multiplier applied to the gate pass rate when the unit-test gate is absent. */
export const MISSING_TESTS_PENALTY = 0.5;
/** Trust factor when a reduced-trust host-local sandbox fallback was used. */
export const SANDBOX_FALLBACK_TRUST = 0.5;
/** Preview factor when the preview was never inspected (no trustworthy evidence). */
export const UNINSPECTED_PREVIEW_EVIDENCE = 0.2;
/** Preview factor when inspected but health did not pass. */
export const UNHEALTHY_PREVIEW_EVIDENCE = 0.4;

/** Inputs to `computeArtifactConfidence`. */
export interface ArtifactConfidenceInput {
  /** Quality-gate tally (e.g. lint/typecheck/test/secret/preview). */
  readonly gates: { readonly passed: number; readonly total: number };
  /** Whether the unit-test gate ran (missing tests reduces the gate factor). */
  readonly testsPresent: boolean;
  /** Provenance bundle completeness in 0..1 (see `provenanceCompleteness`). */
  readonly provenanceCompleteness: number;
  /** Aggregate dependency risk tier (higher tier -> lower confidence). */
  readonly dependencyRisk: RiskTier;
  /** Whether a reduced-trust host-local sandbox fallback was used. */
  readonly sandboxFallback: boolean;
  /** Whether the local preview was inspected (health observed). */
  readonly previewInspected: boolean;
  /** Whether the inspected preview was healthy (default true when inspected). */
  readonly previewHealthy?: boolean;
}

/** The blended confidence plus the factor breakdown the U8 UI renders. */
export interface ArtifactConfidenceResult {
  /** Blended confidence in 0..1 (rounded to 4 dp). */
  readonly confidence: number;
  /** Per-factor breakdown in 0..1; keys are `ARTIFACT_CONFIDENCE_FACTOR_KEYS`. */
  readonly factors: Readonly<Record<string, number>>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

/** Round to 4 decimal places to keep scores deterministic and noise-free. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Map a risk tier to an inverted score (low -> 1, medium -> 0.6, high -> 0.2). */
function invertedRisk(tier: RiskTier): number {
  return clamp01(1 - RISK_TIER_RANK[tier] * 0.4);
}

function gatePassRateFactor(input: ArtifactConfidenceInput): number {
  const { passed, total } = input.gates;
  const ratio = total > 0 ? clamp01(passed / total) : 0;
  return clamp01(ratio * (input.testsPresent ? 1 : MISSING_TESTS_PENALTY));
}

function previewEvidenceFactor(input: ArtifactConfidenceInput): number {
  if (!input.previewInspected) {
    return UNINSPECTED_PREVIEW_EVIDENCE;
  }
  const healthy = input.previewHealthy ?? true;
  return healthy ? 1 : UNHEALTHY_PREVIEW_EVIDENCE;
}

/**
 * Compute the blended artifact confidence and its factor breakdown. The blend is
 * a positively-weighted mean of the five factors, so lowering any single factor
 * (missing tests, incomplete provenance, dependency risk, uninspected preview, or
 * a sandbox fallback) strictly decreases the overall confidence.
 */
export function computeArtifactConfidence(
  input: ArtifactConfidenceInput,
): ArtifactConfidenceResult {
  const factors: Record<ArtifactConfidenceFactorKey, number> = {
    gatePassRate: round4(gatePassRateFactor(input)),
    provenanceCompleteness: round4(clamp01(input.provenanceCompleteness)),
    dependencyRisk: round4(invertedRisk(input.dependencyRisk)),
    previewEvidence: round4(previewEvidenceFactor(input)),
    sandboxTrust: round4(input.sandboxFallback ? SANDBOX_FALLBACK_TRUST : 1),
  };

  let confidence = 0;
  for (const key of ARTIFACT_CONFIDENCE_FACTOR_KEYS) {
    confidence += factors[key] * ARTIFACT_CONFIDENCE_WEIGHTS[key];
  }

  return { confidence: round4(clamp01(confidence)), factors };
}
