/**
 * Workspace materialization (full-factory U4).
 *
 * Materializes a trustworthy workspace for a run — a bound local folder in
 * local mode, or a repository checkout in local/cloud mode — while making
 * unavailable or unsafe source inputs EXPLICIT on the ledger:
 *
 *  - KTD5: cloud runs never pretend to read laptop paths. A local-only folder
 *    on a cloud runtime records `workspace.unavailable` with a required action.
 *  - Local folders are admitted only when they resolve inside the approved
 *    working boundary or an explicitly chosen operator folder; traversal and
 *    outside-boundary paths are rejected with `security.block` evidence.
 *  - Repository checkouts record repo, branch, commit, checkout path, and the
 *    dirty-state policy as evidence (`workspace.checkout_*` / `ref_resolved`).
 *  - Materialization is SEPARATE from worker execution: it can be retried
 *    after setup changes. Retries converge — success events are idempotent on
 *    their material facts, unavailable evidence is idempotent on its reason,
 *    and new checkout attempts increment an explicit attempt counter.
 *  - E5: source checkout credentials live behind the injected
 *    `GitCheckoutClient`; no credential value ever reaches an event payload
 *    (failure reasons pass through `sanitizeCheckoutDetail`).
 */
import { stat } from 'node:fs/promises';
import { contractDigest } from '@software-factory/core';
import type {
  AppendableEvent,
  DirtyStatePolicy,
  EventActor,
  EventStore,
  WorkspaceSourceKind,
} from '@software-factory/core';
import { errorMessage } from '../utils/error';
import { parseGitHubRepo, sanitizeCheckoutDetail } from '../git/git-checkout';
import type { GitCheckoutClient } from '../git/git-checkout';
import { DEFAULT_PATH_KIT, resolveLocalWorkspacePath } from './workspace-policy';
import type { PathKit, WorkspaceLocalPolicy } from './workspace-policy';
import { projectWorkspace } from './workspace-projection';
import type { MaterializedWorkspace, WorkspaceProjection } from './workspace-projection';

const WORKSPACE_ACTOR: EventActor = {
  kind: 'workspace',
  id: 'workspace-materializer',
  display: 'Workspace materializer',
};

/** One materialization request (derived from `run.created` + runtime config). */
export interface WorkspaceMaterializationRequest {
  readonly runId: string;
  /** Runtime visibility: cloud runtimes cannot read operator laptop paths. */
  readonly runtimeMode: 'local' | 'cloud';
  /** Operator-supplied local folder, when any. */
  readonly localFolder?: string;
  /** GitHub repository (owner/repo or URL), when any. */
  readonly githubRepo?: string;
  /** Requested branch for repository checkouts. */
  readonly branch?: string;
  /** Root directory repository checkouts are created under. */
  readonly checkoutRoot?: string;
  /** Local-boundary policy (local mode only). */
  readonly localPolicy?: WorkspaceLocalPolicy;
  /** Recorded dirty-state policy for bound local folders. */
  readonly dirtyStatePolicy?: Exclude<DirtyStatePolicy, 'clean_checkout'>;
  /** Remote-URL override for repository checkouts (tests / local mirrors). */
  readonly remoteUrlOverride?: string;
  readonly signal?: AbortSignal;
}

/** Collaborators. Only repo materialization needs the git client. */
export interface WorkspaceMaterializerDeps {
  readonly store: EventStore;
  readonly git?: GitCheckoutClient;
  readonly clock?: () => number;
  /** Path primitives (injectable so tests can pin win32/posix semantics). */
  readonly pathKit?: PathKit;
  /** Directory probe (injectable for tests). Default: `fs.stat`. */
  readonly isDirectory?: (path: string) => Promise<boolean>;
}

