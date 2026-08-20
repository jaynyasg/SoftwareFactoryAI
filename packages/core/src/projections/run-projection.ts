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
import {
  compareEventsBySequence,
  isFactoryEvent,
  isKnownEventType,
  runModeRequestsStart,
} from '../events/event-types';
import type {
  CallerFamily,
  ContractGeneratedPayload,
  EventActor,
  EventEvidence,
  EventSeverity,
  EventSubject,
  FactoryEvent,
  FactoryEventType,
  ReviewMode,
  RunMode,
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
  // `statement`/`question`/`objective` carry the human-facing detail for
  // research events; they exist on no other payloads, so this stays additive.
  for (const key of [
    'reason',
    'message',
    'rationale',
    'summary',
    'action',
    'statement',
    'question',
    'objective',
  ] as const) {
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

/**
 * Projected execution state (full-factory U3 seam, realized by U5).
 *
 * Derived ONLY from recorded events — never invented:
 *  - `not_requested` — the run never asked for execution (plan-only /
 *    research-and-plan, or a pre-U3 ledger without a mode) and no execution
 *    command touched it.
 *  - `pending`       — a start was requested (mode `research-plan-and-start`)
 *    but no execution/queue events exist yet (e.g. execution controls are
 *    disabled on this instance, or a pre-U5 ledger).
 *  - `queued`        — a `queue.enqueued` run-execution job is awaiting the
 *    execution daemon (or was requeued for a safe restart resume).
 *  - `started`       — execution is running (`run.started` / resumed).
 *  - `paused`        — the operator paused execution; no new worker starts.
 *  - `blocked`       — preflight failed, execution blocked, or a queue lease
 *    was abandoned; an operator intervention is required to proceed.
 *  - `completed`     — `execution.completed` was recorded.
 *  - `failed`        — `execution.failed` was recorded.
 *  - `cancelled`     — the run was cancelled after execution activity began.
 *  - `unavailable`   — a start was requested but the run failed or was
 *    cancelled before any execution activity, so execution cannot proceed.
 */
export type RunExecutionState =
  | 'not_requested'
  | 'pending'
  | 'queued'
  | 'started'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unavailable';

/** The latest projected build contract (from `contract.generated`). */
export interface BuildContractView extends ContractGeneratedPayload {
  readonly sequence: number;
  readonly generatedAt: number;
}

export interface RunProjection {
  readonly runId: string | null;
  readonly status: RunStatus;
  readonly prompt?: string;
  /** Human-facing run title from the `run.created` payload, when provided. */
  readonly title?: string;
  readonly prdRef?: string;
  readonly prdText?: string;
  readonly localFolder?: string;
  readonly githubRepo?: string;
  readonly selectedAdapter?: string;
  readonly modelProfile?: string;
  readonly reasoningEffort?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
  /** Agent family that initiated the run (from the `run.created` payload). */
  readonly callerFamily?: CallerFamily;
  /** Requested run mode (from the `run.created` payload); absent = plan-only. */
  readonly mode?: RunMode;
  /**
   * Owning account (multi-user). Absent on legacy/single-tenant ledgers —
   * those runs are ADMIN-OWNED by definition (migration G5).
   */
  readonly ownerId?: string;
  /** Explicit execution state — see `RunExecutionState` (realized in U5). */
  readonly executionState: RunExecutionState;
  /** Human-facing reason for a blocked/failed/paused execution state. */
  readonly executionReason?: string;
  /** Latest build contract, when `contract.generated` exists on the ledger. */
  readonly buildContract?: BuildContractView;
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
  let title: string | undefined;
  let prdRef: string | undefined;
  let prdText: string | undefined;
  let localFolder: string | undefined;
  let githubRepo: string | undefined;
  let selectedAdapter: string | undefined;
  let modelProfile: string | undefined;
  let reasoningEffort: string | undefined;
  let requestedWorkerCap: number | undefined;
  let reviewMode: ReviewMode | undefined;
  let callerFamily: CallerFamily | undefined;
  let ownerId: string | undefined;
  let mode: RunMode | undefined;
  let buildContract: BuildContractView | undefined;
  let plannedTicketCount: number | undefined;
  let startedAt: number | undefined;
  let completedAt: number | undefined;
  let failureReason: string | undefined;
  let lastSequence = 0;
  // Execution fold (U5): derived exclusively from recorded execution/queue/
  // preflight events. `undefined` means no execution activity was recorded.
  let executionFold: RunExecutionState | undefined;
  let executionReason: string | undefined;

  for (const event of runEvents) {
    ledger.push(toLedgerRow(event));
    if (event.sequence > lastSequence) {
      lastSequence = event.sequence;
    }
    switch (event.type) {
      case 'run.created':
        status = 'created';
        prompt = event.payload.prompt ?? prompt;
        title = event.payload.title ?? title;
        prdRef = event.payload.prdRef ?? prdRef;
        prdText = event.payload.prdText ?? prdText;
        localFolder = event.payload.localFolder ?? localFolder;
        githubRepo = event.payload.githubRepo ?? githubRepo;
        selectedAdapter = event.payload.selectedAdapter ?? selectedAdapter;
        modelProfile = event.payload.modelProfile ?? modelProfile;
        reasoningEffort = event.payload.reasoningEffort ?? reasoningEffort;
        requestedWorkerCap = event.payload.requestedWorkerCap ?? requestedWorkerCap;
        reviewMode = event.payload.reviewMode ?? reviewMode;
        callerFamily = event.payload.callerFamily ?? callerFamily;
        mode = event.payload.mode ?? mode;
        ownerId = event.payload.ownerId ?? ownerId;
        break;
      case 'run.settings_overridden':
        // Mid-run operator course-change: the LATEST override wins for every
        // ticket that has not executed yet; completed tickets keep the
        // evidence they were recorded with.
        selectedAdapter = event.payload.selectedAdapter ?? selectedAdapter;
        modelProfile = event.payload.modelProfile ?? modelProfile;
        reasoningEffort = event.payload.reasoningEffort ?? reasoningEffort;
        break;
      case 'run.planned':
        status = 'planned';
        plannedTicketCount = event.payload.ticketCount;
        break;
      case 'contract.generated':
        // Latest contract wins; older contracts remain replayable in the ledger.
        buildContract = {
          ...event.payload,
          sequence: event.sequence,
          generatedAt: event.timestamp,
        };
        break;
      case 'run.started':
        // Cancellation is TERMINAL: a late `run.started` (e.g. a duplicate
        // daemon claim racing a cancel) never revives a cancelled run.
        if (status === 'cancelled') {
          break;
        }
        status = 'running';
        startedAt = event.timestamp;
        executionFold = 'started';
        executionReason = undefined;
        break;
      case 'run.completed':
        // Cancellation is TERMINAL: a later `run.completed` (e.g. a post-run
        // gate stage finishing while the cancel landed) never flips the
        // status or the execution state back to completed.
        if (status === 'cancelled') {
          break;
        }
        status = 'completed';
        completedAt = event.timestamp;
        // A completed run completes its execution lifecycle too (e.g. a
        // gate-rerun job finishing a previously gate-blocked run — U7). Only
        // when execution activity exists; plan-only ledgers stay untouched.
        if (executionFold !== undefined) {
          executionFold = 'completed';
          executionReason = undefined;
        }
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
        // Cancel propagates to execution only when execution activity exists;
        // otherwise the legacy post-fold `unavailable` derivation applies.
        if (executionFold !== undefined) {
          executionFold = 'cancelled';
          executionReason = event.payload.reason ?? executionReason;
        }
        break;
      case 'queue.enqueued':
        if (event.payload.jobKind === 'run-execution' && executionFold !== 'paused') {
          // A requeue of safely-yielded work while the run is PAUSED is resume
          // bookkeeping, not an un-pause: the operator's pause holds until an
          // explicit `execution.resumed` (U6 pause-yield-requeue path).
          executionFold = 'queued';
          executionReason = event.payload.reason;
        }
        break;
      case 'queue.released':
        if (event.payload.jobKind === 'run-execution') {
          // Terminal outcomes are also carried by execution.* events; folding
          // the release keeps the state honest even if one write was lost.
          switch (event.payload.outcome) {
            case 'completed':
              executionFold = 'completed';
              break;
            case 'failed':
              executionFold = 'failed';
              executionReason = event.payload.reason ?? executionReason;
              break;
            case 'blocked':
              executionFold = 'blocked';
              executionReason = event.payload.reason ?? executionReason;
              break;
            case 'cancelled':
              executionFold = 'cancelled';
              executionReason = event.payload.reason ?? executionReason;
              break;
            case 'requeued':
              // See `queue.enqueued`: a requeue never overrides a live pause.
              if (executionFold !== 'paused') {
                executionFold = 'queued';
                executionReason = event.payload.reason;
              }
              break;
            default: {
              // Exhaustiveness: adding a QueueReleaseOutcome member must fail
              // compile here until this fold handles it.
              const exhaustive: never = event.payload.outcome;
              void exhaustive;
              break;
            }
          }
        }
        break;
      case 'queue.lease_abandoned':
        if (event.payload.jobKind === 'run-execution') {
          executionFold = 'blocked';
          executionReason = event.payload.reason;
        }
        break;
      case 'execution.paused':
        executionFold = 'paused';
        executionReason = event.payload.reason;
        break;
      case 'execution.resumed':
        executionFold = 'started';
        executionReason = undefined;
        break;
      case 'execution.blocked':
        executionFold = 'blocked';
        executionReason = event.payload.reason;
        break;
      case 'execution.completed':
        executionFold = 'completed';
        executionReason = undefined;
        break;
      case 'execution.failed':
        executionFold = 'failed';
        executionReason = event.payload.reason;
        break;
      case 'preflight.failed':
        executionFold = 'blocked';
        executionReason = event.payload.reason;
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

  // Derive the explicit execution state from recorded events only. When queue/
  // execution events exist the fold wins; otherwise the U3 intent semantics
  // apply: `pending` is an honest "start requested, no execution activity yet"
  // state — never a claim that anything is running.
  let executionState: RunExecutionState = 'not_requested';
  if (executionFold !== undefined) {
    executionState = executionFold;
  } else if (startedAt !== undefined) {
    executionState = 'started';
  } else if (mode !== undefined && runModeRequestsStart(mode)) {
    executionState = status === 'failed' || status === 'cancelled' ? 'unavailable' : 'pending';
  }

  return {
    runId: targetRunId,
    status,
    prompt,
    title,
    prdRef,
    prdText,
    localFolder,
    githubRepo,
    selectedAdapter,
    modelProfile,
    reasoningEffort,
    requestedWorkerCap,
    reviewMode,
    callerFamily,
    mode,
    ownerId,
    executionState,
    executionReason,
    buildContract,
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

/**
 * Whether a projected run is a REAL run rather than a phantom. A phantom is a
 * runId that never reached `run.created` — e.g. one minted only by a guard
 * denial (a lone security event) or with an empty ledger — so its status stays
 * the initial `unknown`. Run lists use this to avoid surfacing such entries.
 */
export function isRealRun(run: RunProjection): boolean {
  return run.ledger.length > 0 && run.status !== 'unknown';
}
