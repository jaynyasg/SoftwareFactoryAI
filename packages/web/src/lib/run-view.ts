/**
 * Pure view helpers shared by the server loader and the client components.
 *
 * Everything here imports ONLY types from `@software-factory/core` (erased at
 * compile time), so this module is safe in the browser bundle. The event-reading
 * derivations (`derivePreview`/`deriveDeploy`) are invoked server-side where the
 * raw events are available; the presentation helpers run in client components
 * over already-projected view-models. Nothing invents state: every field traces
 * to a real event or projection.
 */
import type {
  EventEvidence,
  EventSeverity,
  FactoryEvent,
  GateStage,
  InterventionKind,
  OperatorProjection,
  ResearchProjection,
  ReviewDecision,
  RiskTier,
  RunExecutionState,
  RunProjection,
  RunStatus,
  TicketView,
} from '@software-factory/core';
import type { ExecutionJobSnapshot, InterventionItem, PreflightSnapshot } from './types';

/* -------------------------------------------------------------------------- */
/* Severity / risk -> CSS token classes                                       */
/* -------------------------------------------------------------------------- */

export function severityClass(severity: EventSeverity): string {
  return `sev-${severity}`;
}

const RUN_STATUS_SEVERITY: Readonly<Record<RunStatus, EventSeverity>> = {
  unknown: 'info',
  created: 'info',
  planned: 'info',
  running: 'info',
  completed: 'success',
  failed: 'error',
  cancelled: 'warn',
};

export function runStatusSeverity(status: RunStatus): EventSeverity {
  return RUN_STATUS_SEVERITY[status];
}

export function riskClass(tier: RiskTier): string {
  return `risk-${tier}`;
}

const RISK_RANK: Readonly<Record<RiskTier, number>> = { low: 0, medium: 1, high: 2 };

/** The highest risk tier across a run's projected tickets, if any carry one. */
export function highestTicketRisk(tickets: readonly TicketView[]): RiskTier | undefined {
  let highest: RiskTier | undefined;
  for (const ticket of tickets) {
    const tier = ticket.riskTier;
    if (tier === undefined) {
      continue;
    }
    if (highest === undefined || RISK_RANK[tier] > RISK_RANK[highest]) {
      highest = tier;
    }
  }
  return highest;
}

export function riskLabel(tier: RiskTier): string {
  switch (tier) {
    case 'low':
      return 'Low risk · auto-merge eligible';
    case 'medium':
      return 'Medium risk · no human stop';
    case 'high':
      return 'High risk · 2 approvers in human mode';
    default:
      return tier;
  }
}

/* -------------------------------------------------------------------------- */
/* Preview + deploy derivations (read event payloads; server-side)            */
/* -------------------------------------------------------------------------- */

export type PreviewStatus = 'idle' | 'starting' | 'health_pending' | 'ready' | 'failed';

export interface PreviewView {
  readonly status: PreviewStatus;
  readonly url?: string;
  readonly reason?: string;
}

export function derivePreview(events: readonly FactoryEvent[]): PreviewView {
  let view: PreviewView = { status: 'idle' };
  for (const event of events) {
    switch (event.type) {
      case 'preview.starting':
        view = { status: 'starting' };
        break;
      case 'preview.health_pending':
        view = { status: 'health_pending' };
        break;
      case 'preview.ready':
        view = { status: 'ready', url: event.payload.url };
        break;
      case 'preview.failed':
        view = { status: 'failed', reason: event.payload.reason };
        break;
      default:
        break;
    }
  }
  return view;
}

export type DeployStatusValue =
  | 'idle'
  | 'setup_required'
  | 'config_invalid'
  | 'provider_failed'
  | 'migration_failed'
  | 'health_pending'
  | 'health_failed'
  | 'hosted_ready'
  | 'handoff_ready';

export interface DeployView {
  readonly status: DeployStatusValue;
  /** Hosted URL — present ONLY once health succeeded (`deploy.hosted_ready`). */
  readonly url?: string;
  readonly reason?: string;
  readonly action?: string;
  /** Handoff fields (U13): present ONLY on `handoff_ready` — never a hosted URL. */
  readonly repoUrl?: string;
  readonly importUrl?: string;
  readonly instructions?: string;
}

