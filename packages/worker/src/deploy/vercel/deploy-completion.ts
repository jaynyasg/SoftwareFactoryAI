/**
 * Vercel deploy completion for the run lifecycle (U12) — the Vercel twin of
 * `../render/deploy-completion.ts` (same order of operations, same failure
 * taxonomy, same R30 posture): resolve the git destination, push the packaged
 * repo, then run `deployToVercel`. Preconditions come from the SAME
 * `deriveDeployPreconditions` fold the Render path uses.
 */
import type { EventStore } from '@software-factory/core';
import { resolveGitDestination } from '../../git/git-destination';
import type { GitHubDestinationConfig, GitRemoteClient } from '../../git/git-destination';
import type { CompleteRunDeployResult } from '../render/deploy-completion';
import type { DeployOutcome, DeployPreconditions } from '../render/render-deployer';
import { deployToVercel } from './vercel-deployer';
import type { VercelTarget } from './vercel-deployer';
import type { VercelClient } from './vercel-client';

export interface CompleteRunVercelDeployParams {
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
  readonly vercel: VercelTarget;
  /** Optional hosted-URL override (default: the deployment's own URL). */
  readonly hostedUrl?: string;
  readonly maxStatusPolls?: number;
  readonly maxHealthPolls?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

export interface CompleteRunVercelDeployDeps {
  readonly store: EventStore;
  readonly vercelClient: VercelClient;
  readonly gitClient: GitRemoteClient;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** Emit `deploy.setup_required` and return the paused outcome. */
async function pauseWithSetup(
  params: CompleteRunVercelDeployParams,
  deps: CompleteRunVercelDeployDeps,
  action: string,
): Promise<DeployOutcome> {
  await deps.store.append({
    runId: params.runId,
    type: 'deploy.setup_required',
    actor: { kind: 'deploy', id: 'vercel', display: 'vercel-deployer' },
    subject: { kind: 'deploy', id: params.artifactId ?? params.runId },
    severity: 'warn',
    timestamp: params.clock?.(),
    payload: { action },
  });
  return { status: 'setup_required', action, retryable: true };
}

/**
 * Run the Vercel deploy completion flow. Never throws for an expected
 * pause/failure; the local run is never marked failed from here (R30).
 */
export async function completeRunVercelDeploy(
  params: CompleteRunVercelDeployParams,
  deps: CompleteRunVercelDeployDeps,
): Promise<CompleteRunDeployResult> {
  const destination = resolveGitDestination({
    runId: params.runId,
    artifactId: params.artifactId,
    github: params.github,
    allowTemporary: params.allowTemporaryRepo === true,
  });

  // Push the packaged repo when a destination resolved and local readiness
  // holds (unmet readiness is reported by deployToVercel below).
  if (destination.ok) {
    const locallyReady =
      params.preconditions.gatesPassed &&
      params.preconditions.previewHealthy &&
      params.preconditions.packagePresent &&
      params.preconditions.provenancePresent &&
      params.preconditions.reviewSatisfied;
    if (locallyReady) {
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

  const outcome = await deployToVercel(
    {
      runId: params.runId,
      artifactId: params.artifactId,
      preconditions: params.preconditions,
      gitDestination: destination,
      vercel: params.vercel,
      branch: destination.ok ? destination.descriptor.defaultBranch : undefined,
      hostedUrl: params.hostedUrl,
      maxStatusPolls: params.maxStatusPolls,
      maxHealthPolls: params.maxHealthPolls,
      pollIntervalMs: params.pollIntervalMs,
      clock: params.clock,
    },
    {
      store: deps.store,
      client: deps.vercelClient,
      sleep: deps.sleep,
      signal: deps.signal,
    },
  );

  return { outcome, gitDestination: destination };
}
