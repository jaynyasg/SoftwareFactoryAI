/**
 * Shared fixture: a realistic mid-run AI Services Marketplace event log.
 *
 * Used by the web component tests (folded through the real core projections) and
 * by the e2e specs (written to the filesystem event store so the running app
 * renders an active run end to end). Sequences are contiguous from 1 so the
 * projections see no gaps; every event is a fully-formed envelope that satisfies
 * core's `isFactoryEvent` guard. Type-only core imports keep this fixture free of
 * any runtime dependency on the core package.
 */
import type {
  EventActor,
  EventEnvelope,
  EventEvidence,
  EventPayloadMap,
  EventSeverity,
  EventSubject,
  FactoryEvent,
  FactoryEventType,
} from '@software-factory/core';

const SUPERVISOR: EventActor = { kind: 'supervisor', id: 'supervisor' };
const OPERATOR: EventActor = { kind: 'operator', id: 'operator' };
const WORKER: EventActor = { kind: 'worker', id: 'worker' };
const GATE: EventActor = { kind: 'gate', id: 'gate-runner' };
const ADAPTER: EventActor = { kind: 'adapter', id: 'codex-cli' };
const SANDBOX: EventActor = { kind: 'sandbox', id: 'sandbox' };
const DEPLOY: EventActor = { kind: 'deploy', id: 'render' };
const SYSTEM: EventActor = { kind: 'system', id: 'system' };
const RESEARCHER: EventActor = { kind: 'researcher', id: 'research-runner' };
const DAEMON: EventActor = { kind: 'system', id: 'execution-daemon' };

interface EventExtras {
  readonly ticketId?: string;
  readonly subject?: EventSubject;
  readonly actor?: EventActor;
  readonly evidence?: readonly EventEvidence[];
}

interface EventLogBuilder {
  readonly events: FactoryEvent[];
  add<T extends FactoryEventType>(
    type: T,
    severity: EventSeverity,
    payload: EventPayloadMap[T],
    extras?: EventExtras,
  ): void;
  ticket(id: string): EventExtras;
}

function createEventLogBuilder(runId: string): EventLogBuilder {
  const events: FactoryEvent[] = [];
  let sequence = 0;
  const baseTime = 1_700_000_000_000;

  function add<T extends FactoryEventType>(
    type: T,
    severity: EventSeverity,
    payload: EventPayloadMap[T],
    extras: EventExtras = {},
  ): void {
    sequence += 1;
    // Build the precise generic envelope, then widen to the discriminated union.
    // (TS cannot verify the type/payload correlation for a generic `T` at the
    // union level, so the single localized cast is the pragmatic boundary here.)
    const event: EventEnvelope<T> = {
      version: 1,
      eventId: `evt-${sequence}`,
      runId,
      ticketId: extras.ticketId,
      actor: extras.actor ?? SYSTEM,
      subject: extras.subject ?? { kind: 'run', id: runId },
      type,
      sequence,
      timestamp: baseTime + sequence * 1000,
      severity,
      evidence: extras.evidence,
      payload,
    };
    events.push(event as FactoryEvent);
  }

  function ticket(id: string): EventExtras {
    return { ticketId: id, subject: { kind: 'ticket', id } };
  }

  return { events, add, ticket };
}

/**
 * Build the full marketplace event log for `runId`. Deterministic: identical
 * `runId` yields identical events (stable ids/sequences, fixed base timestamp).
 */
export function buildMarketplaceRunEvents(runId: string): FactoryEvent[] {
  const { events, add, ticket } = createEventLogBuilder(runId);

  add(
    'run.created',
    'info',
    {
      prompt: 'Build an AI services marketplace with providers, proposals, and customer requests.',
      requestedWorkerCap: 5,
      reviewMode: 'human',
    },
    { actor: OPERATOR, subject: { kind: 'run', id: runId, version: 0 } },
  );
  addSupervisorPlan({ events, add, ticket });
  addExecutionBody({ events, add, ticket });

  return events;
}

