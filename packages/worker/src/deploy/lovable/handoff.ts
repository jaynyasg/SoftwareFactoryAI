/**
 * Lovable publish-and-import handoff (U13).
 *
 * Lovable exposes no hosting/deploy API, so "deploy to Lovable" is an HONEST
 * handoff, never claimed hosting: publish the generated repo to GitHub with
 * the owner's token (the existing publish path), then record a
 * `deploy.handoff_ready` artifact carrying the Lovable import link and
 * step-by-step instructions. The deploy state is `handoff_ready` — no hosted
 * URL exists and none is claimed. Mirrors the Render/Vercel completion shape
 * (sibling: `../render/deploy-completion.ts`) up to the publish step.
 */
import type { EventStore } from '@software-factory/core';
import { resolveGitDestination } from '../../git/git-destination';
import type {
  GitDestinationOutcome,
  GitHubDestinationConfig,
  GitRemoteClient,
} from '../../git/git-destination';
import type { DeployPreconditions } from '../render/render-deployer';

/** The handoff outcome — a deliberate sibling of DeployOutcome's shapes. */
export type LovableHandoffOutcome =
  | { readonly status: 'setup_required'; readonly action: string; readonly retryable: true }
  | {
      readonly status: 'handoff_ready';
      readonly repoUrl: string;
      readonly importUrl: string;
      readonly instructions: string;
      readonly retryable: false;
    };

export interface CompleteLovableHandoffParams {
  readonly runId: string;
  readonly artifactId?: string;
  readonly packagePath: string;
  readonly commit: string;
  readonly preconditions: DeployPreconditions;
  readonly github?: GitHubDestinationConfig;
  readonly allowTemporaryRepo?: boolean;
  readonly clock?: () => number;
}

export interface CompleteLovableHandoffDeps {
  readonly store: EventStore;
  readonly gitClient: GitRemoteClient;
  readonly signal?: AbortSignal;
}

export interface CompleteLovableHandoffResult {
  readonly outcome: LovableHandoffOutcome;
  readonly gitDestination?: GitDestinationOutcome;
}

/** The import link Lovable's GitHub connector opens for a published repo. */
export function lovableImportUrl(repoUrl: string): string {
  return `https://lovable.dev/projects/new?import=${encodeURIComponent(repoUrl)}`;
}

/** The step-by-step instructions recorded on the handoff artifact. */
export function lovableInstructions(repoUrl: string): string {
  return [
    `1. Open lovable.dev and sign in.`,
    `2. Create a project from GitHub and pick the published repository (${repoUrl}) — or use the import link directly.`,
    `3. Lovable builds and hosts the app from that repo; further edits happen in Lovable.`,
    `The factory's role ends at the published repo: Lovable has no deploy API, so no hosted URL is claimed here.`,
  ].join('\n');
}

/**
 * Publish the packaged repo and record the handoff artifact. A missing
 * destination or failed push pauses with `deploy.setup_required`
 * (owner-directed, per R14 the GitHub token comes from the owner's vault) —
 * NO artifact is emitted on failure.
 */
export async function completeLovableHandoff(
  params: CompleteLovableHandoffParams,
  deps: CompleteLovableHandoffDeps,
): Promise<CompleteLovableHandoffResult> {
  const pause = async (action: string): Promise<CompleteLovableHandoffResult> => {
    await deps.store.append({
      runId: params.runId,
      type: 'deploy.setup_required',
      actor: { kind: 'deploy', id: 'lovable', display: 'lovable-handoff' },
      subject: { kind: 'deploy', id: params.artifactId ?? params.runId },
      severity: 'warn',
      timestamp: params.clock?.(),
      payload: { action },
    });
    return { outcome: { status: 'setup_required', action, retryable: true } };
  };

  // Local readiness mirrors the hosted providers: an incomplete run never
  // publishes a handoff.
  const unmet: string[] = [];
  if (!params.preconditions.gatesPassed) {
    unmet.push('local gates must pass');
  }
  if (!params.preconditions.packagePresent) {
    unmet.push('repo package must exist');
  }
  if (!params.preconditions.provenancePresent) {
    unmet.push('provenance bundle must exist');
  }
  if (!params.preconditions.reviewSatisfied) {
    unmet.push('review policy must be satisfied');
  }
  if (unmet.length > 0) {
    return pause(`Complete local readiness before the handoff: ${unmet.join('; ')}.`);
  }

  const destination = resolveGitDestination({
    runId: params.runId,
    artifactId: params.artifactId,
    github: params.github,
    allowTemporary: params.allowTemporaryRepo === true,
  });
  if (!destination.ok) {
    const paused = await pause(destination.action);
    return { ...paused, gitDestination: destination };
  }

  await deps.gitClient.ensureRepo(destination.descriptor, { signal: deps.signal });
  const push = await deps.gitClient.push({
    descriptor: destination.descriptor,
    localPath: params.packagePath,
    commit: params.commit,
    signal: deps.signal,
  });
  if (!push.pushed) {
    const paused = await pause(
      `Publish the packaged repo to ${destination.descriptor.remoteUrl} (push failed: ${
        push.note ?? 'unknown error'
      }) — add your GitHub token under Settings → Credentials if it is missing — then retry.`,
    );
    return { ...paused, gitDestination: destination };
  }

  const repoUrl = destination.descriptor.remoteUrl.replace(/\.git$/, '');
  const importUrl = lovableImportUrl(repoUrl);
  const instructions = lovableInstructions(repoUrl);
  await deps.store.append({
    runId: params.runId,
    type: 'deploy.handoff_ready',
    actor: { kind: 'deploy', id: 'lovable', display: 'lovable-handoff' },
    subject: { kind: 'deploy', id: params.artifactId ?? params.runId },
    severity: 'success',
    timestamp: params.clock?.(),
    evidence: [
      { label: 'published-repo', href: repoUrl, ref: repoUrl },
      { label: 'lovable-import', href: importUrl, ref: importUrl },
    ],
    payload: { repoUrl, importUrl, instructions, provider: 'lovable' },
  });

  return {
    outcome: { status: 'handoff_ready', repoUrl, importUrl, instructions, retryable: false },
    gitDestination: destination,
  };
}
