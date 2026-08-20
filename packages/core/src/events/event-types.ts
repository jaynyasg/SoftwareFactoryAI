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
  | 'genome'
  | 'researcher'
  | 'workspace';

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

/**
 * How far a run is allowed to progress at creation time (full-factory U3):
 *  - `plan-only`               — current V1 behavior: blueprint (ticket DAG) only.
 *  - `plan-and-start`          — plan (no research pass), then a recorded
 *                                request to start execution: one operator
 *                                action carries the run from prompt to running
 *                                workers. This is the web UI's "Start run".
 *  - `research-and-plan`       — bounded research runs BEFORE planning; the
 *                                enriched brief feeds the supervisor planner and
 *                                a build contract is generated after planning.
 *  - `research-plan-and-start` — everything above, plus a recorded request to
 *                                start execution. Execution controls (queue/
 *                                daemon) are U5; until they exist the run
 *                                projects an explicit execution-pending state
 *                                rather than pretending to start.
 */
export const RUN_MODES = [
  'plan-only',
  'plan-and-start',
  'research-and-plan',
  'research-plan-and-start',
] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** Modes that carry a recorded request to start execution after planning. */
export const START_REQUESTING_RUN_MODES: readonly RunMode[] = [
  'plan-and-start',
  'research-plan-and-start',
];

/** Whether this mode asks execution to start once planning succeeds. */
export function runModeRequestsStart(mode: RunMode): boolean {
  return START_REQUESTING_RUN_MODES.includes(mode);
}

/** The default run mode: planning-only stays the safe V1 default. */
export const DEFAULT_RUN_MODE: RunMode = 'plan-only';

/** Type guard for a run mode value. */
export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

// run
export interface RunCreatedPayload {
  readonly prompt?: string;
  readonly prdRef?: string;
  readonly prdText?: string;
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
  /**
   * Requested run mode (full-factory U3). Absent on pre-U3 ledgers, which is
   * equivalent to the `plan-only` default. Recording the mode here is the U5
   * seam: `research-plan-and-start` is a durable start REQUEST that the future
   * execution controls (U5 queue/daemon) will act on.
   */
  readonly mode?: RunMode;
}
/**
 * Mid-run operator override of run settings (model/effort). Append-only and
 * replay-honest: the projection applies the LATEST override, so tickets that
 * already executed keep their recorded evidence while every ticket that has
 * not started yet picks up the new model on its next execution attempt.
 */
