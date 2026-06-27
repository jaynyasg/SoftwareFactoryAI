import { describe, expect, it } from 'vitest';
import { computeRiskTier, maxRiskTier, riskTierAtLeast } from '../../src/index';

describe('computeRiskTier', () => {
  it('is LOW for plain UI/scaffold/test work (no signals)', () => {
    expect(computeRiskTier({})).toBe('low');
  });

  it('elevates dependency changes ABOVE low', () => {
    expect(computeRiskTier({ dependencyChange: true })).toBe('medium');
    expect(riskTierAtLeast(computeRiskTier({ dependencyChange: true }), 'medium')).toBe(true);
  });

  it('elevates auth/security work ABOVE low', () => {
    const tier = computeRiskTier({ authOrSecurity: true });
    expect(tier).not.toBe('low');
    expect(tier).toBe('high');
  });

  it('elevates deploy changes ABOVE low', () => {
    const tier = computeRiskTier({ deployChange: true });
    expect(tier).not.toBe('low');
    expect(tier).toBe('high');
  });

  it('elevates data migrations ABOVE low', () => {
    const tier = computeRiskTier({ dataMigration: true });
    expect(tier).not.toBe('low');
    expect(tier).toBe('high');
  });

  it('treats external network calls as at least medium', () => {
    expect(computeRiskTier({ externalNetwork: true })).toBe('medium');
  });

  it('takes the most severe tier across multiple signals', () => {
    expect(computeRiskTier({ dependencyChange: true, dataMigration: true })).toBe('high');
  });

  it('honors an explicit hinted tier as a floor', () => {
    expect(computeRiskTier({ hintedTier: 'medium' })).toBe('medium');
    // A higher computed tier still wins over a lower hint.
    expect(computeRiskTier({ hintedTier: 'medium', deployChange: true })).toBe('high');
  });

  it('exposes a usable tier ordering', () => {
    expect(maxRiskTier('low', 'high')).toBe('high');
    expect(maxRiskTier('medium', 'low')).toBe('medium');
    expect(riskTierAtLeast('high', 'medium')).toBe(true);
    expect(riskTierAtLeast('low', 'medium')).toBe(false);
  });
});