const MARKETPLACE_PLAN: ReadonlyArray<{
  id: string;
  title: string;
  moduleId?: string;
  dependsOn: readonly string[];
  riskTier: 'low' | 'medium' | 'high';
}> = [
    {
      id: 'scaffold',
      title: 'Scaffold the marketplace app',
      moduleId: 'scaffold-app',
      dependsOn: [],
      riskTier: 'low',
    },
    {
      id: 'data-model',
      title: 'Define the data model and migrations',
      moduleId: 'data-model',
      dependsOn: ['scaffold'],
      riskTier: 'medium',
    },
    {
      id: 'api-contract',
      title: 'Define the API contract',
      moduleId: 'api-contract',
      dependsOn: ['data-model'],
      riskTier: 'low',
    },
    {
      id: 'marketplace-ui',
      title: 'Build the marketplace request flow (UI)',
      moduleId: 'marketplace-ui',
      dependsOn: ['api-contract'],
      riskTier: 'low',
    },
    {
      id: 'ai-brief',
      title: 'Generate the AI brief',
      moduleId: 'ai-brief',
      dependsOn: ['api-contract'],
      riskTier: 'medium',
    },
    {
      id: 'provider-proposals',
      title: 'Implement provider proposals',
      moduleId: 'provider-proposals',
      dependsOn: ['api-contract'],
      riskTier: 'low',
    },
    {
      id: 'review-acceptance',
      title: 'Implement proposal review and acceptance',
      dependsOn: ['marketplace-ui', 'provider-proposals'],
      riskTier: 'low',
    },
    {
      id: 'admin-status',
      title: 'Build admin and status dashboards',
      dependsOn: ['marketplace-ui', 'ai-brief', 'provider-proposals'],
      riskTier: 'low',
    },
    {
      id: 'tests',
      title: 'Author and run quality gates',
      moduleId: 'qa-gates',
      dependsOn: ['marketplace-ui', 'ai-brief', 'provider-proposals'],
      riskTier: 'low',
    },
    {
      id: 'preview',
      title: 'Run the local preview and health check',
      dependsOn: ['tests'],
      riskTier: 'low',
    },
    {
      id: 'package',
      title: 'Package the repo with provenance',
      dependsOn: ['preview'],
      riskTier: 'low',
    },
    {
      id: 'deploy',
      title: 'Deploy to the hosted target',
      dependsOn: ['package'],
      riskTier: 'high',
    },
  ];

/** Supervisor decisions + the 12-ticket DAG + `run.planned` (shared body). */
function addSupervisorPlan({ add, ticket }: EventLogBuilder): void {
  add(
    'supervisor.decision',
    'info',
    {
      decision: 'classify-intent',
      rationale: 'Prompt matches the AI Services Marketplace intent; planning the V1 pipeline.',
      confidence: 0.9,
    },
    { actor: SUPERVISOR },
  );
  add(
    'supervisor.decision',
    'info',
    {
      decision: 'plan-run',
      rationale: 'Composed 12 tickets from scaffold through deploy. Review mode: human.',
      confidence: 0.86,
    },
    { actor: SUPERVISOR },
  );

  for (const spec of MARKETPLACE_PLAN) {
    add(
      'ticket.created',
      'info',
      {
        title: spec.title,
        moduleId: spec.moduleId,
        dependsOn: spec.dependsOn,
        riskTier: spec.riskTier,
      },
      ticket(spec.id),
    );
  }

  add('run.planned', 'info', { ticketCount: MARKETPLACE_PLAN.length }, { actor: SUPERVISOR });
}

