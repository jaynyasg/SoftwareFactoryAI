/**
 * Artifact confidence (U9) — the blended score and its factor breakdown.
 *
 * The contract that matters: confidence MUST decrease for each negative
 * condition (missing tests, missing provenance, sandbox fallback, dependency
 * risk, uninspected preview), and the returned factors are exactly the breakdown
 * the U8 ArtifactConfidence component renders.
 */
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_CONFIDENCE_FACTOR_KEYS,
  computeArtifactConfidence,
} from '../../src/index';
import type { ArtifactConfidenceInput } from '../../src/index';

/** A best-case artifact: all gates pass, full provenance, low risk, healthy preview. */
const BEST: ArtifactConfidenceInput = {
  gates: { passed: 5, total: 5 },
  testsPresent: true,
  provenanceCompleteness: 1,
  dependencyRisk: 'low',
  sandboxFallback: false,
  previewInspected: true,
  previewHealthy: true,
};

describe('computeArtifactConfidence', () => {
  it('scores a best-case artifact near the top and returns a 0..1 confidence', () => {
    const result = computeArtifactConfidence(BEST);
    expect(result.confidence).toBeGreaterThan(0.95);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('returns the factor breakdown the U8 component renders', () => {
    const { factors } = computeArtifactConfidence(BEST);
    for (const key of ARTIFACT_CONFIDENCE_FACTOR_KEYS) {
      expect(factors[key]).toBeTypeOf('number');
      expect(factors[key]).toBeGreaterThanOrEqual(0);
      expect(factors[key]).toBeLessThanOrEqual(1);
    }
    // Best case: every factor is fully credited.
    expect(factors.gatePassRate).toBe(1);
    expect(factors.provenanceCompleteness).toBe(1);
    expect(factors.dependencyRisk).toBe(1);
    expect(factors.previewEvidence).toBe(1);
    expect(factors.sandboxTrust).toBe(1);
  });

  it('DECREASES for missing tests', () => {
    const worse = computeArtifactConfidence({ ...BEST, testsPresent: false });
    expect(worse.confidence).toBeLessThan(computeArtifactConfidence(BEST).confidence);
    expect(worse.factors.gatePassRate).toBeLessThan(1);
  });

  it('DECREASES for missing provenance', () => {
    const worse = computeArtifactConfidence({ ...BEST, provenanceCompleteness: 0.5 });
    expect(worse.confidence).toBeLessThan(computeArtifactConfidence(BEST).confidence);
    expect(worse.factors.provenanceCompleteness).toBeLessThan(1);
  });

  it('DECREASES for a sandbox fallback (reduced trust)', () => {
    const worse = computeArtifactConfidence({ ...BEST, sandboxFallback: true });
    expect(worse.confidence).toBeLessThan(computeArtifactConfidence(BEST).confidence);
    expect(worse.factors.sandboxTrust).toBeLessThan(1);
  });

  it('DECREASES monotonically as dependency risk rises low -> medium -> high', () => {
    const low = computeArtifactConfidence({ ...BEST, dependencyRisk: 'low' }).confidence;
    const medium = computeArtifactConfidence({ ...BEST, dependencyRisk: 'medium' }).confidence;
    const high = computeArtifactConfidence({ ...BEST, dependencyRisk: 'high' }).confidence;
    expect(medium).toBeLessThan(low);
    expect(high).toBeLessThan(medium);
  });

  it('DECREASES for an uninspected preview', () => {
    const worse = computeArtifactConfidence({ ...BEST, previewInspected: false });
    expect(worse.confidence).toBeLessThan(computeArtifactConfidence(BEST).confidence);
    expect(worse.factors.previewEvidence).toBeLessThan(1);
  });

  it('lowers the gate factor as the gate pass ratio drops', () => {
    const fewer = computeArtifactConfidence({ ...BEST, gates: { passed: 3, total: 5 } });
    expect(fewer.factors.gatePassRate).toBeLessThan(1);
    expect(fewer.confidence).toBeLessThan(computeArtifactConfidence(BEST).confidence);
  });

  it('never returns a confidence outside 0..1 for degenerate input', () => {
    const result = computeArtifactConfidence({
      gates: { passed: 0, total: 0 },
      testsPresent: false,
      provenanceCompleteness: 0,
      dependencyRisk: 'high',
      sandboxFallback: true,
      previewInspected: false,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
