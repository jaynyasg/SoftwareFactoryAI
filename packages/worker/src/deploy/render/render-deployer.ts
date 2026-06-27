/**
 * Orchestrate a Render deploy AFTER local completion.
 *
 * Preconditions are enforced FIRST and a deploy is only triggered once they all
 * hold:
 *   - local gates passed, local preview healthy, the repo package + provenance
 *     exist, and the review policy is satisfied,
 *   - a Git destination is resolved (user repo, or a permitted temporary repo),
 *   - Render is configured (API key + service id), and
 *   - the generated `render.yaml` validates.
 * Any unmet precondition / missing setup PAUSES the deploy via
 * `deploy.setup_required` (or `deploy.config_invalid` for a bad blueprint) and
 * NEVER marks the local run failed (this orchestrator only ever emits `deploy.*`).
 *
 * The hosted URL is emitted (`deploy.hosted_ready`) ONLY after the provider
 * reports the deploy live AND a hosted health check passes — the event sequence
 * on success is `deploy.health_pending` -> `deploy.hosted_ready{url}`, and no
 * earlier event carries a URL. Provider failure, deploy timeout, migration
 * failure, and health failure all attach logs (as event evidence + on the
 * outcome) and are marked retryable.
 */
import type { AppendableEvent, EventActor, EventEvidence, EventStore } from '@software-factory/core';
import type { GitDestinationOutcome } from '../../git/git-destination';
import type { RenderBlueprint } from './render-config';
import { validateRenderBlueprint } from './render-config';
import type { RenderClient } from './render-client';
import { isDeploySuccess, isTerminalDeployStatus } from './render-client';
import { sleepAbortable } from '../../utils/sleep';

/** Local readiness gating the deploy (all must be true to proceed). */
export interface DeployPreconditions {
  readonly gatesPassed: boolean;
  readonly previewHealthy: boolean;
  readonly packagePresent: boolean;
  readonly provenancePresent: boolean;
  readonly reviewSatisfied: boolean;
}

/** Render configuration presence (absent fields pause the deploy). */
export interface RenderTarget {
  readonly serviceId?: string;
  readonly apiKeyPresent?: boolean;
}

/** Parameters for `deployToRender`. */
export interface RenderDeployerParams {
  readonly runId: string;
  readonly ticketId?: string;
  readonly artifactId?: string;
  readonly preconditions: DeployPreconditions;
  /** The resolved Git destination outcome (setup-required pauses the deploy). */
  readonly gitDestination: GitDestinationOutcome;
  readonly render: RenderTarget;
  readonly blueprint: RenderBlueprint;
  /** The expected hosted URL the health check probes after provider success. */
  readonly hostedUrl: string;
  /** Max deploy-status polls before declaring a timeout (default 30). */
  readonly maxStatusPolls?: number;
  /** Max hosted-health polls before declaring a health failure (default 20). */
  readonly maxHealthPolls?: number;
  /** Delay between polls in ms (default 1000; tests inject 0 + a fake sleep). */
  readonly pollIntervalMs?: number;
  readonly clock?: () => number;
}

