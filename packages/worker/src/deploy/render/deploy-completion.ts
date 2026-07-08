/**
 * Deploy completion for the run lifecycle (full-factory U8).
 *
 * `deriveDeployPreconditions` folds the run's ledger into the deployer's
 * local-readiness preconditions (R28): post-run gates passed, preview healthy,
 * package + provenance present, and review policy satisfied (no pending
 * `review.requested`). Pure and replayable — never invents readiness.
 *
 * `completeRunDeploy` wires those preconditions plus the resolved git
 * destination into the existing `deployToRender` orchestrator:
 *
 *   1. resolve the Git destination (user repo preferred, marked-temporary repo
 *      when permitted, else setup-required — which PAUSES the deploy via
 *      `deploy.setup_required` WITHOUT failing the local run, R30),
 *   2. push the packaged repo through the injectable `GitRemoteClient` (a
 *      failed push pauses with setup-required too — hosting cannot proceed
 *      from an unpushed repo, but the local package stays intact),
 *   3. generate + validate the Render blueprint and run `deployToRender`,
 *      which emits the `deploy.*` ledger events and returns the discriminated
 *      outcome. The hosted URL appears ONLY on `hosted_ready` (provider
 *      success AND hosted health pass, R29).
 *
 * Every failure outcome is retryable; retrying execution re-enters this flow
 * (packaging is idempotent upstream) so deploy state converges without
 * duplicating local work.
 */
import type { EventStore, FactoryEvent } from '@software-factory/core';
import { resolveGitDestination, toProvenanceGitDestination } from '../../git/git-destination';
import type {
  GitDestinationOutcome,
  GitHubDestinationConfig,
  GitRemoteClient,
} from '../../git/git-destination';
import { generateRenderConfig } from './render-config';
import type { RenderConfigOptions } from './render-config';
import { deployToRender } from './render-deployer';
import type { DeployOutcome, DeployPreconditions, RenderTarget } from './render-deployer';
import type { RenderClient } from './render-client';

/** Fold the run's ledger events into the deploy preconditions. Pure. */
export function deriveDeployPreconditions(events: readonly FactoryEvent[]): DeployPreconditions {
  let sawPostRunGate = false;
  const anyGateFailedLatest = new Map<string, boolean>();
  let previewHealthy = false;
  let packagePresent = false;
  let provenancePresent = false;
  let pendingReviews = 0;

  for (const event of events) {
    switch (event.type) {
      case 'gate.passed':
        anyGateFailedLatest.set(event.payload.gate, false);
        if (event.payload.stage === 'post_run') {
          sawPostRunGate = true;
        }
        break;
      case 'gate.failed':
        anyGateFailedLatest.set(event.payload.gate, true);
        break;
      case 'preview.ready':
        previewHealthy = true;
        break;
      case 'preview.failed':
        previewHealthy = false;
        break;
      case 'package.created':
        packagePresent = true;
        // The packager writes PROVENANCE.json alongside the handoff.
        provenancePresent =
          event.payload.provenanceRef !== undefined ||
          event.evidence?.some((item) => item.label === 'provenance') === true;
        break;
      case 'review.requested':
        pendingReviews += 1;
        break;
      case 'review.decided':
        pendingReviews = Math.max(0, pendingReviews - 1);
        break;
      default:
        break;
    }
  }

  let gatesFailed = false;
  for (const failed of anyGateFailedLatest.values()) {
    if (failed) {
      gatesFailed = true;
    }
  }
  // Gates count as passed when at least one post-run gate stage passed and no
  // gate's LATEST outcome is a failure. Runs that plan no gates never reach
  // deploy with failures, but they also carry no post-run pass — treat a
  // gate-less ledger as passing only when nothing failed.
  const gatesPassed = !gatesFailed && (sawPostRunGate || anyGateFailedLatest.size === 0);

  return {
    gatesPassed,
    previewHealthy,
    packagePresent,
    provenancePresent,
    reviewSatisfied: pendingReviews === 0,
  };
}