export function deriveDeploy(events: readonly FactoryEvent[]): DeployView {
  let view: DeployView = { status: 'idle' };
  for (const event of events) {
    switch (event.type) {
      case 'deploy.setup_required':
        view = { status: 'setup_required', action: event.payload.action };
        break;
      case 'deploy.config_invalid':
        view = { status: 'config_invalid', reason: event.payload.reason };
        break;
      case 'deploy.provider_failed':
        view = { status: 'provider_failed', reason: event.payload.reason };
        break;
      case 'deploy.migration_failed':
        view = { status: 'migration_failed', reason: event.payload.reason };
        break;
      case 'deploy.health_pending':
        view = { status: 'health_pending' };
        break;
      case 'deploy.health_failed':
        view = { status: 'health_failed', reason: event.payload.reason };
        break;
      case 'deploy.hosted_ready':
        view = { status: 'hosted_ready', url: event.payload.url };
        break;
      case 'deploy.handoff_ready':
        // U13: an honest publish-and-import handoff — no hosted URL claimed.
        view = {
          status: 'handoff_ready',
          repoUrl: event.payload.repoUrl,
          importUrl: event.payload.importUrl,
          instructions: event.payload.instructions,
        };
        break;
      default:
        break;
    }
  }
  return view;
}

/* -------------------------------------------------------------------------- */
/* Package + handoff derivation (read event payloads; server-side) (U8)       */
/* -------------------------------------------------------------------------- */

export interface PackageView {
  readonly status: 'none' | 'packaged';
  /** Packaged repo path — from `package.created`. */
  readonly repoPath?: string;
  /** Repo-relative handoff document reference (e.g. `HANDOFF.md`). */
  readonly handoffRef?: string;
  /** Repo-relative provenance bundle reference (e.g. `PROVENANCE.json`). */
  readonly provenanceRef?: string;
  /** The packaging commit hash, when recorded. */
  readonly commit?: string;
  /** Human handoff summary from the packaging event. */
  readonly summary?: string;
  /** The packaged artifact id, when recorded. */
  readonly artifactId?: string;
  /** Blended artifact confidence for the packaged artifact, when computed. */
  readonly confidence?: number;
}

/** Fold `package.created` + artifact confidence into the package view. Pure. */
export function derivePackage(events: readonly FactoryEvent[]): PackageView {
  let view: PackageView = { status: 'none' };
  let packagedArtifactId: string | undefined;
  const confidenceByArtifact = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'package.created') {
      packagedArtifactId = event.payload.artifactId ?? packagedArtifactId;
      view = {
        status: 'packaged',
        repoPath: event.payload.repoPath,
        handoffRef: event.payload.handoffRef,
        provenanceRef: event.payload.provenanceRef,
        commit: event.payload.commit,
        summary: event.payload.summary,
        artifactId: event.payload.artifactId,
      };
    } else if (event.type === 'artifact.confidence_computed') {
      confidenceByArtifact.set(event.payload.artifactId, event.payload.confidence);
    }
  }
  if (view.status === 'packaged') {
    const confidence =
      packagedArtifactId !== undefined ? confidenceByArtifact.get(packagedArtifactId) : undefined;
    if (confidence !== undefined) {
      view = { ...view, confidence };
    }
  }
  return view;
}

/* -------------------------------------------------------------------------- */
/* Review derivation (match review.requested -> review.decided)                */
/* -------------------------------------------------------------------------- */

export interface ReviewItem {
  /** Sequence of the originating `review.requested`. */
  readonly sequence: number;
  readonly riskTier: RiskTier;
  readonly summary?: string;
  readonly status: 'pending' | ReviewDecision;
  readonly rationale?: string;
  readonly evidence: readonly EventEvidence[];
  /**
   * The blocked stage this review would resume when approved (U7): `gates`
   * re-runs the post-run gate stage, `execution` retries execution. Absent
   * for plain risk-tier reviews.
   */
  readonly stage?: 'gates' | 'execution';
}

