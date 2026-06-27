/**
 * Resolve the Git destination for a packaged repo, then (optionally) push it.
 *
 * Resolution order (pure, no I/O):
 *   1. a USER-PROVIDED GitHub destination is always preferred,
 *   2. else, when permitted, a FACTORY-OWNED TEMPORARY repo whose ownership is
 *      MARKED temporary (in the descriptor and in provenance) so it can be
 *      cleaned up,
 *   3. else a SETUP-REQUIRED outcome the caller turns into `deploy.setup_required`
 *      — WITHOUT failing the local run.
 *
 * The actual remote interaction (create repo, push) sits behind an injectable
 * `GitRemoteClient`, so tests never touch the network. The default client runs
 * `git` through the shared `CommandRunner`; real GitHub repo CREATION for the
 * temporary fallback is deferred (see the runbook / TODOS) and the default client
 * reports it as not-created rather than pretending.
 */
import type { CommandRunner, ProvenanceGitDestination } from '@software-factory/core';

/** A user-provided GitHub destination (the preferred target). */
export interface GitHubDestinationConfig {
  readonly owner: string;
  readonly repo: string;
  readonly defaultBranch?: string;
  /** Explicit remote URL; derived from owner/repo when omitted. */
  readonly remoteUrl?: string;
}

/** Options for resolving a destination. */
export interface ResolveGitDestinationOptions {
  readonly runId: string;
  readonly artifactId?: string;
  /** User-provided GitHub destination (preferred when present). */
  readonly github?: GitHubDestinationConfig;
  /** Whether a factory-owned temporary repo may be used as a fallback. */
  readonly allowTemporary?: boolean;
  /** Owner namespace for the temporary repo (default `software-factory`). */
  readonly temporaryOwner?: string;
}

/** Who owns the destination repo. */
export type GitOwnership = 'user' | 'temporary';

/** A resolved git destination. */
export interface GitDestinationDescriptor {
  readonly kind: GitOwnership;
  readonly owner: string;
  readonly repo: string;
  readonly remoteUrl: string;
  readonly defaultBranch: string;
  /** `true` only for a factory-owned temporary repo (cleanup required). */
  readonly temporary: boolean;
  readonly cleanupNote?: string;
}

/** The outcome of resolving a destination: resolved, or setup-required. */
export type GitDestinationOutcome =
  | { readonly ok: true; readonly descriptor: GitDestinationDescriptor }
  | {
      readonly ok: false;
      readonly setupRequired: true;
      readonly action: string;
      readonly reason: string;
    };

const DEFAULT_BRANCH = 'main';
const DEFAULT_TEMPORARY_OWNER = 'software-factory';

/** GitHub web/clone URL for an owner/repo. */
export function gitHubRemoteUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/** Filesystem/URL-safe slug for a repo name component. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Resolve the git destination. Pure: prefers the user GitHub destination, falls
 * back to a marked-temporary factory repo when permitted, otherwise returns a
 * setup-required outcome (the caller emits `deploy.setup_required`).
 */
export function resolveGitDestination(
  options: ResolveGitDestinationOptions,
): GitDestinationOutcome {
  const { github } = options;
  if (github !== undefined && github.owner.length > 0 && github.repo.length > 0) {
    return {
      ok: true,
      descriptor: {
        kind: 'user',
        owner: github.owner,
        repo: github.repo,
        remoteUrl: github.remoteUrl ?? gitHubRemoteUrl(github.owner, github.repo),
        defaultBranch: github.defaultBranch ?? DEFAULT_BRANCH,
        temporary: false,
      },
    };
  }

  if (options.allowTemporary === true) {
    const owner = options.temporaryOwner ?? DEFAULT_TEMPORARY_OWNER;
    const repo = slug(`sf-temp-${options.runId}`);
    return {
      ok: true,
      descriptor: {
        kind: 'temporary',
        owner,
        repo,
        remoteUrl: gitHubRemoteUrl(owner, repo),
        defaultBranch: DEFAULT_BRANCH,
        temporary: true,
        cleanupNote:
          'Factory-owned TEMPORARY repo. Hand off to the user (fork/transfer) or ' +
          'delete it after the retention window — see docs/runbooks/render-deployment.md.',
      },
    };
  }

  return {
    ok: false,
    setupRequired: true,
    action:
      'Connect a GitHub destination (owner/repo), or permit a factory-owned temporary repo.',
    reason:
      'No GitHub destination is configured and a factory-owned temporary repo is not permitted.',
  };
}

