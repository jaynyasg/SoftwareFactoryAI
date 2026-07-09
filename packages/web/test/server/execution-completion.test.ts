/**
 * Run completion: package, provenance, handoff, and deploy (U8).
 *
 * Exercises the scheduler-backed executor + daemon with the REAL completion
 * stage over injected deterministic seams (fake git runner, fake Render/git
 * clients, fake preview runner — no subprocesses, no network):
 *  - a completed local build produces package + provenance + confidence
 *    events BEFORE run.completed,
 *  - missing deploy setup PAUSES the deploy (deploy.setup_required + a
 *    deploy_setup intervention) while the run still completes locally and the
 *    package/provenance artifacts are preserved (R30),
 *  - the hosted URL is absent until provider success AND hosted health pass;
 *    a health failure records a retryable deploy state (R29/R30),
 *  - retrying a completed-but-not-hosted run resumes cleanly: packaging is
 *    skipped (no duplicate package.created, zero git calls), the deploy is
 *    re-attempted, and run.completed stays idempotent,
 *  - a packaging failure fails the attempt (retryable) without a fake
 *    run.completed, and
 *  - the preflight deploy probe reports REAL readiness (configured vs
 *    missing) without ever blocking local execution on deploy setup.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  projectRun,
} from '@software-factory/core';
import type {
  AdapterTask,
  CommandResult,
  CommandRunner,
  EventStore,
  ExecutionAdapter,
  FactoryEvent,
} from '@software-factory/core';
import { completeRunDeploy, packageCompletedRun } from '@software-factory/worker';
import type { GitRemoteClient, RenderClient, RenderDeployStatus } from '@software-factory/worker';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { createExecutionDaemon, type ExecutionDaemon } from '../../src/server/execution/daemon';
import { createSchedulerTicketExecutor } from '../../src/server/execution/ticket-executor';
import { createCompletionStage } from '../../src/server/execution/completion-stage';
import type {
  CompletionDeployer,
  CompletionPackager,
  CompletionPreviewRunner,
} from '../../src/server/execution/completion-stage';
import { createRuntimePreflight } from '../../src/server/execution/preflight';
import { projectInterventions } from '../../src/server/execution/interventions';
import type { DeployRuntimeConfig } from '../../src/server/runtime';
import { testRuntimeConfig } from '../_helpers/runtime';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';
const COMMIT = '0011223344556677889900112233445566778899';

const MARKETPLACE_PROMPT =
  'Build an AI services marketplace with providers, proposals, and customer requests';

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return { idGenerator: () => `evt-${(id += 1)}`, clock: () => (now += 1000) };
}

function noopTimers() {
  return { setInterval: () => null, clearInterval: () => undefined };
}

function authedHeaders(): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
  body?: unknown,
): ApiRequest {
  return { method, path, query: {}, headers, body };
}

function record(res: ApiResponse): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

function immediateAdapter(): ExecutionAdapter {
  const tasks: AdapterTask[] = [];
  return {
    id: 'fake-exec',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 10 }),
    execute: (task) => {
      tasks.push(task);
      return Promise.resolve({ ok: true, output: `done:${task.ticketId}`, artifacts: [] });
    },
    reportCapacity: () => 10,
  };
}

/* ----------------------------------------------------------------------------
 * Deterministic completion seams
 * ------------------------------------------------------------------------- */

/** A minimal scripted git CommandRunner (no subprocesses; counts calls). */
interface FakeGitRunner extends CommandRunner {
  readonly calls: readonly { command: string; args: readonly string[] }[];
}

function fakeGitRunner(script: Readonly<Record<string, CommandResult>>): FakeGitRunner {
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    calls,
    run(command, args): Promise<CommandResult> {
      calls.push({ command, args: [...args] });
      const key = args.length > 0 ? `${command} ${args[0]}` : command;
      return Promise.resolve(script[key] ?? { code: 0, stdout: '', stderr: '' });
    },
  };
}

