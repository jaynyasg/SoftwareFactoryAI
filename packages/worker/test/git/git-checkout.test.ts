/**
 * git-checkout (full-factory U4) — repo-reference parsing, credential-safe
 * clone argv, branch/commit resolution, and sanitized failures, behind the
 * fake `CommandRunner` (no network, no real git — the git-destination pattern).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCommandGitCheckoutClient,
  parseGitHubRepo,
  sanitizeCheckoutDetail,
} from '../../src/index';
import type { GitHubRepoRef } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

const TOKEN = 'ghp_SuperSecretCheckoutToken1234';
const COMMIT = 'abc123def4567890abc123def4567890abc123de';

describe('parseGitHubRepo', () => {
  it('parses owner/repo', () => {
    const parsed = parseGitHubRepo('octo/marketplace');
    expect(parsed).toMatchObject({
      owner: 'octo',
      repo: 'marketplace',
      slug: 'octo/marketplace',
      remoteUrl: 'https://github.com/octo/marketplace.git',
    });
  });

  it('parses https URLs with or without .git and trailing slash', () => {
    expect(parseGitHubRepo('https://github.com/octo/app')?.slug).toBe('octo/app');
    expect(parseGitHubRepo('https://github.com/octo/app.git')?.slug).toBe('octo/app');
    expect(parseGitHubRepo('https://github.com/octo/app/')?.slug).toBe('octo/app');
  });

  it('parses ssh form', () => {
    expect(parseGitHubRepo('git@github.com:octo/app.git')?.slug).toBe('octo/app');
  });

  it('DISCARDS userinfo credentials embedded in a URL', () => {
    const parsed = parseGitHubRepo(`https://${TOKEN}@github.com/octo/app.git`);
    expect(parsed?.slug).toBe('octo/app');
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  it('rejects non-repo inputs', () => {
    expect(parseGitHubRepo('')).toBeNull();
    expect(parseGitHubRepo('not a repo!!')).toBeNull();
    expect(parseGitHubRepo('https://example.com/octo/app')).toBeNull();
    expect(parseGitHubRepo('justoneword')).toBeNull();
  });
});

describe('sanitizeCheckoutDetail', () => {
  it('strips URL userinfo credentials', () => {
    expect(
      sanitizeCheckoutDetail(
        `fatal: could not read https://x-access-token:${TOKEN}@github.com/o/r.git`,
      ),
    ).not.toContain(TOKEN);
  });

  it('strips bare GitHub token literals', () => {
    expect(sanitizeCheckoutDetail(`auth failed for ${TOKEN}`)).not.toContain(TOKEN);
    expect(sanitizeCheckoutDetail('auth failed for github_pat_11AAAA0000bbbbCCCC')).not.toContain(
      'github_pat_11AAAA0000bbbbCCCC',
    );
  });

  it('leaves ordinary detail intact', () => {
    expect(sanitizeCheckoutDetail('branch main not found')).toBe('branch main not found');
  });
});

describe('createCommandGitCheckoutClient', () => {
  let dest: string;
  const repo: GitHubRepoRef = {
    owner: 'octo',
    repo: 'app',
    slug: 'octo/app',
    remoteUrl: 'https://github.com/octo/app.git',
  };

  beforeEach(async () => {
    dest = join(await mkdtemp(join(tmpdir(), 'sf-checkout-')), 'run-1');
  });

  afterEach(async () => {
    await rm(join(dest, '..'), { recursive: true, force: true });
  });

  function runner(
    overrides: Record<string, { code: number; stdout: string; stderr: string }> = {},
  ) {
    return createFakeRunner({
      responses: {
        'git clone': { code: 0, stdout: '', stderr: '' },
        'git rev-parse': { code: 0, stdout: `${COMMIT}\n`, stderr: '' },
        ...overrides,
      },
      fallback: { code: 0, stdout: '', stderr: '' },
    });
  }

  it('clones shallow and resolves branch + commit', async () => {
    const fake = createFakeRunner({
      responses: { 'git clone': { code: 0, stdout: '', stderr: '' } },
      // rev-parse HEAD then rev-parse --abbrev-ref HEAD share a key; return the
      // commit for both — branch assertions use the argv instead.
      fallback: { code: 0, stdout: `${COMMIT}\n`, stderr: '' },
    });
    const client = createCommandGitCheckoutClient(fake);
    const result = await client.checkout({ repo, dest });

    expect(result.commit).toBe(COMMIT);
    const argv = fake.calls.map((call) => call.args.join(' '));
    expect(argv[0]).toBe(`clone --depth 1 https://github.com/octo/app.git ${dest}`);
    expect(argv).toContain('rev-parse HEAD');
    expect(argv).toContain('rev-parse --abbrev-ref HEAD');
  });

  it('passes --branch when requested', async () => {
    const fake = runner();
    const client = createCommandGitCheckoutClient(fake);
    await client.checkout({ repo, dest, branch: 'develop' });
    expect(fake.calls[0].args.join(' ')).toContain('--branch develop');
  });

  it('passes credentials via the git config ENVIRONMENT — never on the argv — and never throws them', async () => {
    const fake = runner({ 'git clone': { code: 128, stdout: '', stderr: 'fatal: auth failed' } });
    const client = createCommandGitCheckoutClient(fake, { credentials: () => TOKEN });

    await expect(client.checkout({ repo, dest })).rejects.toThrow(/auth failed/);
    // The argv NEVER carries the token (a process listing is world-readable);
    // the clone URL stays credential-free.
    const cloneCall = fake.calls[0];
    expect(cloneCall.args.join(' ')).not.toContain(TOKEN);
    expect(cloneCall.args.join(' ')).toContain('https://github.com/octo/app.git');
    // The credential rides in the exec-time-only git config environment as a
    // Basic Authorization header.
    const env = cloneCall.options?.env ?? {};
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64')}`,
    );
    // Follow-up rev-parse commands run WITHOUT the auth environment.
    // …and the surfaced error is sanitized.
    try {
      await client.checkout({ repo, dest });
      expect.unreachable('checkout should reject');
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });

  it('scopes the auth environment to the clone command only', async () => {
    const fake = runner();
    const client = createCommandGitCheckoutClient(fake, { credentials: () => TOKEN });
    await client.checkout({ repo, dest });
    expect(fake.calls[0].options?.env?.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    for (const call of fake.calls.slice(1)) {
      expect(call.options?.env).toBeUndefined();
    }
    // No call anywhere carries the raw token on its argv.
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
    }
  });

  it('uses the remote-URL override when provided (local fixtures, no credential env)', async () => {
    const fake = runner();
    const client = createCommandGitCheckoutClient(fake, { credentials: () => TOKEN });
    await client.checkout({ repo, dest, remoteUrl: 'C:\\fixtures\\repo' });
    // Non-https remotes never receive credentials in any form.
    expect(fake.calls[0].args.join(' ')).toContain('C:\\fixtures\\repo');
    expect(fake.calls[0].args.join(' ')).not.toContain(TOKEN);
    expect(fake.calls[0].options?.env).toBeUndefined();
  });
});
