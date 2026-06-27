/**
 * Sandbox policy + implementation-selection behavior.
 *
 * Covers: host-secret env protection and workspace-path containment (denials vs
 * allowed in-workspace ops), the Docker `docker run` argv scoping, and the
 * selector/provisioner — Docker available -> `sandbox.started`; Docker missing +
 * permitted fallback -> `sandbox.fallback` (reducedTrust); Docker missing +
 * no permission -> refusal (`sandbox.error`). A fake `CommandRunner` stands in
 * for any real process, so no Docker is required.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import {
  CONTAINER_WORKSPACE,
  DEFAULT_SANDBOX_IMAGE,
  buildDockerArgs,
  createDockerSandbox,
  createLocalFallbackSandbox,
  isSecretEnvName,
  provisionSandbox,
  resolvePolicyEnv,
  validateCommandAgainstPolicy,
} from '../../src/index';
import type { SandboxPolicy } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

const WORKSPACE = resolve('sandbox-test-workspace');

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { workspaceDir: WORKSPACE, ...overrides };
}

describe('sandbox policy: host-secret env protection', () => {
  it('refuses a command that injects a host-secret env var', async () => {
    const runner = createFakeRunner({});
    const sandbox = createLocalFallbackSandbox({ policy: policy({ allowFallback: true }), runner });

    const result = await sandbox.run({
      command: 'node',
      args: ['build.js'],
      env: { OPENAI_API_KEY: 'sk-should-be-blocked' },
    });

    expect(result.denied).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toContain('denied_env');
    // The command never ran.
    expect(runner.calls).toHaveLength(0);
  });

  it('passes through ONLY allow-listed host vars and drops host secrets', () => {
    const resolved = resolvePolicyEnv(
      policy({ envAllowList: ['PATH', 'NODE_ENV'] }),
      {
        PATH: '/usr/bin',
        NODE_ENV: 'test',
        OPENAI_API_KEY: 'sk-secret',
        AWS_SECRET_ACCESS_KEY: 'x',
      },
      undefined,
    );
    expect(resolved.env).toEqual({ PATH: '/usr/bin', NODE_ENV: 'test' });
    expect(resolved.env.OPENAI_API_KEY).toBeUndefined();
    expect(resolved.violations).toEqual([]);
  });

  it('classifies common secret env names', () => {
    expect(isSecretEnvName('OPENAI_API_KEY')).toBe(true);
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true);
    expect(isSecretEnvName('DB_PASSWORD')).toBe(true);
    expect(isSecretEnvName('PATH')).toBe(false);
    expect(isSecretEnvName('NODE_ENV')).toBe(false);
  });
});

describe('sandbox policy: workspace path containment', () => {
  it('denies a relative `..` escape', () => {
    const validated = validateCommandAgainstPolicy(
      policy(),
      { command: 'cat', paths: ['../outside.txt'] },
      {},
    );
    expect(validated.violations.map((v) => v.kind)).toContain('path_escape');
  });

  it('denies an absolute path outside the workspace', () => {
    const outside = resolve(WORKSPACE, '..', 'elsewhere', 'secrets.txt');
    const validated = validateCommandAgainstPolicy(
      policy(),
      { command: 'cat', paths: [outside] },
      {},
    );
    expect(validated.violations.map((v) => v.kind)).toContain('absolute_path');
  });

  it('denies a cwd that escapes the workspace', () => {
    const validated = validateCommandAgainstPolicy(
      policy(),
      { command: 'pnpm', args: ['test'], cwd: '../..' },
      {},
    );
    expect(validated.violations.some((v) => v.target === '../..')).toBe(true);
  });

  it('allows in-workspace ops and runs them through the runner', async () => {
    const runner = createFakeRunner({ fallback: { code: 0, stdout: 'ok', stderr: '' } });
    const sandbox = createLocalFallbackSandbox({
      policy: policy({ allowFallback: true, envAllowList: ['PATH'] }),
      runner,
      hostEnv: { PATH: '/usr/bin' },
    });

    const result = await sandbox.run({
      command: 'pnpm',
      args: ['test'],
      cwd: 'packages/app',
      paths: ['src/index.ts'],
    });

    expect(result.denied).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.reducedTrust).toBe(true);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe('pnpm');
  });
});

describe('docker sandbox', () => {
  it('builds a workspace-scoped, network-closed docker run argv', () => {
    const args = buildDockerArgs(
      policy({ envAllowList: ['PATH'] }),
      { command: 'pnpm', args: ['lint'], cwd: 'app' },
      { PATH: '/usr/bin' },
    );
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    // Network is closed by default.
    const networkIndex = args.indexOf('--network');
    expect(args[networkIndex + 1]).toBe('none');
    // Workspace is bind-mounted and the cwd is inside the mount.
    expect(args).toContain(`${resolve(WORKSPACE)}:${CONTAINER_WORKSPACE}`);
    expect(args).toContain(`${CONTAINER_WORKSPACE}/app`);
    // Only the resolved env is forwarded.
    expect(args).toContain('PATH=/usr/bin');
    // The default image and the command come last.
    expect(args).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(args.slice(-2)).toEqual(['pnpm', 'lint']);
  });

  it('runs through the runner and maps exit code to ok', async () => {
    const runner = createFakeRunner({
      responses: { 'docker run': { code: 0, stdout: '', stderr: '' } },
    });
    const sandbox = createDockerSandbox({ policy: policy(), runner, hostEnv: {} });
    const result = await sandbox.run({ command: 'pnpm', args: ['test'] });
    expect(result.ok).toBe(true);
    expect(result.reducedTrust).toBe(false);
    expect(result.mode).toBe('docker');
    expect(runner.calls[0].command).toBe('docker');
  });

  it('enforces the same policy denials before issuing docker run', async () => {
    const runner = createFakeRunner({});
    const sandbox = createDockerSandbox({ policy: policy(), runner, hostEnv: {} });
    const result = await sandbox.run({ command: 'cat', paths: ['../escape'] });
    expect(result.denied).toBe(true);
    expect(runner.calls).toHaveLength(0);
  });
});

describe('sandbox selection + provisioning', () => {
  it('selects Docker and emits sandbox.started when Docker is available', async () => {
    const store = createInMemoryEventStore();
    const selection = await provisionSandbox(
      {
        runId: 'run-docker',
        policy: policy(),
        runner: createFakeRunner({}),
        detectDocker: () => Promise.resolve(true),
      },
      { store },
    );

    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.mode).toBe('docker');
      expect(selection.reducedTrust).toBe(false);
    }
    const events = await store.readRun('run-docker');
    expect(events.map((e) => e.type)).toContain('sandbox.started');
  });

  it('refuses fallback (sandbox.error) when Docker is missing and fallback is not permitted', async () => {
    const store = createInMemoryEventStore();
    const selection = await provisionSandbox(
      {
        runId: 'run-refused',
        policy: policy({ allowFallback: false }),
        runner: createFakeRunner({}),
        detectDocker: () => Promise.resolve(false),
      },
      { store },
    );

    expect(selection.ok).toBe(false);
    if (!selection.ok) {
      expect(selection.fallbackRefused).toBe(true);
    }
    const events = await store.readRun('run-refused');
    expect(events.map((e) => e.type)).toContain('sandbox.error');
    expect(events.some((e) => e.type === 'sandbox.fallback')).toBe(false);
  });

  it('uses reduced-trust fallback and emits sandbox.fallback when permitted', async () => {
    const store = createInMemoryEventStore();
    const selection = await provisionSandbox(
      {
        runId: 'run-fallback',
        policy: policy({ allowFallback: true }),
        runner: createFakeRunner({}),
        detectDocker: () => Promise.resolve(false),
      },
      { store },
    );

    expect(selection.ok).toBe(true);
    if (selection.ok) {
      expect(selection.mode).toBe('local-fallback');
      expect(selection.reducedTrust).toBe(true);
      expect(selection.fallbackUsed).toBe(true);
    }

    const events = await store.readRun('run-fallback');
    const fallback = events.find((e) => e.type === 'sandbox.fallback');
    expect(fallback).toBeDefined();
    expect((fallback?.payload as { reducedTrust: boolean }).reducedTrust).toBe(true);
  });
});
