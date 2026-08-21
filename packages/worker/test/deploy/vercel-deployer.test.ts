/**
 * vercel-deployer (U12) — deploy orchestration with a MOCKED Vercel client,
 * mirroring the render-deployer suite: setup pause without failing the local
 * run (missing OWNER token names the wizard fix), the success ordering
 * (provider READY -> health_pending -> health pass -> hosted_ready with the
 * URL withheld until health passes), the failure classes attaching logs +
 * retryable, and the Lovable publish-and-import handoff (U13): honest
 * `handoff_ready` with an import link, never a hosted URL.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import {
  completeLovableHandoff,
  deployToVercel,
  resolveGitDestination,
} from '../../src/index';
import type {
  GitDestinationOutcome,
  GitRemoteClient,
  VercelClient,
  VercelDeployment,
  VercelDeploymentState,
  VercelDeployerParams,
} from '../../src/index';

const noSleep = (): Promise<void> => Promise.resolve();

interface ClientScript {
  readonly createState?: VercelDeploymentState;
  readonly pollStates?: readonly VercelDeploymentState[];
  readonly errorMessage?: string;
  readonly health?: readonly boolean[];
  readonly createThrows?: Error;
  readonly url?: string;
}

function mockClient(script: ClientScript): {
  client: VercelClient;
  calls: () => { create: number; ensure: number };
} {
  let create = 0;
  let ensure = 0;
  const polls = [...(script.pollStates ?? [])];
  const healthQueue = [...(script.health ?? [])];
  let lastState: VercelDeploymentState = script.createState ?? 'QUEUED';
  const url = script.url ?? 'my-app-abc.vercel.app';
  return {
    calls: () => ({ create, ensure }),
    client: {
      ensureProject() {
        ensure += 1;
        return Promise.resolve({ id: 'prj-1', name: 'app' });
      },
      createDeployment() {
        create += 1;
        if (script.createThrows !== undefined) {
          return Promise.reject(script.createThrows);
        }
        const deployment: VercelDeployment = { id: 'dpl-1', state: lastState, url };
        return Promise.resolve(deployment);
      },
      getDeployment() {
        if (polls.length > 0) {
          lastState = polls.shift() as VercelDeploymentState;
        }
        const deployment: VercelDeployment = {
          id: 'dpl-1',
          state: lastState,
          url,
          errorMessage: script.errorMessage,
        };
        return Promise.resolve(deployment);
      },
      checkHealth() {
        const healthy = healthQueue.length > 0 ? (healthQueue.shift() as boolean) : false;
        return Promise.resolve({ healthy, status: healthy ? 200 : 503 });
      },
    },
  };
}

const USER_DESTINATION: GitDestinationOutcome = resolveGitDestination({
  runId: 'run-vercel',
  github: { owner: 'octo', repo: 'app' },
});

const READY_PRECONDITIONS = {
  gatesPassed: true,
  previewHealthy: true,
  packagePresent: true,
  provenancePresent: true,
  reviewSatisfied: true,
} as const;

function baseParams(overrides: Partial<VercelDeployerParams> = {}): VercelDeployerParams {
  return {
    runId: 'run-vercel',
    artifactId: 'app',
    preconditions: READY_PRECONDITIONS,
    gitDestination: USER_DESTINATION,
    vercel: { tokenPresent: true },
    pollIntervalMs: 0,
    ...overrides,
  };
}

async function types(store: EventStore, runId: string): Promise<string[]> {
  return (await store.readRun(runId)).map((event: FactoryEvent) => event.type);
}

describe('deployToVercel (U12)', () => {
  it('success ordering: READY -> health_pending -> hosted_ready; URL withheld until health', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createState: 'BUILDING',
      pollStates: ['BUILDING', 'READY'],
      health: [false, true],
    });

    const outcome = await deployToVercel(baseParams(), { store, client, sleep: noSleep });
    expect(outcome.status).toBe('hosted_ready');
    if (outcome.status === 'hosted_ready') {
      expect(outcome.url).toBe('https://my-app-abc.vercel.app');
    }

    const seen = await types(store, 'run-vercel');
    expect(seen).toEqual(['deploy.health_pending', 'deploy.hosted_ready']);
    // R29: NO event before hosted_ready carries a URL.
    const events = await store.readRun('run-vercel');
    const beforeReady = events.slice(0, -1);
    expect(JSON.stringify(beforeReady.map((event) => event.payload))).not.toContain('vercel.app');
  });

  it("missing OWNER token pauses with setup_required naming the wizard fix — never a run failure", async () => {
    const store = createInMemoryEventStore();
    const { client, calls } = mockClient({});
    // A server env key must NEVER substitute for the owner's token (AE1-style
    // env discipline): presence is the ONLY input the deployer consults.
    process.env.SF_VERCEL_TOKEN = 'server-level-token-that-must-not-apply';
    try {
      const outcome = await deployToVercel(
        baseParams({ vercel: { tokenPresent: false } }),
        { store, client, sleep: noSleep },
      );
      expect(outcome.status).toBe('setup_required');
      if (outcome.status === 'setup_required') {
        expect(outcome.action).toContain('Settings → Credentials');
        expect(outcome.retryable).toBe(true);
      }
      // No provider interaction happened at all.
      expect(calls()).toEqual({ create: 0, ensure: 0 });
      expect(await types(store, 'run-vercel')).toEqual(['deploy.setup_required']);
    } finally {
      delete process.env.SF_VERCEL_TOKEN;
    }
  });

  it('provider ERROR -> provider_failed with logs, retryable (Render failure taxonomy)', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createState: 'BUILDING',
      pollStates: ['ERROR'],
      errorMessage: 'build exploded',
    });
    const outcome = await deployToVercel(baseParams(), { store, client, sleep: noSleep });
    expect(outcome.status).toBe('provider_failed');
    if (outcome.status === 'provider_failed') {
      expect(outcome.retryable).toBe(true);
      expect(outcome.logs.join('\n')).toContain('build exploded');
    }
    expect(await types(store, 'run-vercel')).toEqual(['deploy.provider_failed']);
  });

  it('health never passing -> health_failed with evidence; still no URL claimed', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({ createState: 'READY', health: [false, false] });
    const outcome = await deployToVercel(baseParams({ maxHealthPolls: 2 }), {
      store,
      client,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('health_failed');
    const seen = await types(store, 'run-vercel');
    expect(seen).toEqual(['deploy.health_pending', 'deploy.health_failed']);
    const events = await store.readRun('run-vercel');
    expect(events.every((event) => event.type !== 'deploy.hosted_ready')).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * Lovable publish-and-import handoff (U13)
 * ------------------------------------------------------------------------- */

