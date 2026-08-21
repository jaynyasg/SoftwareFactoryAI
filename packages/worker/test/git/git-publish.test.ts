/**
 * Publish client (completion report "ship it"): commit + push discipline with
 * checkout-token auth on the ENVIRONMENT only, no-change convergence, and
 * credential-sanitized failures — all behind the fake runner (no network).
 */
import { describe, expect, it } from 'vitest';
import { createCommandGitPublishClient } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

const TOKEN = 'ghp_SuperSecretPublishToken1234';
const COMMIT = 'abc123def4567890abc123def4567890abc123de';
const ARGS = {
  dest: 'C:\\ws\\run-1',
  remoteUrl: 'https://github.com/octo/app.git',
  branch: 'main',
  message: 'Software Factory: publish run run-1 deliverable',
};

describe('createCommandGitPublishClient', () => {
  it('adds, commits, and pushes HEAD to the branch with env-only auth', async () => {
    const fake = createFakeRunner({ fallback: { code: 0, stdout: `${COMMIT}\n`, stderr: '' } });
    const client = createCommandGitPublishClient(fake, { credentials: () => TOKEN });
    const result = await client.publish(ARGS);

    expect(result).toMatchObject({ pushed: true, commit: COMMIT, branch: 'main', noChanges: false });
    const argv = fake.calls.map((call) => call.args.join(' '));
    expect(argv[0]).toBe('add -A');
    expect(argv[1]).toContain('commit -m');
    // The factory identity rides the commit ENV, not the argv.
    expect(fake.calls[1].options?.env?.GIT_AUTHOR_NAME).toBe('Software Factory');
    expect(argv[2]).toBe('rev-parse --verify --quiet HEAD');
    expect(argv[3]).toBe('push https://github.com/octo/app.git HEAD:main');
    // Auth rides the git config ENVIRONMENT on the push only, never argv.
    for (const call of fake.calls) {
      expect(call.args.join(' ')).not.toContain(TOKEN);
    }
    expect(fake.calls[3].options?.env?.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
  });

  it('still pushes existing commits when there is nothing new to commit', async () => {
    const fake = createFakeRunner({
      responses: {
        'git commit': { code: 1, stdout: 'nothing to commit, working tree clean', stderr: '' },
        'git rev-parse': { code: 0, stdout: `${COMMIT}\n`, stderr: '' },
      },
      fallback: { code: 0, stdout: '', stderr: '' },
    });
    const client = createCommandGitPublishClient(fake);
    const result = await client.publish(ARGS);
    expect(result.pushed).toBe(true);
    expect(result.noChanges).toBe(true);
  });

  it('reports an empty repository honestly instead of pushing nothing', async () => {
    const fake = createFakeRunner({
      responses: {
        'git commit': { code: 1, stdout: 'nothing to commit', stderr: '' },
        'git rev-parse': { code: 1, stdout: '', stderr: 'fatal: Needed a single revision' },
      },
      fallback: { code: 0, stdout: '', stderr: '' },
    });
    const client = createCommandGitPublishClient(fake);
    const result = await client.publish(ARGS);
    expect(result.pushed).toBe(false);
    expect(result.noChanges).toBe(true);
    expect(fake.calls.some((call) => call.args[0] === 'push')).toBe(false);
  });

  it('sanitizes credentials out of surfaced push failures', async () => {
    const fake = createFakeRunner({
      responses: {
        'git push': { code: 128, stdout: '', stderr: `fatal: auth failed for ${TOKEN}` },
      },
      fallback: { code: 0, stdout: `${COMMIT}\n`, stderr: '' },
    });
    const client = createCommandGitPublishClient(fake, { credentials: () => TOKEN });
    await expect(client.publish(ARGS)).rejects.toThrow(/auth failed/);
    try {
      await client.publish(ARGS);
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
