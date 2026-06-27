/**
 * Mocked Render deploy e2e (U9) — drives the REAL deploy orchestrator with a
 * MOCKED Render client and a MOCKED git destination.
 *
 * This spec is BROWSER-FREE and credential-FREE: it uses the Playwright test
 * runner only as a harness (no `page`, no `request`, no network), an in-memory
 * event store, and a hand-rolled `RenderClient`. It proves the full event
 * sequence, that the hosted URL appears ONLY after hosted health passes, and that
 * every failure class (provider / migration / timeout / health) attaches logs and
 * stays retryable — all without real Render credentials or browser binaries.
 */
import { expect, test } from '@playwright/test';
import { createInMemoryEventStore } from '@software-factory/core';
import type { FactoryEvent } from '@software-factory/core';
import { buildRenderBlueprint, deployToRender, resolveGitDestination } from '@software-factory/worker';
import type {
  GitDestinationOutcome,
  RenderClient,
  RenderDeploy,
  RenderDeployStatus,
  RenderDeployerParams,
} from '@software-factory/worker';

const noSleep = (): Promise<void> => Promise.resolve();
const HOSTED_URL = 'https://ai-services-marketplace.onrender.com';

interface ClientScript {
  readonly createStatus?: RenderDeployStatus;
  readonly pollStatuses?: readonly RenderDeployStatus[];
  readonly failureReason?: string;
  readonly health?: readonly boolean[];
}

function mockRenderClient(script: ClientScript): RenderClient {
  const polls = [...(script.pollStatuses ?? [])];
  const healthQueue = [...(script.health ?? [])];
  let status: RenderDeployStatus = script.createStatus ?? 'queued';
  return {
    createDeploy() {
      const deploy: RenderDeploy = { id: 'dep-e2e', status };
      return Promise.resolve(deploy);
    },
    getDeploy() {
      if (polls.length > 0) {
        status = polls.shift() as RenderDeployStatus;
      }
      return Promise.resolve({ id: 'dep-e2e', status, failureReason: script.failureReason });
    },
    checkHealth() {
      const healthy = healthQueue.length > 0 ? (healthQueue.shift() as boolean) : false;
      return Promise.resolve({ healthy, status: healthy ? 200 : 503 });
    },
  };
}

const RUN_ID = 'run-render-e2e';

const READY_GIT: GitDestinationOutcome = resolveGitDestination({
  runId: RUN_ID,
  github: { owner: 'octo', repo: 'ai-services-marketplace' },
});

function params(overrides: Partial<RenderDeployerParams> = {}): RenderDeployerParams {
  return {
    runId: RUN_ID,
    artifactId: 'app',
    preconditions: {
      gatesPassed: true,
      previewHealthy: true,
      packagePresent: true,
      provenancePresent: true,
      reviewSatisfied: true,
    },
    gitDestination: READY_GIT,
    render: { serviceId: 'srv-e2e', apiKeyPresent: true },
    blueprint: buildRenderBlueprint(),
    hostedUrl: HOSTED_URL,
    pollIntervalMs: 0,
    maxStatusPolls: 5,
    maxHealthPolls: 3,
    ...overrides,
  };
}

test('mocked Render success emits the hosted URL ONLY after health passes', async () => {
  const store = createInMemoryEventStore();
  const client = mockRenderClient({
    createStatus: 'queued',
    pollStatuses: ['build_in_progress', 'live'],
    health: [false, true],
  });

  const outcome = await deployToRender(params(), { store, client, sleep: noSleep });
  expect(outcome.status).toBe('hosted_ready');
  if (outcome.status === 'hosted_ready') {
    expect(outcome.url).toBe(HOSTED_URL);
  }

  const events = await store.readRun(RUN_ID);
  const seen = events.map((e) => e.type);

  // Ordering: provider success (-> health_pending) precedes health success
  // (-> hosted_ready). No deploy.* event before hosted_ready carries a URL.
  expect(seen).toEqual(['deploy.health_pending', 'deploy.hosted_ready']);
  const firstWithUrl = events.find((e: FactoryEvent) => {
    const payload = e.payload as Record<string, unknown>;
    return typeof payload.url === 'string';
  });
  expect(firstWithUrl?.type).toBe('deploy.hosted_ready');
  expect((firstWithUrl?.payload as { url: string }).url).toBe(HOSTED_URL);
});