/** Adapter selection + mid-run worker/gate/review/preview/deploy body (shared). */
function addExecutionBody({ add, ticket }: EventLogBuilder): void {
  add('adapter.selected', 'info', { adapterId: 'codex-cli', family: 'codex' }, { actor: ADAPTER });
  add('run.started', 'info', {}, { actor: SUPERVISOR });

  add(
    'worker.started',
    'info',
    { adapterId: 'codex-cli' },
    { ...ticket('scaffold'), actor: WORKER },
  );
  add('gate.started', 'info', { gate: 'lint' }, { ...ticket('scaffold'), actor: GATE });
  add(
    'gate.passed',
    'success',
    { gate: 'lint', summary: 'no lint errors' },
    { ...ticket('scaffold'), actor: GATE },
  );
  add(
    'worker.completed',
    'success',
    { summary: 'scaffold ready' },
    { ...ticket('scaffold'), actor: WORKER },
  );

  add(
    'worker.started',
    'info',
    { adapterId: 'codex-cli' },
    { ...ticket('data-model'), actor: WORKER },
  );
  add(
    'sandbox.fallback',
    'warn',
    {
      reason: 'Docker unavailable; running with the local reduced-trust fallback.',
      reducedTrust: true,
    },
    { actor: SANDBOX },
  );
  add('gate.started', 'info', { gate: 'test' }, { ...ticket('data-model'), actor: GATE });
  add(
    'gate.failed',
    'error',
    { gate: 'test', reason: '2 unit tests failing in data-model' },
    { ...ticket('data-model'), actor: GATE },
  );
  add(
    'worker.retry',
    'warn',
    { attempt: 1, reason: 'test gate failed' },
    { ...ticket('data-model'), actor: WORKER },
  );

  add(
    'worker.started',
    'info',
    { adapterId: 'codex-cli' },
    { ...ticket('api-contract'), actor: WORKER },
  );
  add(
    'worker.started',
    'info',
    { adapterId: 'codex-cli' },
    { ...ticket('marketplace-ui'), actor: WORKER },
  );

  add(
    'artifact.created',
    'info',
    {
      artifactId: 'art-repo',
      kind: 'repo',
      path: 'generated/ai-services-marketplace/apps/web/app/page.tsx',
    },
    { ...ticket('scaffold') },
  );
  add(
    'artifact.confidence_computed',
    'info',
    {
      artifactId: 'art-repo',
      confidence: 0.72,
      factors: {
        gatePassRate: 0.8,
        provenanceCompleteness: 0.9,
        dependencyRisk: 0.4,
        previewEvidence: 0.6,
      },
    },
    { ...ticket('scaffold') },
  );

  add(
    'review.requested',
    'warn',
    {
      riskTier: 'high',
      summary: 'High-risk deploy change requires 2 approvers in human mode.',
    },
    {
      actor: SUPERVISOR,
      evidence: [{ label: 'render config', ref: 'generated/ai-services-marketplace/render.yaml' }],
    },
  );

  add('preview.starting', 'info', {}, { actor: WORKER });
  add('preview.health_pending', 'info', {}, { actor: WORKER });
  add('preview.ready', 'success', { url: 'http://127.0.0.1:4311' }, { actor: WORKER });

  add(
    'deploy.setup_required',
    'warn',
    { action: 'Connect a GitHub destination before deploy.' },
    { actor: DEPLOY },
  );
  add(
    'operator.health_sample',
    'info',
    { metric: 'cpu', value: 0.55, unit: 'ratio', status: 'ok' },
    { actor: SYSTEM },
  );
  add(
    'adapter.capacity_changed',
    'warn',
    { capacity: 3, previousCapacity: 5, reason: 'CPU budget reached; throttled to 3 workers.' },
    { actor: ADAPTER },
  );
}

/**
 * Build the FULL-FACTORY event log for `runId` (U9): the marketplace run plus
 * source-backed research, a build contract, a passed dry-run preflight, the
 * durable execution-queue claim, and one OPEN deploy-setup intervention — so
 * the blueprint lanes, contract/preflight handoff, and cross-run intervention
 * queue all render from real replayed events. Deterministic like the base
 * fixture.
 */
