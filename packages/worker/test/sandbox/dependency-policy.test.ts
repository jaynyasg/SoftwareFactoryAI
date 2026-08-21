/**
 * Dependency allow-list + risk-aware review policy.
 *
 * Asserts the core U6 scenario: allow-listed low-risk deps pass with no review,
 * while unapproved / higher-risk / denied packages elevate risk and require
 * review (the decision the caller turns into `review.requested`).
 */
import { describe, expect, it } from 'vitest';
import { classifyDependency, evaluateDependencies } from '../../src/index';
import type { DependencyPolicy } from '../../src/index';

const POLICY: DependencyPolicy = {
  allowList: ['react', 'zod', '@software-factory/core'],
  denyList: ['left-pad-malware'],
  riskOverrides: { 'child-process-exec': 'high' },
};

describe('dependency policy', () => {
  it('passes allow-listed low-risk dependencies with no review', () => {
    const decision = evaluateDependencies(POLICY, [
      { name: 'react', version: '19.0.0' },
      { name: 'zod', version: '3.23.0' },
    ]);
    expect(decision.riskTier).toBe('low');
    expect(decision.reviewRequired).toBe(false);
    expect(decision.allowed).toEqual(['react', 'zod']);
    expect(decision.needsReview).toEqual([]);
    expect(decision.blocked).toEqual([]);
  });

  it('flags an unapproved package as needs-review and elevates risk to medium', () => {
    const decision = evaluateDependencies(POLICY, [{ name: 'react' }, { name: 'some-random-pkg' }]);
    expect(decision.needsReview).toContain('some-random-pkg');
    expect(decision.riskTier).toBe('medium');
    expect(decision.reviewRequired).toBe(true);
  });

  it('blocks deny-listed packages and reports them as high risk', () => {
    const decision = evaluateDependencies(POLICY, [{ name: 'left-pad-malware' }]);
    expect(decision.blocked).toEqual(['left-pad-malware']);
    expect(decision.riskTier).toBe('high');
    expect(decision.reviewRequired).toBe(true);
  });

  it('honors per-package risk overrides above low risk', () => {
    const classification = classifyDependency(POLICY, { name: 'child-process-exec' });
    expect(classification.status).toBe('needs_review');
    expect(classification.riskTier).toBe('high');
  });

  it('treats an empty dependency set as low risk with no review', () => {
    const decision = evaluateDependencies(POLICY, []);
    expect(decision.riskTier).toBe('low');
    expect(decision.reviewRequired).toBe(false);
    expect(decision.summary).toMatch(/no dependency additions/i);
  });
});
