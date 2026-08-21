/**
 * Orchestrate a Vercel deploy AFTER local completion (U12).
 *
 * Mirrors the Render deployer's semantics and event taxonomy exactly
 * (sibling: `../render/render-deployer.ts` — same `DeployOutcome` union, same
 * `deploy.*` events, same fail-closed posture): preconditions first, missing
 * setup PAUSES via `deploy.setup_required` and never fails the local run
 * (R30), and the hosted URL is emitted (`deploy.hosted_ready`) ONLY after the
 * provider reports READY and a hosted health check passes (R29).
 *
 * The Vercel path is deliberately thin (generated apps are Next.js): the
 * published GitHub repo backs the project, a deployment is triggered from it,
 * its state is polled to terminal, then health is probed at the deployment's
 * own URL (Vercel names the host) or a configured override.
 */
import type { AppendableEvent, EventActor, EventEvidence, EventStore } from '@software-factory/core';
import type { GitDestinationOutcome } from '../../git/git-destination';
import type { DeployOutcome, DeployPreconditions } from '../render/render-deployer';
import { isTerminalVercelState, isVercelDeploySuccess } from './vercel-client';
import type { VercelClient } from './vercel-client';
import { sleepAbortable } from '../../utils/sleep';

/** Vercel configuration presence (absent fields pause the deploy). */
export interface VercelTarget {
  /** Whether the run OWNER's Vercel token is present (never the value). */
  readonly tokenPresent?: boolean;
  /** Project name (defaults to a run-derived name). */
  readonly projectName?: string;
}

export interface VercelDeployerParams {
  readonly runId: string;
  readonly ticketId?: string;
  readonly artifactId?: string;
  readonly preconditions: DeployPreconditions;
  /** The resolved Git destination outcome (setup-required pauses the deploy). */
  readonly gitDestination: GitDestinationOutcome;
  readonly vercel: VercelTarget;
  /** Branch the deployment builds from (the publish branch). */
  readonly branch?: string;
  /** Optional hosted-URL override; default = the deployment's own URL. */
  readonly hostedUrl?: string;
  readonly maxStatusPolls?: number;
  readonly maxHealthPolls?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

export interface VercelDeployerDeps {
  readonly store: EventStore;
  readonly client: VercelClient;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

const DEPLOY_ACTOR: EventActor = { kind: 'deploy', id: 'vercel', display: 'vercel-deployer' };

function unmetPreconditions(preconditions: DeployPreconditions): string[] {
  const unmet: string[] = [];
  if (!preconditions.gatesPassed) {
    unmet.push('local gates must pass');
  }
  if (!preconditions.previewHealthy) {
    unmet.push('local preview must be healthy');
  }
  if (!preconditions.packagePresent) {
    unmet.push('repo package must exist');
  }
  if (!preconditions.provenancePresent) {
    unmet.push('provenance bundle must exist');
  }
  if (!preconditions.reviewSatisfied) {
    unmet.push('review policy must be satisfied');
  }
  return unmet;
}

function logsEvidence(logs: readonly string[], deploymentId?: string): EventEvidence[] {
  return [{ label: 'vercel-deploy-logs', ref: deploymentId, note: logs.join('\n') }];
}

/**
 * Run the Vercel deploy orchestration. Returns the SAME discriminated outcome
 * union as the Render deployer and emits the matching `deploy.*` events;
 * never throws for an expected failure.
 */
export async function deployToVercel(
  params: VercelDeployerParams,
  deps: VercelDeployerDeps,
): Promise<DeployOutcome> {
  const sleep = deps.sleep ?? sleepAbortable;
  const pollIntervalMs = params.pollIntervalMs ?? 1000;
  const maxStatusPolls = Math.max(1, Math.trunc(params.maxStatusPolls ?? 30));
  const maxHealthPolls = Math.max(1, Math.trunc(params.maxHealthPolls ?? 20));

  const append = (
    type: AppendableEvent['type'],
    severity: AppendableEvent['severity'],
    payload: AppendableEvent['payload'],
    evidence?: readonly EventEvidence[],
  ): Promise<unknown> =>
    deps.store.append({
      runId: params.runId,
      ticketId: params.ticketId,
      type,
      actor: DEPLOY_ACTOR,
      subject: { kind: 'deploy', id: params.artifactId ?? params.runId },
      severity,
      evidence,
      timestamp: params.clock?.(),
      payload,
    } as AppendableEvent);

  const setupRequired = async (action: string): Promise<DeployOutcome> => {
    await append('deploy.setup_required', 'warn', { action });
    return { status: 'setup_required', action, retryable: true };
  };

  // 1. Local readiness preconditions.
  const unmet = unmetPreconditions(params.preconditions);
  if (unmet.length > 0) {
    return setupRequired(`Complete local readiness before deploy: ${unmet.join('; ')}.`);
  }

  // 2. Git destination must be resolved (the deployment builds from it).
  if (!params.gitDestination.ok) {
    return setupRequired(params.gitDestination.action);
  }

  // 3. The OWNER's Vercel token must be present (Settings → Credentials).
  if (params.vercel.tokenPresent !== true) {
    return setupRequired(
      'Add your Vercel token under Settings → Credentials (vercel.com → Account Settings → Tokens), then retry the deploy.',
    );
  }

  const repo = `${params.gitDestination.descriptor.owner}/${params.gitDestination.descriptor.repo}`;
  const projectName = params.vercel.projectName ?? params.gitDestination.descriptor.repo;
  const branch = params.branch ?? 'main';
  const logs: string[] = [];

  // 4. Ensure/link the project, then trigger the deployment.
  let deployment;
  try {
    const project = await deps.client.ensureProject({
      name: projectName,
      repo,
      signal: deps.signal,
    });
    logs.push(`project ${project.name} (${project.id}) linked to ${repo}`);
    deployment = await deps.client.createDeployment({
      projectName: project.name,
      repo,
      branch,
      signal: deps.signal,
    });
  } catch (error) {
    const reason = `Vercel deploy could not be triggered: ${error instanceof Error ? error.message : String(error)}`;
    logs.push(reason);
    await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs));
    return { status: 'provider_failed', reason, logs, retryable: true };
  }
  logs.push(`deployment ${deployment.id} created (state: ${deployment.state})`);

