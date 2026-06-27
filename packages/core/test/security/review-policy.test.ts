import { describe, expect, it } from 'vitest';
import { resolveReview } from '../../src/index';

describe('review policy', () => {
  it('human mode stops only for high-risk work', () => {
    expect(resolveReview('low', 'human')).toMatchObject({
      autoApprove: true,
      requiredApprovals: 0,
    });
    expect(resolveReview('medium', 'human')).toMatchObject({
      autoApprove: true,
      requiredApprovals: 0,
    });
    expect(resolveReview('high', 'human')).toMatchObject({
      autoApprove: false,
      requiredApprovals: 2,
    });
  });

  it('autonomous mode does not stop for any risk tier', () => {
    for (const riskTier of ['low', 'medium', 'high'] as const) {
      expect(resolveReview(riskTier, 'autonomous')).toMatchObject({
        autoApprove: true,
        requiredApprovals: 0,
      });
    }
  });
});
