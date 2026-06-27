/**
 * Run projection plus the shared projection primitives reused by the ticket,
 * artifact, and operator projections.
 *
 * Projections are pure functions `events[] -> state`. They:
 *  - never invent state not present in events,
 *  - sort by sequence before folding (tolerating out-of-order reads),
 *  - are deterministic (replaying the same log yields identical output), and
 *  - surface explicit diagnostics for gaps / corrupt / unknown events rather
 *    than throwing.
 */
import { compareEventsBySequence, isFactoryEvent, isKnownEventType } from '../events/event-types';
import type {
  EventActor,
  EventEvidence,
  EventSeverity,
  EventSubject,
  FactoryEvent,
  FactoryEventType,
  ReviewMode,
} from '../events/event-types';

/* ----------------------------------------------------------------------------
 * Shared projection primitives
 * ------------------------------------------------------------------------- */

export type ProjectionDiagnosticCode =
  | 'sequence_gap'
  | 'duplicate_sequence'
  | 'corrupt_event'
  | 'unknown_event_type';

export interface ProjectionDiagnostic {
  readonly code: ProjectionDiagnosticCode;
  readonly message: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly detail?: string;
}

export interface PreparedEvents {
  /** Valid events, sorted ascending by sequence. */
  readonly events: FactoryEvent[];
  /** Diagnostics for entries that were corrupt or of an unknown type. */
  readonly diagnostics: ProjectionDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate raw entries, classify corrupt/unknown ones into diagnostics, and
 * return the valid events sorted by sequence. Never throws.
 */
export function validateAndSortEvents(raw: readonly unknown[]): PreparedEvents {
  const events: FactoryEvent[] = [];
  const diagnostics: ProjectionDiagnostic[] = [];

  for (const item of raw) {
    if (isFactoryEvent(item)) {
      events.push(item);
      continue;
    }
    const runId = isRecord(item) && typeof item.runId === 'string' ? item.runId : undefined;
    const sequence =
      isRecord(item) && typeof item.sequence === 'number' ? item.sequence : undefined;
    if (isRecord(item) && typeof item.type === 'string' && !isKnownEventType(item.type)) {
      diagnostics.push({
        code: 'unknown_event_type',
        message: `Unknown event type: ${item.type}`,
        runId,
        sequence,
        detail: item.type,
      });
    } else {
      diagnostics.push({
        code: 'corrupt_event',
        message: 'Encountered a corrupt or malformed event.',
        runId,
        sequence,
      });
    }
  }

  events.sort(compareEventsBySequence);
  return { events, diagnostics };
}

/**
 * Detect missing or duplicated per-run sequence numbers. Sequences are expected
 * to be contiguous starting at 1, matching the sequence allocator's contract.
 */
export function detectSequenceGaps(events: readonly FactoryEvent[]): ProjectionDiagnostic[] {
  const diagnostics: ProjectionDiagnostic[] = [];
  const byRun = new Map<string, number[]>();

  for (const event of events) {
    const list = byRun.get(event.runId) ?? [];
    list.push(event.sequence);
    byRun.set(event.runId, list);
  }

  for (const [runId, sequences] of byRun) {
    const sorted = [...sequences].sort((a, b) => a - b);
    const seen = new Set<number>();
    for (const sequence of sorted) {
      if (seen.has(sequence)) {
        diagnostics.push({
          code: 'duplicate_sequence',
          message: `Duplicate sequence ${sequence} in run ${runId}.`,
          runId,
          sequence,
        });
      }
      seen.add(sequence);
    }
    const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
    for (let expected = 1; expected <= max; expected += 1) {
      if (!seen.has(expected)) {
        diagnostics.push({
          code: 'sequence_gap',
          message: `Missing sequence ${expected} in run ${runId}.`,
          runId,
          sequence: expected,
        });
      }
    }
  }

  return diagnostics;
}

/** A single projected ledger row. Carries severity and evidence through. */
export interface LedgerRow {
  readonly sequence: number;
  readonly eventId: string;
  readonly runId: string;
  readonly ticketId?: string;
  readonly type: FactoryEventType;
  readonly severity: EventSeverity;
  readonly timestamp: number;
  readonly actor: EventActor;
  readonly subject: EventSubject;
  readonly evidence?: readonly EventEvidence[];
  /** A human-facing detail surfaced from the event's own payload (no invention). */
  readonly detail?: string;
}

function extractDetail(event: FactoryEvent): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ['reason', 'message', 'rationale', 'summary', 'action'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

export function toLedgerRow(event: FactoryEvent): LedgerRow {
  return {
    sequence: event.sequence,
    eventId: event.eventId,
    runId: event.runId,
    ticketId: event.ticketId,
    type: event.type,
    severity: event.severity,
    timestamp: event.timestamp,
    actor: event.actor,
    subject: event.subject,
    evidence: event.evidence,
    detail: extractDetail(event),
  };
}

/**
 * Resolve the run a projection should fold over: the explicit `runId`, else the
 * run of the earliest event, else `null`.
 */
export function resolveTargetRunId(events: readonly FactoryEvent[], runId?: string): string | null {
  if (runId !== undefined) {
    return runId;
  }
  return events.length > 0 ? events[0].runId : null;
}

/* ----------------------------------------------------------------------------
 * Run projection
 * ------------------------------------------------------------------------- */

export type RunStatus =
  | 'unknown'
  | 'created'
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SupervisorDecisionView {
  readonly sequence: number;
  readonly decision: string;
  readonly rationale: string;
  readonly confidence: number;
}

export interface RunProjection {
  readonly runId: string | null;
  readonly status: RunStatus;
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
  readonly plannedTicketCount?: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly failureReason?: string;
  readonly supervisorDecisions: SupervisorDecisionView[];
  readonly ledger: LedgerRow[];
  readonly lastSequence: number;
  readonly diagnostics: ProjectionDiagnostic[];
}

export function projectRun(raw: readonly unknown[], runId?: string): RunProjection {
  const { events, diagnostics } = validateAndSortEvents(raw);
  const targetRunId = resolveTargetRunId(events, runId);
  const runEvents = targetRunId === null ? [] : events.filter((e) => e.runId === targetRunId);
  diagnostics.push(...detectSequenceGaps(runEvents));

  const ledger: LedgerRow[] = [];
  const supervisorDecisions: SupervisorDecisionView[] = [];
  let status: RunStatus = 'unknown';
  let prompt: string | undefined;
  let prdRef: string | undefined;
  let requestedWorkerCap: number | undefined;
  let reviewMode: ReviewMode | undefined;
  let plannedTicketCount: number | undefined;
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let failureReason: string | undefined;
  let lastSequence = 0;

  for (const event of runEvents) {
    ledger.push(toLedgerRow(event));
    if (event.sequence > lastSequence) {
      lastSequence = event.sequence;
    }
    switch (event.type) {
      case 'run.created':
        status = 'created';
        prompt = event.payload.prompt ?? prompt;
        prdRef = event.payload.prdRef ?? prdRef;
        requestedWorkerCap = event.payload.requestedWorkerCap ?? requestedWorkerCap;
        reviewMode = event.payload.reviewMode ?? reviewMode;
        break;
      case 'run.planned':
        status = 'planned';
        plannedTicketCount = event.payload.ticketCount;
        break;
      case 'run.started':
        status = 'running';
        startedAt = event.timestamp;
        break;
      case 'run.completed':
        status = 'completed';
        completedAt = event.timestamp;
        break;
      case 'run.failed':
        status = 'failed';
        completedAt = event.timestamp;
        failureReason = event.payload.reason;
        break;
      case 'run.cancelled':
        status = 'cancelled';
        completedAt = event.timestamp;
        failureReason = event.payload.reason ?? failureReason;
        break;
      case 'supervisor.decision':
        supervisorDecisions.push({
          sequence: event.sequence,
          decision: event.payload.decision,
          rationale: event.payload.rationale,
          confidence: event.payload.confidence,
        });
        break;
      default:
        break;
    }
  }

  return {
    runId: targetRunId,
    status,
    prompt,
    prdRef,
    requestedWorkerCap,
    reviewMode,
    plannedTicketCount,
    startedAt,
    completedAt,
    failureReason,
    supervisorDecisions,
    ledger,
    lastSequence,
    diagnostics,
  };
}
