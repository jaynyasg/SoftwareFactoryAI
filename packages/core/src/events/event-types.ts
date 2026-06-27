/**
 * Versioned ledger event contract for the Software Factory.
 *
 * The append-only ledger is the single source of truth; every UI/CLI view is a
 * replayable projection of these events. The envelope is versioned for forward
 * compatibility, and events are modelled as a discriminated union on `type` so
 * payloads stay type-safe while the set of families remains extensible.
 */

/** Envelope schema version. Bump when the envelope shape changes incompatibly. */
export const EVENT_ENVELOPE_VERSION = 1 as const;

/** Severity ladder used for ledger styling and operator alerting. */
export type EventSeverity = 'info' | 'success' | 'warn' | 'error' | 'critical';

/** Risk tier carried by review-related events. */
export type RiskTier = 'low' | 'medium' | 'high';

/** Whether a run defaults to human gating or may run autonomously. */
export type ReviewMode = 'human' | 'autonomous';

/** Outcome of a human/auto review decision. */
export type ReviewDecision = 'approved' | 'rejected';

/** Operator health-sample status. */
export type HealthStatus = 'ok' | 'degraded' | 'down';

/** Lifecycle states a ticket can occupy (also referenced by ticket payloads). */
export type TicketState =
  | 'created'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'dead_lettered'
  | 'cancelled';

/** The kind of producer that emitted an event. */
export type ActorKind =
  | 'system'
  | 'supervisor'
  | 'worker'
  | 'operator'
  | 'adapter'
  | 'sandbox'
  | 'gate'
  | 'deploy'
  | 'genome';

/** Who/what produced the event. */
export interface EventActor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly display?: string;
}

/** The entity acted on. `version` enables stale-command / optimistic checks. */
export interface EventSubject {
  readonly kind: string;
  readonly id: string;
  readonly version?: number;
}

/** A link or reference attached as evidence (logs, diffs, hashes, URLs). */
export interface EventEvidence {
  readonly label: string;
  readonly href?: string;
  readonly ref?: string;
  readonly digest?: string;
  readonly note?: string;
}

/** Payload for event types that carry no extra data. */
export type EmptyPayload = Record<string, never>;

/* ----------------------------------------------------------------------------
 * Payloads by family
 * ------------------------------------------------------------------------- */

/** Agent family that initiated a run (e.g. via the CLI `--caller-family` flag). */
export type CallerFamily = 'claude' | 'codex' | 'api';

// run
export interface RunCreatedPayload {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly title?: string;
  readonly localFolder?: string;
  readonly githubRepo?: string;
  readonly selectedAdapter?: string;
  readonly modelProfile?: string;
  readonly reasoningEffort?: string;
  readonly requestedWorkerCap?: number;
  readonly reviewMode?: ReviewMode;
  /**
   * The agent family that initiated the run (CLI/skill `--caller-family`).
   * Recorded as nested-agent provenance so the worker runner can later detect a
   * nested execution when the selected adapter family matches this caller.
   */
  readonly callerFamily?: CallerFamily;
}
export interface RunPlannedPayload {
  readonly ticketCount: number;
}
export interface RunCompletedPayload {
  readonly summary?: string;
}
export interface RunFailedPayload {
  readonly reason: string;
}
export interface RunCancelledPayload {
  readonly reason?: string;
}

// supervisor
export interface SupervisorDecisionPayload {
  readonly decision: string;
  readonly rationale: string;
  readonly confidence: number;
}

// ticket
export interface TicketCreatedPayload {
  readonly title: string;
  readonly moduleId?: string;
  readonly dependsOn?: readonly string[];
  readonly riskTier?: RiskTier;
}
export interface TicketStateChangedPayload {
  readonly state: TicketState;
  readonly previousState?: TicketState;
  readonly reason?: string;
}
export interface TicketDeadLetteredPayload {
  readonly reason: string;
}

// worker
export interface WorkerStartedPayload {
  readonly adapterId?: string;
}
export interface WorkerProgressPayload {
  readonly message: string;
  readonly percent?: number;
}
export interface WorkerRetryPayload {
  readonly attempt: number;
  readonly reason: string;
}
export interface WorkerCompletedPayload {
  readonly summary?: string;
}
export interface WorkerFailedPayload {
  readonly reason: string;
}
export interface WorkerCancelledPayload {
  readonly reason?: string;
}

// adapter
export interface AdapterSelectedPayload {
  readonly adapterId: string;
  readonly family?: string;
}
export interface AdapterSetupRequiredPayload {
  readonly action: string;
  readonly reason?: string;
}
export interface AdapterAuthFailedPayload {
  readonly reason: string;
}
export interface AdapterCapacityChangedPayload {
  readonly capacity: number;
  readonly previousCapacity?: number;
  readonly reason?: string;
}
export interface AdapterErrorPayload {
  readonly reason: string;
}

// sandbox
export interface SandboxStartedPayload {
  readonly mode: string;
}
export interface SandboxFallbackPayload {
  readonly reason: string;
  readonly reducedTrust: true;
}
export interface SandboxErrorPayload {
  readonly reason: string;
}