/** Dependencies for `deployToRender`. */
export interface RenderDeployerDeps {
  readonly store: EventStore;
  readonly client: RenderClient;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** The discriminated deploy outcome. Every failure is retryable. */
export type DeployOutcome =
  | { readonly status: 'setup_required'; readonly action: string; readonly retryable: true }
  | { readonly status: 'config_invalid'; readonly reason: string; readonly retryable: true }
  | {
      readonly status: 'provider_failed';
      readonly reason: string;
      readonly logs: readonly string[];
      readonly retryable: true;
    }
  | {
      readonly status: 'migration_failed';
      readonly reason: string;
      readonly logs: readonly string[];
      readonly retryable: true;
    }
  | {
      readonly status: 'timeout';
      readonly reason: string;
      readonly logs: readonly string[];
      readonly retryable: true;
    }
  | {
      readonly status: 'health_failed';
      readonly reason: string;
      readonly logs: readonly string[];
      readonly retryable: true;
    }
  | { readonly status: 'hosted_ready'; readonly url: string; readonly retryable: false };

const DEPLOY_ACTOR: EventActor = { kind: 'deploy', id: 'render', display: 'render-deployer' };

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

function logsEvidence(logs: readonly string[], deployId?: string): EventEvidence[] {
  return [{ label: 'render-deploy-logs', ref: deployId, note: logs.join('\n') }];
}

/**
 * Run the Render deploy orchestration. Returns a discriminated outcome and emits
 * the matching `deploy.*` ledger events; never throws for an expected failure
 * (provider/migration/timeout/health) — those resolve to a retryable outcome.
 */
export async function deployToRender(
  params: RenderDeployerParams,
  deps: RenderDeployerDeps,
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

  // 2. Git destination must be resolved (user repo or permitted temporary repo).
  if (!params.gitDestination.ok) {
    return setupRequired(params.gitDestination.action);
  }

  // 3. Render must be configured.
  if (params.render.apiKeyPresent !== true || params.render.serviceId === undefined) {
    return setupRequired(
      'Configure Render: set a Render API key and the target service id (RENDER_API_KEY, service).',
    );
  }

  // 4. The generated render.yaml must validate.
  const validation = validateRenderBlueprint(params.blueprint);
  if (!validation.valid) {
    const reason = `Invalid render.yaml: ${validation.errors.map((error) => error.message).join(' ')}`;
    await append('deploy.config_invalid', 'error', { reason });
    return { status: 'config_invalid', reason, retryable: true };
  }

  // 5. Trigger the deploy and poll its status to a terminal state.
  const serviceId = params.render.serviceId;
  const logs: string[] = [];
  let current;
  try {
    current = await deps.client.createDeploy({ serviceId, signal: deps.signal });
  } catch (error) {
    const reason = `Render deploy could not be triggered: ${error instanceof Error ? error.message : String(error)}`;
    logs.push(reason);
    await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs));
    return { status: 'provider_failed', reason, logs, retryable: true };
  }
  logs.push(`deploy ${current.id} created (status: ${current.status})`);

  let polls = 0;
  while (!isTerminalDeployStatus(current.status)) {
    if (polls >= maxStatusPolls) {
      const reason = `Render deploy ${current.id} did not reach a terminal state after ${maxStatusPolls} poll(s).`;
      logs.push(reason);
      await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, current.id));
      return { status: 'timeout', reason, logs, retryable: true };
    }
    polls += 1;
    await sleep(pollIntervalMs, deps.signal);
    try {
      current = await deps.client.getDeploy({ serviceId, deployId: current.id, signal: deps.signal });
    } catch (error) {
      const reason = `Polling Render deploy ${current.id} failed: ${error instanceof Error ? error.message : String(error)}`;
      logs.push(reason);
      await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, current.id));
      return { status: 'provider_failed', reason, logs, retryable: true };
    }
    logs.push(`status: ${current.status}`);
  }

  // 6. Classify a terminal non-success as a migration or provider failure.
  if (!isDeploySuccess(current.status)) {
    const detail = current.failureReason ?? `deploy ${current.id} ended as ${current.status}`;
    logs.push(detail);
    if (/migrat/i.test(detail)) {
      const reason = `Database migration failed during deploy: ${detail}`;
      await append('deploy.migration_failed', 'error', { reason }, logsEvidence(logs, current.id));
      return { status: 'migration_failed', reason, logs, retryable: true };
    }
    const reason = `Render provider deploy failed (${current.status}): ${detail}`;
    await append('deploy.provider_failed', 'error', { reason }, logsEvidence(logs, current.id));
    return { status: 'provider_failed', reason, logs, retryable: true };
  }

  // 7. Provider success -> health pending. The hosted URL is still withheld.
  logs.push(`deploy ${current.id} is live; checking hosted health`);
  await append('deploy.health_pending', 'info', {});

  let healthPolls = 0;
  for (;;) {
    healthPolls += 1;
    let health;
    try {
      health = await deps.client.checkHealth({ url: params.hostedUrl, signal: deps.signal });
    } catch (error) {
      health = { healthy: false, status: 0 };
      logs.push(`health check ${healthPolls} errored: ${error instanceof Error ? error.message : String(error)}`);
    }
    logs.push(
      `health check ${healthPolls}: HTTP ${health.status} (${health.healthy ? 'healthy' : 'unhealthy'})`,
    );

    if (health.healthy) {
      await append('deploy.hosted_ready', 'success', { url: params.hostedUrl }, [
        { label: 'hosted-url', href: params.hostedUrl, ref: params.hostedUrl },
      ]);
      return { status: 'hosted_ready', url: params.hostedUrl, retryable: false };
    }

    if (healthPolls >= maxHealthPolls) {
      break;
    }
    await sleep(pollIntervalMs, deps.signal);
  }

  const reason = `Hosted health did not pass at ${params.hostedUrl} after ${maxHealthPolls} check(s).`;
  logs.push(reason);
  await append('deploy.health_failed', 'error', { reason }, logsEvidence(logs, current.id));
  return { status: 'health_failed', reason, logs, retryable: true };
}
