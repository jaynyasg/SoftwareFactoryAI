/**
 * Per-run diagnostics: a pure, operator-facing read of what is wrong with one
 * run RIGHT NOW, joining the ledger, the projections, and the failure registry.
 *
 * It surfaces four things the operator dashboard and runbooks care about:
 *   - projectionDiagnostics    — gaps / corrupt / unknown / duplicate events
 *                                (from the shared U2 projection diagnostics),
 *   - activeFailures           — failure-shaped events that are NOT yet resolved
 *                                by a later success of the same scope, each joined
 *                                to its failure-registry rescue action,
 *   - blockedByFailedDependency — tickets whose DAG dependency failed/dead-lettered
 *                                /cancelled, so they cannot make progress,
 *   - stalled                  — the run is in flight but cannot progress (no
 *                                active workers, work remaining, and a blocker).
 *
 * "Resolved" means a later event of the same scope cleared the failure (e.g. a
 * gate.failed followed by gate.passed for the same ticket+gate, or any deploy
 * failure followed by deploy.hosted_ready). Reduced-trust sandbox fallback is
 * reported as an active (non-blocking) item because it persists for the run.
 *
 * Pure: no clocks, randomness, or I/O — identical inputs yield identical output.
 */
import {
  detectSequenceGaps,
  projectRun,
  resolveTargetRunId,
  validateAndSortEvents,
} from '../projections/run-projection';
import type { ProjectionDiagnostic, RunStatus } from '../projections/run-projection';
import { projectTickets } from '../projections/ticket-projection';
import type { TicketView } from '../projections/ticket-projection';
import { lookupFailure } from './failure-registry';
import type { FailureEventType } from './failure-registry';
import type { EventSeverity, FactoryEvent, TicketState } from '../events/event-types';

/** One unresolved failure, joined to its registry rescue action. */
export interface ActiveFailure {
  readonly type: FailureEventType;
  readonly sequence: number;
  readonly ticketId?: string;
  readonly severity: EventSeverity;
  /** Human detail pulled from the event payload (no invention). */
  readonly message: string;
  readonly blocking: boolean;
  readonly retryable: boolean;
  readonly rescueAction: string;
  readonly runbook: string;
}

/** A ticket blocked because a DAG dependency failed. */
export interface BlockedDependency {
  readonly ticketId: string;
  readonly state: TicketState | 'unknown';
  /** Dependency ticket ids that failed/dead-lettered/cancelled. */
  readonly blockedBy: readonly string[];
}

export interface RunDiagnosticsReport {
  readonly runId: string | null;
  readonly runStatus: RunStatus;
  /** Replay integrity problems: gaps, corrupt, unknown, duplicate. */
  readonly projectionDiagnostics: readonly ProjectionDiagnostic[];
  /** Unresolved failures, newest scope first by sequence. */
  readonly activeFailures: readonly ActiveFailure[];
  /** Subset of `activeFailures` whose registry entry is blocking. */
  readonly blockingFailures: readonly ActiveFailure[];
  readonly blockedByFailedDependency: readonly BlockedDependency[];
  readonly stalled: boolean;
  readonly stallReason?: string;
  /** A reduced-trust sandbox fallback occurred during the run. */
  readonly reducedTrust: boolean;
  /** No blocking failures, no projection diagnostics, not stalled. */
  readonly healthy: boolean;
}

export interface RunDiagnosticsOptions {
  readonly runId?: string;
}

const FAILED_DEP_STATES = new Set<TicketState | 'unknown'>(['failed', 'dead_lettered', 'cancelled']);
const ACTIVE_TICKET_STATES = new Set<TicketState | 'unknown'>(['running', 'retrying']);
const REMAINING_TICKET_STATES = new Set<TicketState | 'unknown'>([
  'created',
  'queued',
  'blocked',
  'retrying',
]);