// gate
export interface GateStartedPayload {
  readonly gate: string;
}
export interface GatePassedPayload {
  readonly gate: string;
  readonly summary?: string;
}
export interface GateFailedPayload {
  readonly gate: string;
  readonly reason: string;
}

// review
export interface ReviewRequestedPayload {
  readonly riskTier: RiskTier;
  readonly summary?: string;
}
export interface ReviewDecidedPayload {
  readonly riskTier: RiskTier;
  readonly decision: ReviewDecision;
  readonly rationale?: string;
}

// preview
export interface PreviewReadyPayload {
  readonly url: string;
}
export interface PreviewFailedPayload {
  readonly reason: string;
}

// artifact
export interface ArtifactCreatedPayload {
  readonly artifactId: string;
  readonly kind: string;
  readonly path?: string;
}
export interface ArtifactConfidenceComputedPayload {
  readonly artifactId: string;
  readonly confidence: number;
  readonly factors?: Readonly<Record<string, number>>;
}

// package
export interface PackageCreatedPayload {
  readonly repoPath?: string;
  readonly handoffRef?: string;
  readonly summary?: string;
}

// deploy
export interface DeploySetupRequiredPayload {
  readonly action: string;
}
export interface DeployConfigInvalidPayload {
  readonly reason: string;
}
export interface DeployProviderFailedPayload {
  readonly reason: string;
}
export interface DeployMigrationFailedPayload {
  readonly reason: string;
}
export interface DeployHealthFailedPayload {
  readonly reason: string;
}
export interface DeployHostedReadyPayload {
  readonly url: string;
}

// security
export interface SecurityBlockPayload {
  readonly reason: string;
}
export interface SecurityCommandRejectedPayload {
  readonly reason: string;
  readonly command?: string;
}

// genome
export interface GenomeModuleSelectedPayload {
  readonly moduleId: string;
  readonly version?: string;
}

// operator / health
export interface OperatorHealthSamplePayload {
  readonly metric: string;
  readonly value: number;
  readonly unit?: string;
  readonly status?: HealthStatus;
}

/**
 * Maps every event `type` discriminant to its payload type. This is the single
 * registry that downstream unions, guards, and the exhaustiveness check derive
 * from.
 */
export interface EventPayloadMap {
  'run.created': RunCreatedPayload;
  'run.planned': RunPlannedPayload;
  'run.started': EmptyPayload;
  'run.completed': RunCompletedPayload;
  'run.failed': RunFailedPayload;
  'run.cancelled': RunCancelledPayload;
  'supervisor.decision': SupervisorDecisionPayload;
  'ticket.created': TicketCreatedPayload;
  'ticket.queued': EmptyPayload;
  'ticket.state_changed': TicketStateChangedPayload;
  'ticket.dead_lettered': TicketDeadLetteredPayload;
  'worker.started': WorkerStartedPayload;
  'worker.progress': WorkerProgressPayload;
  'worker.retry': WorkerRetryPayload;
  'worker.completed': WorkerCompletedPayload;
  'worker.failed': WorkerFailedPayload;
  'worker.cancelled': WorkerCancelledPayload;
  'adapter.selected': AdapterSelectedPayload;
  'adapter.setup_required': AdapterSetupRequiredPayload;
  'adapter.auth_failed': AdapterAuthFailedPayload;
  'adapter.capacity_changed': AdapterCapacityChangedPayload;
  'adapter.error': AdapterErrorPayload;
  'sandbox.started': SandboxStartedPayload;
  'sandbox.fallback': SandboxFallbackPayload;
  'sandbox.error': SandboxErrorPayload;
  'gate.started': GateStartedPayload;
  'gate.passed': GatePassedPayload;
  'gate.failed': GateFailedPayload;
  'review.requested': ReviewRequestedPayload;
  'review.decided': ReviewDecidedPayload;
  'preview.starting': EmptyPayload;
  'preview.health_pending': EmptyPayload;
  'preview.ready': PreviewReadyPayload;
  'preview.failed': PreviewFailedPayload;
  'artifact.created': ArtifactCreatedPayload;
  'artifact.confidence_computed': ArtifactConfidenceComputedPayload;
  'package.created': PackageCreatedPayload;
  'deploy.setup_required': DeploySetupRequiredPayload;
  'deploy.config_invalid': DeployConfigInvalidPayload;
  'deploy.provider_failed': DeployProviderFailedPayload;
  'deploy.migration_failed': DeployMigrationFailedPayload;
  'deploy.health_pending': EmptyPayload;
  'deploy.health_failed': DeployHealthFailedPayload;
  'deploy.hosted_ready': DeployHostedReadyPayload;
  'security.block': SecurityBlockPayload;
  'security.command_rejected': SecurityCommandRejectedPayload;
  'genome.module_selected': GenomeModuleSelectedPayload;
  'operator.health_sample': OperatorHealthSamplePayload;
}

/** Union of every known event `type` discriminant. */
export type FactoryEventType = keyof EventPayloadMap;

