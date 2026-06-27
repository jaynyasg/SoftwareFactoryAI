/**
 * Deterministic supervisor planner.
 *
 * `planRun(request, registry)` is PURE: identical inputs yield an identical plan
 * (no clocks, randomness, or I/O). For the recognized AI Services Marketplace
 * intent it emits the fixed V1 ticket pipeline as a dependency DAG; for unknown
 * or underspecified requests it refuses to guess a build and instead produces a
 * human-review triage ticket plus a low-confidence decision.
 *
 * `emitPlan(sink, runId, plan)` is the ONLY side-effecting path: it appends the
 * plan to the ledger as `run.planned` + one `supervisor.decision` per decision +
 * one `ticket.created` per ticket. It is idempotent (stable idempotency keys),
 * so re-emitting a plan never duplicates events.
 */
import { computeRiskTier, maxRiskTier } from './risk-tier';
import type { RiskSignals } from './risk-tier';
import type { RunIntent, RunRequest } from './run-request';
import type { ModuleRiskHint } from '../genome/module-contract';
import type { ModuleRegistry } from '../genome/module-registry';
import type { AppendableEvent, EventActor, FactoryEvent, RiskTier } from '../events/event-types';
import type { AppendResult } from '../events/event-store';

/** The kind of work a planned ticket represents. */
export type TicketKind =
  | 'scaffold'
  | 'data-model'
  | 'api-contract'
  | 'marketplace-ui'
  | 'ai-brief'
  | 'provider-proposals'
  | 'review-acceptance'
  | 'admin-status'
  | 'tests'
  | 'preview'
  | 'package'
  | 'deploy'
  | 'triage';

/** A single planned ticket; also a `DagNode` (id + dependsOn). */
export interface PlannedTicket {
  readonly id: string;
  readonly title: string;
  readonly kind: TicketKind;
  readonly description: string;
  readonly moduleId?: string;
  readonly dependsOn: readonly string[];
  readonly riskTier: RiskTier;
  /** Set to `human` for tickets that must not be auto-approved (e.g. triage). */
  readonly reviewMode?: 'human';
}

/** A supervisor decision; maps 1:1 onto a `supervisor.decision` payload. */
export interface SupervisorDecision {
  readonly decision: string;
  readonly rationale: string;
  readonly confidence: number;
}

/** The deterministic output of planning. */
export interface RunPlan {
  readonly intent: RunIntent;
  readonly tickets: readonly PlannedTicket[];
  readonly decisions: readonly SupervisorDecision[];
}

/** Anything that can append events (an `EventStore` or `EventWriter`). */
export interface PlanEventSink {
  append(event: AppendableEvent): Promise<AppendResult>;
}

/** The events emitted for a plan. */
export interface EmitPlanResult {
  readonly runId: string;
  readonly events: readonly FactoryEvent[];
  /** `true` if any append was a dedup hit (plan already emitted). */
  readonly deduplicated: boolean;
}

const SUPERVISOR_ACTOR: EventActor = { kind: 'supervisor', id: 'supervisor' };

/** Static spec for one marketplace ticket (risk derived from `signals`). */
interface TicketSpec {
  readonly id: string;
  readonly kind: TicketKind;
  readonly title: string;
  readonly description: string;
  readonly moduleId?: string;
  readonly dependsOn: readonly string[];
  readonly signals: RiskSignals;
}

/**
 * The V1 AI Services Marketplace pipeline. Dependencies encode the build DAG:
 * scaffold -> data-model -> api-contract -> {ui, ai-brief, proposals} ->
 * review/acceptance + admin/status -> tests -> preview -> package -> deploy.
 */
