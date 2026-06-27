/**
 * git-destination (U9) — destination resolution (user vs temporary vs
 * setup-required), provenance mapping, and the resolve+ensure+push flow behind
 * an injectable client (no network).
 */
import { describe, expect, it } from 'vitest';
import {
  createCommandGitRemoteClient,
  pushToDestination,
  resolveGitDestination,
  toProvenanceGitDestination,
} from '../../src/index';
import type { GitRemoteClient } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';

describe('resolveGitDestination', () => {
  it('prefers a user-provided GitHub destination', () => {
    const outcome = resolveGitDestination({
      runId: 'run-1',
      github: { owner: 'octo', repo: 'marketplace' },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.descriptor.kind).toBe('user');
      expect(outcome.descriptor.temporary).toBe(false);
      expect(outcome.descriptor.remoteUrl).toBe('https://github.com/octo/marketplace.git');
      expect(outcome.descriptor.defaultBranch).toBe('main');
    }
  });

  it('falls back to a MARKED temporary factory repo when permitted', () => {
    const outcome = resolveGitDestination({ runId: 'Run ID/42', allowTemporary: true });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.descriptor.kind).toBe('temporary');
      expect(outcome.descriptor.temporary).toBe(true);
      expect(outcome.descriptor.owner).toBe('software-factory');
      expect(outcome.descriptor.repo).toMatch(/^sf-temp-/);
      expect(outcome.descriptor.cleanupNote).toMatch(/temporary/i);
    }
  });

  it('returns setup-required when no destination is configured and temporary is not permitted', () => {
    const outcome = resolveGitDestination({ runId: 'run-1' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.setupRequired).toBe(true);
      expect(outcome.action).toMatch(/github/i);
      expect(outcome.reason.length).toBeGreaterThan(0);
    }
  });

  it('maps a descriptor to the portable provenance shape', () => {
    const outcome = resolveGitDestination({ runId: 'run-1', allowTemporary: true });
    if (!outcome.ok) {
      throw new Error('expected resolved destination');
    }
    const provenance = toProvenanceGitDestination(outcome.descriptor);
    expect(provenance.temporary).toBe(true);
    expect(provenance.kind).toBe('temporary');
    expect(provenance.remoteUrl).toContain('github.com');
  });
});

describe('pushToDestination', () => {
  it('ensures + pushes via the injected client when a destination resolves', async () => {
    const calls: string[] = [];
    const client: GitRemoteClient = {
      ensureRepo: (descriptor) => {
        calls.push('ensure');
        return Promise.resolve({ created: true, remoteUrl: descriptor.remoteUrl });
      },
      push: (args) => {
        calls.push('push');
        return Promise.resolve({ pushed: true, remoteUrl: args.descriptor.remoteUrl, branch: 'main' });
      },
    };

    const outcome = await pushToDestination(
      { runId: 'run-1', github: { owner: 'octo', repo: 'app' }, localPath: '/tmp/app', commit: 'abc' },
      client,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.ensure.created).toBe(true);
      expect(outcome.push.pushed).toBe(true);
    }
    expect(calls).toEqual(['ensure', 'push']);
  });

  it('returns setup-required without calling the client when nothing resolves', async () => {
    let touched = false;
    const client: GitRemoteClient = {
      ensureRepo: () => {
        touched = true;
        return Promise.resolve({ created: false, remoteUrl: '' });
      },
      push: () => {
        touched = true;
        return Promise.resolve({ pushed: false, remoteUrl: '', branch: 'main' });
      },
    };
    const outcome = await pushToDestination({ runId: 'run-1', localPath: '/tmp/app', commit: 'abc' }, client);
    expect(outcome.ok).toBe(false);
    expect(touched).toBe(false);
  });
});

describe('createCommandGitRemoteClient', () => {
  it('configures origin and pushes through the command runner', async () => {
    const runner = createFakeRunner({ fallback: { code: 0, stdout: '', stderr: '' } });
    const client = createCommandGitRemoteClient(runner);
    const resolved = resolveGitDestination({ runId: 'run-1', github: { owner: 'octo', repo: 'app' } });
    if (!resolved.ok) {
      throw new Error('expected resolved destination');
    }

    const result = await client.push({
      descriptor: resolved.descriptor,
      localPath: '/tmp/app',
      commit: 'abc',
    });
    expect(result.pushed).toBe(true);
    const gitArgs = runner.calls.map((c) => c.args.join(' '));
    expect(gitArgs.some((a) => a.startsWith('remote add origin'))).toBe(true);
    expect(gitArgs.some((a) => a.startsWith('push -u origin main'))).toBe(true);
  });

  it('reports pushed:false (not throwing) when a git push fails', async () => {
    const runner = createFakeRunner({
      responses: { 'git push': { code: 128, stdout: '', stderr: 'auth failed' } },
      fallback: { code: 0, stdout: '', stderr: '' },
    });
    const client = createCommandGitRemoteClient(runner);
    const resolved = resolveGitDestination({ runId: 'run-1', github: { owner: 'octo', repo: 'app' } });
    if (!resolved.ok) {
      throw new Error('expected resolved destination');
    }
    const result = await client.push({ descriptor: resolved.descriptor, localPath: '/tmp/app', commit: 'abc' });
    expect(result.pushed).toBe(false);
    expect(result.note).toMatch(/auth failed/);
  });
});
