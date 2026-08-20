/**
 * Install gate hard-won rules (observed live on a nested run workspace):
 * no manifest = pass without running anything (pnpm would walk UP and try to
 * install the FACTORY's own monorepo); with a manifest, pnpm is confined via
 * --ignore-workspace and runs headless (CI=true).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInstallGate, createLocalFallbackSandbox } from '../../src/index';
import type { GateContext, Sandbox } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';
import type { FakeCommandRunner } from '../_helpers/fake-runner';

describe('install gate', () => {
  let workspace: string;
  let runner: FakeCommandRunner;

  function context(): GateContext {
    const sandbox: Sandbox = createLocalFallbackSandbox({
      policy: { workspaceDir: workspace, allowFallback: true },
      runner,
      hostEnv: { PATH: '/usr/bin' },
    });
    return { runId: 'run-install', workspaceDir: workspace, sandbox };
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'sf-install-gate-'));
    runner = createFakeRunner({ fallback: { code: 0, stdout: 'ok', stderr: '' } });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('passes WITHOUT running anything when the workspace has no package.json', async () => {
    const result = await createInstallGate().run(context());
    expect(result.passed).toBe(true);
    expect(result.summary).toMatch(/nothing to install/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('confines pnpm to the workspace and runs headless when a manifest exists', async () => {
    await writeFile(join(workspace, 'package.json'), '{"name":"generated-app"}');
    const result = await createInstallGate().run(context());
    expect(result.passed).toBe(true);
    const call = runner.calls[0];
    expect(call.command).toBe('pnpm');
    expect(call.args).toEqual(['install', '--ignore-workspace']);
    expect(call.options?.env?.CI).toBe('true');
  });

  it('keeps plain `pnpm install` when the workspace is its own pnpm workspace', async () => {
    await writeFile(join(workspace, 'package.json'), '{"name":"generated-monorepo"}');
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    await createInstallGate().run(context());
    expect(runner.calls[0].args).toEqual(['install']);
  });

  it('honors explicit command/args overrides once a manifest exists', async () => {
    await writeFile(join(workspace, 'package.json'), '{"name":"npm-app"}');
    await createInstallGate({ command: 'npm', args: ['ci'] }).run(context());
    expect(runner.calls[0].command).toBe('npm');
    expect(runner.calls[0].args).toEqual(['ci']);
  });
});