const CONFIGURED_DEPLOY: DeployRuntimeConfig = {
  renderApiKeyPresent: true,
  renderServiceId: 'srv-1',
  hostedUrl: 'https://app.onrender.com',
  githubOwner: 'octo',
  githubRepo: 'app',
  allowTemporaryRepo: false,
};

const UNCONFIGURED_DEPLOY: DeployRuntimeConfig = {
  renderApiKeyPresent: false,
  allowTemporaryRepo: false,
};

/** Real packager over a fake git runner; counts invocations + git calls. */
function countingPackager(): {
  packager: CompletionPackager;
  invocations: () => number;
  gitCalls: () => number;
} {
  let invocations = 0;
  let gitCalls = 0;
  const packager: CompletionPackager = async (params, deps) => {
    invocations += 1;
    const runner = fakeGitRunner({
      'git rev-parse': { code: 0, stdout: `${COMMIT}\n`, stderr: '' },
    });
    const result = await packageCompletedRun(params, {
      store: deps.store,
      runner,
      listFiles: () => Promise.resolve(['package.json']),
    });
    gitCalls += runner.calls.length;
    return result;
  };
  return { packager, invocations: () => invocations, gitCalls: () => gitCalls };
}

/** Failing packager (git init explodes) for the packaging-failure scenario. */
const failingPackager: CompletionPackager = (params, deps) =>
  packageCompletedRun(params, {
    store: deps.store,
    runner: fakeGitRunner({
      'git init': { code: 128, stdout: '', stderr: 'fatal: cannot init' },
    }),
    listFiles: () => Promise.resolve([]),
  });

const fakeGitClient: GitRemoteClient = {
  ensureRepo: (descriptor) => Promise.resolve({ created: false, remoteUrl: descriptor.remoteUrl }),
  push: (args) =>
    Promise.resolve({
      pushed: true,
      remoteUrl: args.descriptor.remoteUrl,
      branch: args.branch ?? 'main',
    }),
};

/**
 * Real deploy completion over a scripted Render client. `healthScript` yields
 * one boolean per health poll, shared ACROSS deploy attempts so a retry can
 * observe a different outcome than the first attempt.
 */
function scriptedDeployer(healthScript: boolean[]): CompletionDeployer {
  return (params, deps) => {
    const client: RenderClient = {
      createDeploy: () => Promise.resolve({ id: 'dep-1', status: 'queued' }),
      getDeploy: () => Promise.resolve({ id: 'dep-1', status: 'live' as RenderDeployStatus }),
      checkHealth: () => {
        const healthy = healthScript.length > 0 ? (healthScript.shift() as boolean) : false;
        return Promise.resolve({ healthy, status: healthy ? 200 : 503 });
      },
    };
    return completeRunDeploy(
      { ...params, pollIntervalMs: 0, maxStatusPolls: 3, maxHealthPolls: 1 },
      {
        store: deps.store,
        signal: deps.signal,
        renderClient: client,
        gitClient: fakeGitClient,
        sleep: () => Promise.resolve(),
      },
    );
  };
}

/** Fake preview runner: records preview.* events like the real server does. */
function fakePreview(clock: () => number): CompletionPreviewRunner {
  return async (ctx) => {
    const actor = { kind: 'system', id: 'preview', display: 'preview-server' } as const;
    const subject = { kind: 'preview', id: ctx.runId } as const;
    await ctx.store.append({
      runId: ctx.runId,
      type: 'preview.starting',
      actor,
      subject,
      severity: 'info',
      timestamp: clock(),
      payload: {},
    });
    await ctx.store.append({
      runId: ctx.runId,
      type: 'preview.ready',
      actor,
      subject,
      severity: 'success',
      timestamp: clock(),
      payload: { url: 'http://127.0.0.1:4311' },
    });
    return { attempted: true, healthy: true, url: 'http://127.0.0.1:4311' };
  };
}

/* ----------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------- */

interface HarnessOptions {
  readonly deployConfig: DeployRuntimeConfig;
  readonly packager: CompletionPackager;
  readonly deployer: CompletionDeployer;
}

