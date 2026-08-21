/**
 * Local-fallback host-secret isolation.
 *
 * The reduced-trust host-local sandbox must hand the child its policy-resolved
 * env as the EXCLUSIVE environment (`replaceEnv: true`), so host secrets present
 * in `process.env` never leak into untrusted generated code. This plants a secret
 * (and an allow-listed var) on the real host env and asserts how the runner is
 * invoked — no real process is spawned (a fake runner records the options).
 */
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalFallbackSandbox } from '../../src/index';
import type { SandboxPolicy } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

const SECRET = 'SECRET_TEST_KEY';
const ALLOWED = 'SF_FAKE_ALLOWED';

describe('local-fallback sandbox: host-secret isolation', () => {
  afterEach(() => {
    delete process.env[SECRET];
    delete process.env[ALLOWED];
  });

  it('invokes the runner with replaceEnv and an env that excludes host secrets', async () => {
    // Plant a host secret and an allow-listed var on the REAL host environment.
    process.env[SECRET] = 'sk-should-not-leak';
    process.env[ALLOWED] = 'allowed-value';

    const runner = createFakeRunner({ fallback: { code: 0, stdout: 'ok', stderr: '' } });
    const policy: SandboxPolicy = {
      workspaceDir: resolve('local-fallback-env-workspace'),
      allowFallback: true,
      envAllowList: [ALLOWED],
    };
    // hostEnv defaults to process.env, so the planted vars are the host env.
    const sandbox = createLocalFallbackSandbox({ policy, runner });

    const result = await sandbox.run({ command: 'node', args: ['build.js'] });

    expect(result.ok).toBe(true);
    expect(runner.calls).toHaveLength(1);
    const options = runner.calls[0].options;
    // The child env REPLACES the host env (no merge of process.env).
    expect(options?.replaceEnv).toBe(true);
    // The host secret is NOT forwarded…
    expect(options?.env?.[SECRET]).toBeUndefined();
    // …while the allow-listed host var IS.
    expect(options?.env?.[ALLOWED]).toBe('allowed-value');
  });
});
