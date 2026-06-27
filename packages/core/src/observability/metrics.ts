/**
 * Operator metrics: pure derivations of operator-facing health/throughput from
 * the ledger (events) and the replay projections.
 *
 * Every field traces to real events — nothing is invented. The one optional
 * non-determinism is `lag.eventLagMs`, which needs a wall clock; callers pass
 * `now` explicitly (the server passes `Date.now()`, tests pass a fixed value) so
 * the function stays pure and replay-deterministic for a fixed `now`.
 *
 * Derivations (see each field):
 *   - lag.eventLagMs        — now − timestamp of the newest event (ledger staleness),
 *   - lag.projectionLagEvents — events the projection could not fold (gaps + corrupt),
 *   - workers               — active/queued tickets vs requested/effective cap,
 *   - queue                 — latest queue_wait health sample + queued ticket count,
 *   - adapter               — capacity (throttle), setup/auth/error occurrences,
 *   - sandbox               — reduced-trust fallback + sandbox errors,
 *   - gates                 — gate retries + gate pass/fail tallies,
 *   - preview               — preview failures + folded preview phase,
 *   - deploy                — per-failure occurrences + folded deploy phase/url,
 *   - hostedHealth          — folded hosted-health status (url only when ready),
 *   - alerts                — warn/error/critical counts (from the operator view).
 */
import {
  detectSequenceGaps,
  projectRun,
  resolveTargetRunId,
  validateAndSortEvents,
} from '../projections/run-projection';
import type { RunStatus } from '../projections/run-projection';
import { projectTickets } from '../projections/ticket-projection';
import { projectOperator } from '../projections/operator-projection';
import type { OperatorSeverityCounts } from '../projections/operator-projection';
import type { FactoryEvent, TicketState } from '../events/event-types';

/** Folded deploy phase (mirrors the deploy event families; core-owned). */
export type DeployPhase =
  | 'idle'
  | 'setup_required'
  | 'config_invalid'
  | 'provider_failed'
  | 'migration_failed'
  | 'health_pending'
  | 'health_failed'
  | 'hosted_ready';

/** Folded local-preview phase. */
export type PreviewPhase = 'idle' | 'starting' | 'health_pending' | 'ready' | 'failed';

/** Folded hosted-health status. The hosted URL is only valid when `ready`. */
export type HostedHealthStatus = 'not_attempted' | 'pending' | 'failed' | 'ready';

export interface LagMetric {
  /** now − newest event timestamp, when `now` was supplied; else undefined. */
  readonly eventLagMs?: number;
  /** Newest event timestamp in the run, when any events exist. */
  readonly lastEventTimestamp?: number;
  /** Highest applied sequence (the projection's high-water mark). */
  readonly lastSequence: number;
  /** Events the projection could not fold = sequence gaps + corrupt/unknown. */
  readonly projectionLagEvents: number;
  /** Missing per-run sequence numbers. */
  readonly sequenceGaps: number;
  /** Corrupt or unknown-type entries that were skipped. */
  readonly corruptEvents: number;
}

export interface WorkerCapacityMetric {
  /** Tickets currently running/retrying. */
  readonly active: number;
  /** Tickets created/queued (waiting). */
  readonly queued: number;
  /** Operator-requested upper bound (1..10), when recorded. */
  readonly requestedCap?: number;
  /** Latest adapter-advertised capacity, when changed. */
  readonly adapterCapacity?: number;
  /** min(requestedCap, adapterCapacity) — the effective ceiling. */
  readonly effectiveCap: number;
  /** Effective ceiling sits below the requested cap. */
  readonly throttled: boolean;
}

export interface QueueMetric {
  /** Latest `queue_wait` health sample value, when sampled. */
  readonly waitMs?: number;
  /** Tickets created/queued (waiting for capacity or dependencies). */
  readonly queuedTickets: number;
}

export interface AdapterMetric {
  /** Latest adapter capacity (from adapter.capacity_changed). */
  readonly capacity?: number;
  readonly previousCapacity?: number;
  /** Capacity dropped below the requested cap. */
  readonly throttled: boolean;
  /** Count of adapter.setup_required occurrences. */
  readonly setupRequired: number;
  /** Count of adapter.auth_failed occurrences. */
  readonly authFailures: number;
  /** Count of adapter.error occurrences. */
  readonly errors: number;
  /** True when the adapter had no setup/auth/error events at all. */
  readonly available: boolean;
  /** Latest setup/auth/error reason, for the panel. */
  readonly lastReason?: string;
}

export interface SandboxMetric {
  /** A reduced-trust local fallback occurred. */
  readonly fallback: boolean;
  /** Count of sandbox.error occurrences. */
  readonly errors: number;
  /** Latest fallback/error reason. */
  readonly reason?: string;
}