test('missing GitHub setup pauses the deploy without failing the local run', async () => {
  const store = createInMemoryEventStore();
  const client = mockRenderClient({});
  const noGit = resolveGitDestination({ runId: RUN_ID }); // no github, no temporary

  const outcome = await deployToRender(params({ gitDestination: noGit }), {
    store,
    client,
    sleep: noSleep,
  });

  expect(outcome.status).toBe('setup_required');
  if (outcome.status === 'setup_required') {
    expect(outcome.action).toMatch(/github/i);
    expect(outcome.retryable).toBe(true);
  }
  const seen = (await store.readRun(RUN_ID)).map((e) => e.type);
  expect(seen).toContain('deploy.setup_required');
  expect(seen).not.toContain('run.failed'); // local run is NOT marked failed
});

test('provider failure attaches logs and is retryable', async () => {
  const store = createInMemoryEventStore();
  const client = mockRenderClient({
    createStatus: 'queued',
    pollStatuses: ['build_failed'],
    failureReason: 'compile error in app',
  });

  const outcome = await deployToRender(params(), { store, client, sleep: noSleep });
  expect(outcome.status).toBe('provider_failed');
  if (outcome.status === 'provider_failed') {
    expect(outcome.logs.length).toBeGreaterThan(0);
    expect(outcome.retryable).toBe(true);
  }
  const failed = (await store.readRun(RUN_ID)).find((e) => e.type === 'deploy.provider_failed');
  expect(failed?.evidence?.[0]?.note).toContain('compile error');
});

test('migration failure attaches logs and is retryable', async () => {
  const store = createInMemoryEventStore();
  const client = mockRenderClient({
    createStatus: 'queued',
    pollStatuses: ['update_failed'],
    failureReason: 'prisma migrate deploy failed (P3009)',
  });

  const outcome = await deployToRender(params(), { store, client, sleep: noSleep });
  expect(outcome.status).toBe('migration_failed');
  if (outcome.status === 'migration_failed') {
    expect(outcome.logs.join('\n')).toMatch(/migrate/i);
    expect(outcome.retryable).toBe(true);
  }
  const failed = (await store.readRun(RUN_ID)).find((e) => e.type === 'deploy.migration_failed');
  expect(failed).toBeDefined();
});

test('deploy timeout attaches logs and is retryable', async () => {
  const store = createInMemoryEventStore();
  const client = mockRenderClient({
    createStatus: 'queued',
    pollStatuses: ['build_in_progress', 'build_in_progress', 'build_in_progress'],
  });

  const outcome = await deployToRender(params({ maxStatusPolls: 2 }), {
    store,
    client,
    sleep: noSleep,
  });
  expect(outcome.status).toBe('timeout');
  if (outcome.status === 'timeout') {
    expect(outcome.logs.length).toBeGreaterThan(0);
    expect(outcome.retryable).toBe(true);
  }
  const seen = (await store.readRun(RUN_ID)).map((e) => e.type);
  expect(seen).toContain('deploy.provider_failed'); // timeout surfaces as provider_failed
  expect(seen).not.toContain('deploy.hosted_ready');
});

test('hosted health failure attaches logs and is retryable', async () => {
  const store = createInMemoryEventStore();
  const client = mockRenderClient({ createStatus: 'live', health: [false, false, false] });

  const outcome = await deployToRender(params({ maxHealthPolls: 3 }), {
    store,
    client,
    sleep: noSleep,
  });
  expect(outcome.status).toBe('health_failed');
  if (outcome.status === 'health_failed') {
    expect(outcome.logs.length).toBeGreaterThan(0);
    expect(outcome.retryable).toBe(true);
  }
  const seen = (await store.readRun(RUN_ID)).map((e) => e.type);
  expect(seen).toEqual(['deploy.health_pending', 'deploy.health_failed']);
  expect(seen).not.toContain('deploy.hosted_ready'); // URL never emitted
});