function mockGitClient(pushed: boolean): GitRemoteClient & { pushes: () => number } {
  let pushes = 0;
  return {
    pushes: () => pushes,
    ensureRepo: () => Promise.resolve(),
    push: () => {
      pushes += 1;
      return Promise.resolve(
        pushed ? { pushed: true } : { pushed: false, note: 'auth failed (no GitHub token)' },
      );
    },
  } as unknown as GitRemoteClient & { pushes: () => number };
}

describe('completeLovableHandoff (U13)', () => {
  it('publishes the repo and records deploy.handoff_ready with the import link — NO hosted URL', async () => {
    const store = createInMemoryEventStore();
    const result = await completeLovableHandoff(
      {
        runId: 'run-lovable',
        artifactId: 'app',
        packagePath: '/tmp/pkg',
        commit: 'abc123',
        preconditions: READY_PRECONDITIONS,
        github: { owner: 'octo', repo: 'app' },
      },
      { store, gitClient: mockGitClient(true) },
    );

    expect(result.outcome.status).toBe('handoff_ready');
    if (result.outcome.status === 'handoff_ready') {
      expect(result.outcome.repoUrl).toContain('github.com/octo/app');
      expect(result.outcome.importUrl).toContain('lovable.dev');
      expect(result.outcome.instructions).toContain('no hosted URL is claimed');
    }

    const events = await store.readRun('run-lovable');
    expect(events.map((event) => event.type)).toEqual(['deploy.handoff_ready']);
    // Nothing anywhere claims Lovable hosting.
    expect(events.every((event) => event.type !== 'deploy.hosted_ready')).toBe(true);
    const payload = events[0].payload as { importUrl: string; provider: string };
    expect(payload.provider).toBe('lovable');
    expect(payload.importUrl).toContain(encodeURIComponent('github.com/octo/app'));
  });

  it('a failed publish pauses owner-directed (R14) and emits NO artifact', async () => {
    const store = createInMemoryEventStore();
    const git = mockGitClient(false);
    const result = await completeLovableHandoff(
      {
        runId: 'run-lovable',
        packagePath: '/tmp/pkg',
        commit: 'abc123',
        preconditions: READY_PRECONDITIONS,
        github: { owner: 'octo', repo: 'app' },
      },
      { store, gitClient: git },
    );

    expect(result.outcome.status).toBe('setup_required');
    if (result.outcome.status === 'setup_required') {
      expect(result.outcome.action).toContain('GitHub token under Settings');
    }
    const seen = (await store.readRun('run-lovable')).map((event) => event.type);
    expect(seen).toEqual(['deploy.setup_required']);
    expect(seen).not.toContain('deploy.handoff_ready');
  });
});