export interface GateMetric {
  /** worker.retry occurrences (bounded gate-driven retries). */
  readonly retries: number;
  /** gate.failed occurrences. */
  readonly failures: number;
  /** gate.passed occurrences. */
  readonly passed: number;
}

export interface PreviewMetric {
  readonly failures: number;
  readonly status: PreviewPhase;
}

export interface DeployMetric {
  /** Folded deploy phase (last deploy.* event). */
  readonly status: DeployPhase;
  /** Hosted URL — present ONLY when `status === 'hosted_ready'`. */
  readonly hostedUrl?: string;
  readonly setupRequired: number;
  readonly configInvalid: number;
  readonly providerFailed: number;
  readonly migrationFailed: number;
  readonly healthFailed: number;
  /** Sum of hard deploy failures (excludes setup_required, which is a pause). */
  readonly failures: number;
}

/** The full operator metrics snapshot the dashboard renders. */
export interface OperatorMetrics {
  readonly runId: string | null;
  readonly runStatus: RunStatus;
  readonly lag: LagMetric;
  readonly workers: WorkerCapacityMetric;
  readonly queue: QueueMetric;
  readonly adapter: AdapterMetric;
  readonly sandbox: SandboxMetric;
  readonly gates: GateMetric;
  readonly preview: PreviewMetric;
  readonly deploy: DeployMetric;
  readonly hostedHealth: HostedHealthStatus;
  readonly alerts: OperatorSeverityCounts;
}

export interface OperatorMetricsOptions {
  /** Scope to one run; defaults to the run of the earliest event. */
  readonly runId?: string;
  /** Wall clock for `lag.eventLagMs`. Omit to leave event lag undefined. */
  readonly now?: number;
}

const ACTIVE_TICKET_STATES = new Set<TicketState | 'unknown'>(['running', 'retrying']);
const QUEUED_TICKET_STATES = new Set<TicketState | 'unknown'>(['created', 'queued']);

const DEFAULT_WORKER_CAP = 10;

