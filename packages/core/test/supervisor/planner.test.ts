import { describe, expect, it } from 'vitest';
import {
  buildTicketDag,
  createInMemoryEventStore,
  createModuleRegistry,
  emitPlan,
  parseRunRequest,
  planRun,
  projectRun,
  projectTickets,
  type EventStore,
  type ModuleRegistry,
} from '../../src/index';

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

const EMPTY_REGISTRY: ModuleRegistry = createModuleRegistry([]);

const MARKETPLACE_PROMPT =
  'Build an AI services marketplace where customers submit service requests, an AI brief is generated, and providers submit proposals the customer can accept or reject.';

async function freshStore(): Promise<EventStore> {
  return createInMemoryEventStore(deterministic());
}

describe('planRun — marketplace intent', () => {
  it('detects the marketplace intent from the prompt', () => {
    expect(parseRunRequest(MARKETPLACE_PROMPT).intent).toBe('ai-services-marketplace');
  });

  it('detects the marketplace intent from PRD text without a prompt', () => {
    expect(
      parseRunRequest({
        prdText:
          'AI Services Marketplace PRD: customers submit service requests, providers submit proposals, and customers review acceptance.',
      }).intent,
    ).toBe('ai-services-marketplace');
  });

  it('clamps requested worker cap to 1 through 20 without inventing a default', () => {
    expect(
      parseRunRequest({ prompt: MARKETPLACE_PROMPT, requestedWorkerCap: 25 }).requestedWorkerCap,
    ).toBe(20);
    expect(
      parseRunRequest({ prompt: MARKETPLACE_PROMPT, requestedWorkerCap: 0 }).requestedWorkerCap,
    ).toBe(1);
    expect(parseRunRequest({ prompt: MARKETPLACE_PROMPT }).requestedWorkerCap).toBeUndefined();
  });

  it('produces the full V1 pipeline (no triage)', () => {
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    const ids = plan.tickets.map((ticket) => ticket.id);
    expect(ids).toEqual([
      'scaffold',
      'data-model',
      'api-contract',
      'marketplace-ui',
      'ai-brief',
      'provider-proposals',
      'review-acceptance',
      'admin-status',
      'tests',
      'preview',
      'package',
      'deploy',
    ]);
    expect(ids).not.toContain('triage');
  });

  it('encodes the expected dependency DAG', () => {
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    const dag = buildTicketDag(plan.tickets);

    expect(dag.dependencies.get('api-contract')).toContain('data-model');
    expect(dag.dependencies.get('data-model')).toContain('scaffold');
    for (const downstream of ['marketplace-ui', 'ai-brief', 'provider-proposals']) {
      expect(dag.dependencies.get(downstream)).toContain('api-contract');
    }

    // Deploy is last: nothing depends on it and it is the final node in topo order.
    expect(dag.dependents.get('deploy')).toEqual([]);
    expect(dag.order[dag.order.length - 1]).toBe('deploy');
  });

  it('is deterministic (identical plans for identical input)', () => {
    const a = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    const b = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    expect(a).toEqual(b);
  });

  it('elevates risk for migrations, external network, and deploy', () => {
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    const byId = new Map(plan.tickets.map((ticket) => [ticket.id, ticket]));
    expect(byId.get('scaffold')?.riskTier).toBe('low');
    expect(byId.get('marketplace-ui')?.riskTier).toBe('low');
    expect(byId.get('data-model')?.riskTier).toBe('high');
    expect(byId.get('ai-brief')?.riskTier).toBe('medium');
    expect(byId.get('deploy')?.riskTier).toBe('high');
  });

  it('emits run.planned + supervisor.decision + ticket.created to the ledger', async () => {
    const store = await freshStore();
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    const result = await emitPlan(store, 'run-1', plan);
    expect(result.deduplicated).toBe(false);

    const events = await store.readRun('run-1');
    const run = projectRun(events);
    expect(run.status).toBe('planned');
    expect(run.plannedTicketCount).toBe(plan.tickets.length);
    expect(run.supervisorDecisions).toHaveLength(2);
    expect(run.supervisorDecisions[0]).toMatchObject({
      decision: 'classify-intent',
      confidence: 0.9,
    });
    expect(run.supervisorDecisions[0].rationale.length).toBeGreaterThan(0);

    const tickets = projectTickets(events);
    expect(tickets.byId['api-contract'].dependsOn).toContain('data-model');
    expect(tickets.byId['data-model'].riskTier).toBe('high');
    expect(tickets.byId['tests'].moduleId).toBe('qa-gates');
  });

  it('is idempotent: re-emitting the same plan does not duplicate events', async () => {
    const store = await freshStore();
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    await emitPlan(store, 'run-1', plan);
    const second = await emitPlan(store, 'run-1', plan);
    expect(second.deduplicated).toBe(true);

    const tickets = projectTickets(await store.readRun('run-1'));
    expect(tickets.tickets).toHaveLength(plan.tickets.length);
  });
});

describe('planRun — unknown / underspecified', () => {
  it('routes an underspecified prompt to a human-review triage ticket', () => {
    const request = parseRunRequest('make an app');
    expect(request.intent).toBe('underspecified');

    const plan = planRun(request, EMPTY_REGISTRY);
    expect(plan.tickets).toHaveLength(1);
    const [ticket] = plan.tickets;
    expect(ticket.kind).toBe('triage');
    expect(ticket.reviewMode).toBe('human');
    expect(ticket.riskTier).not.toBe('low');

    const ids = plan.tickets.map((t) => t.id);
    expect(ids).not.toContain('deploy');
    expect(ids).not.toContain('data-model');

    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0].confidence).toBeLessThan(0.5);
  });

  it('routes an unrecognized-but-specified prompt to triage', () => {
    const request = parseRunRequest('Build a 3D tetris game that runs in the web browser.');
    expect(request.intent).toBe('unknown');

    const plan = planRun(request, EMPTY_REGISTRY);
    expect(plan.tickets.map((t) => t.kind)).toEqual(['triage']);
    expect(plan.decisions[0].decision).toBe('request-clarification');
  });

  it('emits a low-confidence supervisor decision for triage', async () => {
    const store = await freshStore();
    const plan = planRun(parseRunRequest('help'), EMPTY_REGISTRY);
    await emitPlan(store, 'run-x', plan);

    const run = projectRun(await store.readRun('run-x'));
    expect(run.supervisorDecisions).toHaveLength(1);
    expect(run.supervisorDecisions[0].confidence).toBeLessThan(0.5);
    expect(run.plannedTicketCount).toBe(1);
  });
});
