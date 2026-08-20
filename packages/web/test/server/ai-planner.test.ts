/**
 * AI-backed run planner (planner generalization): unknown intents get an
 * AI-proposed ticket DAG (validated fail-closed), the built-in intent and
 * underspecified requests keep their deterministic paths, and every AI
 * failure falls back to human triage with an explicit ai-plan-fallback
 * decision. No real CLI — the plan client is injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryEventStore, projectRun, projectTickets } from '@software-factory/core';
import type { EventStore } from '@software-factory/core';
import {
  buildPlanningPrompt,
  createAiRunPlanner,
  parsePlanClientOutput,
} from '../../src/server/ai-planner';

const RUN_ID = 'run-ai-plan';

const VAULT_PROMPT =
  'Create an Obsidian knowledge vault from my GitLab folder and then build a study app on top of it.';

const GOOD_PROPOSAL = {
  confidence: 0.85,
  rationale: 'Vault first, study app second — dependent stages of one dag.',
  tickets: [
    {
      id: 'scaffold-vault',
      title: 'Scaffold the vault generator',
      kind: 'scaffold',
      description: 'Set up the generator project.',
      dependsOn: [],
      riskTier: 'low',
    },
    {
      id: 'build-study-app',
      title: 'Build the study app',
      kind: 'marketplace-ui',
      description: 'Review/study UI over the generated vault.',
      dependsOn: ['scaffold-vault'],
      riskTier: 'medium',
    },
  ],
};

function store(): EventStore {
  let id = 0;
  let now = 1_700_000_000_000;
  return createInMemoryEventStore({
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  });
}

describe('createAiRunPlanner', () => {
  it('plans real tickets from a valid AI proposal for an unknown intent', async () => {
    const client = vi.fn().mockResolvedValue(GOOD_PROPOSAL);
    const planner = createAiRunPlanner({ client });
    const sink = store();

    await planner(sink, RUN_ID, { prompt: VAULT_PROMPT });

    const events = await sink.readRun(RUN_ID);
    const tickets = projectTickets(events, RUN_ID);
    expect(tickets.tickets.map((t) => t.ticketId)).toEqual(['scaffold-vault', 'build-study-app']);
    expect(tickets.byId['triage']).toBeUndefined();
    expect(projectRun(events, RUN_ID).status).toBe('planned');
    const decisions = events
      .filter((e) => e.type === 'supervisor.decision')
      .map((e) => (e.payload as { decision: string }).decision);
    expect(decisions).toEqual(['classify-intent', 'plan-run']);
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('falls back to triage with an ai-plan-fallback decision when the client fails', async () => {
    const client = vi.fn().mockRejectedValue(new Error('CLI unavailable'));
    const planner = createAiRunPlanner({ client });
    const sink = store();

    await planner(sink, RUN_ID, { prompt: VAULT_PROMPT });

    const events = await sink.readRun(RUN_ID);
    expect(projectTickets(events, RUN_ID).byId['triage']).toBeDefined();
    const fallback = events.find(
      (e) =>
        e.type === 'supervisor.decision' &&
        (e.payload as { decision: string }).decision === 'ai-plan-fallback',
    );
    expect(fallback).toBeDefined();
    expect((fallback?.payload as { rationale: string }).rationale).toContain('CLI unavailable');
  });

  it('falls back to triage when the proposal fails validation', async () => {
    const cyclic = {
      ...GOOD_PROPOSAL,
      tickets: GOOD_PROPOSAL.tickets.map((t, i) => ({
        ...t,
        dependsOn: [GOOD_PROPOSAL.tickets[(i + 1) % 2].id],
      })),
    };
    const planner = createAiRunPlanner({ client: vi.fn().mockResolvedValue(cyclic) });
    const sink = store();

    await planner(sink, RUN_ID, { prompt: VAULT_PROMPT });

    const events = await sink.readRun(RUN_ID);
    expect(projectTickets(events, RUN_ID).byId['triage']).toBeDefined();
  });

  it('falls back to triage when confidence is below the execution threshold', async () => {
    const timid = { ...GOOD_PROPOSAL, confidence: 0.3 };
    const planner = createAiRunPlanner({ client: vi.fn().mockResolvedValue(timid) });
    const sink = store();

    await planner(sink, RUN_ID, { prompt: VAULT_PROMPT });

    const events = await sink.readRun(RUN_ID);
    expect(projectTickets(events, RUN_ID).byId['triage']).toBeDefined();
    const fallback = events.find(
      (e) =>
        e.type === 'supervisor.decision' &&
        (e.payload as { decision: string }).decision === 'ai-plan-fallback',
    );
    expect((fallback?.payload as { rationale: string }).rationale).toContain('below the execution');
  });

  it('never calls the AI for the built-in intent or underspecified requests', async () => {
    const client = vi.fn();
    const planner = createAiRunPlanner({ client });

    const marketplaceSink = store();
    await planner(marketplaceSink, RUN_ID, {
      prompt:
        'Build an AI services marketplace where customers submit service requests and providers submit proposals.',
    });
    const marketplaceTickets = projectTickets(await marketplaceSink.readRun(RUN_ID), RUN_ID);
    expect(marketplaceTickets.tickets.length).toBeGreaterThan(3);
    expect(marketplaceTickets.byId['triage']).toBeUndefined();

    const vagueSink = store();
    await planner(vagueSink, RUN_ID, { prompt: 'make app' });
    expect(projectTickets(await vagueSink.readRun(RUN_ID), RUN_ID).byId['triage']).toBeDefined();

    expect(client).not.toHaveBeenCalled();
  });
});

describe('parsePlanClientOutput', () => {
  it('unwraps the claude --output-format json envelope, including fenced results', () => {
    const inner = JSON.stringify(GOOD_PROPOSAL);
    const envelope = JSON.stringify({
      type: 'result',
      result: '```json\n' + inner + '\n```',
    });
    expect(parsePlanClientOutput(envelope)).toEqual(GOOD_PROPOSAL);
  });

  it('accepts a bare proposal object on stdout', () => {
    expect(parsePlanClientOutput(JSON.stringify(GOOD_PROPOSAL))).toEqual(GOOD_PROPOSAL);
  });

  it('throws on empty or non-JSON output', () => {
    expect(() => parsePlanClientOutput('')).toThrow(/no output/);
    expect(() => parsePlanClientOutput('sorry, I cannot help')).toThrow(/no JSON object/);
  });
});

describe('buildPlanningPrompt', () => {
  it('embeds the operator request and the JSON contract', () => {
    const prompt = buildPlanningPrompt({
      title: 'Vault',
      prompt: VAULT_PROMPT,
      reviewMode: 'human',
      mode: 'plan-only',
      intent: 'unknown',
    } as Parameters<typeof buildPlanningPrompt>[0]);
    expect(prompt).toContain('Output ONLY a JSON object');
    expect(prompt).toContain(VAULT_PROMPT);
    expect(prompt).toContain('"confidence"');
  });
});
