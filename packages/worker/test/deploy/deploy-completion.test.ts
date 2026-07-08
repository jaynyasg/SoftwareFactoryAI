/**
 * deploy-completion (U8) — ledger-derived preconditions + destination/push/
 * deploy wiring with FAKE clients (no network, no real git).
 *
 * Covers: precondition derivation from events (gates/preview/package/review),
 * setup-missing pauses (git destination, Render config, hosted URL, failed
 * push) that never fail the local run, the strict hosted-ready ordering
 * (push -> provider -> health -> URL), and retryable failure classes.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { AppendableEvent, EventStore } from '@software-factory/core';
import { completeRunDeploy, deriveDeployPreconditions } from '../../src/index';
import type {
  CompleteRunDeployParams,
  DeployPreconditions,
  GitRemoteClient,
  RenderClient,
  RenderDeployStatus,
} from '../../src/index';

const RUN_ID = 'run-deploy-completion';

async function append(
  store: EventStore,
  partial: Partial<AppendableEvent> & Pick<AppendableEvent, 'type' | 'payload'>,
): Promise<void> {
  await store.append({
    runId: RUN_ID,
    actor: { kind: 'system', id: 'test' },
    subject: { kind: 'run', id: RUN_ID },
    severity: 'info',
    ...partial,
  } as AppendableEvent);
}

function readyPreconditions(): DeployPreconditions {
  return {
    gatesPassed: true,
    previewHealthy: true,
    packagePresent: true,
    provenancePresent: true,
    reviewSatisfied: true,
  };
}

interface FakeGit {
  client: GitRemoteClient;
  pushes: () => number;
  failPush?: boolean;
}

function fakeGitClient(options: { failPush?: boolean } = {}): FakeGit {
  let pushes = 0;
  return {
    pushes: () => pushes,
    client: {
      ensureRepo: (descriptor) =>
        Promise.resolve({ created: false, remoteUrl: descriptor.remoteUrl }),
      push: (args) => {
        pushes += 1;
        return Promise.resolve(
          options.failPush === true
            ? {
                pushed: false,
                remoteUrl: args.descriptor.remoteUrl,
                branch: args.branch ?? 'main',
                note: 'auth failed',
              }
            : { pushed: true, remoteUrl: args.descriptor.remoteUrl, branch: args.branch ?? 'main' },
        );
      },
    },
  };
}

function fakeRenderClient(script: {
  pollStatuses?: readonly RenderDeployStatus[];
  health?: readonly boolean[];
  failureReason?: string;
}): RenderClient {
  const polls = [...(script.pollStatuses ?? ['live'])];
  const healthQueue = [...(script.health ?? [true])];
  let status: RenderDeployStatus = 'queued';
  return {
    createDeploy: () => Promise.resolve({ id: 'dep-1', status }),
    getDeploy: () => {
      if (polls.length > 0) {
        status = polls.shift() as RenderDeployStatus;
      }
      return Promise.resolve({ id: 'dep-1', status, failureReason: script.failureReason });
    },
    checkHealth: () => {
      const healthy = healthQueue.length > 0 ? (healthQueue.shift() as boolean) : false;
      return Promise.resolve({ healthy, status: healthy ? 200 : 503 });
    },
  };
}

function baseParams(overrides: Partial<CompleteRunDeployParams> = {}): CompleteRunDeployParams {
  return {
    runId: RUN_ID,
    artifactId: 'app',
    packagePath: 'C:/factory/workspaces/run-deploy-completion',
    commit: 'abc123',
    preconditions: readyPreconditions(),
    github: { owner: 'octo', repo: 'app' },
    render: { serviceId: 'srv-1', apiKeyPresent: true },
    hostedUrl: 'https://app.onrender.com',
    pollIntervalMs: 0,
    maxStatusPolls: 5,
    maxHealthPolls: 3,
    ...overrides,
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

async function types(store: EventStore): Promise<string[]> {
  return (await store.readRun(RUN_ID)).map((event) => event.type);
}

describe('deriveDeployPreconditions', () => {
  it('derives readiness from gate/preview/package/review events', async () => {
    const store = createInMemoryEventStore();
    await append(store, { type: 'run.created', payload: { prompt: 'x marketplace' } });
    await append(store, { type: 'gate.passed', payload: { gate: 'unit-test', stage: 'post_run' } });
    await append(store, { type: 'preview.ready', payload: { url: 'http://127.0.0.1:4311' } });
    await append(store, {
      type: 'package.created',
      payload: { repoPath: 'C:/pkg', handoffRef: 'HANDOFF.md', provenanceRef: 'PROVENANCE.json' },
    });

    const preconditions = deriveDeployPreconditions(await store.readRun(RUN_ID));
    expect(preconditions).toEqual({
      gatesPassed: true,
      previewHealthy: true,
      packagePresent: true,
      provenancePresent: true,
      reviewSatisfied: true,
    });
  });

  it('reports unmet readiness: failed gate, no preview, pending review, no package', async () => {
    const store = createInMemoryEventStore();
    await append(store, { type: 'run.created', payload: { prompt: 'x marketplace' } });
    await append(store, { type: 'gate.failed', severity: 'error', payload: { gate: 'unit-test', reason: 'red' } });
    await append(store, { type: 'review.requested', severity: 'warn', payload: { riskTier: 'high' } });

    const preconditions = deriveDeployPreconditions(await store.readRun(RUN_ID));
    expect(preconditions.gatesPassed).toBe(false);
    expect(preconditions.previewHealthy).toBe(false);
    expect(preconditions.packagePresent).toBe(false);
    expect(preconditions.provenancePresent).toBe(false);
    expect(preconditions.reviewSatisfied).toBe(false);
  });

  it('a repaired gate (latest pass) and a decided review count as satisfied', async () => {
    const store = createInMemoryEventStore();
    await append(store, { type: 'run.created', payload: { prompt: 'x marketplace' } });
    await append(store, { type: 'gate.failed', severity: 'error', payload: { gate: 'unit-test', reason: 'red' } });
    await append(store, { type: 'gate.passed', payload: { gate: 'unit-test', stage: 'post_run' } });
    await append(store, { type: 'review.requested', severity: 'warn', payload: { riskTier: 'high' } });
    await append(store, { type: 'review.decided', payload: { riskTier: 'high', decision: 'approved' } });

    const preconditions = deriveDeployPreconditions(await store.readRun(RUN_ID));
    expect(preconditions.gatesPassed).toBe(true);
    expect(preconditions.reviewSatisfied).toBe(true);
  });
});

describe('completeRunDeploy — setup pauses preserve local success', () => {
  it('pauses with setup_required when no git destination is configured (run NOT failed)', async () => {
    const store = createInMemoryEventStore();
    const git = fakeGitClient();
    const { outcome } = await completeRunDeploy(
      baseParams({ github: undefined, allowTemporaryRepo: false }),
      { store, renderClient: fakeRenderClient({}), gitClient: git.client, sleep: noSleep },
    );

    expect(outcome.status).toBe('setup_required');
    expect(outcome.retryable).toBe(true);
    expect(git.pushes()).toBe(0);
    const seen = await types(store);
    expect(seen).toContain('deploy.setup_required');
    expect(seen).not.toContain('run.failed');
    expect(seen).not.toContain('deploy.hosted_ready');
  });

  it('pauses with setup_required when the hosted URL is not configured', async () => {
    const store = createInMemoryEventStore();
    const git = fakeGitClient();
    const { outcome } = await completeRunDeploy(baseParams({ hostedUrl: undefined }), {
      store,
      renderClient: fakeRenderClient({}),
      gitClient: git.client,
      sleep: noSleep,
    });

    expect(outcome.status).toBe('setup_required');
    if (outcome.status === 'setup_required') {
      expect(outcome.action).toMatch(/SF_RENDER_HOSTED_URL/);
    }
    expect(git.pushes()).toBe(0);
  });

  it('pauses with setup_required when the push fails (local package preserved)', async () => {
    const store = createInMemoryEventStore();
    const git = fakeGitClient({ failPush: true });
    const { outcome } = await completeRunDeploy(baseParams(), {
      store,
      renderClient: fakeRenderClient({}),
      gitClient: git.client,
      sleep: noSleep,
    });

    expect(outcome.status).toBe('setup_required');
    if (outcome.status === 'setup_required') {
      expect(outcome.action).toMatch(/push/i);
    }
    const seen = await types(store);
    expect(seen).toContain('deploy.setup_required');
    expect(seen).not.toContain('deploy.hosted_ready');
  });

  it('does not push when local preconditions are unmet; deployToRender records the pause', async () => {
    const store = createInMemoryEventStore();
    const git = fakeGitClient();
    const { outcome } = await completeRunDeploy(
      baseParams({ preconditions: { ...readyPreconditions(), previewHealthy: false } }),
      { store, renderClient: fakeRenderClient({}), gitClient: git.client, sleep: noSleep },
    );

    expect(outcome.status).toBe('setup_required');
    if (outcome.status === 'setup_required') {
      expect(outcome.action).toMatch(/preview/i);
    }
    expect(git.pushes()).toBe(0);
  });
});

describe('completeRunDeploy — hosted-ready ordering and failure classes', () => {
  it('pushes, deploys, and projects the hosted URL ONLY after health passes', async () => {
    const store = createInMemoryEventStore();
    const git = fakeGitClient();
    const { outcome, gitDestination } = await completeRunDeploy(baseParams(), {
      store,
      renderClient: fakeRenderClient({ pollStatuses: ['build_in_progress', 'live'], health: [false, true] }),
      gitClient: git.client,
      sleep: noSleep,
    });

    expect(git.pushes()).toBe(1);
    expect(gitDestination?.ok).toBe(true);
    expect(outcome.status).toBe('hosted_ready');
    if (outcome.status === 'hosted_ready') {
      expect(outcome.url).toBe('https://app.onrender.com');
    }
    const events = await store.readRun(RUN_ID);
    const seen = events.map((e) => e.type);
    expect(seen.indexOf('deploy.health_pending')).toBeLessThan(seen.indexOf('deploy.hosted_ready'));
    // No event carries a URL before hosted_ready.
    const firstWithUrl = events.find(
      (e) => typeof (e.payload as Record<string, unknown>).url === 'string',
    );
    expect(firstWithUrl?.type).toBe('deploy.hosted_ready');
  });

  it('migration failure is retryable and withholds the hosted URL', async () => {
    const store = createInMemoryEventStore();
    const { outcome } = await completeRunDeploy(baseParams(), {
      store,
      renderClient: fakeRenderClient({
        pollStatuses: ['update_failed'],
        failureReason: 'prisma migrate deploy failed: P3009',
      }),
      gitClient: fakeGitClient().client,
      sleep: noSleep,
    });

    expect(outcome.status).toBe('migration_failed');
    expect(outcome.retryable).toBe(true);
    const seen = await types(store);
    expect(seen).toContain('deploy.migration_failed');
    expect(seen).not.toContain('deploy.hosted_ready');
  });

  it('hosted health failure is retryable and withholds the hosted URL', async () => {
    const store = createInMemoryEventStore();
    const { outcome } = await completeRunDeploy(baseParams(), {
      store,
      renderClient: fakeRenderClient({ pollStatuses: ['live'], health: [false, false, false] }),
      gitClient: fakeGitClient().client,
      sleep: noSleep,
    });

    expect(outcome.status).toBe('health_failed');
    expect(outcome.retryable).toBe(true);
    const seen = await types(store);
    expect(seen).toContain('deploy.health_failed');
    expect(seen).not.toContain('deploy.hosted_ready');
  });
});