const MARKETPLACE_PIPELINE: readonly TicketSpec[] = [
  {
    id: 'scaffold',
    kind: 'scaffold',
    title: 'Scaffold the marketplace app',
    description: 'Create the Next.js + TypeScript app skeleton with lint/test/build tooling.',
    moduleId: 'scaffold-app',
    dependsOn: [],
    signals: {},
  },
  {
    id: 'data-model',
    kind: 'data-model',
    title: 'Define the data model and migrations',
    description:
      'Model Customer, Provider, ServiceRequest, AIBrief, Proposal, and StatusEvent with migrations.',
    moduleId: 'data-model',
    dependsOn: ['scaffold'],
    signals: { dataMigration: true },
  },
  {
    id: 'api-contract',
    kind: 'api-contract',
    title: 'Define the API contract',
    description: 'Specify route contracts for service requests, proposals, and status.',
    moduleId: 'api-contract',
    dependsOn: ['data-model'],
    signals: {},
  },
  {
    id: 'marketplace-ui',
    kind: 'marketplace-ui',
    title: 'Build the marketplace request flow (UI)',
    description: 'Customer request submission plus customer/provider/admin dashboard shells.',
    moduleId: 'marketplace-ui',
    dependsOn: ['api-contract'],
    signals: {},
  },
  {
    id: 'ai-brief',
    kind: 'ai-brief',
    title: 'Generate the AI brief',
    description: 'Generate an AI brief for each request with a deterministic fallback.',
    moduleId: 'ai-brief',
    dependsOn: ['api-contract'],
    signals: { externalNetwork: true },
  },
  {
    id: 'provider-proposals',
    kind: 'provider-proposals',
    title: 'Implement provider proposals',
    description: 'Let providers submit proposals against a service request.',
    moduleId: 'provider-proposals',
    dependsOn: ['api-contract'],
    signals: {},
  },
  {
    id: 'review-acceptance',
    kind: 'review-acceptance',
    title: 'Implement proposal review and acceptance',
    description: 'Let customers accept or reject proposals, persisting status transitions.',
    dependsOn: ['marketplace-ui', 'provider-proposals'],
    signals: {},
  },
  {
    id: 'admin-status',
    kind: 'admin-status',
    title: 'Build admin and status dashboards',
    description:
      'Surface request, brief, and proposal status across customer/provider/admin views.',
    dependsOn: ['marketplace-ui', 'ai-brief', 'provider-proposals', 'review-acceptance'],
    signals: {},
  },
  {
    id: 'tests',
    kind: 'tests',
    title: 'Author and run quality gates',
    description: 'Unit + smoke tests, lint, typecheck, and secret scan across the app.',
    moduleId: 'qa-gates',
    dependsOn: [
      'marketplace-ui',
      'ai-brief',
      'provider-proposals',
      'review-acceptance',
      'admin-status',
    ],
    signals: {},
  },
  {
    id: 'preview',
    kind: 'preview',
    title: 'Run the local preview and health check',
    description: 'Start the app locally and verify preview health before packaging.',
    dependsOn: ['tests'],
    signals: {},
  },
  {
    id: 'package',
    kind: 'package',
    title: 'Package the repo with provenance',
    description: 'Produce a Git repo artifact with handoff, tests summary, and provenance bundle.',
    dependsOn: ['preview'],
    signals: {},
  },
  {
    id: 'deploy',
    kind: 'deploy',
    title: 'Deploy to the hosted target',
    description: 'Generate deploy config and trigger a hosted deploy after local gates pass.',
    dependsOn: ['package'],
    signals: { deployChange: true },
  },
];

/** Convert a module risk hint into risk signals. */
function signalsFromHint(hint: ModuleRiskHint): RiskSignals {
  return {
    hintedTier: hint.tier,
    dependencyChange: hint.dependencyChange,
    authOrSecurity: hint.authOrSecurity,
    deployChange: hint.deployChange,
    dataMigration: hint.dataMigration,
    externalNetwork: hint.externalNetwork,
    destructive: hint.destructive,
  };
}

/** Risk tier for a spec: kind signals, raised by the module's hint when known. */
function riskTierForSpec(spec: TicketSpec, registry: ModuleRegistry): RiskTier {
  let tier = computeRiskTier(spec.signals);
  if (spec.moduleId !== undefined) {
    const hint = registry.get(spec.moduleId)?.riskHint;
    if (hint !== undefined) {
      tier = maxRiskTier(tier, computeRiskTier(signalsFromHint(hint)));
    }
  }
  return tier;
}