/** The outcome of one materialization pass. The ledger carries full detail. */
export type WorkspaceMaterializationResult =
  | {
      readonly ok: true;
      readonly workspace: MaterializedWorkspace;
      /** `true` when an existing ready workspace was reused (no new events). */
      readonly converged: boolean;
    }
  | {
      readonly ok: false;
      readonly outcome: 'unavailable';
      readonly source: WorkspaceSourceKind;
      readonly reason: string;
      readonly requiredAction?: string;
      /** `true` when the rejection also recorded `security.block` evidence. */
      readonly securityBlocked: boolean;
    }
  | {
      readonly ok: false;
      readonly outcome: 'checkout_failed';
      readonly reason: string;
      /** The attempt number that failed (retries increment it). */
      readonly attempt: number;
    };

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Materialize the workspace for a run, emitting `workspace.*` (and, for
 * boundary violations, `security.block`) events into the store. Never throws
 * for source/setup/checkout problems — those become explicit ledger states.
 */
export async function materializeWorkspace(
  request: WorkspaceMaterializationRequest,
  deps: WorkspaceMaterializerDeps,
): Promise<WorkspaceMaterializationResult> {
  const { store } = deps;
  const clock = deps.clock ?? Date.now;
  const kit = deps.pathKit ?? DEFAULT_PATH_KIT;
  const isDirectory = deps.isDirectory ?? defaultIsDirectory;
  const { runId } = request;
  const subject = { kind: 'workspace', id: runId } as const;

  const append = (event: Omit<AppendableEvent, 'runId' | 'timestamp'>): Promise<unknown> =>
    store.append({ ...event, runId, timestamp: clock() } as AppendableEvent);

  const recordUnavailable = async (
    source: WorkspaceSourceKind,
    reason: string,
    requiredAction: string | undefined,
    securityBlocked: boolean,
  ): Promise<WorkspaceMaterializationResult> => {
    if (securityBlocked) {
      // Boundary/traversal rejections are fail-closed security evidence, in
      // the same class as sandbox path escapes (`security.block`).
      await append({
        type: 'security.block',
        actor: WORKSPACE_ACTOR,
        subject,
        severity: 'critical',
        idempotencyKey: `${runId}:security.block:workspace:${contractDigest(reason)}`,
        payload: { reason },
      });
    }
    // Idempotent on the material facts: retrying with unchanged setup
    // converges on the same evidence instead of stacking duplicates.
    await append({
      type: 'workspace.unavailable',
      actor: WORKSPACE_ACTOR,
      subject,
      severity: 'warn',
      idempotencyKey: `${runId}:workspace.unavailable:${contractDigest(
        `${source}|${reason}|${requiredAction ?? ''}`,
      )}`,
      payload: { reason, source, requiredAction },
    });
    return { ok: false, outcome: 'unavailable', source, reason, requiredAction, securityBlocked };
  };

  // Replay first: an already-ready workspace for the same source converges
  // without re-materializing or duplicating evidence.
  const existing: WorkspaceProjection = projectWorkspace(await store.readRun(runId), runId);
  const converged = convergedWorkspace(existing, request, kit);
  if (converged !== undefined) {
    return { ok: true, workspace: converged, converged: true };
  }

  const wantsLocal = request.localFolder !== undefined && request.localFolder.length > 0;
  const wantsRepo = request.githubRepo !== undefined && request.githubRepo.length > 0;

  // KTD5: a cloud runtime never pretends it can read a laptop path. When the
  // local folder is the ONLY source, the workspace is explicitly unavailable;
  // when a repo is also supplied, the repo backs the workspace instead.
  if (request.runtimeMode === 'cloud' && wantsLocal && !wantsRepo) {
    return recordUnavailable(
      'local_folder',
      `Local folder "${request.localFolder}" is not readable from the cloud runtime; cloud runs never read laptop paths.`,
      'Provide a GitHub repository, upload the PRD content, or use a future upload/sync input.',
      false,
    );
  }

  // Local mode prefers the operator's local folder when both are supplied
  // (mirrors the build contract's workspace precedence).
  if (request.runtimeMode === 'local' && wantsLocal) {
    return bindLocalFolder(request, { append, recordUnavailable, isDirectory, kit });
  }

  if (wantsRepo) {
    return checkoutRepository(request, existing, deps, { append, recordUnavailable, kit });
  }

  return recordUnavailable(
    'none',
    'The run supplied no source workspace input (no local folder or GitHub repository).',
    'Provide a local folder (local runs) or a GitHub repository — prompt/PRD-only runs receive a fresh generated workspace when execution starts.',
    false,
  );
}

