/**
 * AI brief generation.
 *
 * Given a service request's fields, produce a structured brief a provider can
 * act on. When a live model provider is configured (AI_BRIEF_PROVIDER +
 * AI_BRIEF_API_KEY) this is where a real model call would slot in behind the
 * same async signature. Until then — and in tests/CI — we use a fully
 * deterministic, dependency-free fallback so output is reproducible with no
 * external services.
 */

export interface BriefInput {
  title: string;
  description: string;
  category: string;
  budget: number;
}

export interface GeneratedBrief {
  summary: string;
  scope: string;
  successCriteria: string;
  suggestedBudget: number;
  source: string;
}

export const FALLBACK_SOURCE = 'deterministic-fallback';

type EnvLike = Record<string, string | undefined>;

/** Whether a live model provider is configured via the environment. */
export function isLiveProviderConfigured(env: EnvLike = process.env): boolean {
  return Boolean(env.AI_BRIEF_PROVIDER && env.AI_BRIEF_API_KEY);
}

/**
 * Deterministic, dependency-free brief derived purely from the request fields.
 * Identical input always yields identical output (used directly by tests).
 */
export function deterministicBrief(input: BriefInput): GeneratedBrief {
  const title = input.title.trim();
  const category = input.category.trim();
  const description = input.description.trim();

  // Complexity is a stable function of the description length (1..5), used to
  // nudge the suggested budget — no randomness, so the brief is reproducible.
  const complexity = Math.min(5, Math.max(1, Math.ceil(description.length / 80)));
  const suggestedBudget = input.budget + complexity * 50;

  const summary =
    `AI-assisted engagement to deliver "${title}" in the ${category} space. ` +
    `The customer describes: ${description}`;

  const scope = [
    `1. Clarify requirements and success metrics for "${title}".`,
    `2. Design and implement the ${category} solution the customer described.`,
    `3. Validate against the acceptance criteria and hand off with documentation.`,
  ].join('\n');

  const successCriteria = [
    `Solution addresses the stated need: ${title}.`,
    `Delivered at an estimated complexity tier of ${complexity}/5.`,
    `Customer accepts a provider proposal at or near the suggested budget.`,
  ].join('\n');

  return { summary, scope, successCriteria, suggestedBudget, source: FALLBACK_SOURCE };
}

/**
 * Generate a brief. Async so a real provider call can be slotted in without
 * changing callers. Falls back to the deterministic template whenever no live
 * provider is configured.
 */
export async function generateBrief(
  input: BriefInput,
  env: EnvLike = process.env,
): Promise<GeneratedBrief> {
  if (isLiveProviderConfigured(env)) {
    // A real integration would call the provider API here, map its response
    // into GeneratedBrief, and return it. Deferred for V1: we intentionally
    // fall through to the deterministic brief so behaviour stays reproducible.
  }
  return deterministicBrief(input);
}
