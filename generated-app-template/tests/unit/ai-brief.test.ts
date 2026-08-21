import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SOURCE,
  deterministicBrief,
  generateBrief,
  isLiveProviderConfigured,
} from '@/lib/ai-brief';

const input = {
  title: 'Support chatbot',
  description: 'A bot to triage support tickets and hand off to humans. '.repeat(3),
  category: 'Conversational AI',
  budget: 5000,
};

describe('ai-brief', () => {
  it('produces identical output for identical input (deterministic)', async () => {
    const a = await generateBrief(input, {});
    const b = await generateBrief(input, {});
    expect(a).toEqual(b);
  });

  it('uses the deterministic fallback when no live provider is configured', async () => {
    const brief = await generateBrief(input, {});
    expect(brief.source).toBe(FALLBACK_SOURCE);
    expect(isLiveProviderConfigured({})).toBe(false);
  });

  it('derives content and a suggested budget from the request fields', () => {
    const brief = deterministicBrief(input);
    expect(brief.summary).toContain('Support chatbot');
    expect(brief.summary).toContain('Conversational AI');
    expect(brief.scope.length).toBeGreaterThan(0);
    expect(brief.successCriteria.length).toBeGreaterThan(0);
    expect(brief.suggestedBudget).toBeGreaterThanOrEqual(input.budget);
  });

  it('detects a configured live provider from the environment', () => {
    expect(isLiveProviderConfigured({ AI_BRIEF_PROVIDER: 'openai', AI_BRIEF_API_KEY: 'sk-x' })).toBe(
      true,
    );
    expect(isLiveProviderConfigured({ AI_BRIEF_PROVIDER: 'openai' })).toBe(false);
  });
});