export interface RunSettingsOverriddenPayload {
  /** New adapter for not-yet-executed tickets (e.g. usage-pool failover). */
  readonly selectedAdapter?: string;
  readonly modelProfile?: string;
  readonly reasoningEffort?: string;
  /** Why the operator changed course (e.g. "usage window exhausted"). */
  readonly reason?: string;
}
export interface RunPlannedPayload {
  readonly ticketCount: number;
  /**
   * Research findings (by `findingId`) that influenced this plan/DAG, when the
   * run was planned from an enriched research brief (full-factory U3).
   */
  readonly influencingFindingIds?: readonly string[];
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

// research
/**
 * The class of source a research event refers to. Source-agnostic by design:
 * later providers can plug in web search, documentation fetch, repo scans,
 * uploaded PRDs, or model-generated synthesis behind the same event shapes.
 * `other` keeps the family open to future provider classes.
 */
export type ResearchSourceKind =
  | 'web_search'
  | 'documentation'
  | 'repo_scan'
  | 'local_folder'
  | 'uploaded_prd'
  | 'model_synthesis'
  | 'other';

/**
 * How a recorded finding is grounded. Assumptions and unresolved gaps are their
 * own event families (`research.assumption_recorded` / `research.gap_recorded`),
 * so findings only distinguish source-verified facts from model inference.
 */
export type ResearchFindingClassification = 'verified_fact' | 'inference';

/** Bounds requested for a research pass (enforced by the U2 research runner). */
export interface ResearchBudget {
  readonly maxSources?: number;
  readonly maxDurationMs?: number;
}

export interface ResearchRequestedPayload {
  readonly objective: string;
  readonly requestedSources?: readonly ResearchSourceKind[];
  readonly budget?: ResearchBudget;
}
export interface ResearchSourceFoundPayload {
  readonly sourceId: string;
  readonly kind: ResearchSourceKind;
  readonly title?: string;
  /** Source-agnostic locator: URL, repo path, doc ref, or upload reference. */
  readonly locator?: string;
  readonly summary?: string;
}
export interface ResearchSourceReadPayload {
  readonly sourceId: string;
  readonly summary?: string;
  /** Content digest of what was read, for provenance/staleness checks. */
  readonly contentDigest?: string;
}
export interface ResearchFindingRecordedPayload {
  readonly findingId: string;
  readonly statement: string;
  readonly classification: ResearchFindingClassification;
  /** Producer confidence in the finding, 0..1. */
  readonly confidence?: number;
  /** Sources (by `sourceId`) backing this finding. */
  readonly sourceIds?: readonly string[];
  /** A previously recorded gap this finding answers, if any. */
  readonly resolvesGapId?: string;
}
export interface ResearchAssumptionRecordedPayload {
  readonly assumptionId: string;
  readonly statement: string;
  readonly reason?: string;
  readonly sourceIds?: readonly string[];
}
export interface ResearchGapRecordedPayload {
  readonly gapId: string;
  /** The open question that could not be answered from available sources. */
  readonly question: string;
  readonly impact?: string;
  /** Whether the gap should block execution-capable run modes. */
  readonly blocking?: boolean;
}
export interface ResearchBriefCompletedPayload {
  readonly summary: string;
  /** Reference to the full enriched-brief artifact, when one is produced. */
  readonly briefRef?: string;
}
export interface ResearchFailedPayload {
  readonly reason: string;
}

// knowledge (lightweight reusable knowledge index)
/** What a reusable knowledge entry captures. */
export type KnowledgeEntryKind =
  | 'source'
  | 'finding'
  | 'repo_fact'
  | 'gate_lesson'
  | 'run_reference';

/**
 * Redaction/privacy class for a knowledge entry. `sensitive` entries are
 * excluded from normal knowledge queries unless a caller explicitly opts in;
 * redaction (via `knowledge.entry_redacted`) excludes an entry unconditionally.
 */
export type KnowledgeSensitivity = 'public' | 'internal' | 'sensitive';

export interface KnowledgeEntryRecordedPayload {
  readonly entryId: string;
  readonly kind: KnowledgeEntryKind;
  readonly title: string;
  readonly body: string;
  /** Producer confidence in the entry, 0..1. Required so reuse is never blind. */
  readonly confidence: number;
  /** Privacy class. Required so sensitive context is never silently reused. */
  readonly sensitivity: KnowledgeSensitivity;
  readonly tags?: readonly string[];
  /** Source-agnostic locator for `source` entries (URL, path, ref). */
  readonly locator?: string;
  /** The run whose work produced this entry (defaults to the envelope run). */
  readonly sourceRunId?: string;
  /** Ledger events (by `eventId`) evidencing this entry. */
  readonly sourceEventIds?: readonly string[];
  /** Epoch ms after which the entry is stale and must not be silently reused. */
  readonly freshUntil?: number;
  /** Epoch ms after which retention expires and queries must not return it. */
  readonly retainUntil?: number;
}
export interface KnowledgeEntryRedactedPayload {
  readonly entryId: string;
  readonly reason: string;
}
export interface KnowledgeEntryRetiredPayload {
  readonly entryId: string;
  readonly reason?: string;
}

// supervisor
export interface SupervisorDecisionPayload {
  readonly decision: string;
  readonly rationale: string;
  readonly confidence: number;
}

// contract (build contract, full-factory U3 / CEO expansion X3)
/**
 * The build contract generated after research + planning (X3). It summarizes
 * what execution would do BEFORE any worker mutates files: scope, workspace,
 * write boundaries, risks, gate expectations, deploy target, completion
 * criteria, and the operator approvals required before execution.
 *
 * Emission is idempotent on `contractDigest` (a digest of the contract
 * content), so re-emitting appends a new event ONLY when the underlying
 * research or plan actually changed; projections take the latest contract.
 */
export interface ContractGeneratedPayload {
  /** Digest of the contract content; stable unless research/plan changes. */
  readonly contractDigest: string;
  /** What the run will build (title + planned ticket summary). */
  readonly scope: string;
  /** The workspace execution would run in (or an explicit "not bound yet"). */
  readonly workspace: string;
  /** Where workers are allowed to write. */
  readonly writeBoundaries: readonly string[];
  /** Elevated-risk tickets and blocking research gaps. */
  readonly risks: readonly string[];
  /** Quality gates the run is expected to pass. */
  readonly gateExpectations: readonly string[];
  /** Deploy target, or an explicit "none". */
  readonly deployTarget: string;
  /** What "done" means for this run. */
  readonly completionCriteria: readonly string[];
  /** Operator approvals required before execution may start. */
  readonly operatorApprovals: readonly string[];
  /** Whether completed research findings informed this contract. */
  readonly researchBacked: boolean;
  /** Research findings (by `findingId`) that influenced the plan/DAG. */
  readonly influencingFindingIds: readonly string[];
}

// workspace (materialization, full-factory U4)
/**
 * Which source input a workspace materialization refers to. `none` covers runs
 * that supplied no source workspace at all (prompt/PRD-only runs receive a
 * fresh generated workspace when execution starts — U5/U6).
 */
export type WorkspaceSourceKind = 'local_folder' | 'github_repo' | 'none';

/**
 * The recorded dirty-state policy for a materialized workspace:
 *  - `allow_dirty`     — execution may proceed on a folder with uncommitted or
 *    untracked changes (the operator explicitly chose the folder),
 *  - `reject_dirty`    — execution must refuse a dirty workspace,
 *  - `clean_checkout`  — the workspace is a fresh repository checkout and is
 *    clean by construction.
 * U4 records the policy as evidence; enforcement at execution time is U5/U6.
 */
export type DirtyStatePolicy = 'allow_dirty' | 'reject_dirty' | 'clean_checkout';

/** Which local rule admitted an operator-supplied folder. */
export type WorkspaceLocalBoundary = 'working_boundary' | 'operator_folder';

export interface WorkspaceLocalBoundPayload {
  /** Resolved absolute path bound as the run workspace. */
  readonly path: string;
  /** The operator-supplied path exactly as requested. */
  readonly requestedPath: string;
  /** Which rule admitted the folder (approved boundary vs explicit folder). */
  readonly boundary: WorkspaceLocalBoundary;
  /** The approving boundary root the path resolved inside. */
  readonly boundaryRoot: string;
  readonly dirtyStatePolicy: DirtyStatePolicy;
}
export interface WorkspaceCheckoutStartedPayload {
  /** Repository reference, e.g. `owner/repo`. NEVER a credentialed URL. */
  readonly repo: string;
  readonly requestedBranch?: string;
  /** Where the checkout is being materialized. */
  readonly checkoutPath: string;
  /** 1-based materialization attempt (retries increment it). */
  readonly attempt: number;
}
export interface WorkspaceRefResolvedPayload {
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
}
/** A completed run's checkout was published back to its GitHub remote. */
export interface WorkspacePublishedPayload {
  readonly repo: string;
  readonly branch: string;
  readonly commit?: string;
  readonly pushed: boolean;
  readonly note?: string;
}
export interface WorkspaceCheckoutCompletedPayload {
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly checkoutPath: string;
  readonly dirtyStatePolicy: DirtyStatePolicy;
}
export interface WorkspaceCheckoutFailedPayload {
  /** Sanitized failure reason — credential values must never appear here. */
  readonly reason: string;
  readonly repo?: string;
  /** The materialization attempt that failed. */
  readonly attempt?: number;
}
export interface WorkspaceUnavailablePayload {
  /** Why the requested source cannot back a workspace on this runtime. */
  readonly reason: string;
  /** Which source input is unavailable. */
  readonly source: WorkspaceSourceKind;
  /** What the operator must change before a retry can succeed. */
  readonly requiredAction?: string;
}

// execution (run controls, full-factory U5)
/**
 * Execution state events describe the run's EXECUTION lifecycle, distinct from
 * the run's planning lifecycle: a run may be planned but never executed, and
 * execution can pause/resume/block/fail without changing planning history.
 * `run.started` (existing) marks the first real execution start; these events
 * carry the rest of the execution state machine.
 */
export interface ExecutionPausedPayload {
  readonly reason?: string;
}
export interface ExecutionResumedPayload {
  readonly reason?: string;
}
export interface ExecutionBlockedPayload {
  /** Why execution cannot proceed (preflight, intervention, abandoned lease…). */
  readonly reason: string;
  /** What the operator must do before execution can continue. */
  readonly requiredAction?: string;
}
export interface ExecutionCompletedPayload {
  readonly summary?: string;
}
export interface ExecutionFailedPayload {
  readonly reason: string;
}

// preflight (dry-run execution rehearsal, full-factory U5 / CEO expansion X2)
/**
 * The named preflight checks a dry-run rehearsal verifies BEFORE any worker
 * mutates files: ticket DAG integrity, workspace readiness, write scopes,
 * credentials, adapter readiness, gate setup, deploy prerequisites, and
 * outstanding operator approvals.
 */
export const PREFLIGHT_CHECKS = [
  'dag',
  'workspace',
  'write_scopes',
  'credentials',
  'adapters',
  'gates',
  'deploy',
  'approvals',
] as const;
export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number];

