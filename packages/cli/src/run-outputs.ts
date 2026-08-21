/**
 * The CLI's run artifact-output contract.
 *
 * `buildRunOutputs` derives the stable object `software-factory run`/`status`
 * return from a run's ledger events. It uses core's pure projections for run,
 * ticket, and artifact state, and folds the remaining lifecycle events (preview,
 * deploy, package, gates) locally — every field traces to a real event, nothing
 * is invented. The SAME shape is returned regardless of caller (web, CLI, Claude
 * wrapper, Codex wrapper), which is the contract the skill wrappers rely on.
 *
 * In V1 the run flow is planning-only: a freshly-created run settles at `planned`
 * with a ticket DAG, so preview/hosted/repo/handoff fields are typically absent
 * until a (manual/optional) worker run produces them. Once those events exist
 * (e.g. a completed run), the same builder surfaces them.
 */
import { projectArtifacts, projectRun, projectTickets } from '@software-factory/core';
import type {
  CallerFamily,
  FactoryEvent,
  ReviewMode,
  RiskTier,
  RunStatus,
} from '@software-factory/core';

export interface TicketOutput {
  readonly id: string;
  readonly title?: string;
  readonly state: string;
  readonly riskTier?: RiskTier;
  readonly dependsOn: readonly string[];
}

export interface GateOutput {
  readonly gate: string;
  readonly status: 'passed' | 'failed';
  readonly detail?: string;
}

export interface TestsSummary {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
  readonly summary: string;
  readonly gates: readonly GateOutput[];
}

export interface ArtifactOutput {
  readonly artifactId: string;
  readonly kind?: string;
  readonly path?: string;
  readonly confidence?: number;
}

/**
 * Ledger-derived repair-loop state for one ticket (U7). Mirrors the counters
 * ReviewStudio shows, so remote/CLI callers see the same repair evidence the UI
 * does — a bounded gate-repair loop that exhausted its budget is a first-class
 * signal, not UI-only state.
 */
export interface RepairOutput {
  readonly ticketId: string;
  /** Repair attempts consumed (max observed `repair.*` attempt for the ticket). */
  readonly attempts: number;
  readonly status: 'repairing' | 'succeeded' | 'exhausted';
  readonly gate?: string;
  readonly reason?: string;
}

/** Deploy lifecycle states derivable from `deploy.*` events (U8). */
export type DeployOutputStatus =
  | 'idle'
  | 'setup_required'
  | 'config_invalid'
  | 'provider_failed'
  | 'migration_failed'
  | 'health_pending'
  | 'health_failed'
  | 'hosted_ready'
  | 'handoff_ready';

/** The projected deploy state (R29/R30): URL only on `hosted_ready`. */
export interface DeployOutput {
  readonly status: DeployOutputStatus;
  /** Hosted URL — present ONLY after `deploy.hosted_ready` (health passed). */
  readonly url?: string;
  readonly reason?: string;
  readonly action?: string;
  /** Whether the current deploy state can be retried (all non-ready states). */
  readonly retryable: boolean;
  /** Handoff fields (U13, `handoff_ready` only): published repo + import link. */
  readonly repoUrl?: string;
  readonly importUrl?: string;
  readonly instructions?: string;
}

/** The stable artifact contract `run`/`status` return (and `--json` prints). */
export interface RunOutputs {
  readonly runId: string;
  readonly status: RunStatus;
  readonly reviewMode?: ReviewMode;
  /** The agent family that initiated the run (CLI `--caller-family`). */
  readonly callerFamily?: CallerFamily;
  readonly plannedTicketCount?: number;
  readonly tickets: readonly TicketOutput[];
  /** Local preview URL — present only after `preview.ready`. */
  readonly previewUrl?: string;
  /** Hosted URL — present only after `deploy.hosted_ready` (health passed). */
  readonly hostedUrl?: string;
  /** Packaged repo artifact path — from `package.created` or a `repo` artifact. */
  readonly repoPath?: string;
  /** Handoff markdown reference — from `package.created`. */
  readonly handoffRef?: string;
  /** Provenance bundle reference — from `package.created` (U8). */
  readonly provenanceRef?: string;
  /** Human handoff summary — from `package.created` / `run.completed` (U8). */
  readonly handoffSummary?: string;
  /** Projected deploy state (U8): url only after hosted health passes. */
  readonly deploy: DeployOutput;
  readonly tests: TestsSummary;
  /** Ledger-derived per-ticket repair-loop counters (U7); empty when none ran. */
  readonly repairs: readonly RepairOutput[];
  readonly artifacts: readonly ArtifactOutput[];
  /** Absolute URL of the read-only event log. */
  readonly eventsUrl: string;
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
}

interface DerivedLifecycle {
  previewUrl?: string;
  hostedUrl?: string;
  repoPath?: string;
  handoffRef?: string;
  provenanceRef?: string;
  handoffSummary?: string;
  deploy: DeployOutput;
  gates: GateOutput[];
  repairs: Map<string, RepairOutput>;
}