function reasonOf(event: FactoryEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['reason', 'action', 'message', 'summary'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Compute the operator metrics snapshot from raw ledger entries. Pure for a
 * fixed `options.now`; tolerant of corrupt/out-of-order/gappy logs (those become
 * `lag.projectionLagEvents` rather than throwing).
 */
export function computeOperatorMetrics(
  raw: readonly unknown[],
  options: OperatorMetricsOptions = {},
): OperatorMetrics {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const runId = resolveTargetRunId(events, options.runId);
  const runEvents = runId === null ? [] : events.filter((event) => event.runId === runId);
  const gaps = detectSequenceGaps(runEvents);

  const run = projectRun(raw, options.runId);
  const operator = projectOperator(raw, options.runId);
  const tickets = projectTickets(raw, options.runId).tickets;

  let active = 0;
  let queued = 0;
  for (const ticket of tickets) {
    if (ACTIVE_TICKET_STATES.has(ticket.state)) {
      active += 1;
    } else if (QUEUED_TICKET_STATES.has(ticket.state)) {
      queued += 1;
    }
  }

  // Single pass over the run's events for occurrence counts + folded phases.
  let adapterSetupRequired = 0;
  let adapterAuthFailures = 0;
  let adapterErrors = 0;
  let adapterLastReason: string | undefined;
  let adapterCapacity: number | undefined;
  let adapterPreviousCapacity: number | undefined;

  let sandboxFallback = false;
  let sandboxErrors = 0;
  let sandboxReason: string | undefined;

  let gateRetries = 0;
  let gateFailures = 0;
  let gatePassed = 0;

  let previewFailures = 0;
  let previewStatus: PreviewPhase = 'idle';

  let deploySetupRequired = 0;
  let deployConfigInvalid = 0;
  let deployProviderFailed = 0;
  let deployMigrationFailed = 0;
  let deployHealthFailed = 0;
  let deployStatus: DeployPhase = 'idle';
  let deployHostedUrl: string | undefined;
  let hostedHealth: HostedHealthStatus = 'not_attempted';

  for (const event of runEvents) {
    switch (event.type) {
      case 'adapter.setup_required':
        adapterSetupRequired += 1;
        adapterLastReason = reasonOf(event) ?? adapterLastReason;
        break;
      case 'adapter.auth_failed':
        adapterAuthFailures += 1;
        adapterLastReason = reasonOf(event) ?? adapterLastReason;
        break;
      case 'adapter.error':
        adapterErrors += 1;
        adapterLastReason = reasonOf(event) ?? adapterLastReason;
        break;
      case 'adapter.capacity_changed':
        adapterCapacity = event.payload.capacity;
        adapterPreviousCapacity = event.payload.previousCapacity ?? adapterPreviousCapacity;
        break;
      case 'sandbox.fallback':
        sandboxFallback = true;
        sandboxReason = reasonOf(event) ?? sandboxReason;
        break;
      case 'sandbox.error':
        sandboxErrors += 1;
        sandboxReason = reasonOf(event) ?? sandboxReason;
        break;
      case 'worker.retry':
        gateRetries += 1;
        break;
      case 'gate.failed':
        gateFailures += 1;
        break;
      case 'gate.passed':
        gatePassed += 1;
        break;
      case 'preview.starting':
        previewStatus = 'starting';
        break;
      case 'preview.health_pending':
        previewStatus = 'health_pending';
        break;
      case 'preview.ready':
        previewStatus = 'ready';
        break;
      case 'preview.failed':
        previewFailures += 1;
        previewStatus = 'failed';
        break;
      case 'deploy.setup_required':
        deploySetupRequired += 1;
        deployStatus = 'setup_required';
        break;
      case 'deploy.config_invalid':
        deployConfigInvalid += 1;
        deployStatus = 'config_invalid';
        break;
      case 'deploy.provider_failed':
        deployProviderFailed += 1;
        deployStatus = 'provider_failed';
        break;
      case 'deploy.migration_failed':
        deployMigrationFailed += 1;
        deployStatus = 'migration_failed';
        break;
      case 'deploy.health_pending':
        deployStatus = 'health_pending';
        hostedHealth = 'pending';
        break;
      case 'deploy.health_failed':
        deployHealthFailed += 1;
        deployStatus = 'health_failed';
        hostedHealth = 'failed';
        break;
      case 'deploy.hosted_ready':
        deployStatus = 'hosted_ready';
        deployHostedUrl = event.payload.url;
        hostedHealth = 'ready';
        break;
      default:
        break;
    }
  }

  const requestedCap = run.requestedWorkerCap;
  const capCeiling = requestedCap ?? DEFAULT_WORKER_CAP;
  const effectiveCap = Math.min(capCeiling, adapterCapacity ?? capCeiling);
  const workersThrottled = effectiveCap < capCeiling;
  const adapterThrottled =
    adapterCapacity !== undefined && requestedCap !== undefined && adapterCapacity < requestedCap;

  const lastEventTimestamp =
    runEvents.length > 0 ? runEvents[runEvents.length - 1].timestamp : undefined;
  const eventLagMs =
    options.now !== undefined && lastEventTimestamp !== undefined
      ? Math.max(0, options.now - lastEventTimestamp)
      : undefined;
  const corruptEvents = diagnostics.length;
  const sequenceGaps = gaps.length;

  return {
    runId,
    runStatus: run.status,
    lag: {
      eventLagMs,
      lastEventTimestamp,
      lastSequence: run.lastSequence,
      projectionLagEvents: corruptEvents + sequenceGaps,
      sequenceGaps,
      corruptEvents,
    },
    workers: {
      active,
      queued,
      requestedCap,
      adapterCapacity,
      effectiveCap,
      throttled: workersThrottled,
    },
    queue: {
      waitMs: operator.latestByMetric.queue_wait?.value,
      queuedTickets: queued,
    },
    adapter: {
      capacity: adapterCapacity,
      previousCapacity: adapterPreviousCapacity,
      throttled: adapterThrottled,
      setupRequired: adapterSetupRequired,
      authFailures: adapterAuthFailures,
      errors: adapterErrors,
      available: adapterSetupRequired === 0 && adapterAuthFailures === 0 && adapterErrors === 0,
      lastReason: adapterLastReason,
    },
    sandbox: {
      fallback: sandboxFallback || operator.sandboxFallback,
      errors: sandboxErrors,
      reason: sandboxReason,
    },
    gates: {
      retries: gateRetries,
      failures: gateFailures,
      passed: gatePassed,
    },
    preview: {
      failures: previewFailures,
      status: previewStatus,
    },
    deploy: {
      status: deployStatus,
      hostedUrl: deployStatus === 'hosted_ready' ? deployHostedUrl : undefined,
      setupRequired: deploySetupRequired,
      configInvalid: deployConfigInvalid,
      providerFailed: deployProviderFailed,
      migrationFailed: deployMigrationFailed,
      healthFailed: deployHealthFailed,
      failures:
        deployConfigInvalid + deployProviderFailed + deployMigrationFailed + deployHealthFailed,
    },
    hostedHealth,
    alerts: operator.counts,
  };
}
