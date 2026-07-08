/**
 * Workspace materialization projection (full-factory U4).
 *
 * Pure `events[] -> state` fold over the `workspace.*` family, following the
 * core projection invariants: never invents state, sorts by sequence, is
 * deterministic on replay, and later attempts supersede earlier ones (so a
 * retried materialization CONVERGES instead of accumulating ambiguity).
 *
 * Lives in the worker package (with the materializer) so U5/U6 execution and
 * the web server can both consume the projected workspace without widening the
 * core surface beyond the event contract.
 */
import { resolveTargetRunId, validateAndSortEvents } from '@software-factory/core';
import type {
  DirtyStatePolicy,
  WorkspaceLocalBoundary,
  WorkspaceSourceKind,
} from '@software-factory/core';

/** A workspace that has been materialized and can back execution. */
export type MaterializedWorkspace =
  | {
      readonly kind: 'local_folder';
      /** Resolved absolute path bound as the workspace. */
      readonly path: string;
      readonly boundary: WorkspaceLocalBoundary;
      readonly boundaryRoot: string;
      readonly dirtyStatePolicy: DirtyStatePolicy;
    }
  | {
      readonly kind: 'repo_checkout';
      readonly repo: string;
      readonly branch: string;
      readonly commit: string;
      readonly checkoutPath: string;
      readonly dirtyStatePolicy: DirtyStatePolicy;
    };

/**
 * Projected materialization status:
 *  - `none`          — no workspace events on the ledger,
 *  - `materializing` — a checkout attempt started and has not concluded,
 *  - `ready`         — a workspace is bound/checked out and usable,
 *  - `failed`        — the latest checkout attempt failed (retryable),
 *  - `unavailable`   — the requested source cannot back a workspace on this
 *                       runtime until setup changes (KTD5 / boundary rules).
 */
export type WorkspaceStatus = 'none' | 'materializing' | 'ready' | 'failed' | 'unavailable';

export interface WorkspaceProjection {
  readonly runId: string | null;
  readonly status: WorkspaceStatus;
  /** The materialized workspace when `status === 'ready'`. */
  readonly workspace?: MaterializedWorkspace;
  /** Checkout attempts observed (retries increment this). */
  readonly attempts: number;
  /** Latest `workspace.unavailable` reason, when any. */
  readonly unavailableReason?: string;
  /** Latest `workspace.unavailable` source kind, when any. */
  readonly unavailableSource?: WorkspaceSourceKind;
  /** Latest recorded operator remediation, when any. */
  readonly requiredAction?: string;
  /** Latest `workspace.checkout_failed` reason, when any. */
  readonly failureReason?: string;
  /** Highest workspace-event sequence folded (0 when none). */
  readonly lastSequence: number;
}

/** Project the workspace materialization state for a run. Pure and replayable. */
export function projectWorkspace(raw: readonly unknown[], runId?: string): WorkspaceProjection {
  const { events } = validateAndSortEvents(raw);
  const targetRunId = resolveTargetRunId(events, runId);
  const runEvents = targetRunId === null ? [] : events.filter((e) => e.runId === targetRunId);

  let status: WorkspaceStatus = 'none';
  let workspace: MaterializedWorkspace | undefined;
  let attempts = 0;
  let unavailableReason: string | undefined;
  let unavailableSource: WorkspaceSourceKind | undefined;
  let requiredAction: string | undefined;
  let failureReason: string | undefined;
  let lastSequence = 0;

  for (const event of runEvents) {
    switch (event.type) {
      case 'workspace.local_bound':
        status = 'ready';
        workspace = {
          kind: 'local_folder',
          path: event.payload.path,
          boundary: event.payload.boundary,
          boundaryRoot: event.payload.boundaryRoot,
          dirtyStatePolicy: event.payload.dirtyStatePolicy,
        };
        failureReason = undefined;
        unavailableReason = undefined;
        unavailableSource = undefined;
        requiredAction = undefined;
        break;
      case 'workspace.checkout_started':
        status = 'materializing';
        attempts = Math.max(attempts, event.payload.attempt);
        break;
      case 'workspace.ref_resolved':
        // Evidence-only: branch/commit land on the completed payload below.
        break;
      case 'workspace.checkout_completed':
        status = 'ready';
        workspace = {
          kind: 'repo_checkout',
          repo: event.payload.repo,
          branch: event.payload.branch,
          commit: event.payload.commit,
          checkoutPath: event.payload.checkoutPath,
          dirtyStatePolicy: event.payload.dirtyStatePolicy,
        };
        failureReason = undefined;
        unavailableReason = undefined;
        unavailableSource = undefined;
        requiredAction = undefined;
        break;
      case 'workspace.checkout_failed':
        status = 'failed';
        failureReason = event.payload.reason;
        workspace = undefined;
        break;
      case 'workspace.unavailable':
        status = 'unavailable';
        unavailableReason = event.payload.reason;
        unavailableSource = event.payload.source;
        requiredAction = event.payload.requiredAction;
        workspace = undefined;
        break;
      default:
        continue;
    }
    if (event.sequence > lastSequence) {
      lastSequence = event.sequence;
    }
  }

  return {
    runId: targetRunId,
    status,
    workspace,
    attempts,
    unavailableReason,
    unavailableSource,
    requiredAction,
    failureReason,
    lastSequence,
  };
}

/**
 * Map a ready workspace to build-contract evidence (`deriveBuildContract`'s
 * optional 4th argument), so the contract's workspace/write-boundary fields
 * reflect what was ACTUALLY materialized. Returns `undefined` when the
 * workspace is not ready (the contract keeps its payload-derived description).
 */
export function workspaceContractEvidence(
  projection: WorkspaceProjection,
): { workspace: string; writeBoundaries: readonly string[] } | undefined {
  if (projection.status !== 'ready' || projection.workspace === undefined) {
    return undefined;
  }
  const ws = projection.workspace;
  if (ws.kind === 'local_folder') {
    return {
      workspace: `Local folder (bound): ${ws.path} [dirty-state policy: ${ws.dirtyStatePolicy}]`,
      writeBoundaries: [`Writes are limited to ${ws.path}.`],
    };
  }
  return {
    workspace: `GitHub repository: ${ws.repo} checked out at ${ws.checkoutPath} (branch ${ws.branch}, commit ${ws.commit}) [dirty-state policy: ${ws.dirtyStatePolicy}]`,
    writeBoundaries: [`Writes are limited to the checkout at ${ws.checkoutPath}.`],
  };
}