/** Fold preview/deploy/package/gate events that core projections do not cover. */
function deriveLifecycle(events: readonly FactoryEvent[]): DerivedLifecycle {
  const derived: DerivedLifecycle = {
    gates: [],
    deploy: { status: 'idle', retryable: false },
    repairs: new Map<string, RepairOutput>(),
  };
  let repoFromArtifact: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'preview.ready':
        derived.previewUrl = event.payload.url;
        break;
      case 'preview.failed':
        derived.previewUrl = undefined;
        break;
      case 'deploy.setup_required':
        derived.deploy = {
          status: 'setup_required',
          action: event.payload.action,
          retryable: true,
        };
        break;
      case 'deploy.config_invalid':
        derived.deploy = {
          status: 'config_invalid',
          reason: event.payload.reason,
          retryable: true,
        };
        break;
      case 'deploy.provider_failed':
        derived.deploy = {
          status: 'provider_failed',
          reason: event.payload.reason,
          retryable: true,
        };
        break;
      case 'deploy.migration_failed':
        derived.deploy = {
          status: 'migration_failed',
          reason: event.payload.reason,
          retryable: true,
        };
        break;
      case 'deploy.health_pending':
        derived.deploy = { status: 'health_pending', retryable: true };
        break;
      case 'deploy.health_failed':
        derived.deploy = { status: 'health_failed', reason: event.payload.reason, retryable: true };
        break;
      case 'deploy.hosted_ready':
        derived.hostedUrl = event.payload.url;
        derived.deploy = { status: 'hosted_ready', url: event.payload.url, retryable: false };
        break;
      case 'deploy.handoff_ready':
        // U13: parity across CLI/MCP/UI — the handoff artifact rides the SAME
        // deploy slot the hosted URL does, but claims NO hosting.
        derived.deploy = {
          status: 'handoff_ready',
          repoUrl: event.payload.repoUrl,
          importUrl: event.payload.importUrl,
          instructions: event.payload.instructions,
          retryable: false,
        };
        break;
      case 'package.created':
        derived.repoPath = event.payload.repoPath ?? derived.repoPath;
        derived.handoffRef = event.payload.handoffRef ?? derived.handoffRef;
        derived.provenanceRef = event.payload.provenanceRef ?? derived.provenanceRef;
        derived.handoffSummary = event.payload.summary ?? derived.handoffSummary;
        break;
      case 'run.completed':
        derived.handoffSummary ??= event.payload.summary;
        break;
      case 'artifact.created':
        if (event.payload.kind === 'repo' && event.payload.path !== undefined) {
          repoFromArtifact ??= event.payload.path;
        }
        break;
      case 'gate.passed':
        derived.gates.push({
          gate: event.payload.gate,
          status: 'passed',
          detail: event.payload.summary,
        });
        break;
      case 'gate.failed':
        derived.gates.push({
          gate: event.payload.gate,
          status: 'failed',
          detail: event.payload.reason,
        });
        break;
      case 'repair.started':
      case 'repair.succeeded':
      case 'repair.failed': {
        if (event.ticketId === undefined) {
          break;
        }
        const prior = derived.repairs.get(event.ticketId);
        const attempts = Math.max(prior?.attempts ?? 0, event.payload.attempt);
        const status =
          event.type === 'repair.started'
            ? ('repairing' as const)
            : event.type === 'repair.succeeded'
              ? ('succeeded' as const)
              : ('exhausted' as const);
        derived.repairs.set(event.ticketId, {
          ticketId: event.ticketId,
          attempts,
          status,
          gate: event.payload.gate,
          // A successful repair clears the failure reason; started/failed keep it.
          reason: event.type === 'repair.succeeded' ? undefined : event.payload.reason,
        });
        break;
      }
      default:
        break;
    }
  }

  derived.repoPath ??= repoFromArtifact;
  return derived;
}

function summarizeGates(gates: readonly GateOutput[]): TestsSummary {
  const passed = gates.filter((gate) => gate.status === 'passed').length;
  const failed = gates.filter((gate) => gate.status === 'failed').length;
  const total = gates.length;
  const summary =
    total === 0
      ? 'no gate evidence yet'
      : `${passed}/${total} gate checks passed${failed > 0 ? ` (${failed} failed)` : ''}`;
  return { passed, failed, total, summary, gates };
}

/** Build the artifact contract for `runId` from its event log + an events URL. */
export function buildRunOutputs(
  runId: string,
  events: readonly FactoryEvent[],
  eventsUrl: string,
): RunOutputs {
  const run = projectRun(events, runId);
  const tickets = projectTickets(events, runId).tickets;
  const artifacts = projectArtifacts(events, runId).artifacts;
  const lifecycle = deriveLifecycle(events);

  return {
    runId,
    status: run.status,
    reviewMode: run.reviewMode,
    callerFamily: run.callerFamily,
    plannedTicketCount: run.plannedTicketCount,
    tickets: tickets.map((ticket) => ({
      id: ticket.ticketId,
      title: ticket.title,
      state: ticket.state,
      riskTier: ticket.riskTier,
      dependsOn: ticket.dependsOn,
    })),
    previewUrl: lifecycle.previewUrl,
    hostedUrl: lifecycle.hostedUrl,
    repoPath: lifecycle.repoPath,
    handoffRef: lifecycle.handoffRef,
    provenanceRef: lifecycle.provenanceRef,
    handoffSummary: lifecycle.handoffSummary,
    deploy: lifecycle.deploy,
    tests: summarizeGates(lifecycle.gates),
    repairs: [...lifecycle.repairs.values()],
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      path: artifact.path,
      confidence: artifact.confidence,
    })),
    eventsUrl,
    diagnostics: run.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
    })),
  };
}