/** An existing ready workspace that satisfies the request, or `undefined`. */
function convergedWorkspace(
  existing: WorkspaceProjection,
  request: WorkspaceMaterializationRequest,
  kit: PathKit,
): MaterializedWorkspace | undefined {
  if (existing.status !== 'ready' || existing.workspace === undefined) {
    return undefined;
  }
  const ws = existing.workspace;
  if (ws.kind === 'local_folder' && request.runtimeMode === 'local' && request.localFolder !== undefined) {
    const resolution = resolveLocalWorkspacePath(request.localPolicy ?? {}, request.localFolder, kit);
    if (resolution.ok && resolution.resolved === ws.path) {
      return ws;
    }
    return undefined;
  }
  if (ws.kind === 'repo_checkout' && request.githubRepo !== undefined) {
    const parsed = parseGitHubRepo(request.githubRepo);
    if (parsed !== null && parsed.slug === ws.repo) {
      if (request.branch === undefined || request.branch === ws.branch) {
        return ws;
      }
    }
  }
  return undefined;
}

interface MaterializerHelpers {
  append(event: Omit<AppendableEvent, 'runId' | 'timestamp'>): Promise<unknown>;
  recordUnavailable(
    source: WorkspaceSourceKind,
    reason: string,
    requiredAction: string | undefined,
    securityBlocked: boolean,
  ): Promise<WorkspaceMaterializationResult>;
  readonly kit: PathKit;
}

async function bindLocalFolder(
  request: WorkspaceMaterializationRequest,
  helpers: MaterializerHelpers & { isDirectory(path: string): Promise<boolean> },
): Promise<WorkspaceMaterializationResult> {
  const requestedPath = request.localFolder ?? '';
  const resolution = resolveLocalWorkspacePath(
    request.localPolicy ?? {},
    requestedPath,
    helpers.kit,
  );
  if (!resolution.ok) {
    // Traversal / outside-boundary paths are a security rejection; a missing
    // boundary configuration is a setup problem (no security evidence).
    const securityBlocked = resolution.rejection !== 'no_boundary_configured';
    return helpers.recordUnavailable(
      'local_folder',
      resolution.reason,
      securityBlocked
        ? 'Choose a folder inside the approved working boundary, or approve the folder explicitly (SF_WORKSPACE_APPROVED_FOLDERS).'
        : 'Configure the approved working boundary (SF_WORKSPACE_BOUNDARY) or approve the folder explicitly (SF_WORKSPACE_APPROVED_FOLDERS).',
      securityBlocked,
    );
  }
  if (!(await helpers.isDirectory(resolution.resolved))) {
    return helpers.recordUnavailable(
      'local_folder',
      `Local folder "${requestedPath}" does not exist (or is not a directory) under the approved boundary.`,
      'Create the folder or choose an existing folder inside the approved boundary.',
      false,
    );
  }
  const dirtyStatePolicy: DirtyStatePolicy = request.dirtyStatePolicy ?? 'allow_dirty';
  const workspace: MaterializedWorkspace = {
    kind: 'local_folder',
    path: resolution.resolved,
    boundary: resolution.boundary,
    boundaryRoot: resolution.boundaryRoot,
    dirtyStatePolicy,
  };
  await helpers.append({
    type: 'workspace.local_bound',
    actor: WORKSPACE_ACTOR,
    subject: { kind: 'workspace', id: request.runId },
    severity: 'success',
    // Idempotent on the bound path + policy: a retried bind converges.
    idempotencyKey: `${request.runId}:workspace.local_bound:${contractDigest(
      `${resolution.resolved}|${resolution.boundary}|${dirtyStatePolicy}`,
    )}`,
    evidence: [{ label: 'workspace-path', ref: resolution.resolved }],
    payload: {
      path: resolution.resolved,
      requestedPath,
      boundary: resolution.boundary,
      boundaryRoot: resolution.boundaryRoot,
      dirtyStatePolicy,
    },
  });
  return { ok: true, workspace, converged: false };
}