interface MutableReview {
  sequence: number;
  riskTier: RiskTier;
  summary?: string;
  status: 'pending' | ReviewDecision;
  rationale?: string;
  evidence: readonly EventEvidence[];
  stage?: 'gates' | 'execution';
}

/**
 * Fold review events into review items. The event model carries no review id, so
 * a `review.decided` closes the oldest still-pending request (FIFO). Risk tier
 * comes from the originating request (or the decision when no request preceded).
 */
export function deriveReviews(events: readonly FactoryEvent[]): ReviewItem[] {
  const items: MutableReview[] = [];
  for (const event of events) {
    if (event.type === 'review.requested') {
      items.push({
        sequence: event.sequence,
        riskTier: event.payload.riskTier,
        summary: event.payload.summary,
        status: 'pending',
        evidence: event.evidence ?? [],
        stage: event.payload.stage,
      });
    } else if (event.type === 'review.decided') {
      const pending = items.find((item) => item.status === 'pending');
      if (pending !== undefined) {
        pending.status = event.payload.decision;
        pending.rationale = event.payload.rationale;
      } else {
        items.push({
          sequence: event.sequence,
          riskTier: event.payload.riskTier,
          status: event.payload.decision,
          rationale: event.payload.rationale,
          evidence: event.evidence ?? [],
        });
      }
    }
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/* Gate / repair / blocked-stage derivations (U7; read event payloads)        */
/* -------------------------------------------------------------------------- */

/** Latest observed outcome of one gate (per ticket scope), for the gate panel. */
export interface GateOutcomeRow {
  /** Ticket id for post-ticket gates; absent for run-level gates. */
  readonly ticketId?: string;
  readonly gate: string;
  readonly stage?: GateStage;
  readonly status: 'running' | 'passed' | 'failed';
  /** Pass summary or failure reason from the event payload. */
  readonly detail?: string;
  /** Total gate.started attempts observed for this scope+gate. */
  readonly attempts: number;
  readonly evidence: readonly EventEvidence[];
}

/** Fold `gate.*` events into the latest outcome per (scope, gate). Pure. */
export function deriveGateOutcomes(events: readonly FactoryEvent[]): GateOutcomeRow[] {
  const rows = new Map<string, GateOutcomeRow & { order: number }>();
  let order = 0;
  for (const event of events) {
    if (
      event.type !== 'gate.started' &&
      event.type !== 'gate.passed' &&
      event.type !== 'gate.failed'
    ) {
      continue;
    }
    const key = `${event.ticketId ?? ''}|${event.payload.gate}`;
    const existing = rows.get(key);
    const base = existing ?? {
      ticketId: event.ticketId,
      gate: event.payload.gate,
      stage: undefined,
      status: 'running' as const,
      detail: undefined,
      attempts: 0,
      evidence: [] as readonly EventEvidence[],
      order: (order += 1),
    };
    if (event.type === 'gate.started') {
      rows.set(key, {
        ...base,
        stage: event.payload.stage ?? base.stage,
        status: 'running',
        attempts: base.attempts + 1,
      });
    } else if (event.type === 'gate.passed') {
      rows.set(key, {
        ...base,
        stage: event.payload.stage ?? base.stage,
        status: 'passed',
        detail: event.payload.summary,
        evidence: event.evidence ?? [],
      });
    } else {
      rows.set(key, {
        ...base,
        stage: event.payload.stage ?? base.stage,
        status: 'failed',
        detail: event.payload.reason,
        evidence: event.evidence ?? [],
      });
    }
  }
  return [...rows.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, ...row }) => row);
}

/** Ledger-derived repair-loop state for one ticket. */
export interface RepairSummaryRow {
  readonly ticketId: string;
  /** Repair attempts consumed (count of `repair.started`; ledger-derived). */
  readonly attempts: number;
  readonly status: 'repairing' | 'succeeded' | 'exhausted';
  readonly gate?: string;
  readonly reason?: string;
}