interface Harness {
  readonly app: App;
  readonly store: EventStore;
  readonly daemon: ExecutionDaemon;
  makeDaemon(ownerId: string): ExecutionDaemon;
}

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'sf-completion-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeHarness(options: HarnessOptions): Harness {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;
  const adapter = immediateAdapter();

  const completionStage = createCompletionStage({
    deployConfig: options.deployConfig,
    packager: options.packager,
    deployer: options.deployer,
    preview: fakePreview(det.clock),
    clock: det.clock,
  });

  const makeDaemon = (ownerId: string): ExecutionDaemon =>
    createExecutionDaemon({
      store,
      clock: det.clock,
      idGenerator: () => `lease-${(leaseSeq += 1)}`,
      ownerId,
      timers: noopTimers(),
      executor: createSchedulerTicketExecutor({
        adapters: createAdapterCatalog([adapter]),
        freshWorkspaceRoot: workspaceRoot,
        clock: det.clock,
        completionStage,
      }),
    });

  const daemon = makeDaemon('daemon-c1');
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    adapterCatalog: createAdapterCatalog([adapter]),
  });
  return { app, store, daemon, makeDaemon };
}

async function createAndStart(app: App): Promise<string> {
  const created = await app.handle(
    req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT }),
  );
  expect(created.status).toBe(201);
  const runId = record(created).runId as string;
  const started = await app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
  expect(started.status).toBe(202);
  return runId;
}

async function events(store: EventStore, runId: string): Promise<FactoryEvent[]> {
  return store.readRun(runId);
}

function typesOf(all: readonly FactoryEvent[]): string[] {
  return all.map((event) => event.type);
}

/* ----------------------------------------------------------------------------
 * 1. Completed local build -> package + provenance events, then run.completed
 * ------------------------------------------------------------------------- */

describe('U8: completed local build packages with provenance', () => {
  it('emits package.created + artifact + confidence BEFORE run.completed, then hosts after health', async () => {
    const counting = countingPackager();
    const { app, store, daemon } = makeHarness({
      deployConfig: CONFIGURED_DEPLOY,
      packager: counting.packager,
      deployer: scriptedDeployer([true]),
    });
    const runId = await createAndStart(app);

    const tick = await daemon.tick();
    expect(tick.completed).toBe(1);

    const all = await events(store, runId);
    const seen = typesOf(all);
    expect(seen).toContain('preview.ready');
    expect(seen).toContain('package.created');
    expect(seen).toContain('artifact.created');
    expect(seen).toContain('artifact.confidence_computed');
    expect(seen).toContain('deploy.hosted_ready');
    expect(seen).toContain('run.completed');

    // Ordering: package precedes deploy precedes run.completed.
    const sequenceOf = (type: string): number =>
      all.find((event) => event.type === type)?.sequence ?? -1;
    expect(sequenceOf('package.created')).toBeLessThan(sequenceOf('deploy.hosted_ready'));
    expect(sequenceOf('deploy.hosted_ready')).toBeLessThan(sequenceOf('run.completed'));

    // package.created carries the artifact/commit/provenance references.
    const pkg = all.find((event) => event.type === 'package.created');
    expect(pkg?.payload).toMatchObject({
      artifactId: 'app',
      commit: COMMIT,
      handoffRef: 'HANDOFF.md',
      provenanceRef: 'PROVENANCE.json',
    });

    // The run summary carries the handoff notes (package + hosted URL).
    const completed = all.find((event) => event.type === 'run.completed');
    const summary = (completed?.payload as { summary?: string }).summary ?? '';
    expect(summary).toContain('Packaged app');
    expect(summary).toContain('https://app.onrender.com');
    expect(projectRun(all, runId).status).toBe('completed');
  });
});

/* ----------------------------------------------------------------------------
 * 2. Deploy setup missing pauses deploy, preserves local success
 * ------------------------------------------------------------------------- */

