/**
 * render-deployer (U9) — deploy orchestration with a MOCKED Render client.
 *
 * Covers: preconditions/setup pause WITHOUT failing the local run, config-invalid,
 * the success ordering (provider live -> health_pending -> health pass ->
 * hosted_ready, with the URL withheld until health passes), and the four failure
 * classes (provider, migration, timeout, health) each attaching logs + retryable.
 * Also exercises the default render-client over a mock HTTP transport (no network).
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import {
  buildRenderBlueprint,
  createRenderClient,
  deployToRender,
  resolveGitDestination,
} from '../../src/index';
import type {
  GitDestinationOutcome,
  HttpTransport,
  RenderClient,
  RenderDeploy,
  RenderDeployStatus,
  RenderDeployerParams,
} from '../../src/index';

const noSleep = (): Promise<void> => Promise.resolve();

interface ClientScript {
  readonly createStatus?: RenderDeployStatus;
  readonly pollStatuses?: readonly RenderDeployStatus[];
  readonly failureReason?: string;
  readonly health?: readonly boolean[];
  readonly createThrows?: Error;
}

function mockClient(script: ClientScript): { client: RenderClient; createCalls: () => number } {
  let createCalls = 0;
  const polls = [...(script.pollStatuses ?? [])];
  const healthQueue = [...(script.health ?? [])];
  let lastStatus: RenderDeployStatus = script.createStatus ?? 'queued';
  return {
    createCalls: () => createCalls,
    client: {
      createDeploy() {
        createCalls += 1;
        if (script.createThrows !== undefined) {
          return Promise.reject(script.createThrows);
        }
        const deploy: RenderDeploy = { id: 'dep-1', status: lastStatus };
        return Promise.resolve(deploy);
      },
      getDeploy() {
        if (polls.length > 0) {
          lastStatus = polls.shift() as RenderDeployStatus;
        }
        const deploy: RenderDeploy = {
          id: 'dep-1',
          status: lastStatus,
          failureReason: script.failureReason,
        };
        return Promise.resolve(deploy);
      },
      checkHealth() {
        const healthy = healthQueue.length > 0 ? (healthQueue.shift() as boolean) : false;
        return Promise.resolve({ healthy, status: healthy ? 200 : 503 });
      },
    },
  };
}

const USER_DESTINATION: GitDestinationOutcome = resolveGitDestination({
  runId: 'run-deploy',
  github: { owner: 'octo', repo: 'app' },
});

function baseParams(overrides: Partial<RenderDeployerParams> = {}): RenderDeployerParams {
  return {
    runId: 'run-deploy',
    artifactId: 'app',
    preconditions: {
      gatesPassed: true,
      previewHealthy: true,
      packagePresent: true,
      provenancePresent: true,
      reviewSatisfied: true,
    },
    gitDestination: USER_DESTINATION,
    render: { serviceId: 'srv-1', apiKeyPresent: true },
    blueprint: buildRenderBlueprint(),
    hostedUrl: 'https://app.onrender.com',
    pollIntervalMs: 0,
    maxStatusPolls: 5,
    maxHealthPolls: 3,
    ...overrides,
  };
}

async function types(store: EventStore): Promise<string[]> {
  return (await store.readRun('run-deploy')).map((e) => e.type);
}

describe('deployToRender — pause without failing the run', () => {
  it('pauses with setup_required when a precondition is unmet (run NOT failed)', async () => {
    const store = createInMemoryEventStore();
    const { client, createCalls } = mockClient({});
    const outcome = await deployToRender(
      baseParams({ preconditions: { ...baseParams().preconditions, gatesPassed: false } }),
      { store, client, sleep: noSleep },
    );

    expect(outcome.status).toBe('setup_required');
    if (outcome.status === 'setup_required') {
      expect(outcome.action).toMatch(/gates/i);
      expect(outcome.retryable).toBe(true);
    }
    const seen = await types(store);
    expect(seen).toContain('deploy.setup_required');
    expect(seen).not.toContain('run.failed'); // local run is never marked failed
    expect(createCalls()).toBe(0); // never reached the provider
  });

  it('pauses with setup_required when no Git destination is configured', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({});
    const noGit: GitDestinationOutcome = resolveGitDestination({ runId: 'run-deploy' });
    expect(noGit.ok).toBe(false);

    const outcome = await deployToRender(baseParams({ gitDestination: noGit }), {
      store,
      client,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('setup_required');
    if (outcome.status === 'setup_required') {
      expect(outcome.action).toMatch(/github/i);
    }
    expect(await types(store)).not.toContain('run.failed');
  });

  it('pauses with setup_required when Render is not configured', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({});
    const outcome = await deployToRender(baseParams({ render: { apiKeyPresent: false } }), {
      store,
      client,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('setup_required');
    if (outcome.status === 'setup_required') {
      expect(outcome.action).toMatch(/render/i);
    }
  });

  it('emits config_invalid for a bad blueprint', async () => {
    const store = createInMemoryEventStore();
    const { client, createCalls } = mockClient({});
    const base = buildRenderBlueprint();
    const badBlueprint = {
      ...base,
      services: [{ ...base.services[0], buildCommand: 'pnpm build' }], // no migration
    };
    const outcome = await deployToRender(baseParams({ blueprint: badBlueprint }), {
      store,
      client,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('config_invalid');
    if (outcome.status === 'config_invalid') {
      expect(outcome.reason).toMatch(/migrat/i);
    }
    expect(await types(store)).toContain('deploy.config_invalid');
    expect(createCalls()).toBe(0);
  });
});

describe('deployToRender — success ordering', () => {
  it('emits the hosted URL ONLY after provider success AND health pass', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createStatus: 'queued',
      pollStatuses: ['build_in_progress', 'live'],
      health: [false, true], // first health check fails, second passes
    });

    const outcome = await deployToRender(baseParams(), { store, client, sleep: noSleep });
    expect(outcome.status).toBe('hosted_ready');
    if (outcome.status === 'hosted_ready') {
      expect(outcome.url).toBe('https://app.onrender.com');
      expect(outcome.retryable).toBe(false);
    }

    const events = await store.readRun('run-deploy');
    const seen = events.map((e) => e.type);
    // health_pending (provider success signal) strictly precedes hosted_ready.
    expect(seen).toContain('deploy.health_pending');
    expect(seen.indexOf('deploy.health_pending')).toBeLessThan(seen.indexOf('deploy.hosted_ready'));

    // No event carries a URL before the final hosted_ready.
    const firstWithUrl = events.find((e: FactoryEvent) => {
      const payload = e.payload as Record<string, unknown>;
      return typeof payload.url === 'string';
    });
    expect(firstWithUrl?.type).toBe('deploy.hosted_ready');
    expect(seen[seen.length - 1]).toBe('deploy.hosted_ready');
  });
});

describe('deployToRender — failure classes attach logs + allow retry', () => {
  it('provider failure', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createStatus: 'queued',
      pollStatuses: ['build_failed'],
      failureReason: 'build error: tsc failed',
    });
    const outcome = await deployToRender(baseParams(), { store, client, sleep: noSleep });
    expect(outcome.status).toBe('provider_failed');
    if (outcome.status === 'provider_failed') {
      expect(outcome.logs.length).toBeGreaterThan(0);
      expect(outcome.retryable).toBe(true);
    }
    const failed = (await store.readRun('run-deploy')).find((e) => e.type === 'deploy.provider_failed');
    expect(failed?.evidence?.[0].note).toContain('build error');
    expect(await types(store)).not.toContain('deploy.hosted_ready');
  });

  it('migration failure', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createStatus: 'queued',
      pollStatuses: ['update_failed'],
      failureReason: 'prisma migrate deploy failed: P3009',
    });
    const outcome = await deployToRender(baseParams(), { store, client, sleep: noSleep });
    expect(outcome.status).toBe('migration_failed');
    if (outcome.status === 'migration_failed') {
      expect(outcome.logs.join('\n')).toMatch(/migrate/i);
      expect(outcome.retryable).toBe(true);
    }
    const failed = (await store.readRun('run-deploy')).find((e) => e.type === 'deploy.migration_failed');
    expect(failed).toBeDefined();
    expect(failed?.evidence?.[0].note).toMatch(/migrate/i);
  });

  it('deploy timeout', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createStatus: 'queued',
      pollStatuses: ['build_in_progress', 'build_in_progress', 'build_in_progress'],
    });
    const outcome = await deployToRender(baseParams({ maxStatusPolls: 2 }), {
      store,
      client,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('timeout');
    if (outcome.status === 'timeout') {
      expect(outcome.logs.length).toBeGreaterThan(0);
      expect(outcome.retryable).toBe(true);
    }
    // Timeout surfaces as a provider_failed event (no dedicated timeout event type).
    const failed = (await store.readRun('run-deploy')).find((e) => e.type === 'deploy.provider_failed');
    expect(failed?.evidence?.[0].note).toMatch(/terminal state/i);
    expect(await types(store)).not.toContain('deploy.hosted_ready');
  });

  it('hosted health failure', async () => {
    const store = createInMemoryEventStore();
    const { client } = mockClient({
      createStatus: 'live',
      health: [false, false, false],
    });
    const outcome = await deployToRender(baseParams({ maxHealthPolls: 3 }), {
      store,
      client,
      sleep: noSleep,
    });
    expect(outcome.status).toBe('health_failed');
    if (outcome.status === 'health_failed') {
      expect(outcome.logs.length).toBeGreaterThan(0);
      expect(outcome.retryable).toBe(true);
    }
    const seen = await types(store);
    expect(seen).toContain('deploy.health_pending');
    expect(seen).toContain('deploy.health_failed');
    expect(seen).not.toContain('deploy.hosted_ready');
    const failed = (await store.readRun('run-deploy')).find((e) => e.type === 'deploy.health_failed');
    expect(failed?.evidence?.[0].note).toContain('health check');
  });
});

describe('createRenderClient over a mock HTTP transport (no network)', () => {
  it('maps create/get/health calls through the transport', async () => {
    const requests: string[] = [];
    const transport: HttpTransport = (request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url.endsWith('/deploys')) {
        return Promise.resolve({ status: 201, ok: true, body: JSON.stringify({ id: 'dep-9', status: 'queued' }) });
      }
      if (request.url.includes('/deploys/')) {
        return Promise.resolve({ status: 200, ok: true, body: JSON.stringify({ deploy: { id: 'dep-9', status: 'live' } }) });
      }
      return Promise.resolve({ status: 200, ok: true, body: 'ok' });
    };
    const client = createRenderClient({ apiKey: 'test-key', transport });

    const created = await client.createDeploy({ serviceId: 'srv-9' });
    expect(created).toEqual({ id: 'dep-9', status: 'queued', commit: undefined, failureReason: undefined });

    const polled = await client.getDeploy({ serviceId: 'srv-9', deployId: 'dep-9' });
    expect(polled.status).toBe('live'); // unwrapped from { deploy: {...} }

    const health = await client.checkHealth({ url: 'https://app.onrender.com/api/status' });
    expect(health.healthy).toBe(true);
    expect(health.status).toBe(200);

    expect(requests[0]).toBe('POST https://api.render.com/v1/services/srv-9/deploys');
  });
});