/** Fold `repair.*` events into per-ticket repair summaries. Pure. */
export function deriveRepairSummaries(events: readonly FactoryEvent[]): RepairSummaryRow[] {
  const rows = new Map<string, RepairSummaryRow>();
  for (const event of events) {
    if (
      (event.type !== 'repair.started' &&
        event.type !== 'repair.succeeded' &&
        event.type !== 'repair.failed') ||
      event.ticketId === undefined
    ) {
      continue;
    }
    const existing = rows.get(event.ticketId);
    const attempts = Math.max(existing?.attempts ?? 0, event.payload.attempt);
    if (event.type === 'repair.started') {
      rows.set(event.ticketId, {
        ticketId: event.ticketId,
        attempts,
        status: 'repairing',
        gate: event.payload.gate,
        reason: event.payload.reason,
      });
    } else if (event.type === 'repair.succeeded') {
      rows.set(event.ticketId, {
        ticketId: event.ticketId,
        attempts,
        status: 'succeeded',
        gate: event.payload.gate,
        reason: undefined,
      });
    } else {
      rows.set(event.ticketId, {
        ticketId: event.ticketId,
        attempts,
        status: 'exhausted',
        gate: event.payload.gate,
        reason: event.payload.reason,
      });
    }
  }
  return [...rows.values()];
}

/**
 * An OPEN operator intervention rendered as a blocked stage in the Review
 * Studio. `approvable` is computed SERVER-SIDE from the core review policy
 * (KTD6): `policy_block` and setup-class kinds are never approval-resolvable.
 */
export interface BlockedStageView {
  readonly interventionId: string;
  readonly kind: InterventionKind;
  readonly blockingStage: string;
  readonly severity: EventSeverity;
  readonly reason: string;
  readonly requiredAction: string;
  /** Whether a review approval may resolve this entry (core policy). */
  readonly approvable: boolean;
}

/* -------------------------------------------------------------------------- */
/* Worker board derivation (from ticket projection)                           */
/* -------------------------------------------------------------------------- */

export interface WorkerBoardModel {
  readonly active: readonly TicketView[];
  readonly queued: readonly TicketView[];
  readonly done: readonly TicketView[];
  readonly blocked: readonly TicketView[];
}

const ACTIVE_STATES = new Set<TicketView['state']>(['running', 'retrying']);
const QUEUED_STATES = new Set<TicketView['state']>(['created', 'queued']);
const DONE_STATES = new Set<TicketView['state']>(['completed']);
const BLOCKED_STATES = new Set<TicketView['state']>([
  'blocked',
  'failed',
  'dead_lettered',
  'cancelled',
]);

export function deriveWorkerBoard(tickets: readonly TicketView[]): WorkerBoardModel {
  return {
    active: tickets.filter((t) => ACTIVE_STATES.has(t.state)),
    queued: tickets.filter((t) => QUEUED_STATES.has(t.state)),
    done: tickets.filter((t) => DONE_STATES.has(t.state)),
    blocked: tickets.filter((t) => BLOCKED_STATES.has(t.state)),
  };
}

/* -------------------------------------------------------------------------- */
/* Execution state + blueprint lane derivations (U9)                          */
/* -------------------------------------------------------------------------- */

const EXECUTION_STATE_SEVERITY: Readonly<Record<RunExecutionState, EventSeverity>> = {
  not_requested: 'info',
  pending: 'info',
  queued: 'info',
  started: 'info',
  paused: 'warn',
  blocked: 'warn',
  completed: 'success',
  failed: 'error',
  cancelled: 'warn',
  unavailable: 'warn',
};

export function executionStateSeverity(state: RunExecutionState): EventSeverity {
  return EXECUTION_STATE_SEVERITY[state];
}

/** Human label for a projected execution state (underscores removed). */
export function executionStateLabel(state: RunExecutionState): string {
  return state.replace(/_/g, ' ');
}

export type BlueprintLaneId =
  | 'research'
  | 'planning'
  | 'queue'
  | 'workers'
  | 'gates'
  | 'repair'
  | 'package'
  | 'deploy';

/** One dense status strip in the factory blueprint (never invented state). */
export interface BlueprintLane {
  readonly id: BlueprintLaneId;
  readonly label: string;
  /** Short projected status word(s), always paired with the severity color. */
  readonly status: string;
  readonly severity: EventSeverity;
  /** Compact machine metric (counts), rendered mono. */
  readonly metric?: string;
  /** One-line human detail from the underlying projection. */
  readonly detail?: string;
}