function messageOf(event: FactoryEvent): string {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['reason', 'action', 'message', 'summary'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return event.type;
}

/** Does a later event clear this failure's scope? */
function isResolved(failure: FactoryEvent, later: readonly FactoryEvent[]): boolean {
  const ticketId = failure.ticketId;
  const sameTicket = (event: FactoryEvent): boolean =>
    ticketId !== undefined && event.ticketId === ticketId;

  switch (failure.type) {
    case 'gate.failed': {
      const gate = failure.payload.gate;
      return later.some(
        (event) =>
          (event.type === 'gate.passed' && sameTicket(event) && event.payload.gate === gate) ||
          (event.type === 'worker.completed' && sameTicket(event)),
      );
    }
    case 'worker.failed':
      return later.some((event) => event.type === 'worker.completed' && sameTicket(event));
    case 'worker.retry':
      return later.some(
        (event) =>
          (event.type === 'worker.completed' && sameTicket(event)) ||
          (event.type === 'worker.retry' && sameTicket(event)) ||
          (event.type === 'ticket.dead_lettered' && sameTicket(event)),
      );
    case 'worker.cancelled':
      return later.some(
        (event) =>
          (event.type === 'worker.started' || event.type === 'worker.completed') &&
          sameTicket(event),
      );
    case 'adapter.setup_required':
    case 'adapter.auth_failed':
    case 'adapter.error':
      return later.some((event) => event.type === 'adapter.selected');
    case 'sandbox.error':
      return later.some((event) => event.type === 'sandbox.started');
    case 'preview.failed':
      return later.some((event) => event.type === 'preview.ready');
    case 'deploy.setup_required':
    case 'deploy.config_invalid':
    case 'deploy.provider_failed':
    case 'deploy.migration_failed':
    case 'deploy.health_failed':
      return later.some((event) => event.type === 'deploy.hosted_ready');
    // sandbox.fallback persists (reduced trust); terminal run/ticket failures and
    // security audit events are never auto-resolved.
    case 'sandbox.fallback':
    case 'ticket.dead_lettered':
    case 'run.failed':
    case 'run.cancelled':
    case 'security.block':
    case 'security.command_rejected':
      return false;
    default:
      return false;
  }
}

function toActiveFailure(event: FactoryEvent, type: FailureEventType): ActiveFailure {
  const entry = lookupFailure(type);
  return {
    type,
    sequence: event.sequence,
    ticketId: event.ticketId,
    severity: event.severity,
    message: messageOf(event),
    blocking: entry?.blocking ?? true,
    retryable: entry?.retryable ?? false,
    rescueAction: entry?.rescueAction ?? 'No rescue action registered for this failure class.',
    runbook: entry?.runbook ?? 'docs/runbooks/failure-taxonomy.md',
  };
}

function computeBlockedDependencies(tickets: readonly TicketView[]): BlockedDependency[] {
  const byId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket]));
  const blocked: BlockedDependency[] = [];
  for (const ticket of tickets) {
    if (ticket.state === 'completed') {
      continue;
    }
    const blockedBy = ticket.dependsOn.filter((dep) => {
      const dependency = byId.get(dep);
      return dependency !== undefined && FAILED_DEP_STATES.has(dependency.state);
    });
    if (blockedBy.length > 0) {
      blocked.push({ ticketId: ticket.ticketId, state: ticket.state, blockedBy });
    }
  }
  return blocked;
}

/**
 * Compute per-run diagnostics from raw ledger entries. Tolerant of corrupt /
 * out-of-order / gappy logs — integrity problems become `projectionDiagnostics`.
 */
export function computeRunDiagnostics(
  raw: readonly unknown[],
  options: RunDiagnosticsOptions = {},
): RunDiagnosticsReport {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const runId = resolveTargetRunId(events, options.runId);
  const runEvents = runId === null ? [] : events.filter((event) => event.runId === runId);

  const projectionDiagnostics: ProjectionDiagnostic[] = [
    ...diagnostics.filter((diag) => diag.runId === undefined || diag.runId === runId),
    ...detectSequenceGaps(runEvents),
  ];

  const run = projectRun(raw, options.runId);
  const tickets = projectTickets(raw, options.runId).tickets;

  const activeFailures: ActiveFailure[] = [];
  for (let index = 0; index < runEvents.length; index += 1) {
    const event = runEvents[index];
    const entry = lookupFailure(event.type);
    if (entry === undefined) {
      continue;
    }
    const later = runEvents.slice(index + 1);
    if (!isResolved(event, later)) {
      activeFailures.push(toActiveFailure(event, entry.type));
    }
  }
  const blockingFailures = activeFailures.filter((failure) => failure.blocking);

  const blockedByFailedDependency = computeBlockedDependencies(tickets);
  const reducedTrust = runEvents.some((event) => event.type === 'sandbox.fallback');

  const inFlight = run.status === 'running' || run.status === 'planned' || run.status === 'created';
  const activeWorkers = tickets.filter((ticket) => ACTIVE_TICKET_STATES.has(ticket.state)).length;
  const remainingWork = tickets.some((ticket) => REMAINING_TICKET_STATES.has(ticket.state));
  const hasBlocker = blockingFailures.length > 0 || blockedByFailedDependency.length > 0;
  const stalled = inFlight && activeWorkers === 0 && remainingWork && hasBlocker;
  const stallReason = stalled
    ? blockedByFailedDependency.length > 0
      ? 'Tickets are blocked by a failed dependency and no worker is active.'
      : 'A blocking failure is unresolved and no worker is active.'
    : undefined;

  const healthy = blockingFailures.length === 0 && projectionDiagnostics.length === 0 && !stalled;

  return {
    runId,
    runStatus: run.status,
    projectionDiagnostics,
    activeFailures,
    blockingFailures,
    blockedByFailedDependency,
    stalled,
    stallReason,
    reducedTrust,
    healthy,
  };
}