export function buildFullFactoryRunEvents(runId: string): FactoryEvent[] {
  const builder = createEventLogBuilder(runId);
  const { events, add } = builder;
  const research: EventExtras = { actor: RESEARCHER, subject: { kind: 'research', id: runId } };
  const jobId = `${runId}:execution`;

  add(
    'run.created',
    'info',
    {
      prompt: 'Build an AI services marketplace with providers, proposals, and customer requests.',
      requestedWorkerCap: 5,
      reviewMode: 'human',
      mode: 'research-plan-and-start',
      localFolder: 'C:\\factory\\workspaces\\marketplace',
    },
    { actor: OPERATOR, subject: { kind: 'run', id: runId, version: 0 } },
  );

  // Research stage (U1–U3): sources found+read, findings, assumption, gap, brief.
  add(
    'research.requested',
    'info',
    {
      objective: 'Ground the marketplace plan in the existing repo and platform docs.',
      requestedSources: ['repo_scan', 'documentation'],
      budget: { maxSources: 6, maxDurationMs: 60_000 },
    },
    research,
  );
  add(
    'research.source_found',
    'info',
    {
      sourceId: 'src-repo',
      kind: 'repo_scan',
      title: 'Existing marketplace scaffold',
      locator: 'generated/ai-services-marketplace/apps/web',
      summary: 'Next.js app scaffold with provider/request routes already present.',
    },
    research,
  );
  add(
    'research.source_found',
    'info',
    {
      sourceId: 'src-docs',
      kind: 'documentation',
      title: 'Render deploy documentation',
      locator: 'https://render.com/docs/deploys',
      summary: 'Deploy hooks and health-check requirements for hosted services.',
    },
    research,
  );
  add('research.source_read', 'info', { sourceId: 'src-repo' }, research);
  add('research.source_read', 'info', { sourceId: 'src-docs' }, research);
  add(
    'research.finding_recorded',
    'info',
    {
      findingId: 'find-scaffold',
      statement: 'The repo already contains a provider/request scaffold that tickets can extend.',
      classification: 'verified_fact',
      confidence: 0.9,
      sourceIds: ['src-repo'],
    },
    research,
  );
  add(
    'research.finding_recorded',
    'info',
    {
      findingId: 'find-health',
      statement: 'Hosted readiness requires a passing Render health check before any URL is real.',
      classification: 'inference',
      confidence: 0.7,
      sourceIds: ['src-docs'],
    },
    research,
  );
  add(
    'research.assumption_recorded',
    'warn',
    {
      assumptionId: 'assume-sqlite',
      statement: 'SQLite is sufficient for the V1 data model.',
      reason: 'No scale requirements were stated in the prompt.',
      sourceIds: ['src-repo'],
    },
    research,
  );
  add(
    'research.gap_recorded',
    'warn',
    {
      gapId: 'gap-payments',
      question: 'Which payment provider should proposals settle through?',
      impact: 'Payment flows stay stubbed until decided.',
      blocking: false,
    },
    research,
  );
  add(
    'research.brief_completed',
    'success',
    {
      summary:
        'Extend the existing scaffold; gate deploy on Render health; payments stay stubbed pending a provider decision.',
      briefRef: 'briefs/marketplace-v1.md',
    },
    research,
  );

  addSupervisorPlan(builder);

  // Build contract (X3) — the blueprint→execution handoff.
  add(
    'contract.generated',
    'info',
    {
      contractDigest: 'digest-marketplace-v1',
      scope: 'AI services marketplace: 12 tickets from scaffold through hosted deploy.',
      workspace: 'C:\\factory\\workspaces\\marketplace',
      writeBoundaries: ['generated/ai-services-marketplace/**', 'briefs/**'],
      risks: ['deploy ticket is high-risk (2 approvers)', '1 open research gap: payments provider'],
      gateExpectations: ['lint', 'typecheck', 'test', 'secret-scan'],
      deployTarget: 'render:ai-services-marketplace',
      completionCriteria: [
        'All 12 tickets completed with gates passing',
        'Local preview healthy',
        'Package + provenance recorded',
      ],
      operatorApprovals: ['High-risk deploy requires 2 approvals in human mode'],
      researchBacked: true,
      influencingFindingIds: ['find-scaffold', 'find-health'],
    },
    { actor: SUPERVISOR },
  );

  // Dry-run rehearsal (X2) — all checks pass, so start may enqueue execution.
  const checks = [
    'dag',
    'workspace',
    'write_scopes',
    'credentials',
    'adapters',
    'gates',
    'deploy',
    'approvals',
  ] as const;
  add('preflight.started', 'info', { attempt: 1, checks }, { actor: DAEMON });
  for (const check of checks) {
    add(
      'preflight.check_passed',
      'info',
      { attempt: 1, check, detail: `${check.replace(/_/g, ' ')} verified without mutating files.` },
      { actor: DAEMON },
    );
  }
  add('preflight.passed', 'success', { attempt: 1, checkCount: checks.length }, { actor: DAEMON });

  // Durable queue (KTD4/E2): enqueue + daemon lease claim.
  add(
    'queue.enqueued',
    'info',
    { jobId, jobKind: 'run-execution', attempt: 1, reason: 'operator start' },
    { actor: OPERATOR, subject: { kind: 'queue', id: jobId } },
  );
  add(
    'queue.claimed',
    'info',
    {
      jobId,
      jobKind: 'run-execution',
      attempt: 1,
      leaseId: 'lease-1',
      ownerId: 'daemon-1',
      // FAR-FUTURE lease expiry: the e2e dev server runs the REAL execution
      // daemon/reconciler; an expired lease would be (correctly) marked
      // abandoned mid-test, flipping the run to blocked and raising an extra
      // intervention. A live lease keeps the seeded run honestly "started".
      leaseExpiresAt: 4_100_000_000_000,
    },
    { actor: DAEMON, subject: { kind: 'queue', id: jobId } },
  );

  addExecutionBody(builder);

  // One OPEN operator intervention (X4): deploy setup blocks the deploy stage.
  add(
    'intervention.raised',
    'warn',
    {
      interventionId: `${runId}:deploy:setup:1`,
      kind: 'deploy_setup',
      blockingStage: 'deploy',
      reason: 'Render deploy credentials are not configured for this factory.',
      requiredAction: 'Connect the GitHub destination and Render credentials, then re-run the deploy stage.',
    },
    { actor: DAEMON, subject: { kind: 'intervention', id: `${runId}:deploy:setup:1` } },
  );

  return events;
}

/** A minimal just-created run (only `run.created`). */
export function buildCreatedRunEvents(runId: string): FactoryEvent[] {
  return [
    {
      version: 1,
      eventId: 'evt-1',
      runId,
      actor: OPERATOR,
      subject: { kind: 'run', id: runId, version: 0 },
      type: 'run.created',
      sequence: 1,
      timestamp: 1_700_000_000_000,
      severity: 'info',
      payload: { prompt: 'A fresh run with no plan yet.', reviewMode: 'human' },
    } satisfies FactoryEvent,
  ];
}