export interface PreflightStartedPayload {
  /** 1-based preflight attempt for this run (re-runs increment it). */
  readonly attempt: number;
  readonly checks: readonly PreflightCheck[];
}
export interface PreflightCheckPassedPayload {
  readonly attempt: number;
  readonly check: PreflightCheck;
  readonly detail?: string;
}
export interface PreflightCheckFailedPayload {
  readonly attempt: number;
  readonly check: PreflightCheck;
  readonly reason: string;
  /** What the operator must change before the check can pass. */
  readonly requiredAction?: string;
}
export interface PreflightPassedPayload {
  readonly attempt: number;
  readonly checkCount: number;
}
export interface PreflightFailedPayload {
  readonly attempt: number;
  readonly reason: string;
  readonly failedChecks: readonly PreflightCheck[];
}

// queue (ledger-backed durable execution queue, full-factory U5 / KTD4 / E2)
/** What a queue job executes. U5 ships run execution + gate re-runs. */
export type QueueJobKind = 'run-execution' | 'gate-rerun';

/** Terminal (or requeue) outcome recorded when a claimed job is released. */
export type QueueReleaseOutcome = 'completed' | 'failed' | 'blocked' | 'cancelled' | 'requeued';

export interface QueueEnqueuedPayload {
  readonly jobId: string;
  readonly jobKind: QueueJobKind;
  /** 1-based execution attempt for this job (operator retries increment it). */
  readonly attempt: number;
  readonly reason?: string;
  /** Optional ticket focus for retry-ticket commands (consumed by U6). */
  readonly ticketId?: string;
}
export interface QueueClaimedPayload {
  readonly jobId: string;
  readonly jobKind: QueueJobKind;
  readonly attempt: number;
  readonly leaseId: string;
  /** The daemon (process) instance that owns the lease. */
  readonly ownerId: string;
  /** Epoch ms when the lease expires unless heartbeaten. */
  readonly leaseExpiresAt: number;
}
export interface QueueHeartbeatPayload {
  readonly jobId: string;
  readonly jobKind: QueueJobKind;
  readonly attempt: number;
  readonly leaseId: string;
  readonly ownerId: string;
  /** The EXTENDED lease expiry. */
  readonly leaseExpiresAt: number;
}
export interface QueueReleasedPayload {
  readonly jobId: string;
  readonly jobKind: QueueJobKind;
  readonly attempt: number;
  readonly leaseId?: string;
  readonly outcome: QueueReleaseOutcome;
  readonly reason?: string;
}
export interface QueueLeaseAbandonedPayload {
  readonly jobId: string;
  readonly jobKind: QueueJobKind;
  readonly attempt: number;
  readonly leaseId: string;
  /** The owner that stopped heartbeating (when known). */
  readonly ownerId?: string;
  readonly reason: string;
}