/** Everything the blueprint folds over — all replayed projections, no invention. */
export interface BlueprintInputs {
  readonly run: RunProjection;
  readonly tickets: readonly TicketView[];
  readonly research: ResearchProjection;
  readonly preflight: PreflightSnapshot;
  readonly executionJob: ExecutionJobSnapshot | null;
  readonly gates: readonly GateOutcomeRow[];
  readonly repairs: readonly RepairSummaryRow[];
  readonly packageView: PackageView;
  readonly deploy: DeployView;
  readonly operator: OperatorProjection;
}

/** Severity per deploy status — shared by the blueprint lane and DeployStatus. */
export const DEPLOY_STATUS_SEVERITY: Readonly<Record<DeployStatusValue, EventSeverity>> = {
  idle: 'info',
  setup_required: 'warn',
  config_invalid: 'error',
  provider_failed: 'error',
  migration_failed: 'error',
  health_pending: 'warn',
  health_failed: 'error',
  hosted_ready: 'success',
  handoff_ready: 'success',
};

const DEPLOY_LANE_STATUS: Readonly<Record<DeployStatusValue, string>> = {
  idle: 'not started',
  setup_required: 'setup required',
  config_invalid: 'config invalid',
  provider_failed: 'provider failed',
  migration_failed: 'migration failed',
  health_pending: 'health pending',
  health_failed: 'health failed',
  hosted_ready: 'hosted · healthy',
  handoff_ready: 'handoff ready',
};

function researchLane(research: ResearchProjection): BlueprintLane {
  const base = { id: 'research' as const, label: 'Research' };
  switch (research.status) {
    case 'none':
      return {
        ...base,
        status: 'not requested',
        severity: 'info',
        detail: 'No research events recorded for this run.',
      };
    case 'requested':
      return { ...base, status: 'requested', severity: 'info', detail: research.objective };
    case 'in_progress':
      return {
        ...base,
        status: 'in progress',
        severity: 'info',
        metric: `${research.readSourceCount}/${research.sourceCount} sources read`,
        detail: research.objective,
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        severity: 'error',
        metric: `${research.findings.length} findings · ${research.unresolvedGapCount} gaps`,
        detail: research.failureReason,
      };
    case 'completed':
      return {
        ...base,
        status: 'brief complete',
        severity: 'success',
        metric: `${research.findings.length} findings · ${research.sourceCount} sources · ${research.unresolvedGapCount} open gaps`,
        detail: research.briefSummary,
      };
    default: {
      // Exhaustiveness: adding a ResearchStatus member must fail compile here
      // until it gets a designed lane label; the runtime fallback stays honest.
      const exhaustive: never = research.status;
      return {
        ...base,
        status: 'unknown',
        severity: 'info',
        detail: `Unrecognized research status: ${String(exhaustive)}`,
      };
    }
  }
}

function planningLane(run: RunProjection, tickets: readonly TicketView[]): BlueprintLane {
  const base = { id: 'planning' as const, label: 'Planning' };
  const decisions = run.supervisorDecisions.length;
  if (run.status === 'created') {
    return {
      ...base,
      status: 'planning',
      severity: 'info',
      detail: 'Supervisor has not planned this run yet.',
    };
  }
  if (run.status === 'unknown') {
    return { ...base, status: 'no plan', severity: 'info' };
  }
  const count = run.plannedTicketCount ?? tickets.length;
  return {
    ...base,
    status: 'planned',
    severity: 'success',
    metric: `${count} tickets · ${decisions} decisions`,
    detail: run.buildContract !== undefined ? run.buildContract.scope : undefined,
  };
}