function planMarketplace(request: RunRequest, registry: ModuleRegistry): RunPlan {
  const tickets: PlannedTicket[] = MARKETPLACE_PIPELINE.map((spec) => ({
    id: spec.id,
    title: spec.title,
    kind: spec.kind,
    description: spec.description,
    moduleId: spec.moduleId,
    dependsOn: spec.dependsOn,
    riskTier: riskTierForSpec(spec, registry),
  }));

  const elevated = tickets
    .filter((ticket) => ticket.riskTier !== 'low')
    .map((ticket) => `${ticket.id} (${ticket.riskTier})`);

  const decisions: SupervisorDecision[] = [
    {
      decision: 'classify-intent',
      rationale:
        'Prompt matches the AI Services Marketplace intent; planning the deterministic V1 pipeline.',
      confidence: 0.9,
    },
    {
      decision: 'plan-run',
      rationale: `Composed ${tickets.length} tickets from scaffold through deploy. Review mode: ${request.reviewMode}. Elevated-risk tickets: ${elevated.length > 0 ? elevated.join(', ') : 'none'}.`,
      confidence: 0.86,
    },
  ];

  return { intent: 'ai-services-marketplace', tickets, decisions };
}

function planTriage(request: RunRequest): RunPlan {
  const underspecified = request.intent === 'underspecified';
  const ticket: PlannedTicket = {
    id: 'triage',
    kind: 'triage',
    title: 'Triage and clarify the request before building',
    description: underspecified
      ? 'The request is underspecified. A human must clarify scope and intent before planning a build.'
      : 'The request intent is unrecognized. A human must confirm scope and intent before planning a build.',
    dependsOn: [],
    // Above LOW so autonomous mode cannot auto-pass it; building is gated on a human.
    riskTier: 'medium',
    reviewMode: 'human',
  };

  const decision: SupervisorDecision = {
    decision: 'request-clarification',
    rationale: underspecified
      ? 'Request is underspecified; routing to human triage instead of guessing an implementation.'
      : 'Request intent is unrecognized; routing to human triage instead of guessing an implementation.',
    confidence: underspecified ? 0.15 : 0.25,
  };

  return { intent: request.intent, tickets: [ticket], decisions: [decision] };
}

/**
 * Plan a run deterministically. Recognized intents get the full V1 pipeline;
 * unknown/underspecified requests get a single human-review triage ticket and a
 * low-confidence decision (never a guessed, potentially dangerous build).
 */
export function planRun(request: RunRequest, registry: ModuleRegistry): RunPlan {
  if (request.intent === 'ai-services-marketplace') {
    return planMarketplace(request, registry);
  }
  return planTriage(request);
}

/**
 * Append a plan to the ledger: one `supervisor.decision` per decision, one
 * `ticket.created` per ticket (carrying moduleId/dependsOn/riskTier), then a
 * `run.planned` capstone. Idempotent via stable idempotency keys.
 */
export async function emitPlan(
  sink: PlanEventSink,
  runId: string,
  plan: RunPlan,
): Promise<EmitPlanResult> {
  const events: FactoryEvent[] = [];
  let deduplicated = false;

  const record = (result: AppendResult): void => {
    events.push(result.event);
    deduplicated = deduplicated || result.deduplicated;
  };

  let decisionIndex = 0;
  for (const decision of plan.decisions) {
    const result = await sink.append({
      runId,
      type: 'supervisor.decision',
      actor: SUPERVISOR_ACTOR,
      subject: { kind: 'run', id: runId },
      severity: decision.confidence < 0.5 ? 'warn' : 'info',
      idempotencyKey: `${runId}:supervisor.decision:${decisionIndex}`,
      payload: {
        decision: decision.decision,
        rationale: decision.rationale,
        confidence: decision.confidence,
      },
    });
    record(result);
    decisionIndex += 1;
  }

  for (const ticket of plan.tickets) {
    const result = await sink.append({
      runId,
      ticketId: ticket.id,
      type: 'ticket.created',
      actor: SUPERVISOR_ACTOR,
      subject: { kind: 'ticket', id: ticket.id },
      severity: 'info',
      idempotencyKey: `${runId}:ticket.created:${ticket.id}`,
      payload: {
        title: ticket.title,
        moduleId: ticket.moduleId,
        dependsOn: ticket.dependsOn,
        riskTier: ticket.riskTier,
      },
    });
    record(result);
  }

  const planned = await sink.append({
    runId,
    type: 'run.planned',
    actor: SUPERVISOR_ACTOR,
    subject: { kind: 'run', id: runId },
    severity: 'info',
    idempotencyKey: `${runId}:run.planned`,
    payload: { ticketCount: plan.tickets.length },
  });
  record(planned);

  return { runId, events, deduplicated };
}
