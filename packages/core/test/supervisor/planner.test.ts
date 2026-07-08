import { describe, expect, it } from 'vitest';
import {
  buildTicketDag,
  createInMemoryEventStore,
  createModuleRegistry,
  deriveBuildContract,
  emitBuildContract,
  emitPlan,
  parseRunRequest,
  planRun,
  projectResearch,
  projectRun,
  projectTickets,
  researchPlanContext,
  type EventStore,
  type ModuleRegistry,
  type PlannerResearchContext,
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

describe('parseRunRequest — run mode', () => {
  it('defaults to plan-only (the V1 behavior)', () => {
    expect(parseRunRequest(MARKETPLACE_PROMPT).mode).toBe('plan-only');
  });

  it('carries an explicit run mode through normalization', () => {
    expect(
      parseRunRequest({ prompt: MARKETPLACE_PROMPT, mode: 'research-plan-and-start' }).mode,
    ).toBe('research-plan-and-start');
  });
});

describe('planRun — enriched research brief (full-factory U3)', () => {
  const RESEARCH: PlannerResearchContext = {
    briefSummary: 'Marketplace research brief.',
    findings: [
      { findingId: 'f-1', statement: 'The stack must be Next.js + TypeScript.', confidence: 0.9 },
      { findingId: 'f-2', statement: 'Postgres is the available database.', confidence: 0.8 },
    ],
    assumptionCount: 1,
    unresolvedGaps: [{ gapId: 'g-1', question: 'Which auth provider?', blocking: true }],
  };

  it('records a research-backed decision naming the findings that influenced the DAG', () => {
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY, RESEARCH);

    const research = plan.decisions.find((d) => d.decision === 'incorporate-research');
    expect(research).toBeDefined();
    expect(research?.rationale).toContain('f-1');
    expect(research?.rationale).toContain('f-2');
    expect(research?.rationale).toContain('2 finding(s)');
    expect(research?.rationale).toContain('1 unresolved gap(s)');
    expect(research?.rationale).toContain('blocking');
    expect(research?.rationale).toContain('Marketplace research brief.');
    expect(plan.influencingFindingIds).toEqual(['f-1', 'f-2']);
  });

  it('keeps the ticket pipeline deterministic — research never invents tickets', () => {
    const withResearch = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY, RESEARCH);
    const without = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY);
    expect(withResearch.tickets).toEqual(without.tickets);
  });

  it('adds no research decision when the brief has no findings', () => {
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY, {
      findings: [],
      assumptionCount: 0,
      unresolvedGaps: [],
    });
    expect(plan.decisions.some((d) => d.decision === 'incorporate-research')).toBe(false);
    expect(plan.influencingFindingIds).toBeUndefined();
  });

  it('is deterministic with an identical research context', () => {
    const a = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY, RESEARCH);
    const b = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY, RESEARCH);
    expect(a).toEqual(b);
  });

  it('emitPlan records the influencing finding ids on run.planned (idempotently)', async () => {
    const store = await freshStore();
    const plan = planRun(parseRunRequest(MARKETPLACE_PROMPT), EMPTY_REGISTRY, RESEARCH);
    await emitPlan(store, 'run-1', plan);
    const second = await emitPlan(store, 'run-1', plan);
    expect(second.deduplicated).toBe(true);

    const events = await store.readRun('run-1');
    const planned = events.filter((event) => event.type === 'run.planned');
    expect(planned).toHaveLength(1);
    expect(planned[0].payload).toMatchObject({ influencingFindingIds: ['f-1', 'f-2'] });
  });

  it('researchPlanContext distills a projected research view (resolved gaps excluded)', async () => {
    const store = await freshStore();
    const base = {
      runId: 'run-1',
      actor: { kind: 'researcher' as const, id: 'r' },
      subject: { kind: 'research', id: 'run-1' },
      severity: 'info' as const,
    };
    await store.append({
      ...base,
      type: 'research.finding_recorded',
      payload: { findingId: 'f-1', statement: 'Fact.', classification: 'verified_fact' },
    });
    await store.append({
      ...base,
      type: 'research.finding_recorded',
      payload: {
        findingId: 'f-2',
        statement: 'Resolves the open gap.',
        classification: 'inference',
        resolvesGapId: 'g-resolved',
      },
    });
    await store.append({
      ...base,
      type: 'research.assumption_recorded',
      payload: { assumptionId: 'a-1', statement: 'Assumed.' },
    });
    await store.append({
      ...base,
      type: 'research.gap_recorded',
      payload: { gapId: 'g-resolved', question: 'Answered later?' },
    });
    await store.append({
      ...base,
      type: 'research.gap_recorded',
      payload: { gapId: 'g-open', question: 'Still open?', blocking: true },
    });

    const context = researchPlanContext(projectResearch(await store.readRun('run-1'), 'run-1'));
    expect(context.findings.map((finding) => finding.findingId)).toEqual(['f-1', 'f-2']);
    expect(context.assumptionCount).toBe(1);
    expect(context.unresolvedGaps).toEqual([
      { gapId: 'g-open', question: 'Still open?', blocking: true },
    ]);
  });
});