/** Parameters for `completeRunDeploy`. */
export interface CompleteRunDeployParams {
  readonly runId: string;
  readonly artifactId?: string;
  /** The packaged repo path (pushed to the resolved destination). */
  readonly packagePath: string;
  /** The packaging commit hash. */
  readonly commit: string;
  /** Ledger-derived local readiness (see `deriveDeployPreconditions`). */
  readonly preconditions: DeployPreconditions;
  /** User-provided GitHub destination, when configured. */
  readonly github?: GitHubDestinationConfig;
  /** Whether a factory-owned temporary repo may back the deploy. */
  readonly allowTemporaryRepo?: boolean;
  readonly render: RenderTarget;
  /** The hosted URL health is probed at (required to reach hosted_ready). */
  readonly hostedUrl?: string;
  readonly blueprintOptions?: RenderConfigOptions;
  readonly maxStatusPolls?: number;
  readonly maxHealthPolls?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

/** Dependencies for `completeRunDeploy` (all injectable; no network in tests). */
export interface CompleteRunDeployDeps {
  readonly store: EventStore;
  readonly renderClient: RenderClient;
  readonly gitClient: GitRemoteClient;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** The completion outcome: the deployer outcome plus destination context. */
export interface CompleteRunDeployResult {
  readonly outcome: DeployOutcome;
  /** The resolved destination (absent when destination setup is required). */
  readonly gitDestination?: GitDestinationOutcome;
}

/** Emit `deploy.setup_required` and return the paused outcome. */
async function pauseWithSetup(
  params: CompleteRunDeployParams,
  deps: CompleteRunDeployDeps,
  action: string,
): Promise<DeployOutcome> {
  await deps.store.append({
    runId: params.runId,
    type: 'deploy.setup_required',
    actor: { kind: 'deploy', id: 'render', display: 'render-deployer' },
    subject: { kind: 'deploy', id: params.artifactId ?? params.runId },
    severity: 'warn',
    timestamp: params.clock?.(),
    payload: { action },
  });
  return { status: 'setup_required', action, retryable: true };
}

/**
 * Run the deploy completion flow. Never throws for an expected pause/failure —
 * every unmet prerequisite resolves to a retryable outcome with its ledger
 * event, and the local run is never marked failed from here (R30).
 */
export async function completeRunDeploy(
  params: CompleteRunDeployParams,
  deps: CompleteRunDeployDeps,
): Promise<CompleteRunDeployResult> {
  // Resolve the git destination first: a setup-required destination pauses the
  // deploy before any provider interaction.
  const destination = resolveGitDestination({
    runId: params.runId,
    artifactId: params.artifactId,
    github: params.github,
    allowTemporary: params.allowTemporaryRepo === true,
  });

  // The hosted URL must be configured for the health check to ever pass; treat
  // a missing URL as deploy setup (NOT a failure).
  if (params.hostedUrl === undefined || params.hostedUrl.length === 0) {
    const outcome = await pauseWithSetup(
      params,
      deps,
      'Configure the hosted URL for post-deploy health checks (SF_RENDER_HOSTED_URL).',
    );
    return { outcome, gitDestination: destination };
  }

  // Push the packaged repo when a destination resolved and preconditions hold
  // (an unmet precondition is reported by deployToRender below — we avoid
  // pushing anything for a run that is not locally ready).
  if (destination.ok) {
    const unmetLocally = !(
      params.preconditions.gatesPassed &&
      params.preconditions.previewHealthy &&
      params.preconditions.packagePresent &&
      params.preconditions.provenancePresent &&
      params.preconditions.reviewSatisfied
    );
    if (!unmetLocally) {
      await deps.gitClient.ensureRepo(destination.descriptor, { signal: deps.signal });
      const push = await deps.gitClient.push({
        descriptor: destination.descriptor,
        localPath: params.packagePath,
        commit: params.commit,
        signal: deps.signal,
      });
      if (!push.pushed) {
        const outcome = await pauseWithSetup(
          params,
          deps,
          `Push the packaged repo to ${destination.descriptor.remoteUrl} (push failed: ${
            push.note ?? 'unknown error'
          }), then retry deploy.`,
        );
        return { outcome, gitDestination: destination };
      }
    }
  }

  const generated = generateRenderConfig(params.blueprintOptions);
  const outcome = await deployToRender(
    {
      runId: params.runId,
      artifactId: params.artifactId,
      preconditions: params.preconditions,
      gitDestination: destination,
      render: params.render,
      blueprint: generated.blueprint,
      hostedUrl: params.hostedUrl,
      maxStatusPolls: params.maxStatusPolls,
      maxHealthPolls: params.maxHealthPolls,
      pollIntervalMs: params.pollIntervalMs,
      clock: params.clock,
    },
    {
      store: deps.store,
      client: deps.renderClient,
      sleep: deps.sleep,
      signal: deps.signal,
    },
  );

  return { outcome, gitDestination: destination };
}

/** Provenance-shaped destination for a resolved outcome (or undefined). */
export function provenanceDestinationOf(
  destination: GitDestinationOutcome | undefined,
): ReturnType<typeof toProvenanceGitDestination> | undefined {
  return destination !== undefined && destination.ok
    ? toProvenanceGitDestination(destination.descriptor)
    : undefined;
}