export function deriveBlueprintLanes(inputs: BlueprintInputs): BlueprintLane[] {
  const { run, tickets, research, executionJob, gates, repairs, packageView, deploy, operator } =
    inputs;
  const board = deriveWorkerBoard(tickets);

  const queueDetail =
    executionJob !== null
      ? `execution job ${executionJob.status} · attempt ${executionJob.attempt}${
          executionJob.reason !== undefined ? ` (${executionJob.reason})` : ''
        }`
      : 'No execution job enqueued yet.';
  const queueLane: BlueprintLane = {
    id: 'queue',
    label: 'Queued',
    status: board.queued.length > 0 ? 'waiting' : board.active.length > 0 ? 'drained' : 'empty',
    severity: 'info',
    metric: `${board.queued.length} queued`,
    detail: queueDetail,
  };

  const cap = run.requestedWorkerCap ?? 10;
  const effectiveCap = Math.min(cap, operator.adapterCapacity ?? cap);
  const throttled = effectiveCap < cap;
  const workersLane: BlueprintLane = {
    id: 'workers',
    label: 'Workers',
    status: board.active.length > 0 ? 'running' : 'idle',
    severity: throttled ? 'warn' : 'info',
    metric: `${board.active.length} active · capacity ${effectiveCap}/${cap}`,
    detail: throttled ? 'Throttled below the requested cap by system constraints.' : undefined,
  };

  const failedGates = gates.filter((g) => g.status === 'failed');
  const runningGates = gates.filter((g) => g.status === 'running');
  const passedGates = gates.filter((g) => g.status === 'passed');
  const gatesLane: BlueprintLane = {
    id: 'gates',
    label: 'Gates',
    status:
      gates.length === 0
        ? 'not run'
        : failedGates.length > 0
          ? 'failing'
          : runningGates.length > 0
            ? 'running'
            : 'passing',
    severity: failedGates.length > 0 ? 'error' : gates.length === 0 ? 'info' : 'success',
    metric:
      gates.length === 0
        ? undefined
        : `${passedGates.length} passed · ${failedGates.length} failed`,
    detail:
      failedGates[0] !== undefined
        ? `${failedGates[0].gate}: ${failedGates[0].detail ?? 'failed'}`
        : undefined,
  };

  const exhausted = repairs.filter((r) => r.status === 'exhausted');
  const repairing = repairs.filter((r) => r.status === 'repairing');
  const repairLane: BlueprintLane = {
    id: 'repair',
    label: 'Repair',
    status:
      repairs.length === 0
        ? 'none needed'
        : exhausted.length > 0
          ? 'escalated'
          : repairing.length > 0
            ? 'repairing'
            : 'recovered',
    severity:
      exhausted.length > 0
        ? 'error'
        : repairing.length > 0
          ? 'warn'
          : repairs.length > 0
            ? 'success'
            : 'info',
    metric: repairs.length > 0 ? `${repairs.length} ticket(s) in repair` : undefined,
    detail: exhausted[0]?.reason ?? repairing[0]?.reason,
  };

  const packageLane: BlueprintLane = {
    id: 'package',
    label: 'Package',
    status: packageView.status === 'packaged' ? 'packaged' : 'not packaged',
    severity: packageView.status === 'packaged' ? 'success' : 'info',
    metric:
      packageView.confidence !== undefined
        ? `confidence ${formatPercent(packageView.confidence)}`
        : undefined,
    detail: packageView.summary,
  };

  const deployLane: BlueprintLane = {
    id: 'deploy',
    label: 'Deploy',
    status: DEPLOY_LANE_STATUS[deploy.status],
    severity: DEPLOY_STATUS_SEVERITY[deploy.status],
    detail:
      deploy.reason ?? deploy.action ?? (deploy.status === 'hosted_ready' ? deploy.url : undefined),
  };

  return [
    researchLane(research),
    planningLane(run, tickets),
    queueLane,
    workersLane,
    gatesLane,
    repairLane,
    packageLane,
    deployLane,
  ];
}

/** The compact operator pulse: capacity, throttle, queue, and blocking item. */
export interface FactoryPulse {
  readonly activeWorkers: number;
  readonly queuedTickets: number;
  readonly effectiveCapacity: number;
  readonly requestedCap: number;
  readonly throttleReason?: string;
  /** The FIRST currently blocking policy/setup/intervention item, when any. */
  readonly blocking?: string;
}

