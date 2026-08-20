/**
 * AI plan proposals (planner generalization) — fail-closed validation and the
 * conversion into a RunPlan gated by the confidence threshold (KTD6).
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PLAN_MIN_CONFIDENCE,
  parseRunRequest,
  planFromAiProposal,
  validateAiPlanProposal,
} from '../../src/index';

const REQUEST = parseRunRequest(
  'Build an Obsidian knowledge vault generator from a local folder of project notes.',
);

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confidence: 0.85,
    rationale: 'Two dependent stages: extract knowledge, then render the vault.',
    tickets: [
      {
        id: 'scaffold-vault',
        title: 'Scaffold the vault generator',
        kind: 'scaffold',
        description: 'Set up the project and folder walking.',
        dependsOn: [],
        riskTier: 'low',
      },
      {
        id: 'extract-knowledge',
        title: 'Extract knowledge into notes',
        kind: 'ai-brief',
        description: 'Distill topics into markdown notes with links.',
        dependsOn: ['scaffold-vault'],
        riskTier: 'medium',
      },
      {
        id: 'tests',
        title: 'Test the extraction pipeline',
        kind: 'tests',
        description: 'Unit tests over the extraction and rendering.',
        dependsOn: ['extract-knowledge'],
        riskTier: 'low',
      },
    ],
    ...overrides,
  };
}

describe('validateAiPlanProposal', () => {
  it('accepts a well-formed proposal', () => {
    const result = validateAiPlanProposal(proposal());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.tickets).toHaveLength(3);
      expect(result.proposal.tickets[1].dependsOn).toEqual(['scaffold-vault']);
    }
  });

  it('rejects non-objects, missing confidence, and empty ticket lists', () => {
    expect(validateAiPlanProposal('nope').ok).toBe(false);
    expect(validateAiPlanProposal(proposal({ confidence: 'high' })).ok).toBe(false);
    expect(validateAiPlanProposal(proposal({ confidence: 1.4 })).ok).toBe(false);
    expect(validateAiPlanProposal(proposal({ tickets: [] })).ok).toBe(false);
  });

  it('rejects duplicate ids, the reserved triage id, self- and unknown dependencies', () => {
    const dup = proposal();
    (dup.tickets as Record<string, unknown>[])[1].id = 'scaffold-vault';
    expect(validateAiPlanProposal(dup).ok).toBe(false);

    const reserved = proposal();
    (reserved.tickets as Record<string, unknown>[])[0].id = 'triage';
    expect(validateAiPlanProposal(reserved).ok).toBe(false);

    const selfDep = proposal();
    (selfDep.tickets as Record<string, unknown>[])[0].dependsOn = ['scaffold-vault'];
    expect(validateAiPlanProposal(selfDep).ok).toBe(false);

    const unknownDep = proposal();
    (unknownDep.tickets as Record<string, unknown>[])[2].dependsOn = ['does-not-exist'];
    expect(validateAiPlanProposal(unknownDep).ok).toBe(false);
  });

  it('rejects cyclic proposals', () => {
    const cyclic = proposal();
    (cyclic.tickets as Record<string, unknown>[])[0].dependsOn = ['tests'];
    const result = validateAiPlanProposal(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/DAG/);
    }
  });

  it('coerces unknown kinds to scaffold, unknown tiers to medium, and floors deploy at high', () => {
    const odd = proposal();
    const tickets = odd.tickets as Record<string, unknown>[];
    tickets[0].kind = 'made-up-kind';
    tickets[0].riskTier = 'extreme';
    tickets[1].kind = 'deploy';
    tickets[1].riskTier = 'low';
    const result = validateAiPlanProposal(odd);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.tickets[0].kind).toBe('scaffold');
      expect(result.proposal.tickets[0].riskTier).toBe('medium');
      expect(result.proposal.tickets[1].riskTier).toBe('high');
    }
  });
});

describe('planFromAiProposal', () => {
  it('produces a RunPlan with classify-intent and plan-run decisions', () => {
    const validated = validateAiPlanProposal(proposal());
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    const plan = planFromAiProposal(REQUEST, validated.proposal, 'claude-code-cli');
    expect(plan).not.toBeNull();
    expect(plan?.tickets.map((t) => t.id)).toEqual([
      'scaffold-vault',
      'extract-knowledge',
      'tests',
    ]);
    expect(plan?.tickets.some((t) => t.id === 'triage')).toBe(false);
    expect(plan?.decisions.map((d) => d.decision)).toEqual(['classify-intent', 'plan-run']);
    expect(plan?.decisions[0].rationale).toContain('claude-code-cli');
  });

  it('returns null below the confidence threshold (KTD6 — triage takes over)', () => {
    const validated = validateAiPlanProposal(
      proposal({ confidence: AI_PLAN_MIN_CONFIDENCE - 0.01 }),
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    expect(planFromAiProposal(REQUEST, validated.proposal, 'claude-code-cli')).toBeNull();
  });
});
