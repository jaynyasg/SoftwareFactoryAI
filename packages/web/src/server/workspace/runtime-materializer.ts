/**
 * Runtime workspace materializer (full-factory U4): builds a materialization
 * request for a run from the runtime configuration + the run's `run.created`
 * payload, then executes the worker materializer.
 *
 * Cloud/local boundary handling (KTD5) lives in the materializer itself; this
 * wrapper supplies the runtime's visibility mode, local-boundary policy,
 * checkout root, and the credential-safe git checkout client (E5: the
 * `SF_GIT_CHECKOUT_TOKEN` value is read at exec time only and never recorded).
 *
 * Materialization stays SEPARATE from worker execution: the route surface
 * triggers/retries it and inspects the projected state; nothing here runs
 * tickets.
 */
import { createNodeCommandRunner } from '@software-factory/core';
import type { EventStore, RunCreatedPayload } from '@software-factory/core';
import {
  createCommandGitCheckoutClient,
  createCommandGitPublishClient,
  gitHubRemoteUrl,
  materializeWorkspace,
  projectWorkspace,
} from '@software-factory/worker';
import type {
  GitCheckoutClient,
  GitPublishClient,
  GitPublishResult,
  WorkspaceMaterializationResult,
} from '@software-factory/worker';
import { runCreatedPayload } from '../run-created';
import { resolveWorkspaceRuntimeConfig } from '../runtime';
import type { RuntimeConfig } from '../runtime';

/** Input accepted by the workspace trigger (route body). */
export interface WorkspaceTriggerInput {
  /** Requested branch for repository checkouts. */
  readonly branch?: string;
}

/**
 * A materializer bound to the server runtime: executes one materialization
 * pass for a run, emitting workspace events into the given store.
 */
export type RunWorkspaceMaterializer = (
  store: EventStore,
  runId: string,
  input: WorkspaceTriggerInput,
) => Promise<WorkspaceMaterializationResult>;

/** Options for building the runtime materializer (hooks injectable for tests). */
export interface RuntimeMaterializerOptions {
  /** Runtime config (mode + workspace boundary/checkout defaults). */
  readonly runtime?: RuntimeConfig;
  readonly clock?: () => number;
  /** Injectable checkout client (default: command-backed `git`). */
  readonly git?: GitCheckoutClient;
}

/**
 * Build the default runtime materializer. Reads the run's `run.created`
 * payload for source context and runs one materialization pass; every outcome
 * (bound, checked out, unavailable, failed) is explicit on the ledger.
 */
export function createRuntimeWorkspaceMaterializer(
  options: RuntimeMaterializerOptions = {},
): RunWorkspaceMaterializer {
  const workspace = options.runtime?.workspace ?? resolveWorkspaceRuntimeConfig();
  const mode = options.runtime?.mode ?? 'local';
  const clock = options.clock ?? Date.now;
  const git =
    options.git ??
    createCommandGitCheckoutClient(createNodeCommandRunner(), {
      // E5: exec-time-only credential read; the value never leaves the client.
      credentials: () => process.env.SF_GIT_CHECKOUT_TOKEN,
    });

  return async (store, runId, input) => {
    const payload: RunCreatedPayload = runCreatedPayload(await store.readRun(runId));

    return materializeWorkspace(
      {
        runId,
        runtimeMode: mode,
        localFolder: payload.localFolder,
        githubRepo: payload.githubRepo,
        branch: input.branch,
        checkoutRoot: workspace.checkoutRoot,
        localPolicy: {
          boundaryRoot: workspace.localBoundaryRoot,
          approvedFolders: workspace.approvedFolders,
        },
        dirtyStatePolicy: workspace.dirtyStatePolicy,
      },
      { store, git, clock },
    );
  };
}

/* ----------------------------------------------------------------------------
 * Workspace publish (the completion report's "ship the deliverable" action)
 * ------------------------------------------------------------------------- */

/** The outcome surfaced by the publish trigger route. */
export type WorkspacePublishOutcome =
  | { readonly ok: true; readonly result: GitPublishResult; readonly repo: string }
  | { readonly ok: false; readonly reason: string };

/** A publisher bound to the server runtime: pushes a run's checkout to GitHub. */
export type RunWorkspacePublisher = (
  store: EventStore,
  runId: string,
) => Promise<WorkspacePublishOutcome>;

/** Options for building the runtime publisher (hooks injectable for tests). */
export interface RuntimePublisherOptions {
  readonly clock?: () => number;
  /** Injectable publish client (default: command-backed `git`). */
  readonly git?: GitPublishClient;
}

/**
 * Build the default runtime workspace publisher. Publishable = a READY
 * repo-checkout workspace; the push commits any uncommitted worker output
 * and pushes HEAD to the checkout's branch on the credential-free remote
 * (auth rides the git config env — E5). The outcome is recorded on the
 * ledger as `workspace.published`.
 */
export function createRuntimeWorkspacePublisher(
  options: RuntimePublisherOptions = {},
): RunWorkspacePublisher {
  const clock = options.clock ?? Date.now;
  const git =
    options.git ??
    createCommandGitPublishClient(createNodeCommandRunner(), {
      // E5: exec-time-only credential read; the value never leaves the client.
      credentials: () => process.env.SF_GIT_CHECKOUT_TOKEN,
    });

  return async (store, runId) => {
    const events = await store.readRun(runId);
    const projection = projectWorkspace(events, runId);
    const workspace = projection.workspace;
    if (projection.status !== 'ready' || workspace?.kind !== 'repo_checkout') {
      return {
        ok: false,
        reason:
          workspace?.kind === 'local_folder'
            ? 'This run works directly in a bound local folder — there is no checkout to publish.'
            : 'The run has no ready repository checkout to publish.',
      };
    }

    const [owner, repo] = workspace.repo.split('/');
    const result = await git.publish({
      dest: workspace.checkoutPath,
      remoteUrl: gitHubRemoteUrl(owner, repo),
      branch: workspace.branch,
      message: `Software Factory: publish run ${runId} deliverable`,
    });

    await store.append({
      runId,
      type: 'workspace.published',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'workspace', id: runId },
      severity: result.pushed ? 'success' : 'info',
      timestamp: clock(),
      payload: {
        repo: workspace.repo,
        branch: result.branch,
        commit: result.commit,
        pushed: result.pushed,
        note: result.note,
      },
    });

    return { ok: true, result, repo: workspace.repo };
  };
}
