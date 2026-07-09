/**
 * Workspace materialization (full-factory U4).
 *
 * Exercises the materializer against the in-memory event store with fake
 * checkout clients (no network, no real git):
 *  - KTD5: a cloud run with a laptop-only path records `workspace.unavailable`
 *    and never pretends it can read the folder,
 *  - local folders bind only inside the approved boundary; traversal /
 *    outside-boundary paths are rejected WITH `security.block` evidence,
 *  - repository materialization records repo, branch, commit, checkout path,
 *    and dirty-state policy as evidence,
 *  - retries converge: unchanged setup dedups its evidence, new attempts
 *    increment the attempt counter, and a ready workspace is reused,
 *  - E5: credential values never appear in any serialized event.
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import { materializeWorkspace, projectWorkspace, workspaceContractEvidence } from '../../src/index';
import type {
  GitCheckoutArgs,
  GitCheckoutClient,
  WorkspaceMaterializationRequest,
  WorkspaceMaterializerDeps,
} from '../../src/index';
import { deterministic } from '../_helpers/events';

const SECRET_TOKEN = 'ghp_SuperSecretCheckoutToken1234';

function makeStore(): EventStore {
  return createInMemoryEventStore(deterministic());
}

/** A fake checkout client scripted per call. */
function fakeGit(
  script: (args: GitCheckoutArgs, call: number) => Promise<{ branch: string; commit: string }>,
): GitCheckoutClient & { readonly calls: GitCheckoutArgs[] } {
  const calls: GitCheckoutArgs[] = [];
  return {
    calls,
    checkout(args: GitCheckoutArgs) {
      calls.push(args);
      return script(args, calls.length);
    },
  };
}

function okGit(): GitCheckoutClient & { readonly calls: GitCheckoutArgs[] } {
  return fakeGit(() => Promise.resolve({ branch: 'main', commit: 'abc123def456' }));
}

async function events(store: EventStore, runId: string): Promise<FactoryEvent[]> {
  return [...(await store.readRun(runId))];
}

function types(list: readonly FactoryEvent[]): string[] {
  return list.map((event) => event.type);
}

const BASE_LOCAL: Omit<WorkspaceMaterializationRequest, 'runId'> = {
  runtimeMode: 'local',
  localPolicy: { boundaryRoot: '/home/op/work' },
  checkoutRoot: '/home/op/.factory/workspaces',
};

function deps(
  store: EventStore,
  overrides: Partial<WorkspaceMaterializerDeps> = {},
): WorkspaceMaterializerDeps {
  return {
    store,
    pathKit: posix,
    isDirectory: () => Promise.resolve(true),
    ...overrides,
  };
}

describe('materializeWorkspace — cloud source boundaries (KTD5)', () => {
  it('records the workspace as unavailable for a laptop-only path and reads nothing', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      {
        runId: 'run-cloud',
        runtimeMode: 'cloud',
        localFolder: 'C:\\Users\\someone\\laptop-only',
        checkoutRoot: '/var/data/.factory/workspaces',
      },
      deps(store, {
        pathKit: win32,
        // Any filesystem probe would be "pretending to read" — forbid it.
        isDirectory: () => {
          throw new Error('cloud materialization must not probe laptop paths');
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'unavailable') {
      expect(result.source).toBe('local_folder');
      expect(result.reason).toMatch(/cloud runs never read laptop paths/i);
      expect(result.requiredAction).toMatch(/GitHub repository/i);
      expect(result.securityBlocked).toBe(false);
    }
    const ledger = await events(store, 'run-cloud');
    expect(types(ledger)).toEqual(['workspace.unavailable']);
    const projection = projectWorkspace(ledger, 'run-cloud');
    expect(projection.status).toBe('unavailable');
    expect(projection.workspace).toBeUndefined();
  });

  it('materializes the GitHub repo when a cloud run supplies both folder and repo', async () => {
    const store = makeStore();
    const git = okGit();
    const result = await materializeWorkspace(
      {
        runId: 'run-cloud-2',
        runtimeMode: 'cloud',
        localFolder: 'C:\\Users\\someone\\laptop-only',
        githubRepo: 'octo/marketplace',
        checkoutRoot: '/var/data/.factory/workspaces',
      },
      deps(store, { git }),
    );

    expect(result.ok).toBe(true);
    const ledger = await events(store, 'run-cloud-2');
    expect(types(ledger)).toContain('workspace.checkout_completed');
    expect(types(ledger)).not.toContain('workspace.unavailable');
  });

  it('records unavailable when a run has no source input at all', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      { runId: 'run-empty', runtimeMode: 'local', checkoutRoot: '/tmp/ws' },
      deps(store),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'unavailable') {
      expect(result.source).toBe('none');
      expect(result.requiredAction).toMatch(/fresh generated workspace/i);
    }
  });
});

