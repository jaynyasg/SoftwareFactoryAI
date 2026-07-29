/**
 * Client-safe view-model types shared across the UI and the server loader.
 *
 * Type-only: importing this from a client component pulls in no runtime code, so
 * the browser bundle never reaches the Node-only server modules. The server
 * loader (server/run-data.ts) re-exports these and produces values for them.
 */
import type {
  ArtifactView,
  EventSeverity,
  InterventionKind,
  LedgerRow,
  OperatorMetrics,
  OperatorProjection,
  ResearchProjection,
  RunDiagnosticsReport,
  RunProjection,
  TicketView,
} from '@software-factory/core';
import type {
  BlockedStageView,
  DeployView,
  GateOutcomeRow,
  PackageView,
  PreviewView,
  RepairSummaryRow,
  ReviewItem,
} from './run-view';

/**
 * One dry-run preflight check outcome, ready to render as a structured row
 * (client-safe mirror of the server preflight projection — U9).
 */
export interface PreflightCheckRow {
  readonly check: string;
  readonly ok: boolean;
  readonly detail?: string;
  readonly reason?: string;
  readonly requiredAction?: string;
}

/** The latest projected preflight rehearsal for a run (X2), or `none`. */
export interface PreflightSnapshot {
  readonly status: 'none' | 'running' | 'passed' | 'failed';
  readonly attempt: number;
  readonly checks: readonly PreflightCheckRow[];
  readonly failedChecks: readonly string[];
}

/** The projected run-execution queue job (client-safe mirror — U9). */
export interface ExecutionJobSnapshot {
  readonly jobId: string;
  readonly jobKind: string;
  readonly attempt: number;
  readonly status:
    | 'queued'
    | 'leased'
    | 'completed'
    | 'failed'
    | 'blocked'
    | 'cancelled'
    | 'abandoned';
  readonly reason?: string;
  readonly ticketId?: string;
  readonly enqueuedAt: number;
}

/**
 * One cross-run operator intervention item (X4), as served by
 * GET /api/interventions. Client-safe mirror of the server projection.
 */
export interface InterventionItem {
  readonly interventionId: string;
  readonly runId: string;
  readonly ticketId?: string;
  readonly kind: InterventionKind;
  readonly severity: EventSeverity;
  readonly blockingStage: string;
  readonly reason: string;
  readonly requiredAction: string;
  readonly raisedAt: number;
  readonly sequence: number;
  readonly status: 'open' | 'resolved';
  readonly resolution?: string;
  readonly resolutionNote?: string;
  readonly resolvedAt?: number;
}

/** The cross-run intervention queue payload the UI polls (X4). */
export interface InterventionQueueSnapshot {
  readonly interventions: readonly InterventionItem[];
  readonly openCount: number;
}

/** The full projected view of one run, ready to render. */
export interface RunAggregate {
  readonly run: RunProjection;
  readonly tickets: readonly TicketView[];
  readonly artifacts: readonly ArtifactView[];
  readonly operator: OperatorProjection;
  /** Research status, sources, findings, assumptions, and gaps (U1–U3). */
  readonly research: ResearchProjection;
  /** Latest dry-run preflight rehearsal outcome for the run (X2/U5). */
  readonly preflight: PreflightSnapshot;
  /** The run-execution queue job, when one was ever enqueued (U5). */
  readonly executionJob: ExecutionJobSnapshot | null;
  /** Preview lifecycle (url present only after `preview.ready`). */
  readonly preview: PreviewView;
  /** Deploy lifecycle (hosted url present only after `deploy.hosted_ready`). */
  readonly deploy: DeployView;
  /** Package + handoff state (repo, handoff, provenance, confidence) (U8). */
  readonly packageView: PackageView;
  /** Risk-tiered review requests folded with their decisions. */
  readonly reviews: readonly ReviewItem[];
  /** Latest gate outcomes per (ticket, gate) with evidence (U7). */
  readonly gates: readonly GateOutcomeRow[];
  /** Ledger-derived repair-loop summaries per ticket (U7). */
  readonly repairs: readonly RepairSummaryRow[];
  /** OPEN interventions blocking this run's stages (approvability per policy). */
  readonly interventions: readonly BlockedStageView[];
  readonly lastSequence: number;
  /** Ledger rows with `sequence > afterSequence` (the reconnect/resume slice). */
  readonly tail: readonly LedgerRow[];
}

/**
 * The operator-facing aggregate for the /operator dashboard. Distinct from the
 * user `RunAggregate`: it carries the computed operator metrics and per-run
 * diagnostics (with joined failure-registry rescue actions) the panels render.
 * Fully JSON-serializable so the server component can hand it to the panels.
 */
export interface OperatorAggregate {
  readonly runId: string | null;
  readonly run: RunProjection;
  readonly operator: OperatorProjection;
  readonly metrics: OperatorMetrics;
  readonly diagnostics: RunDiagnosticsReport;
  readonly tickets: readonly TicketView[];
}

/**
 * Factory-wide execution state (shape of GET /api/execution). The daemon
 * boots HELD — nothing runs automatically when the factory opens — and the
 * operator releases the gate with the Resume control.
 */
export interface ExecutionOverview {
  readonly execution: {
    /** False on instances without an execution daemon (controls hidden). */
    readonly enabled: boolean;
    /** True while the drain gate is engaged (no queued work is started). */
    readonly held: boolean;
    readonly running: boolean;
  };
  /** Cross-run queue job counts (what a resume would start / a hold stops). */
  readonly queue: { readonly queued: number; readonly leased: number };
}

/**
 * Combined floor payload (shape of GET /api/floor): the execution overview
 * plus the cross-run intervention queue, folded server-side from ONE ledger
 * read so the Factory Floor polls a single endpoint per tick. Named
 * `interventionQueue` (not `queue`) deliberately: the wire body's top-level
 * `queue` key is the JOB counts (parsed into `overview.queue`), and reusing
 * the word one level apart invited exactly that confusion.
 */
export interface FloorStatus {
  readonly overview: ExecutionOverview;
  readonly interventionQueue: InterventionQueueSnapshot;
}

/** The read-only setup status feeding the checklist (shape of GET /api/setup). */
export interface SetupStatus {
  readonly operatorToken: { readonly present: boolean };
  readonly sandbox: { readonly status: string };
  readonly adapters: { readonly status: string; readonly detected: readonly string[] };
  readonly deploy: { readonly status: string };
  readonly workspace: { readonly root: string };
  readonly runtime?: {
    readonly mode?: string;
    readonly publicBaseUrl?: string;
    readonly factoryDir?: string;
    readonly operatorTokenSource?: string;
  };
}
