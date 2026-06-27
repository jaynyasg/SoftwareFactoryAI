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
import type { CallerFamily, FactoryEvent, ReviewMode, RiskTier, RunStatus } from '@software-factory/core';

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
  readonly tests: TestsSummary;
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
  gates: GateOutput[];
}

/** Fold preview/deploy/package/gate events that core projections do not cover. */
function deriveLifecycle(events: readonly FactoryEvent[]): DerivedLifecycle {
  const derived: DerivedLifecycle = { gates: [] };
  let repoFromArtifact: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case 'preview.ready':
        derived.previewUrl = event.payload.url;
        break;
      case 'preview.failed':
        derived.previewUrl = undefined;
        break;
      case 'deploy.hosted_ready':
        derived.hostedUrl = event.payload.url;
        break;
      case 'package.created':
        derived.repoPath = event.payload.repoPath ?? derived.repoPath;
        derived.handoffRef = event.payload.handoffRef ?? derived.handoffRef;
        break;
      case 'artifact.created':
        if (event.payload.kind === 'repo' && event.payload.path !== undefined) {
          repoFromArtifact ??= event.payload.path;
        }
        break;
      case 'gate.passed':
        derived.gates.push({ gate: event.payload.gate, status: 'passed', detail: event.payload.summary });
        break;
      case 'gate.failed':
        derived.gates.push({ gate: event.payload.gate, status: 'failed', detail: event.payload.reason });
        break;
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
    tests: summarizeGates(lifecycle.gates),
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