describe('build contract (full-factory U3 / X3)', () => {
  /** Ledger with a created + researched + planned marketplace run. */
  async function plannedLedger(options: {
    mode: 'research-and-plan' | 'research-plan-and-start';
    blockingGap?: boolean;
  }): Promise<{ store: EventStore; runId: string }> {
    const store = await freshStore();
    const runId = 'run-1';
    await store.append({
      runId,
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: runId, version: 0 },
      severity: 'info',
      payload: {
        prompt: MARKETPLACE_PROMPT,
        title: 'Marketplace build',
        localFolder: 'C:\\repo\\app',
        mode: options.mode,
      },
    });
    const base = {
      runId,
      actor: { kind: 'researcher' as const, id: 'r' },
      subject: { kind: 'research', id: runId },
      severity: 'info' as const,
    };
    await store.append({
      ...base,
      type: 'research.finding_recorded',
      payload: { findingId: 'f-1', statement: 'Fact.', classification: 'verified_fact' },
    });
    if (options.blockingGap === true) {
      await store.append({
        ...base,
        type: 'research.gap_recorded',
        payload: { gapId: 'g-1', question: 'Which auth provider?', blocking: true },
      });
    }
    await store.append({
      ...base,
      type: 'research.brief_completed',
      payload: { summary: 'Brief.' },
    });
    const research = researchPlanContext(projectResearch(await store.readRun(runId), runId));
    const plan = planRun(
      parseRunRequest({ prompt: MARKETPLACE_PROMPT, mode: options.mode }),
      EMPTY_REGISTRY,
      research,
    );
    await emitPlan(store, runId, plan);
    return { store, runId };
  }

  async function deriveFor(store: EventStore, runId: string) {
    const events = await store.readRun(runId);
    return deriveBuildContract(
      projectRun(events, runId),
      projectTickets(events, runId),
      projectResearch(events, runId),
    );
  }

  it('summarizes scope, workspace, boundaries, risks, gates, deploy, and completion', async () => {
    const { store, runId } = await plannedLedger({ mode: 'research-and-plan' });
    const contract = await deriveFor(store, runId);

    expect(contract.scope).toContain('Marketplace build');
    expect(contract.scope).toContain('12 planned ticket(s)');
    expect(contract.workspace).toContain('C:\\repo\\app');
    expect(contract.writeBoundaries.join(' ')).toContain('C:\\repo\\app');
    expect(contract.risks.join(' ')).toContain('data-model (high)');
    expect(contract.gateExpectations).toContain('typecheck');
    expect(contract.gateExpectations).toContain('local preview health check');
    expect(contract.deployTarget).toContain('Render');
    expect(contract.completionCriteria.join(' ')).toContain('hosted health');
    expect(contract.researchBacked).toBe(true);
    expect(contract.influencingFindingIds).toEqual(['f-1']);
    // Human review mode (default) gates elevated-risk tickets.
    expect(contract.operatorApprovals.join(' ')).toContain('Human review approval required');
  });

  it('records the U5 start seam and blocking gaps as operator approvals', async () => {
    const { store, runId } = await plannedLedger({
      mode: 'research-plan-and-start',
      blockingGap: true,
    });
    const contract = await deriveFor(store, runId);

    expect(contract.operatorApprovals.join(' ')).toContain(
      'execution controls are not yet available',
    );
    expect(contract.operatorApprovals.join(' ')).toContain('Which auth provider?');
    expect(contract.risks.join(' ')).toContain('Blocking research gap');
  });

  it('is idempotent: re-emitting an unchanged contract appends exactly one event', async () => {
    const { store, runId } = await plannedLedger({ mode: 'research-and-plan' });
    const contract = await deriveFor(store, runId);

    const first = await emitBuildContract(store, runId, contract);
    const second = await emitBuildContract(store, runId, contract);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);

    const events = await store.readRun(runId);
    expect(events.filter((event) => event.type === 'contract.generated')).toHaveLength(1);
    expect(projectRun(events, runId).buildContract?.contractDigest).toBe(contract.contractDigest);
  });

  it('updates only when the underlying research or plan changes (latest wins)', async () => {
    const { store, runId } = await plannedLedger({ mode: 'research-and-plan' });
    const original = await deriveFor(store, runId);
    await emitBuildContract(store, runId, original);

    // New research evidence arrives -> the derived contract (and digest) change.
    await store.append({
      runId,
      type: 'research.finding_recorded',
      actor: { kind: 'researcher', id: 'r' },
      subject: { kind: 'research', id: runId },
      severity: 'info',
      payload: { findingId: 'f-2', statement: 'New fact.', classification: 'inference' },
    });
    const updated = await deriveFor(store, runId);
    expect(updated.contractDigest).not.toBe(original.contractDigest);
    await emitBuildContract(store, runId, updated);

    const events = await store.readRun(runId);
    expect(events.filter((event) => event.type === 'contract.generated')).toHaveLength(2);
    const projected = projectRun(events, runId).buildContract;
    expect(projected?.contractDigest).toBe(updated.contractDigest);
    expect(projected?.influencingFindingIds).toEqual(['f-1', 'f-2']);
  });

  it('projects the explicit execution-pending state for start-mode runs (U5 seam)', async () => {
    const { store, runId } = await plannedLedger({ mode: 'research-plan-and-start' });
    const run = projectRun(await store.readRun(runId), runId);
    expect(run.mode).toBe('research-plan-and-start');
    expect(run.status).toBe('planned');
    // Explicit "pending, not running" — U5 will consume this.
    expect(run.executionState).toBe('pending');
  });

  it('projects not_requested for plan-only and pre-U3 ledgers', async () => {
    const store = await freshStore();
    await store.append({
      runId: 'run-1',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-1', version: 0 },
      severity: 'info',
      payload: { prompt: 'legacy run without a mode' },
    });
    const run = projectRun(await store.readRun('run-1'), 'run-1');
    expect(run.mode).toBeUndefined();
    expect(run.executionState).toBe('not_requested');
    expect(run.buildContract).toBeUndefined();
  });
});