  // 5. Poll the deployment to a terminal state.
  let polls = 0;
  while (!isTerminalVercelState(deployment.state)) {
    if (polls >= maxStatusPolls) {
      const reason = `Vercel deployment ${deployment.id} did not reach a terminal state after ${maxStatusPolls} poll(s).`;
      logs.push(reason);
      await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, deployment.id));
      return { status: 'timeout', reason, logs, retryable: true };
    }
    polls += 1;
    await sleep(pollIntervalMs, deps.signal);
    try {
      deployment = await deps.client.getDeployment({
        deploymentId: deployment.id,
        signal: deps.signal,
      });
    } catch (error) {
      const reason = `Polling Vercel deployment ${deployment.id} failed: ${error instanceof Error ? error.message : String(error)}`;
      logs.push(reason);
      await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, deployment.id));
      return { status: 'provider_failed', reason, logs, retryable: true };
    }
    logs.push(`state: ${deployment.state}`);
  }

  // 6. Classify a terminal non-success (same taxonomy as Render; Vercel has
  //    no separate migration phase, so failures classify by message).
  if (!isVercelDeploySuccess(deployment.state)) {
    const detail =
      deployment.errorMessage ?? `deployment ${deployment.id} ended as ${deployment.state}`;
    logs.push(detail);
    if (/migrat/i.test(detail)) {
      const reason = `Database migration failed during deploy: ${detail}`;
      await append('deploy.migration_failed', 'error', { reason }, logsEvidence(logs, deployment.id));
      return { status: 'migration_failed', reason, logs, retryable: true };
    }
    const reason = `Vercel provider deploy failed (${deployment.state}): ${detail}`;
    await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, deployment.id));
    return { status: 'provider_failed', reason, logs, retryable: true };
  }

  // 7. Provider success -> health pending; the URL is still withheld (R29).
  const hostedUrl =
    params.hostedUrl ?? (deployment.url !== undefined ? `https://${deployment.url}` : undefined);
  if (hostedUrl === undefined) {
    const reason = `Vercel deployment ${deployment.id} is READY but reported no URL to health-check.`;
    logs.push(reason);
    await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, deployment.id));
    return { status: 'provider_failed', reason, logs, retryable: true };
  }
  logs.push(`deployment ${deployment.id} is READY; checking hosted health at ${hostedUrl}`);
  await append('deploy.health_pending', 'info', {});

  let healthPolls = 0;
  for (;;) {
    healthPolls += 1;
    let health;
    try {
      health = await deps.client.checkHealth({ url: hostedUrl, signal: deps.signal });
    } catch (error) {
      health = { healthy: false, status: 0 };
      logs.push(
        `health check ${healthPolls} errored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    logs.push(
      `health check ${healthPolls}: HTTP ${health.status} (${health.healthy ? 'healthy' : 'unhealthy'})`,
    );

    if (health.healthy) {
      await append('deploy.hosted_ready', 'success', { url: hostedUrl }, [
        { label: 'hosted-url', href: hostedUrl, ref: hostedUrl },
      ]);
      return { status: 'hosted_ready', url: hostedUrl, retryable: false };
    }

    if (healthPolls >= maxHealthPolls) {
      break;
    }
    await sleep(pollIntervalMs, deps.signal);
  }

  const reason = `Hosted health did not pass at ${hostedUrl} after ${maxHealthPolls} check(s).`;
  logs.push(reason);
  await append('deploy.health_failed', 'error', { reason }, logsEvidence(logs, deployment.id));
  return { status: 'health_failed', reason, logs, retryable: true };
}
