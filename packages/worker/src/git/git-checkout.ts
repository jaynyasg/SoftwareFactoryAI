/**
 * Repository checkout for workspace materialization (full-factory U4).
 *
 * Mirrors `git-destination.ts`: the actual remote interaction sits behind an
 * injectable `GitCheckoutClient` so tests never touch the network; the default
 * client runs `git` through the shared `CommandRunner`.
 *
 * Credential handling (hardening E5): source checkout credentials are their own
 * setup surface (`SF_GIT_CHECKOUT_TOKEN` — separate from deploy and research
 * credentials). The token is read through an injected provider at exec time and
 * passed to git through its config ENVIRONMENT (`GIT_CONFIG_*` ->
 * `http.extraHeader` with a Basic Authorization header) — NEVER on the child
 * process argv, where any user on the machine could read it from the process
 * listing. Error messages are still stripped of anything credential-shaped
 * before they can reach ledger evidence (`sanitizeCheckoutDetail`). No
 * credential value is ever returned or recorded.
 */
import { rm } from 'node:fs/promises';
import type { CommandRunner } from '@software-factory/core';
import { errorMessage } from '../utils/error';
import { gitHubRemoteUrl } from './git-destination';

/** Bounded timeout so a stalled clone cannot hang materialization forever. */
const GIT_CHECKOUT_TIMEOUT_MS = 180_000;

/** A parsed GitHub repository reference. */
export interface GitHubRepoRef {
  readonly owner: string;
  readonly repo: string;
  /** Credential-free https remote URL (display/evidence safe). */
  readonly remoteUrl: string;
  /** Canonical `owner/repo` display form recorded in evidence. */
  readonly slug: string;
}

/**
 * Parse an operator-supplied GitHub repo input: `owner/repo`, an https URL, or
 * an ssh form. Returns `null` for anything that does not identify a repo.
 * Any userinfo credentials embedded in a URL are DISCARDED, never kept.
 */
export function parseGitHubRepo(input: string): GitHubRepoRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let ownerRepo: string | undefined;
  const httpsMatch =
    /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  const sshMatch = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  const bareMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  if (httpsMatch !== null) {
    ownerRepo = `${httpsMatch[1]}/${httpsMatch[2]}`;
  } else if (sshMatch !== null) {
    ownerRepo = `${sshMatch[1]}/${sshMatch[2]}`;
  } else if (bareMatch !== null) {
    ownerRepo = `${bareMatch[1]}/${bareMatch[2]}`;
  }
  if (ownerRepo === undefined) {
    return null;
  }
  const [owner, repo] = ownerRepo.split('/');
  return { owner, repo, remoteUrl: gitHubRemoteUrl(owner, repo), slug: `${owner}/${repo}` };
}

/**
 * Strip anything credential-shaped from a checkout detail before it becomes
 * ledger evidence: URL userinfo (`https://token@…` / `user:token@…`) and
 * common token literals (`ghp_…`, `github_pat_…`).
 */
export function sanitizeCheckoutDetail(text: string): string {
  return text
    .replace(/(https?:\/\/)[^@/\s]+@/gi, '$1***@')
    .replace(/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{8,}\b/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, '***');
}

/** What a completed checkout resolved to. */
export interface GitCheckoutResult {
  readonly branch: string;
  readonly commit: string;
}

/** Arguments for one checkout. */
export interface GitCheckoutArgs {
  readonly repo: GitHubRepoRef;
  /** Remote to clone from (defaults to `repo.remoteUrl`; tests may override). */
  readonly remoteUrl?: string;
  /** Absolute destination directory (recreated fresh per attempt). */
  readonly dest: string;
  readonly branch?: string;
  readonly signal?: AbortSignal;
}

/** The injectable checkout client (tests substitute a fake — no network). */
export interface GitCheckoutClient {
  checkout(args: GitCheckoutArgs): Promise<GitCheckoutResult>;
}

/** Options for the default command-backed client. */
export interface CommandGitCheckoutClientOptions {
  /**
   * Source checkout credential provider, read at exec time only (E5). The
   * value is handed to git through its config ENVIRONMENT (never the argv,
   * which is world-readable via the process listing) and never returned,
   * logged, or recorded.
   */
  readonly credentials?: () => string | undefined;
  readonly timeoutMs?: number;
}

/**
 * Build the exec-time-only git config ENVIRONMENT that authenticates an https
 * clone: `GIT_CONFIG_*` -> `http.extraHeader` with a Basic Authorization
 * header for `x-access-token:<token>`. The token never appears on the child
 * process argv (E5) — env vars are readable only by the same user, argv by
 * every user on the machine.
 */
function checkoutAuthEnv(token: string): Readonly<Record<string, string>> {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/**
 * The default `GitCheckoutClient` backed by the shared `CommandRunner`:
 * `git clone --depth 1 [--branch <b>] <url> <dest>` then `git rev-parse` for
 * the branch + commit evidence. The destination is recreated fresh so a retry
 * after a failed attempt starts clean. Every thrown error is sanitized.
 */
export function createCommandGitCheckoutClient(
  runner: CommandRunner,
  options: CommandGitCheckoutClientOptions = {},
): GitCheckoutClient {
  const timeoutMs = options.timeoutMs ?? GIT_CHECKOUT_TIMEOUT_MS;

  const git = async (
    args: readonly string[],
    cwd: string | undefined,
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const result = await runner.run('git', args, { cwd, signal, timeoutMs, env });
    if (result.code !== 0) {
      throw new Error(
        sanitizeCheckoutDetail(
          `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`,
        ),
      );
    }
    return result.stdout.trim();
  };

  return {
    async checkout(args: GitCheckoutArgs): Promise<GitCheckoutResult> {
      const cloneUrl = args.remoteUrl ?? args.repo.remoteUrl;
      const token = options.credentials?.();
      // Exec-time-only credential ENV; the clone URL stays credential-free on
      // the argv. Non-https remotes (local fixtures) never receive auth.
      const authEnv =
        token !== undefined && token.length > 0 && /^https:\/\//i.test(cloneUrl)
          ? checkoutAuthEnv(token)
          : undefined;
      try {
        // Fresh destination per attempt so failed clones cannot poison retries.
        await rm(args.dest, { recursive: true, force: true });
        const cloneArgs = ['clone', '--depth', '1'];
        if (args.branch !== undefined && args.branch.length > 0) {
          cloneArgs.push('--branch', args.branch);
        }
        cloneArgs.push(cloneUrl, args.dest);
        await git(cloneArgs, undefined, args.signal, authEnv);
        const commit = await git(['rev-parse', 'HEAD'], args.dest, args.signal);
        const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], args.dest, args.signal);
        return { branch, commit };
      } catch (error) {
        // Belt-and-braces: sanitize once more in case a raw error escaped.
        throw new Error(sanitizeCheckoutDetail(errorMessage(error)));
      }
    },
  };
}