/**
 * The versioned event envelope. Generic so the discriminated union can bind a
 * concrete `type` to its payload; the defaults give a loose form for code that
 * handles arbitrary events.
 */
export interface EventEnvelope<
  TType extends FactoryEventType = FactoryEventType,
  TPayload = EventPayloadMap[TType],
> {
  readonly version: number;
  readonly eventId: string;
  readonly runId: string;
  readonly ticketId?: string;
  readonly actor: EventActor;
  readonly subject: EventSubject;
  readonly type: TType;
  readonly sequence: number;
  readonly timestamp: number;
  readonly severity: EventSeverity;
  readonly evidence?: readonly EventEvidence[];
  readonly idempotencyKey?: string;
  readonly payload: TPayload;
}

type EnvelopeByType = { [K in FactoryEventType]: EventEnvelope<K, EventPayloadMap[K]> };

/** Discriminated union of all concrete, fully-formed events. */
export type FactoryEvent = EnvelopeByType[FactoryEventType];

type AppendableByType = {
  [K in FactoryEventType]: Omit<
    EventEnvelope<K, EventPayloadMap[K]>,
    'version' | 'eventId' | 'sequence' | 'timestamp'
  > & {
    /** Optional explicit id; the store generates one when omitted. */
    readonly eventId?: string;
    /** Optional explicit timestamp; the store stamps one via its clock. */
    readonly timestamp?: number;
  };
};

/**
 * Shape callers pass to `EventStore.append`. The store assigns `version` and
 * the monotonic `sequence`, and fills `eventId`/`timestamp` when omitted.
 */
export type AppendableEvent = AppendableByType[FactoryEventType];

/** Every known event type, in a stable order. */
export const EVENT_TYPES = [
  'run.created',
  'run.planned',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'supervisor.decision',
  'ticket.created',
  'ticket.queued',
  'ticket.state_changed',
  'ticket.dead_lettered',
  'worker.started',
  'worker.progress',
  'worker.retry',
  'worker.completed',
  'worker.failed',
  'worker.cancelled',
  'adapter.selected',
  'adapter.setup_required',
  'adapter.auth_failed',
  'adapter.capacity_changed',
  'adapter.error',
  'sandbox.started',
  'sandbox.fallback',
  'sandbox.error',
  'gate.started',
  'gate.passed',
  'gate.failed',
  'review.requested',
  'review.decided',
  'preview.starting',
  'preview.health_pending',
  'preview.ready',
  'preview.failed',
  'artifact.created',
  'artifact.confidence_computed',
  'package.created',
  'deploy.setup_required',
  'deploy.config_invalid',
  'deploy.provider_failed',
  'deploy.migration_failed',
  'deploy.health_pending',
  'deploy.health_failed',
  'deploy.hosted_ready',
  'security.block',
  'security.command_rejected',
  'genome.module_selected',
  'operator.health_sample',
] as const satisfies readonly FactoryEventType[];

// Compile-time guarantee that EVENT_TYPES covers every key of EventPayloadMap.
type UncoveredEventType = Exclude<FactoryEventType, (typeof EVENT_TYPES)[number]>;
const _eventTypesAreExhaustive: UncoveredEventType extends never ? true : UncoveredEventType = true;

const KNOWN_EVENT_TYPES = new Set<string>(EVENT_TYPES);
const SEVERITIES: readonly EventSeverity[] = ['info', 'success', 'warn', 'error', 'critical'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSeverity(value: unknown): value is EventSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

function isActor(value: unknown): value is EventActor {
  return isRecord(value) && typeof value.kind === 'string' && typeof value.id === 'string';
}

function isSubject(value: unknown): value is EventSubject {
  return isRecord(value) && typeof value.kind === 'string' && typeof value.id === 'string';
}

/** Type guard for the `type` discriminant. */
export function isKnownEventType(value: unknown): value is FactoryEventType {
  return typeof value === 'string' && KNOWN_EVENT_TYPES.has(value);
}

/**
 * Structural guard for a fully-formed event. Validates the envelope shape (not
 * deep payload schemas, which producers own) so corrupt/unknown reads can be
 * surfaced as projection diagnostics rather than thrown.
 */
export function isFactoryEvent(value: unknown): value is FactoryEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.version === 'number' &&
    typeof value.eventId === 'string' &&
    value.eventId.length > 0 &&
    typeof value.runId === 'string' &&
    value.runId.length > 0 &&
    isKnownEventType(value.type) &&
    typeof value.sequence === 'number' &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    isSeverity(value.severity) &&
    isActor(value.actor) &&
    isSubject(value.subject) &&
    isRecord(value.payload) &&
    (value.ticketId === undefined || typeof value.ticketId === 'string') &&
    (value.idempotencyKey === undefined || typeof value.idempotencyKey === 'string')
  );
}

/** Stable comparator: ascending by sequence, tie-broken by eventId. */
export function compareEventsBySequence(a: FactoryEvent, b: FactoryEvent): number {
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  if (a.eventId < b.eventId) {
    return -1;
  }
  if (a.eventId > b.eventId) {
    return 1;
  }
  return 0;
}