describe('materializeWorkspace — local folder binding', () => {
  it('binds a folder inside the approved boundary and records the dirty-state policy', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      {
        runId: 'run-local',
        ...BASE_LOCAL,
        localFolder: '/home/op/work/site',
        dirtyStatePolicy: 'reject_dirty',
      },
      deps(store),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace).toMatchObject({
        kind: 'local_folder',
        path: '/home/op/work/site',
        boundary: 'working_boundary',
        boundaryRoot: '/home/op/work',
        dirtyStatePolicy: 'reject_dirty',
      });
      expect(result.converged).toBe(false);
    }
    const ledger = await events(store, 'run-local');
    expect(types(ledger)).toEqual(['workspace.local_bound']);
    const projection = projectWorkspace(ledger, 'run-local');
    expect(projection.status).toBe('ready');
    expect(projection.workspace?.kind).toBe('local_folder');
  });

  it('rejects traversal with security evidence (security.block + unavailable)', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      { runId: 'run-esc', ...BASE_LOCAL, localFolder: '../../etc' },
      deps(store),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'unavailable') {
      expect(result.securityBlocked).toBe(true);
      expect(result.reason).toMatch(/traversal/i);
    }
    const ledger = await events(store, 'run-esc');
    expect(types(ledger)).toEqual(['security.block', 'workspace.unavailable']);
    expect(ledger[0].severity).toBe('critical');
  });

  it('rejects an outside-boundary absolute path with security evidence', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      { runId: 'run-out', ...BASE_LOCAL, localFolder: '/etc/passwd' },
      deps(store),
    );
    expect(result.ok).toBe(false);
    const ledger = await events(store, 'run-out');
    expect(types(ledger)).toContain('security.block');
    expect(projectWorkspace(ledger, 'run-out').status).toBe('unavailable');
  });

  it('handles Windows drive letters and backslashes in the boundary check', async () => {
    const store = makeStore();
    const ok = await materializeWorkspace(
      {
        runId: 'run-win',
        runtimeMode: 'local',
        localFolder: 'C:\\Users\\op\\work\\app',
        localPolicy: { boundaryRoot: 'C:\\Users\\op\\work' },
        checkoutRoot: 'C:\\Users\\op\\.factory\\workspaces',
      },
      deps(store, { pathKit: win32 }),
    );
    expect(ok.ok).toBe(true);

    const rejected = await materializeWorkspace(
      {
        runId: 'run-win-2',
        runtimeMode: 'local',
        localFolder: 'D:\\elsewhere',
        localPolicy: { boundaryRoot: 'C:\\Users\\op\\work' },
        checkoutRoot: 'C:\\Users\\op\\.factory\\workspaces',
      },
      deps(store, { pathKit: win32 }),
    );
    expect(rejected.ok).toBe(false);
    expect(types(await events(store, 'run-win-2'))).toContain('security.block');
  });

  it('records a missing folder as unavailable WITHOUT security evidence', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      { runId: 'run-miss', ...BASE_LOCAL, localFolder: '/home/op/work/ghost' },
      deps(store, { isDirectory: () => Promise.resolve(false) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'unavailable') {
      expect(result.securityBlocked).toBe(false);
      expect(result.reason).toMatch(/does not exist/i);
    }
    expect(types(await events(store, 'run-miss'))).toEqual(['workspace.unavailable']);
  });
});

