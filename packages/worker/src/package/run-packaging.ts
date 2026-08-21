/**
 * Run packaging orchestration (full-factory U8).
 *
 * `packageCompletedRun` turns a run whose tickets and post-run gates all passed
 * into a packaged, provenance-carrying repo artifact:
 *
 *   1. IDEMPOTENCE FIRST — when the run's ledger already carries a
 *      `package.created` event, packaging is SKIPPED and the existing package
 *      descriptor is returned (a restart/replay/deploy-retry never re-packages
 *      or re-runs git),
 *   2. derive provenance + artifact confidence from the ledger and the
 *      workspace file listing (`deriveRunProvenance`),
 *   3. render the human handoff markdown (`renderHandoffMarkdown`),
 *   4. package the workspace as a committed git repo (`packageRepo`, which
 *      emits `package.created` with an idempotency key), and
 *   5. emit `artifact.created` + `artifact.confidence_computed` for the repo
 *      artifact (both idempotent per run+artifact).
 *
 * Failures from the git packaging step propagate as thrown errors — the caller
 * (the executor completion stage) maps them onto a retryable failed state; the
 * ledger never records a fake `package.created`.
 */
import type {
  AppendableEvent,
  CommandRunner,
  EventStore,
  FactoryEvent,
  ProvenanceDeployConfig,
  ProvenanceGitDestination,
  RunProjection,
  TicketProjection,
} from '@software-factory/core';
import { deriveRunProvenance } from '../provenance/run-provenance';
import type { DerivedRunProvenance, WorkspaceFileLister } from '../provenance/run-provenance';
import { listWorkspaceFiles } from '../provenance/run-provenance';
import { renderHandoffMarkdown, summarizeGates } from './handoff-writer';
import type { GateSummaryItem, StatusSnapshot } from './handoff-writer';
import { packageRepo } from './repo-packager';
import type { RepoArtifactDescriptor } from './repo-packager';

/** Parameters for `packageCompletedRun`. */
export interface PackageCompletedRunParams {
  readonly runId: string;
  /** Artifact id for the packaged repo (default `app`). */
  readonly artifactId?: string;
  /** The completed run's workspace directory (packaged in place). */
  readonly workspaceDir: string;
  readonly run: RunProjection;
  readonly tickets: TicketProjection;
  /** The run's full ledger events (idempotence check + provenance source). */
  readonly events: readonly FactoryEvent[];
  /** Deploy config summary recorded into provenance, when deploy is planned. */
  readonly deployConfig?: ProvenanceDeployConfig;
  readonly gitDestination?: ProvenanceGitDestination;
  /** Local preview + deploy status snapshots for the handoff document. */
  readonly previewStatus?: StatusSnapshot;
  readonly deployStatus?: StatusSnapshot;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
}

/** Dependencies for `packageCompletedRun` (all injectable for tests). */
export interface PackageCompletedRunDeps {
  readonly store: EventStore;
  /** Command runner for the git init/add/commit sequence. */
  readonly runner: CommandRunner;
  /** Workspace file lister (default: bounded fs walk). */
  readonly listFiles?: WorkspaceFileLister;
}

/** The packaging outcome: the descriptor plus whether work actually ran. */
export interface PackageCompletedRunResult {
  /** `true` when an existing `package.created` short-circuited packaging. */
  readonly alreadyPackaged: boolean;
  readonly artifactId: string;
  readonly descriptor: RepoArtifactDescriptor;
  /** The derived provenance (absent on the already-packaged fast path). */
  readonly provenance?: DerivedRunProvenance;
}

const DEFAULT_ARTIFACT_ID = 'app';

/** Find an existing `package.created` for the run, if any. */
function existingPackage(
  events: readonly FactoryEvent[],
): { repoPath?: string; commit?: string; artifactId?: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'package.created') {
      return {
        repoPath: event.payload.repoPath,
        commit: event.payload.commit,
        artifactId: event.payload.artifactId,
      };
    }
  }
  return undefined;
}