async function checkoutRepository(
  request: WorkspaceMaterializationRequest,
  existing: WorkspaceProjection,
  deps: WorkspaceMaterializerDeps,
  helpers: MaterializerHelpers,
): Promise<WorkspaceMaterializationResult> {
  const parsed = parseGitHubRepo(request.githubRepo ?? '');
  if (parsed === null) {
    return helpers.recordUnavailable(
      'github_repo',
      `GitHub repository "${request.githubRepo}" is not a recognizable owner/repo reference or GitHub URL.`,
      'Provide the repository as owner/repo or a github.com URL.',
      false,
    );
  }
  if (deps.git === undefined) {
    return helpers.recordUnavailable(
      'github_repo',
      'No repository checkout client is configured on this instance.',
      'Configure git-based checkout on this instance, then retry materialization.',
      false,
    );
  }
  if (request.checkoutRoot === undefined || request.checkoutRoot.length === 0) {
    return helpers.recordUnavailable(
      'github_repo',
      'No workspace checkout root is configured on this instance.',
      'Configure the checkout root (SF_WORKSPACE_CHECKOUT_ROOT), then retry materialization.',
      false,
    );
  }

  const attempt = existing.attempts + 1;
  const checkoutPath = helpers.kit.resolve(request.checkoutRoot, request.runId);
  const subject = { kind: 'workspace', id: request.runId } as const;

  await helpers.append({
    type: 'workspace.checkout_started',
    actor: WORKSPACE_ACTOR,
    subject,
    severity: 'info',
    idempotencyKey: `${request.runId}:workspace.checkout_started:${attempt}`,
    payload: {
      repo: parsed.slug,
      requestedBranch: request.branch,
      checkoutPath,
      attempt,
    },
  });

  try {
    const result = await deps.git.checkout({
      repo: parsed,
      remoteUrl: request.remoteUrlOverride,
      dest: checkoutPath,
      branch: request.branch,
      signal: request.signal,
    });
    await helpers.append({
      type: 'workspace.ref_resolved',
      actor: WORKSPACE_ACTOR,
      subject,
      severity: 'info',
      idempotencyKey: `${request.runId}:workspace.ref_resolved:${contractDigest(
        `${parsed.slug}|${result.branch}|${result.commit}`,
      )}`,
      payload: { repo: parsed.slug, branch: result.branch, commit: result.commit },
    });
    const workspace: MaterializedWorkspace = {
      kind: 'repo_checkout',
      repo: parsed.slug,
      branch: result.branch,
      commit: result.commit,
      checkoutPath,
      dirtyStatePolicy: 'clean_checkout',
    };
    await helpers.append({
      type: 'workspace.checkout_completed',
      actor: WORKSPACE_ACTOR,
      subject,
      severity: 'success',
      // Idempotent on the material facts (repo/branch/commit/path).
      idempotencyKey: `${request.runId}:workspace.checkout_completed:${contractDigest(
        `${parsed.slug}|${result.branch}|${result.commit}|${checkoutPath}`,
      )}`,
      evidence: [
        { label: 'repo', ref: parsed.slug },
        { label: 'branch', ref: result.branch },
        { label: 'commit', ref: result.commit },
        { label: 'checkout-path', ref: checkoutPath },
      ],
      payload: {
        repo: parsed.slug,
        branch: result.branch,
        commit: result.commit,
        checkoutPath,
        dirtyStatePolicy: 'clean_checkout',
      },
    });
    return { ok: true, workspace, converged: false };
  } catch (error) {
    // Belt-and-braces sanitization: no credential value may reach evidence (E5).
    const reason = sanitizeCheckoutDetail(errorMessage(error));
    await helpers.append({
      type: 'workspace.checkout_failed',
      actor: WORKSPACE_ACTOR,
      subject,
      severity: 'error',
      idempotencyKey: `${request.runId}:workspace.checkout_failed:${attempt}`,
      payload: { reason, repo: parsed.slug, attempt },
    });
    return { ok: false, outcome: 'checkout_failed', reason, attempt };
  }
}