describe('materializeWorkspace — repository checkout', () => {
  it('records checkout start, resolved ref, and completion with branch + commit evidence', async () => {
    const store = makeStore();
    const git = okGit();
    const result = await materializeWorkspace(
      {
        runId: 'run-repo',
        runtimeMode: 'local',
        githubRepo: 'octo/marketplace',
        checkoutRoot: '/tmp/ws',
      },
      deps(store, { git }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace).toMatchObject({
        kind: 'repo_checkout',
        repo: 'octo/marketplace',
        branch: 'main',
        commit: 'abc123def456',
        dirtyStatePolicy: 'clean_checkout',
      });
    }
    const ledger = await events(store, 'run-repo');
    expect(types(ledger)).toEqual([
      'workspace.checkout_started',
      'workspace.ref_resolved',
      'workspace.checkout_completed',
    ]);
    const completed = ledger[2];
    expect(completed.payload).toMatchObject({
      repo: 'octo/marketplace',
      branch: 'main',
      commit: 'abc123def456',
      dirtyStatePolicy: 'clean_checkout',
    });
    // The checkout path is recorded and inside the checkout root.
    expect((completed.payload as { checkoutPath: string }).checkoutPath).toContain('run-repo');
    // The client received the credential-free display URL.
    expect(git.calls[0].repo.remoteUrl).toBe('https://github.com/octo/marketplace.git');

    const projection = projectWorkspace(ledger, 'run-repo');
    expect(projection.status).toBe('ready');
    expect(projection.attempts).toBe(1);
    expect(workspaceContractEvidence(projection)?.workspace).toContain('octo/marketplace');
    expect(workspaceContractEvidence(projection)?.workspace).toContain('abc123def456');
  });

  it('accepts full GitHub URLs and normalizes them to owner/repo (credentials discarded)', async () => {
    const store = makeStore();
    const git = okGit();
    const result = await materializeWorkspace(
      {
        runId: 'run-url',
        runtimeMode: 'cloud',
        githubRepo: `https://${SECRET_TOKEN}@github.com/octo/app.git`,
        checkoutRoot: '/tmp/ws',
      },
      deps(store, { git }),
    );
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(await events(store, 'run-url'));
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).toContain('octo/app');
  });

  it('records a sanitized checkout_failed (retryable) when the clone fails', async () => {
    const store = makeStore();
    const git = fakeGit(() =>
      Promise.reject(
        new Error(
          `git clone https://x-access-token:${SECRET_TOKEN}@github.com/octo/app.git failed: auth`,
        ),
      ),
    );
    const result = await materializeWorkspace(
      { runId: 'run-fail', runtimeMode: 'local', githubRepo: 'octo/app', checkoutRoot: '/tmp/ws' },
      deps(store, { git }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'checkout_failed') {
      expect(result.attempt).toBe(1);
      expect(result.reason).not.toContain(SECRET_TOKEN);
    }
    const ledger = await events(store, 'run-fail');
    expect(types(ledger)).toEqual(['workspace.checkout_started', 'workspace.checkout_failed']);
    // E5: the credential value appears NOWHERE in serialized events.
    expect(JSON.stringify(ledger)).not.toContain(SECRET_TOKEN);
    expect(projectWorkspace(ledger, 'run-fail').status).toBe('failed');
  });

  it('records an unparseable repo reference as unavailable with a required action', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      {
        runId: 'run-bad',
        runtimeMode: 'cloud',
        githubRepo: 'not a repo!!',
        checkoutRoot: '/tmp/ws',
      },
      deps(store, { git: okGit() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'unavailable') {
      expect(result.source).toBe('github_repo');
      expect(result.requiredAction).toMatch(/owner\/repo/);
    }
  });

  it('records a missing checkout root as unavailable (setup, not security)', async () => {
    const store = makeStore();
    const result = await materializeWorkspace(
      { runId: 'run-noroot', runtimeMode: 'cloud', githubRepo: 'octo/app' },
      deps(store, { git: okGit() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.outcome === 'unavailable') {
      expect(result.requiredAction).toMatch(/SF_WORKSPACE_CHECKOUT_ROOT/);
      expect(result.securityBlocked).toBe(false);
    }
  });
});

describe('materializeWorkspace — retry convergence', () => {
  it('reuses a ready workspace on retry without duplicating evidence', async () => {
    const store = makeStore();
    const git = okGit();
    const request: WorkspaceMaterializationRequest = {
      runId: 'run-retry',
      runtimeMode: 'local',
      githubRepo: 'octo/app',
      checkoutRoot: '/tmp/ws',
    };
    const first = await materializeWorkspace(request, deps(store, { git }));
    const second = await materializeWorkspace(request, deps(store, { git }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.converged).toBe(true);
    }
    // No second clone, no duplicated events.
    expect(git.calls).toHaveLength(1);
    const ledger = await events(store, 'run-retry');
    expect(types(ledger)).toEqual([
      'workspace.checkout_started',
      'workspace.ref_resolved',
      'workspace.checkout_completed',
    ]);
  });

  it('retrying an unchanged unavailable setup converges on the same single event', async () => {
    const store = makeStore();
    const request: WorkspaceMaterializationRequest = {
      runId: 'run-conv',
      runtimeMode: 'cloud',
      localFolder: 'C:\\laptop\\only',
      checkoutRoot: '/tmp/ws',
    };
    await materializeWorkspace(request, deps(store));
    await materializeWorkspace(request, deps(store));

    const ledger = await events(store, 'run-conv');
    expect(types(ledger)).toEqual(['workspace.unavailable']);
  });

  it('retries a failed checkout as a NEW attempt and converges to ready', async () => {
    const store = makeStore();
    let succeed = false;
    const git = fakeGit(() =>
      succeed
        ? Promise.resolve({ branch: 'main', commit: 'fixed789' })
        : Promise.reject(new Error('remote unreachable')),
    );
    const request: WorkspaceMaterializationRequest = {
      runId: 'run-fix',
      runtimeMode: 'local',
      githubRepo: 'octo/app',
      checkoutRoot: '/tmp/ws',
    };

    const first = await materializeWorkspace(request, deps(store, { git }));
    expect(first.ok).toBe(false);

    succeed = true; // "setup changed" — e.g. credentials/network fixed
    const second = await materializeWorkspace(request, deps(store, { git }));
    expect(second.ok).toBe(true);

    const ledger = await events(store, 'run-fix');
    expect(types(ledger)).toEqual([
      'workspace.checkout_started',
      'workspace.checkout_failed',
      'workspace.checkout_started',
      'workspace.ref_resolved',
      'workspace.checkout_completed',
    ]);
    const attempts = ledger
      .filter((event) => event.type === 'workspace.checkout_started')
      .map((event) => (event.payload as { attempt: number }).attempt);
    expect(attempts).toEqual([1, 2]);

    const projection = projectWorkspace(ledger, 'run-fix');
    expect(projection.status).toBe('ready');
    expect(projection.attempts).toBe(2);
    expect(projection.failureReason).toBeUndefined();
    expect(projection.workspace).toMatchObject({ commit: 'fixed789' });
  });

  it('replays deterministically: projecting twice yields identical state', async () => {
    const store = makeStore();
    await materializeWorkspace(
      { runId: 'run-replay', ...BASE_LOCAL, localFolder: '/home/op/work/app' },
      deps(store),
    );
    const ledger = await events(store, 'run-replay');
    expect(projectWorkspace(ledger, 'run-replay')).toEqual(projectWorkspace(ledger, 'run-replay'));
  });
});
