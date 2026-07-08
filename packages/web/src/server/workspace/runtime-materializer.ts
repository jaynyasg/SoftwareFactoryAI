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
import { createCommandGitCheckoutClient, materializeWorkspace } from '@software-factory/worker';
import type {
  GitCheckoutClient,
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
