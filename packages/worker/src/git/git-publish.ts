/**
 * Publish a completed run's repo-checkout workspace back to its GitHub remote
 * (the "ship the deliverable" action on the completion report).
 *
 * Mirrors `git-checkout.ts` discipline (E5): the checkout token is read at
 * exec time only, rides the git config ENVIRONMENT as an Authorization header
 * (never the argv), and every surfaced error is credential-sanitized. The
 * push targets the credential-free https remote URL directly, so no remote
 * config is ever rewritten with secrets.
 */
import type { CommandRunner } from '@software-factory/core';
import { errorMessage } from '../utils/error';
import { checkoutAuthEnv, sanitizeCheckoutDetail } from './git-checkout';

/** Bounded timeout so a stalled push cannot hang the publish request. */
const GIT_PUBLISH_TIMEOUT_MS = 180_000;

/** Identity recorded on factory-made publish commits (env, not argv). */
const COMMIT_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Software Factory',
  GIT_AUTHOR_EMAIL: 'factory@local',
  GIT_COMMITTER_NAME: 'Software Factory',
  GIT_COMMITTER_EMAIL: 'factory@local',
};

/** The outcome of one publish attempt. */
export interface GitPublishResult {
  readonly pushed: boolean;
  /** HEAD commit sha after the publish commit (absent on empty repos). */
  readonly commit?: string;
  readonly branch: string;
  /** `true` when the workspace had no changes beyond what was already committed. */
  readonly noChanges: boolean;
  readonly note?: string;
}

/** Arguments for one publish. */
export interface GitPublishArgs {
  /** Absolute checkout directory to publish from. */
  readonly dest: string;
  /** Credential-free https remote URL to push to. */
  readonly remoteUrl: string;
  /** Branch to push HEAD to (the checkout's branch). */
  readonly branch: string;
  /** Commit message for uncommitted workspace changes. */
  readonly message: string;
  readonly signal?: AbortSignal;
}

/** The injectable publish client (tests substitute a fake — no network). */
export interface GitPublishClient {
  publish(args: GitPublishArgs): Promise<GitPublishResult>;
}

/** Options for the default command-backed client. */
export interface CommandGitPublishClientOptions {
  /** Exec-time-only credential provider (E5) — never recorded or returned. */
  readonly credentials?: () => string | undefined;
  readonly timeoutMs?: number;
}

/** The default `GitPublishClient` backed by the shared `CommandRunner`. */
export function createCommandGitPublishClient(
  runner: CommandRunner,
  options: CommandGitPublishClientOptions = {},
): GitPublishClient {
  const timeoutMs = options.timeoutMs ?? GIT_PUBLISH_TIMEOUT_MS;

  const git = async (
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>,
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    return runner.run('git', args, { cwd, signal, timeoutMs, env });
  };

  return {
    async publish(args: GitPublishArgs): Promise<GitPublishResult> {
      const token = options.credentials?.();
      const authEnv =
        token !== undefined && token.length > 0 && /^https:\/\//i.test(args.remoteUrl)
          ? checkoutAuthEnv(token)
          : undefined;
      try {
        const add = await git(['add', '-A'], args.dest, args.signal);
        if (add.code !== 0) {
          throw new Error(`git add failed (exit ${add.code}): ${add.stderr.trim()}`);
        }

        const commit = await git(
          ['commit', '-m', args.message],
          args.dest,
          args.signal,
          COMMIT_IDENTITY,
        );
        const noChanges =
          commit.code !== 0 && /nothing to commit|no changes added/i.test(commit.stdout + commit.stderr);
        if (commit.code !== 0 && !noChanges) {
          throw new Error(`git commit failed (exit ${commit.code}): ${commit.stderr.trim() || commit.stdout.trim()}`);
        }

        const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], args.dest, args.signal);
        if (head.code !== 0) {
          return {
            pushed: false,
            branch: args.branch,
            noChanges: true,
            note: 'The workspace has no commits — nothing to publish.',
          };
        }

        const push = await git(
          ['push', args.remoteUrl, `HEAD:${args.branch}`],
          args.dest,
          args.signal,
          authEnv,
        );
        if (push.code !== 0) {
          throw new Error(`git push failed (exit ${push.code}): ${push.stderr.trim()}`);
        }

        return {
          pushed: true,
          commit: head.stdout.trim(),
          branch: args.branch,
          noChanges,
          note: noChanges ? 'No new changes; existing commits were pushed.' : undefined,
        };
      } catch (error) {
        // Belt-and-braces: no credential value may reach a caller/ledger (E5).
        throw new Error(sanitizeCheckoutDetail(errorMessage(error)));
      }
    },
  };
}