/** Map a resolved descriptor to the portable provenance shape. */
export function toProvenanceGitDestination(
  descriptor: GitDestinationDescriptor,
): ProvenanceGitDestination {
  return {
    kind: descriptor.kind,
    owner: descriptor.owner,
    repo: descriptor.repo,
    remoteUrl: descriptor.remoteUrl,
    temporary: descriptor.temporary,
    cleanupNote: descriptor.cleanupNote,
  };
}

/* ----------------------------------------------------------------------------
 * Remote interaction behind an injectable client (no network in tests)
 * ------------------------------------------------------------------------- */

/** The result of ensuring a remote repo exists. */
export interface EnsureRepoResult {
  /** `true` when this call created the repo (false when it already existed). */
  readonly created: boolean;
  readonly remoteUrl: string;
  /** Detail when the repo could not be created (e.g. creation deferred). */
  readonly note?: string;
}

/** The result of pushing a local repo to the remote. */
export interface PushResult {
  readonly pushed: boolean;
  readonly remoteUrl: string;
  readonly branch: string;
  readonly note?: string;
}

/** Arguments for a push. */
export interface PushArgs {
  readonly descriptor: GitDestinationDescriptor;
  /** Absolute path to the local packaged repo. */
  readonly localPath: string;
  readonly commit: string;
  readonly branch?: string;
  readonly signal?: AbortSignal;
}

/** The injectable remote client (tests substitute a stub — no network). */
export interface GitRemoteClient {
  ensureRepo(
    descriptor: GitDestinationDescriptor,
    options?: { readonly signal?: AbortSignal },
  ): Promise<EnsureRepoResult>;
  push(args: PushArgs): Promise<PushResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The default `GitRemoteClient` backed by the shared `CommandRunner`.
 *
 * `push` configures the `origin` remote then `git push -u origin <branch>`.
 * `ensureRepo` is a deliberate no-op for an existing user repo; real GitHub
 * repo CREATION for the temporary fallback is deferred (it needs the GitHub API)
 * and is reported honestly as `created: false` with a note.
 */
export function createCommandGitRemoteClient(runner: CommandRunner): GitRemoteClient {
  const git = async (
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await runner.run('git', args, { cwd, signal });
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`);
    }
  };

  return {
    ensureRepo(descriptor) {
      return Promise.resolve({
        created: false,
        remoteUrl: descriptor.remoteUrl,
        note:
          descriptor.temporary === true
            ? 'Temporary-repo creation via the GitHub API is deferred; assuming the remote exists.'
            : undefined,
      });
    },
    async push(args) {
      const branch = args.branch ?? args.descriptor.defaultBranch;
      try {
        // Re-point origin idempotently: remove if present, then add.
        await runner.run('git', ['remote', 'remove', 'origin'], { cwd: args.localPath });
        await git(args.localPath, ['remote', 'add', 'origin', args.descriptor.remoteUrl], args.signal);
        await git(args.localPath, ['push', '-u', 'origin', branch], args.signal);
        return { pushed: true, remoteUrl: args.descriptor.remoteUrl, branch };
      } catch (error) {
        return {
          pushed: false,
          remoteUrl: args.descriptor.remoteUrl,
          branch,
          note: messageOf(error),
        };
      }
    },
  };
}

/** Parameters for the convenience resolve+ensure+push flow. */
export interface PushToDestinationParams extends ResolveGitDestinationOptions {
  readonly localPath: string;
  readonly commit: string;
  readonly branch?: string;
  readonly signal?: AbortSignal;
}

/** The outcome of `pushToDestination`. */
export type PushToDestinationOutcome =
  | {
      readonly ok: true;
      readonly descriptor: GitDestinationDescriptor;
      readonly ensure: EnsureRepoResult;
      readonly push: PushResult;
    }
  | {
      readonly ok: false;
      readonly setupRequired: true;
      readonly action: string;
      readonly reason: string;
    };

/**
 * Resolve the destination then ensure + push via the injected client. Returns a
 * setup-required outcome (without throwing) when no destination can be resolved.
 */
export async function pushToDestination(
  params: PushToDestinationParams,
  client: GitRemoteClient,
): Promise<PushToDestinationOutcome> {
  const resolution = resolveGitDestination(params);
  if (!resolution.ok) {
    return resolution;
  }
  const { descriptor } = resolution;
  const ensure = await client.ensureRepo(descriptor, { signal: params.signal });
  const push = await client.push({
    descriptor,
    localPath: params.localPath,
    commit: params.commit,
    branch: params.branch,
    signal: params.signal,
  });
  return { ok: true, descriptor, ensure, push };
}