/** Map ledger gate evidence into the handoff's tests-summary rows. */
function gateSummaryItems(provenance: DerivedRunProvenance): GateSummaryItem[] {
  const latest = new Map<string, GateSummaryItem>();
  for (const evidence of provenance.bundle.gateEvidence) {
    latest.set(evidence.gate, {
      gate: evidence.gate,
      passed: evidence.passed,
      summary: evidence.summary,
      reason: evidence.reason,
    });
  }
  return [...latest.values()];
}

/**
 * Package a completed run's workspace as a provenance-carrying git repo.
 * Idempotent per run: an existing `package.created` short-circuits (no git
 * operations, no duplicate events).
 */
export async function packageCompletedRun(
  params: PackageCompletedRunParams,
  deps: PackageCompletedRunDeps,
): Promise<PackageCompletedRunResult> {
  const artifactId = params.artifactId ?? DEFAULT_ARTIFACT_ID;

  const existing = existingPackage(params.events);
  if (existing !== undefined) {
    return {
      alreadyPackaged: true,
      artifactId: existing.artifactId ?? artifactId,
      descriptor: {
        path: existing.repoPath ?? params.workspaceDir,
        commit: existing.commit ?? 'unknown',
        branch: 'main',
        files: [],
      },
    };
  }

  const listFiles = deps.listFiles ?? listWorkspaceFiles;
  const generatedFiles = await listFiles(params.workspaceDir);
  const provenance = deriveRunProvenance({
    runId: params.runId,
    artifactId,
    events: params.events,
    run: params.run,
    tickets: params.tickets,
    generatedFiles,
    deployConfig: params.deployConfig,
    gitDestination: params.gitDestination,
    generatedAt: params.clock?.(),
  });

  const gates = gateSummaryItems(provenance);
  const testsSummary = summarizeGates(gates);
  const handoffMarkdown = renderHandoffMarkdown({
    title: params.run.title ?? 'Software Factory build',
    runId: params.runId,
    artifactId,
    summary: `Packaged after ${params.tickets.tickets.length} ticket(s) and ${testsSummary.passed}/${testsSummary.total} gate(s) passed.`,
    prompt: params.run.prompt,
    prdRef: params.run.prdRef,
    repoPath: params.workspaceDir,
    testsSummary,
    provenanceRef: 'PROVENANCE.json',
    preview: params.previewStatus,
    deploy: params.deployStatus,
    gitDestination: params.gitDestination,
    reducedTrust: provenance.bundle.reducedTrust,
    confidence: provenance.confidence.confidence,
  });

  const descriptor = await packageRepo(
    {
      runId: params.runId,
      artifactId,
      repoDir: params.workspaceDir,
      provenance: provenance.bundle,
      handoffMarkdown,
      ledgerExcerpt: params.events,
      idempotencyKey: `${params.runId}:package.created:${artifactId}`,
      signal: params.signal,
      clock: params.clock,
    },
    { store: deps.store, runner: deps.runner },
  );

  const append = (event: Omit<AppendableEvent, 'runId'>): Promise<unknown> =>
    deps.store.append({ ...event, runId: params.runId } as AppendableEvent);

  await append({
    type: 'artifact.created',
    actor: { kind: 'system', id: 'run-packaging', display: 'run-packaging' },
    subject: { kind: 'artifact', id: artifactId },
    severity: 'success',
    timestamp: params.clock?.(),
    idempotencyKey: `${params.runId}:artifact.created:${artifactId}`,
    payload: { artifactId, kind: 'repo', path: descriptor.path },
  });
  await append({
    type: 'artifact.confidence_computed',
    actor: { kind: 'system', id: 'run-packaging', display: 'run-packaging' },
    subject: { kind: 'artifact', id: artifactId },
    severity: 'info',
    timestamp: params.clock?.(),
    idempotencyKey: `${params.runId}:artifact.confidence_computed:${artifactId}`,
    payload: {
      artifactId,
      confidence: provenance.confidence.confidence,
      factors: provenance.confidence.factors,
    },
  });

  return { alreadyPackaged: false, artifactId, descriptor, provenance };
}
