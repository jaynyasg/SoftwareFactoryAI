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
  ReviewDecision,
  RiskTier,
  RunStatus,
  TicketView,
} from '@software-factory/core';

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

export function riskLabel(tier: RiskTier): string {
  switch (tier) {
    case 'low':
      return 'Low risk · auto-merge eligible';
    case 'medium':
      return 'Medium risk · 1 approver';
    case 'high':
      return 'High risk · 2 approvers · never autonomous';
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
  | 'hosted_ready';

export interface DeployView {
  readonly status: DeployStatusValue;
  /** Hosted URL — present ONLY once health succeeded (`deploy.hosted_ready`). */
  readonly url?: string;
  readonly reason?: string;
  readonly action?: string;
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
      default:
        break;
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
}

interface MutableReview {
  sequence: number;
  riskTier: RiskTier;
  summary?: string;
  status: 'pending' | ReviewDecision;
  rationale?: string;
  evidence: readonly EventEvidence[];
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
/* Confidence factor labels                                                   */
/* -------------------------------------------------------------------------- */

const FACTOR_LABELS: Readonly<Record<string, string>> = {
  gatePassRate: 'Gate pass rate',
  provenanceCompleteness: 'Provenance completeness',
  dependencyRisk: 'Dependency risk (inverted)',
  previewEvidence: 'Preview evidence',
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
