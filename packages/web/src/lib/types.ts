/**
 * Client-safe view-model types shared across the UI and the server loader.
 *
 * Type-only: importing this from a client component pulls in no runtime code, so
 * the browser bundle never reaches the Node-only server modules. The server
 * loader (server/run-data.ts) re-exports these and produces values for them.
 */
import type {
  ArtifactView,
  LedgerRow,
  OperatorMetrics,
  OperatorProjection,
  RunDiagnosticsReport,
  RunProjection,
  TicketView,
} from '@software-factory/core';
import type { DeployView, PreviewView, ReviewItem } from './run-view';

/** The full projected view of one run, ready to render. */
export interface RunAggregate {
  readonly run: RunProjection;
  readonly tickets: readonly TicketView[];
  readonly artifacts: readonly ArtifactView[];
  readonly operator: OperatorProjection;
  /** Preview lifecycle (url present only after `preview.ready`). */
  readonly preview: PreviewView;
  /** Deploy lifecycle (hosted url present only after `deploy.hosted_ready`). */
  readonly deploy: DeployView;
  /** Risk-tiered review requests folded with their decisions. */
  readonly reviews: readonly ReviewItem[];
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

/** The read-only setup status feeding the checklist (shape of GET /api/setup). */
export interface SetupStatus {
  readonly operatorToken: { readonly present: boolean };
  readonly sandbox: { readonly status: string };
  readonly adapters: { readonly status: string; readonly detected: readonly string[] };
  readonly deploy: { readonly status: string };
}
