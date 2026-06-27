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

interface EventExtras {
  readonly ticketId?: string;
  readonly subject?: EventSubject;
  readonly actor?: EventActor;
  readonly evidence?: readonly EventEvidence[];
}

/**
 * Build the full marketplace event log for `runId`. Deterministic: identical
 * `runId` yields identical events (stable ids/sequences, fixed base timestamp).
 */
export function buildMarketplaceRunEvents(runId: string): FactoryEvent[] {
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

  const plan: ReadonlyArray<{
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

  for (const spec of plan) {
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

  add('run.planned', 'info', { ticketCount: plan.length }, { actor: SUPERVISOR });
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