describe('U8: missing deploy setup pauses deploy without failing the run', () => {
  it('completes locally, records deploy.setup_required + a deploy_setup intervention, no hosted URL', async () => {
    const counting = countingPackager();
    const { app, store, daemon } = makeHarness({
      deployConfig: UNCONFIGURED_DEPLOY,
      packager: counting.packager,
      deployer: scriptedDeployer([true]),
    });
    const runId = await createAndStart(app);

    const tick = await daemon.tick();
    expect(tick.completed).toBe(1);

    const all = await events(store, runId);
    const seen = typesOf(all);
    // Local success artifacts are preserved.
    expect(seen).toContain('package.created');
    expect(seen).toContain('run.completed');
    expect(seen).not.toContain('run.failed');
    expect(seen).not.toContain('execution.failed');
    // Deploy paused, retryable, actionable.
    expect(seen).toContain('deploy.setup_required');
    expect(seen).not.toContain('deploy.hosted_ready');
    const open = projectInterventions(all).open;
    const deploySetup = open.find((item) => item.kind === 'deploy_setup');
    expect(deploySetup).toBeDefined();
    expect(deploySetup?.blockingStage).toBe('deploy');
    expect(deploySetup?.requiredAction).toMatch(/retry/i);
    // No event anywhere carries a hosted URL.
    expect(
      all.some(
        (event) =>
          event.type.startsWith('deploy.') &&
          typeof (event.payload as Record<string, unknown>).url === 'string',
      ),
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------------------
 * 3 + 4. Health failure is retryable; retry resumes WITHOUT re-packaging
 * ------------------------------------------------------------------------- */

describe('U8: hosted health failure + retry without duplicate packaging', () => {
  it('withholds the URL on health failure, then a retry deploys without re-packaging', async () => {
    const counting = countingPackager();
    // First attempt: health fails. Retry: health passes.
    const { app, store, daemon } = makeHarness({
      deployConfig: CONFIGURED_DEPLOY,
      packager: counting.packager,
      deployer: scriptedDeployer([false, true]),
    });
    const runId = await createAndStart(app);

    const first = await daemon.tick();
    expect(first.completed).toBe(1);

    let all = await events(store, runId);
    let seen = typesOf(all);
    expect(seen).toContain('deploy.health_failed');
    expect(seen).not.toContain('deploy.hosted_ready');
    expect(seen).toContain('run.completed'); // local success preserved (R30)
    expect(counting.invocations()).toBe(1);
    const gitCallsAfterFirst = counting.gitCalls();
    expect(gitCallsAfterFirst).toBeGreaterThan(0);
    // Retryable deploy state is surfaced as an intervention on the deploy stage.
    expect(
      projectInterventions(all).open.some(
        (item) => item.kind === 'retry_choice' && item.blockingStage === 'deploy',
      ),
    ).toBe(true);

    // Operator retries the (locally complete) run to re-attempt the deploy.
    const retried = await app.handle(req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}));
    expect(retried.status).toBe(202);
    const second = await daemon.tick();
    expect(second.completed).toBe(1);

    all = await events(store, runId);
    seen = typesOf(all);
    expect(seen).toContain('deploy.hosted_ready');
    // Packaging resumed idempotently: one more packager call but ZERO git
    // re-runs and still exactly ONE package.created on the ledger.
    expect(counting.invocations()).toBe(2);
    expect(counting.gitCalls()).toBe(gitCallsAfterFirst);
    expect(all.filter((event) => event.type === 'package.created').length).toBe(1);
    expect(all.filter((event) => event.type === 'artifact.created').length).toBe(1);
    // run.completed stays idempotent on `<runId>:run.completed`.
    expect(all.filter((event) => event.type === 'run.completed').length).toBe(1);
    // The hosted URL appears exactly once, on hosted_ready.
    const hostedReady = all.filter((event) => event.type === 'deploy.hosted_ready');
    expect(hostedReady.length).toBe(1);
    expect((hostedReady[0].payload as { url: string }).url).toBe('https://app.onrender.com');
  });

  it('a restarted daemon (new owner) resumes the deploy retry without duplicate packaging', async () => {
    const counting = countingPackager();
    const { app, store, daemon, makeDaemon } = makeHarness({
      deployConfig: CONFIGURED_DEPLOY,
      packager: counting.packager,
      deployer: scriptedDeployer([false, true]),
    });
    const runId = await createAndStart(app);
    await daemon.tick();
    expect(typesOf(await events(store, runId))).toContain('deploy.health_failed');

    // Retry, then a RESTARTED daemon (fresh owner) drains the queue.
    await app.handle(req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}));
    const restarted = makeDaemon('daemon-c2');
    const tick = await restarted.tick();
    expect(tick.completed).toBe(1);

    const all = await events(store, runId);
    expect(all.filter((event) => event.type === 'package.created').length).toBe(1);
    expect(all.filter((event) => event.type === 'run.completed').length).toBe(1);
    expect(typesOf(all)).toContain('deploy.hosted_ready');
  });
});

/* ----------------------------------------------------------------------------
 * 5. Packaging failure fails the attempt (retryable), no fake completion
 * ------------------------------------------------------------------------- */

describe('U8: packaging failure fails the attempt without run.completed', () => {
  it('surfaces execution.failed with the packaging reason and emits no package/run events', async () => {
    const { app, store, daemon } = makeHarness({
      deployConfig: CONFIGURED_DEPLOY,
      packager: failingPackager,
      deployer: scriptedDeployer([true]),
    });
    const runId = await createAndStart(app);

    const tick = await daemon.tick();
    expect(tick.failed).toBe(1);

    const all = await events(store, runId);
    const seen = typesOf(all);
    expect(seen).toContain('execution.failed');
    expect(seen).not.toContain('run.completed');
    expect(seen).not.toContain('package.created');
    const failed = all.find((event) => event.type === 'execution.failed');
    expect((failed?.payload as { reason: string }).reason).toMatch(/packaging/i);
  });
});

/* ----------------------------------------------------------------------------
 * 6. Preflight deploy probe reports REAL readiness (never blocks local work)
 * ------------------------------------------------------------------------- */

describe('U8: preflight deploy probe', () => {
  it('reports concrete readiness when deploy is configured', async () => {
    const counting = countingPackager();
    const { app, store } = makeHarness({
      deployConfig: CONFIGURED_DEPLOY,
      packager: counting.packager,
      deployer: scriptedDeployer([true]),
    });
    const created = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT }),
    );
    const runId = record(created).runId as string;

    const preflight = createRuntimePreflight({
      runtime: testRuntimeConfig({ deploy: CONFIGURED_DEPLOY }),
    });
    const result = await preflight(store, runId);
    const deployCheck = result.checks.find((check) => check.check === 'deploy');
    expect(deployCheck?.ok).toBe(true);
    expect(deployCheck?.detail).toMatch(/Deploy is ready/);
    expect(deployCheck?.detail).toContain('srv-1');
  });

  it('states the missing setup and the pause-not-fail behavior when unconfigured', async () => {
    const counting = countingPackager();
    const { app, store } = makeHarness({
      deployConfig: UNCONFIGURED_DEPLOY,
      packager: counting.packager,
      deployer: scriptedDeployer([true]),
    });
    const created = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT }),
    );
    const runId = record(created).runId as string;

    const preflight = createRuntimePreflight({
      runtime: testRuntimeConfig({ deploy: UNCONFIGURED_DEPLOY }),
    });
    const result = await preflight(store, runId);
    const deployCheck = result.checks.find((check) => check.check === 'deploy');
    // Missing deploy setup NEVER blocks local execution (R30) …
    expect(deployCheck?.ok).toBe(true);
    // … but the operator sees exactly what is missing and what will happen.
    expect(deployCheck?.detail).toMatch(/missing/i);
    expect(deployCheck?.detail).toMatch(/Render API key/);
    expect(deployCheck?.detail).toMatch(/deploy\.setup_required/);
  });
});