// intervention (operator intervention queue, full-factory U5 / CEO expansion X4)
/** The human decision classes the intervention queue collects. */
export const INTERVENTION_KINDS = [
  'approval',
  'missing_credentials',
  'source_choice',
  'unsafe_path',
  'adapter_setup',
  'deploy_setup',
  'retry_choice',
  'policy_block',
] as const;
export type InterventionKind = (typeof INTERVENTION_KINDS)[number];

export interface InterventionRaisedPayload {
  readonly interventionId: string;
  readonly kind: InterventionKind;
  /** The stage the intervention blocks (e.g. `preflight`, `execution`). */
  readonly blockingStage: string;
  readonly reason: string;
  /** The action the operator must take to unblock the stage. */
  readonly requiredAction: string;
}
export interface InterventionResolvedPayload {
  readonly interventionId: string;
  readonly resolution: string;
  readonly note?: string;
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
/**
 * Which run-lifecycle stage a gate event belongs to (full-factory U7):
 *  - `post_ticket` — gates run against ONE ticket's output right after its
 *    worker completes (failures feed the bounded repair loop), and
 *  - `post_run`    — gates run against the whole workspace after every ticket
 *    completed (failures block `run.completed` until re-run or approval).
 * Absent on pre-U7 ledgers, which stays valid: stage-less gate events replay
 * exactly as before.
 */
export type GateStage = 'post_ticket' | 'post_run';

export interface GateStartedPayload {
  readonly gate: string;
  /** Lifecycle stage this gate run belongs to (U7; absent on older ledgers). */
  readonly stage?: GateStage;
  /** 1-based attempt within the current gate-stage run (bounded budget). */
  readonly attempt?: number;
}
export interface GatePassedPayload {
  readonly gate: string;
  readonly summary?: string;
  readonly stage?: GateStage;
}
export interface GateFailedPayload {
  readonly gate: string;
  readonly reason: string;
  readonly stage?: GateStage;
}

// repair (bounded gate-repair loop, full-factory U7)
/**
 * Repair events record the bounded post-ticket repair loop: a failed gate
 * feeds structured feedback back into the ticket's worker context and the
 * ticket re-runs. Attempt numbers are 1-based and LEDGER-DERIVED (the count of
 * prior `repair.started` events for the ticket), so a process restart resumes
 * the SAME budget instead of resetting it.
 */
export interface RepairStartedPayload {
  /** 1-based repair attempt for this ticket (monotonic across restarts). */
  readonly attempt: number;
  /** The gate whose failure triggered this repair. */
  readonly gate: string;
  readonly reason: string;
}
export interface RepairSucceededPayload {
  /** The repair attempt that produced a passing gate stage. */
  readonly attempt: number;
  readonly gate: string;
}
export interface RepairFailedPayload {
  /** The final repair attempt made before the budget was exhausted. */
  readonly attempt: number;
  readonly gate: string;
  readonly reason: string;
}

// review
export interface ReviewRequestedPayload {
  readonly riskTier: RiskTier;
  readonly summary?: string;
  /**
   * The blocked stage a human approval would resume (full-factory U7):
   * `gates` re-enqueues the gate re-run job, `execution` retries the
   * run-execution job. Absent for plain risk-tier reviews.
   */
  readonly stage?: 'gates' | 'execution';
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
  /** The packaged artifact id (U8; absent on older ledgers). */
  readonly artifactId?: string;
  /** The packaging commit hash (U8; absent on older ledgers). */
  readonly commit?: string;
  /** Repo-relative provenance bundle reference (U8; absent on older ledgers). */
  readonly provenanceRef?: string;
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
  'run.settings_overridden': RunSettingsOverriddenPayload;
  'run.planned': RunPlannedPayload;
  'run.started': EmptyPayload;
  'run.completed': RunCompletedPayload;
  'run.failed': RunFailedPayload;
  'run.cancelled': RunCancelledPayload;
  'research.requested': ResearchRequestedPayload;
  'research.source_found': ResearchSourceFoundPayload;
  'research.source_read': ResearchSourceReadPayload;
  'research.finding_recorded': ResearchFindingRecordedPayload;
  'research.assumption_recorded': ResearchAssumptionRecordedPayload;
  'research.gap_recorded': ResearchGapRecordedPayload;
  'research.brief_completed': ResearchBriefCompletedPayload;
  'research.failed': ResearchFailedPayload;
  'knowledge.entry_recorded': KnowledgeEntryRecordedPayload;
  'knowledge.entry_redacted': KnowledgeEntryRedactedPayload;
  'knowledge.entry_retired': KnowledgeEntryRetiredPayload;
  'supervisor.decision': SupervisorDecisionPayload;
  'contract.generated': ContractGeneratedPayload;
  'workspace.local_bound': WorkspaceLocalBoundPayload;
  'workspace.checkout_started': WorkspaceCheckoutStartedPayload;
  'workspace.ref_resolved': WorkspaceRefResolvedPayload;
  'workspace.checkout_completed': WorkspaceCheckoutCompletedPayload;
  'workspace.published': WorkspacePublishedPayload;
  'workspace.checkout_failed': WorkspaceCheckoutFailedPayload;
  'workspace.unavailable': WorkspaceUnavailablePayload;
  'execution.paused': ExecutionPausedPayload;
  'execution.resumed': ExecutionResumedPayload;
  'execution.blocked': ExecutionBlockedPayload;
  'execution.completed': ExecutionCompletedPayload;
  'execution.failed': ExecutionFailedPayload;
  'preflight.started': PreflightStartedPayload;
  'preflight.check_passed': PreflightCheckPassedPayload;
  'preflight.check_failed': PreflightCheckFailedPayload;
  'preflight.passed': PreflightPassedPayload;
  'preflight.failed': PreflightFailedPayload;
  'queue.enqueued': QueueEnqueuedPayload;
  'queue.claimed': QueueClaimedPayload;
  'queue.heartbeat': QueueHeartbeatPayload;
  'queue.released': QueueReleasedPayload;
  'queue.lease_abandoned': QueueLeaseAbandonedPayload;
  'intervention.raised': InterventionRaisedPayload;
  'intervention.resolved': InterventionResolvedPayload;
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
  'repair.started': RepairStartedPayload;
  'repair.succeeded': RepairSucceededPayload;
  'repair.failed': RepairFailedPayload;
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
  'run.settings_overridden',
  'run.planned',
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'research.requested',
  'research.source_found',
  'research.source_read',
  'research.finding_recorded',
  'research.assumption_recorded',
  'research.gap_recorded',
  'research.brief_completed',
  'research.failed',
  'knowledge.entry_recorded',
  'knowledge.entry_redacted',
  'knowledge.entry_retired',
  'supervisor.decision',
  'contract.generated',
  'workspace.local_bound',
  'workspace.checkout_started',
  'workspace.ref_resolved',
  'workspace.checkout_completed',
  'workspace.published',
  'workspace.checkout_failed',
  'workspace.unavailable',
  'execution.paused',
  'execution.resumed',
  'execution.blocked',
  'execution.completed',
  'execution.failed',
  'preflight.started',
  'preflight.check_passed',
  'preflight.check_failed',
  'preflight.passed',
  'preflight.failed',
  'queue.enqueued',
  'queue.claimed',
  'queue.heartbeat',
  'queue.released',
  'queue.lease_abandoned',
  'intervention.raised',
  'intervention.resolved',
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
  'repair.started',
  'repair.succeeded',
  'repair.failed',
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