export function deriveFactoryPulse(inputs: {
  readonly run: RunProjection;
  readonly tickets: readonly TicketView[];
  readonly operator: OperatorProjection;
  readonly preflight: PreflightSnapshot;
  readonly interventions: readonly BlockedStageView[];
}): FactoryPulse {
  const { run, tickets, operator, preflight, interventions } = inputs;
  const board = deriveWorkerBoard(tickets);
  const cap = run.requestedWorkerCap ?? 10;
  const effectiveCapacity = Math.min(cap, operator.adapterCapacity ?? cap);
  const throttleReason = operator.alerts
    .filter((alert) => alert.type === 'adapter.capacity_changed')
    .map((alert) => alert.message)
    .at(-1);

  let blocking: string | undefined;
  const firstIntervention = interventions[0];
  if (firstIntervention !== undefined) {
    blocking = `${firstIntervention.blockingStage}: ${firstIntervention.requiredAction}`;
  } else if (preflight.status === 'failed') {
    blocking = `preflight: ${preflight.failedChecks.join(', ')} failed`;
  } else if (run.executionState === 'blocked' && run.executionReason !== undefined) {
    blocking = run.executionReason;
  }

  return {
    activeWorkers: board.active.length,
    queuedTickets: board.queued.length,
    effectiveCapacity,
    requestedCap: cap,
    throttleReason,
    blocking,
  };
}

/* -------------------------------------------------------------------------- */
/* Cross-run intervention queue filtering (X4, client mirror of the server)   */
/* -------------------------------------------------------------------------- */

export interface InterventionItemFilter {
  readonly runId?: string;
  readonly severity?: EventSeverity;
  readonly blockingStage?: string;
  /** Case-insensitive substring match over the required action. */
  readonly actionText?: string;
  readonly openOnly?: boolean;
}

/** Pure client-side filter over the polled cross-run intervention queue. */
export function filterInterventionItems(
  items: readonly InterventionItem[],
  filter: InterventionItemFilter = {},
): InterventionItem[] {
  const actionText = filter.actionText?.trim().toLowerCase();
  return items.filter(
    (item) =>
      (filter.openOnly !== true || item.status === 'open') &&
      (filter.runId === undefined || item.runId === filter.runId) &&
      (filter.severity === undefined || item.severity === filter.severity) &&
      (filter.blockingStage === undefined || item.blockingStage === filter.blockingStage) &&
      (actionText === undefined ||
        actionText.length === 0 ||
        item.requiredAction.toLowerCase().includes(actionText)),
  );
}

/* -------------------------------------------------------------------------- */
/* Confidence factor labels                                                   */
/* -------------------------------------------------------------------------- */

const FACTOR_LABELS: Readonly<Record<string, string>> = {
  gatePassRate: 'Gate pass rate',
  provenanceCompleteness: 'Provenance completeness',
  dependencyRisk: 'Dependency risk (inverted)',
  previewEvidence: 'Preview evidence',
  sandboxTrust: 'Sandbox trust (reduced on fallback)',
};

export interface ConfidenceFactorRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export function humanizeFactor(key: string): string {
  if (key in FACTOR_LABELS) {
    return FACTOR_LABELS[key];
  }
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export function confidenceFactorRows(
  factors: Readonly<Record<string, number>> | undefined,
): ConfidenceFactorRow[] {
  if (factors === undefined) {
    return [];
  }
  return Object.keys(factors)
    .sort()
    .map((key) => ({ key, label: humanizeFactor(key), value: factors[key] }));
}

/* -------------------------------------------------------------------------- */
/* Formatting + middle-truncation (§8: no horizontal scroll from long values) */
/* -------------------------------------------------------------------------- */

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toISOString().slice(11, 19);
}

/** Humanize a millisecond lag/duration into a compact, stable label. */
export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) {
    return '—';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return `${Math.round(hours)} h`;
  }
  return `${Math.round(hours / 24)} d`;
}

/**
 * Middle-truncate a long machine value to `max` characters, keeping the head and
 * tail (so a run id / path / url stays recognizable). The full value is always
 * preserved by the caller in a `title`/copy affordance.
 */
export function middleTruncate(value: string, max = 28): string {
  if (value.length <= max) {
    return value;
  }
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
