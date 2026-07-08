/**
 * Ticket-to-worker execution integration (full-factory U6).
 *
 * Exercises the REAL scheduler-backed TicketExecutor through the daemon: a
 * planned ticket DAG runs in dependency order inside the run workspace,
 * write-scope conflicts serialize despite free slots, adapter setup/auth
 * failures stop before execution with setup events, review modes change
 * nothing outside policy (KTD6), duplicate queue claims cannot run a ticket
 * twice, and cancellation/pause/shutdown yield safely and resume without
 * re-running completed tickets.
 *
 * All adapters are deterministic fakes (no real model/CLI invocations); tests
 * drive the daemon manually via `tick()` with no-op timers.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createModuleRegistry,
  createOperatorTokenProvider,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type {
  AdapterCatalog,
  AdapterResult,
  AdapterSetupState,
  AdapterTask,
  EventStore,
  ExecutionAdapter,
  ModuleContract,
  ModuleRegistry,
  RunProjection,
} from '@software-factory/core';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { createExecutionDaemon, type ExecutionDaemon } from '../../src/server/execution/daemon';
import { createSchedulerTicketExecutor } from '../../src/server/execution/ticket-executor';
import { projectExecutionQueue } from '../../src/server/execution/queue';
import { projectInterventions } from '../../src/server/execution/interventions';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';
const FRESH_ROOT = '/virtual/workspaces';

const MARKETPLACE_PROMPT =
  'Build an AI services marketplace with providers, proposals, and customer requests';

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

function noopTimers() {
  return {
    setInterval: () => null,
    clearInterval: () => undefined,
  };
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

async function types(store: EventStore, runId: string): Promise<string[]> {
  return (await store.readRun(runId)).map((event) => event.type);
}

async function flushMicrotasks(passes = 40): Promise<void> {
  for (let i = 0; i < passes; i += 1) {
    await Promise.resolve();
  }
}

/* ----------------------------------------------------------------------------
 * Fake adapters
 * ------------------------------------------------------------------------- */

interface RecordingAdapter extends ExecutionAdapter {
  /** Ticket ids in execution start order. */
  readonly started: readonly string[];
  /** Tasks as received (workspace dir, compiled context, …). */
  readonly tasks: readonly AdapterTask[];
  /** Executions started per ticket (across shared maps when injected). */
  readonly executions: ReadonlyMap<string, number>;
}

interface FakeAdapterOptions {
  readonly id?: string;
  readonly capacity?: number;
  readonly setup?: Partial<AdapterSetupState>;
  /** Shared execution counter (resume tests span two adapters). */
  readonly executions?: Map<string, number>;
}

function baseSetup(options: FakeAdapterOptions): () => Promise<AdapterSetupState> {
  return () =>
    Promise.resolve({
      available: options.setup?.available ?? true,
      authenticated: options.setup?.authenticated ?? true,
      capacity: options.setup?.capacity ?? options.capacity ?? 10,
      setupActions: options.setup?.setupActions,
      detail: options.setup?.detail,
    });
}

/** Records every execution and completes it immediately. */
function immediateAdapter(options: FakeAdapterOptions = {}): RecordingAdapter {
  const started: string[] = [];
  const tasks: AdapterTask[] = [];
  const executions = options.executions ?? new Map<string, number>();
  return {
    id: options.id ?? 'fake-exec',
    family: 'codex',
    detectSetup: baseSetup(options),
    execute: (task) => {
      started.push(task.ticketId);
      tasks.push(task);
      executions.set(task.ticketId, (executions.get(task.ticketId) ?? 0) + 1);
      return Promise.resolve({
        ok: true,
        output: `done:${task.ticketId}`,
        artifacts: [],
        summary: `Completed ${task.ticketId}.`,
      });
    },
    reportCapacity: () => options.capacity ?? 10,
    started,
    tasks,
    executions,
  };
}

interface GatedRecordingAdapter extends RecordingAdapter {
  whenStarted(n: number): Promise<void>;
  release(ticketId: string, result?: AdapterResult): void;
  releaseAll(): void;
  readonly inFlight: ReadonlySet<string>;
  /** Whether the two tickets were ever in flight simultaneously. */
  overlapped(a: string, b: string): boolean;
}

/** Blocks each execution on a per-ticket gate the test resolves on command. */
function gatedRecordingAdapter(options: FakeAdapterOptions = {}): GatedRecordingAdapter {
  const started: string[] = [];
  const tasks: AdapterTask[] = [];
  const executions = options.executions ?? new Map<string, number>();
  const gates = new Map<string, (result: AdapterResult) => void>();
  const inFlight = new Set<string>();
  const overlaps = new Set<string>();
  const waiters: { n: number; resolve: () => void }[] = [];

  const checkWaiters = (): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (started.length >= waiters[i].n) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  };

  return {
    id: options.id ?? 'fake-gated',
    family: 'codex',
    detectSetup: baseSetup(options),
    execute: (task, opts) => {
      if (opts.signal.aborted) {
        return Promise.resolve({ ok: false, error: AdapterError.cancelled() });
      }
      started.push(task.ticketId);
      tasks.push(task);
      executions.set(task.ticketId, (executions.get(task.ticketId) ?? 0) + 1);
      for (const other of inFlight) {
        overlaps.add([other, task.ticketId].sort().join('|'));
      }
      inFlight.add(task.ticketId);
      checkWaiters();
      return new Promise<AdapterResult>((resolve) => {
        const settle = (result: AdapterResult): void => {
          if (gates.delete(task.ticketId)) {
            inFlight.delete(task.ticketId);
            resolve(result);
          }
        };
        gates.set(task.ticketId, settle);
        opts.signal.addEventListener(
          'abort',
          () => settle({ ok: false, error: AdapterError.cancelled() }),
          { once: true },
        );
      });
    },
    reportCapacity: () => options.capacity ?? 10,
    started,
    tasks,
    executions,
    whenStarted(n: number): Promise<void> {
      if (started.length >= n) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push({ n, resolve }));
    },
    release(ticketId: string, result?: AdapterResult): void {
      gates.get(ticketId)?.(
        result ?? { ok: true, output: `done:${ticketId}`, artifacts: [], summary: undefined },
      );
    },
    releaseAll(): void {
      for (const ticketId of [...gates.keys()]) {
        this.release(ticketId);
      }
    },
    get inFlight(): ReadonlySet<string> {
      return inFlight;
    },
    overlapped(a: string, b: string): boolean {
      return overlaps.has([a, b].sort().join('|'));
    },
  };
}

/* ----------------------------------------------------------------------------
 * Harness: app + daemon wired with the REAL scheduler-backed executor
 * ------------------------------------------------------------------------- */

interface HarnessOptions {
  readonly adapter: ExecutionAdapter;
  /** Catalog for the app's preflight readiness check (defaults to the adapter). */
  readonly appCatalog?: AdapterCatalog;
  readonly moduleRegistry?: ModuleRegistry;
}

interface Harness {
  readonly app: App;
  readonly store: EventStore;
  readonly daemon: ExecutionDaemon;
  /** Fresh-workspace directories the executor ensured. */
  readonly ensured: readonly string[];
  /** Build another daemon on the SAME store (restart / duplicate-claim tests). */
  makeDaemon(ownerId: string, adapter: ExecutionAdapter): ExecutionDaemon;
}

function makeHarness(options: HarnessOptions): Harness {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  const ensured: string[] = [];
  let runSeq = 0;
  let leaseSeq = 0;

  const makeDaemon = (ownerId: string, adapter: ExecutionAdapter): ExecutionDaemon =>
    createExecutionDaemon({
      store,
      clock: det.clock,
      idGenerator: () => `lease-${(leaseSeq += 1)}`,
      ownerId,
      timers: noopTimers(),
      executor: createSchedulerTicketExecutor({
        adapters: createAdapterCatalog([adapter]),
        moduleRegistry: options.moduleRegistry,
        freshWorkspaceRoot: FRESH_ROOT,
        ensureWorkspaceDir: (path) => {
          ensured.push(path);
          return Promise.resolve();
        },
        clock: det.clock,
      }),
    });

  const daemon = makeDaemon('daemon-w1', options.adapter);
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    adapterCatalog: options.appCatalog ?? createAdapterCatalog([options.adapter]),
  });
  return { app, store, daemon, ensured, makeDaemon };
}

async function createPlannedRun(app: App, body: Record<string, unknown> = {}): Promise<string> {
  const res = await app.handle(
    req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT, ...body }),
  );
  expect(res.status).toBe(201);
  const runId = record(res).runId as string;
  expect(((record(res).run as RunProjection) ?? {}).status).toBe('planned');
  return runId;
}

async function startRun(app: App, runId: string): Promise<ApiResponse> {
  return app.handle(req('POST', `/api/runs/${runId}/start`, authedHeaders(), {}));
}

/** Enqueue the run-execution job directly (bypasses preflight): the executor
 * itself must fail closed on stale/duplicate enqueues. */
async function enqueueDirectly(store: EventStore, runId: string, attempt = 1): Promise<void> {
  await store.append({
    runId,
    type: 'queue.enqueued',
    actor: { kind: 'system', id: 'test' },
    subject: { kind: 'queue-job', id: `${runId}:execution` },
    severity: 'info',
    payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt },
  });
}

/** Release gated work in waves until a pending daemon tick settles. */
async function drainTick(
  adapter: GatedRecordingAdapter,
  tick: Promise<unknown>,
): Promise<void> {
  let done = false;
  void tick.then(() => {
    done = true;
  });
  while (!done) {
    adapter.releaseAll();
    await flushMicrotasks();
  }
  await tick;
}

function indexOfTicket(started: readonly string[], ticketId: string): number {
  const index = started.indexOf(ticketId);
  expect(index, `ticket ${ticketId} never started`).toBeGreaterThanOrEqual(0);
  return index;
}

/* ----------------------------------------------------------------------------
 * 1. A planned DAG runs in dependency order in the run workspace
 * ------------------------------------------------------------------------- */

describe('scheduler-backed executor: planned DAG execution', () => {
  it('runs the marketplace DAG in dependency order and updates ticket + run projections', async () => {
    const adapter = immediateAdapter();
    const { app, store, daemon, ensured } = makeHarness({ adapter });
    const runId = await createPlannedRun(app);

    const start = await startRun(app, runId);
    expect(start.status).toBe(202);

    const tick = await daemon.tick();
    expect(tick.claimed).toBe(1);
    expect(tick.completed).toBe(1);

    // Every planned ticket executed exactly once, respecting the DAG.
    const events = await store.readRun(runId);
    const tickets = projectTickets(events, runId);
    expect(adapter.started).toHaveLength(tickets.tickets.length);
    const idx = (ticketId: string): number => indexOfTicket(adapter.started, ticketId);
    expect(idx('scaffold')).toBeLessThan(idx('data-model'));
    expect(idx('data-model')).toBeLessThan(idx('api-contract'));
    expect(idx('api-contract')).toBeLessThan(idx('marketplace-ui'));
    expect(idx('api-contract')).toBeLessThan(idx('ai-brief'));
    expect(idx('api-contract')).toBeLessThan(idx('provider-proposals'));
    expect(idx('review-acceptance')).toBeGreaterThan(idx('marketplace-ui'));
    expect(idx('tests')).toBeGreaterThan(idx('admin-status'));
    expect(idx('deploy')).toBeGreaterThan(idx('package'));

    // Prompt-only run: a fresh generated workspace backed every task.
    const expectedWorkspace = join(FRESH_ROOT, runId);
    expect(ensured).toContain(expectedWorkspace);
    for (const task of adapter.tasks) {
      expect(task.workspaceDir).toBe(expectedWorkspace);
    }

    // Worker completion updated ticket AND run projections (ledger truth).
    for (const ticket of tickets.tickets) {
      expect(ticket.state, `ticket ${ticket.ticketId}`).toBe('completed');
    }
    const run = projectRun(events, runId);
    expect(run.status).toBe('completed');
    expect(run.executionState).toBe('completed');
    const seen = events.map((event) => event.type);
    expect(seen).toContain('run.started');
    expect(seen).toContain('adapter.selected');
    expect(seen).toContain('worker.started');
    expect(seen).toContain('ticket.state_changed');
    expect(seen).toContain('execution.completed');
    expect(seen).toContain('run.completed');
    expect(projectExecutionQueue(events, runId).jobs[0].status).toBe('completed');
  });

  it('resolves compiled inputs so genome-backed tickets get complete contexts', async () => {
    const adapter = immediateAdapter();
    const { app, daemon } = makeHarness({ adapter });
    const runId = await createPlannedRun(app);
    await startRun(app, runId);
    await daemon.tick();

    const apiContract = adapter.tasks.find((task) => task.ticketId === 'api-contract');
    expect(apiContract).toBeDefined();
    // `data.schema` resolves from the data-model ticket's declared outputs.
    expect(apiContract?.context.missingInputs).toEqual([]);
    expect(apiContract?.context.complete).toBe(true);
    expect(apiContract?.context.resolvedInputs.map((input) => input.key)).toEqual(['data.schema']);
    expect(apiContract?.context.allowedTools).toEqual(['fs.read', 'fs.write']);
  });
});

/* ----------------------------------------------------------------------------
 * 2. Write-scope conflicts serialize tickets even with free worker slots
 * ------------------------------------------------------------------------- */

function moduleContract(
  id: string,
  requiredInputs: readonly string[],
  expectedOutputs: readonly string[],
): ModuleContract {
  return {
    id,
    version: '1.0.0',
    title: `Module ${id}`,
    description: `Test module ${id}.`,
    requiredInputs: [...requiredInputs],
    expectedOutputs: [...expectedOutputs],
    allowedTools: ['fs.read', 'fs.write'],
    riskHint: {},
    artifactContracts: expectedOutputs.map((key) => ({ key, kind: 'code', required: true })),
  };
}

describe('scheduler-backed executor: write-scope serialization', () => {
  it('serializes tickets that declare the same output even when slots are free', async () => {
    // marketplace-ui and provider-proposals both declare `shared.ui`, so their
    // derived write scopes conflict; ai-brief stays independent.
    const registry = createModuleRegistry([
      moduleContract('scaffold-app', [], ['app.scaffold']),
      moduleContract('data-model', ['app.scaffold'], ['data.schema']),
      moduleContract('api-contract', ['data.schema'], ['api.contract']),
      moduleContract('marketplace-ui', ['api.contract'], ['shared.ui']),
      moduleContract('ai-brief', ['api.contract'], ['ai.brief.generator']),
      moduleContract('provider-proposals', ['api.contract'], ['shared.ui']),
      moduleContract('qa-gates', [], ['qa.report']),
    ]);
    const adapter = gatedRecordingAdapter({ capacity: 10 });
    const { app, store, daemon } = makeHarness({ adapter, moduleRegistry: registry });
    const runId = await createPlannedRun(app, { requestedWorkerCap: 10 });
    await startRun(app, runId);

    const tick = daemon.tick();
    await adapter.whenStarted(1);
    adapter.release('scaffold');
    await adapter.whenStarted(2);
    adapter.release('data-model');
    await adapter.whenStarted(3);
    adapter.release('api-contract');

    // marketplace-ui + ai-brief start; provider-proposals waits on the scope
    // conflict despite plenty of free worker slots.
    await adapter.whenStarted(5);
    await flushMicrotasks();
    expect(adapter.started).toHaveLength(5);
    expect(adapter.started.slice(3).sort()).toEqual(['ai-brief', 'marketplace-ui']);
    expect([...adapter.inFlight].sort()).toEqual(['ai-brief', 'marketplace-ui']);

    adapter.release('marketplace-ui');
    await adapter.whenStarted(6);
    expect(adapter.started[5]).toBe('provider-proposals');

    await drainTick(adapter, tick);

    // The conflicting pair never overlapped; the run still completed fully.
    expect(adapter.overlapped('marketplace-ui', 'provider-proposals')).toBe(false);
    expect(adapter.overlapped('marketplace-ui', 'ai-brief')).toBe(true);
    const events = await store.readRun(runId);
    expect(projectRun(events, runId).executionState).toBe('completed');
    const queuedTickets = events
      .filter((event) => event.type === 'ticket.queued')
      .map((event) => event.ticketId);
    expect(queuedTickets).toContain('provider-proposals');
  });
});

/* ----------------------------------------------------------------------------
 * 3. Adapter setup/auth failure prevents execution and emits setup events
 * ------------------------------------------------------------------------- */

describe('scheduler-backed executor: adapter setup gating', () => {
  it('preflight fails the start when no adapter is ready (real readiness check)', async () => {
    const notReady = immediateAdapter({
      id: 'fake-down',
      setup: { available: false, authenticated: false, capacity: 0, detail: 'not installed' },
    });
    const { app, store } = makeHarness({ adapter: notReady });
    const runId = await createPlannedRun(app);

    const res = await startRun(app, runId);
    expect(res.status).toBe(422);
    expect(record(res).error).toBe('preflight_failed');
    const preflight = record(res).preflight as { failedChecks: string[] };
    expect(preflight.failedChecks).toContain('adapters');

    const events = await store.readRun(runId);
    expect(events.some((event) => event.type === 'queue.enqueued')).toBe(false);
    const open = projectInterventions(events).open;
    expect(open.some((item) => item.kind === 'adapter_setup')).toBe(true);
  });

  it('an unauthenticated adapter blocks execution with auth + setup events, no workers', async () => {
    const unauthenticated = immediateAdapter({
      id: 'fake-unauth',
      setup: {
        available: true,
        authenticated: false,
        capacity: 0,
        detail: 'no active session',
        setupActions: [{ id: 'login', title: 'Authenticate the CLI' }],
      },
    });
    const { app, store, daemon } = makeHarness({ adapter: unauthenticated });
    const runId = await createPlannedRun(app);
    // Bypass preflight: even a stale/duplicate enqueue must fail closed.
    await enqueueDirectly(store, runId);

    const tick = await daemon.tick();
    expect(tick.blocked).toBe(1);

    const events = await store.readRun(runId);
    const seen = events.map((event) => event.type);
    expect(seen).toContain('adapter.auth_failed');
    expect(seen).toContain('adapter.setup_required');
    expect(seen).toContain('execution.blocked');
    expect(seen).not.toContain('worker.started');
    expect(unauthenticated.started).toHaveLength(0);
    const open = projectInterventions(events).open;
    expect(open.some((item) => item.kind === 'adapter_setup')).toBe(true);
    expect(projectRun(events, runId).executionState).toBe('blocked');
  });

  it('an unknown selected adapter blocks with an explicit setup event', async () => {
    const adapter = immediateAdapter();
    const { app, store, daemon } = makeHarness({ adapter });
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        selectedAdapter: 'nonexistent-adapter',
      }),
    );
    const runId = record(res).runId as string;
    await enqueueDirectly(store, runId);

    const tick = await daemon.tick();
    expect(tick.blocked).toBe(1);

    const events = await store.readRun(runId);
    const setup = events.find((event) => event.type === 'adapter.setup_required');
    expect(setup).toBeDefined();
    expect((setup?.payload as { reason?: string }).reason).toContain('nonexistent-adapter');
    expect(events.some((event) => event.type === 'worker.started')).toBe(false);
    expect(adapter.started).toHaveLength(0);
  });
});

/* ----------------------------------------------------------------------------
 * 4. Review modes affect execution only through policy (KTD6)
 * ------------------------------------------------------------------------- */

describe('scheduler-backed executor: review modes and policy', () => {
  it('human and autonomous modes schedule identically (no policy limit set)', async () => {
    const results: { started: readonly string[]; types: string[] }[] = [];
    for (const reviewMode of ['human', 'autonomous'] as const) {
      const adapter = immediateAdapter();
      const { app, store, daemon } = makeHarness({ adapter });
      const runId = await createPlannedRun(app, { reviewMode });
      await startRun(app, runId);
      await daemon.tick();
      results.push({ started: adapter.started, types: await types(store, runId) });
      expect(projectRun(await store.readRun(runId), runId).executionState).toBe('completed');
    }
    // Identical scheduling and identical ledger shape: the mode changed nothing.
    expect(results[0].started).toEqual(results[1].started);
    expect(results[0].types).toEqual(results[1].types);
  });

  it('a policy-blocked triage plan stays blocked in human AND autonomous modes', async () => {
    for (const reviewMode of ['human', 'autonomous'] as const) {
      const adapter = immediateAdapter();
      const { app, store, daemon } = makeHarness({ adapter });
      // Underspecified prompt -> triage plan (requires human clarification).
      const res = await app.handle(
        req('POST', '/api/runs', authedHeaders(), { prompt: 'hi', reviewMode }),
      );
      const runId = record(res).runId as string;
      await enqueueDirectly(store, runId);

      const tick = await daemon.tick();
      expect(tick.blocked, `review mode ${reviewMode}`).toBe(1);

      const events = await store.readRun(runId);
      expect(events.some((event) => event.type === 'worker.started')).toBe(false);
      expect(adapter.started).toHaveLength(0);
      const open = projectInterventions(events).open;
      expect(open.some((item) => item.kind === 'policy_block')).toBe(true);
      expect(projectRun(events, runId).executionState).toBe('blocked');
    }
  });
});

/* ----------------------------------------------------------------------------
 * 5. Duplicate queue claims cannot run the same ticket twice
 * ------------------------------------------------------------------------- */

describe('scheduler-backed executor: duplicate claim protection', () => {
  it('two daemons racing the same queued job execute every ticket exactly once', async () => {
    const executions = new Map<string, number>();
    const adapterA = immediateAdapter({ id: 'fake-a', executions });
    const adapterB = immediateAdapter({ id: 'fake-b', executions });
    const harness = makeHarness({ adapter: adapterA });
    const daemonB = harness.makeDaemon('daemon-w2', adapterB);
    const runId = await createPlannedRun(harness.app);
    await startRun(harness.app, runId);

    await Promise.all([harness.daemon.tick(), daemonB.tick()]);

    const events = await harness.store.readRun(runId);
    expect(events.filter((event) => event.type === 'queue.claimed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.started')).toHaveLength(1);
    for (const [ticketId, count] of executions) {
      expect(count, `ticket ${ticketId} executed ${count} times`).toBe(1);
    }
    expect(executions.size).toBeGreaterThan(0);
    expect(projectRun(events, runId).executionState).toBe('completed');
  });
});

/* ----------------------------------------------------------------------------
 * 6. Cancellation and graceful shutdown mid-DAG
 * ------------------------------------------------------------------------- */

describe('scheduler-backed executor: cancellation and shutdown', () => {
  it('run cancellation aborts in-flight tickets and releases the job as cancelled', async () => {
    const adapter = gatedRecordingAdapter();
    const { app, store, daemon } = makeHarness({ adapter });
    const runId = await createPlannedRun(app);
    await startRun(app, runId);

    const tick = daemon.tick();
    await adapter.whenStarted(1);
    expect([...adapter.inFlight]).toEqual(['scaffold']);

    const cancel = await app.handle(
      req('POST', `/api/runs/${runId}/cancel`, authedHeaders(), { reason: 'operator stop' }),
    );
    expect(cancel.status).toBe(200);
    await tick;

    const events = await store.readRun(runId);
    const seen = events.map((event) => event.type);
    expect(seen).toContain('worker.cancelled');
    const releases = events.filter((event) => event.type === 'queue.released');
    expect(
      releases.some((event) => (event.payload as { outcome?: string }).outcome === 'cancelled'),
    ).toBe(true);
    expect(projectRun(events, runId).executionState).toBe('cancelled');
    const tickets = projectTickets(events, runId);
    expect(tickets.byId['scaffold']?.state).toBe('cancelled');
    // No ticket beyond the aborted one ever started.
    expect(adapter.started).toEqual(['scaffold']);
  });

  it('graceful shutdown yields mid-DAG; a fresh daemon resumes WITHOUT re-running completed tickets', async () => {
    const executions = new Map<string, number>();
    const gated = gatedRecordingAdapter({ id: 'fake-a', executions });
    const harness = makeHarness({ adapter: gated });
    const runId = await createPlannedRun(harness.app);
    await startRun(harness.app, runId);

    const tick = harness.daemon.tick();
    await gated.whenStarted(1);
    gated.release('scaffold'); // scaffold completes...
    await gated.whenStarted(2); // ...data-model is now in flight
    await harness.daemon.stop(); // graceful shutdown aborts in-flight work
    await tick;

    const afterStop = await harness.store.readRun(runId);
    const job = projectExecutionQueue(afterStop, runId).jobs[0];
    expect(job.status).toBe('queued'); // requeued for a safe resume
    expect(job.attempt).toBe(2);
    const ticketsAfterStop = projectTickets(afterStop, runId);
    expect(ticketsAfterStop.byId['scaffold']?.state).toBe('completed');
    expect(ticketsAfterStop.byId['data-model']?.state).toBe('cancelled');
    expect(afterStop.some((event) => event.type === 'queue.lease_abandoned')).toBe(false);

    // A fresh daemon (new process) resumes: completed work is pre-settled.
    const resumeAdapter = immediateAdapter({ id: 'fake-b', executions });
    const daemonB = harness.makeDaemon('daemon-w2', resumeAdapter);
    const tickB = await daemonB.tick();
    expect(tickB.claimed).toBe(1);
    expect(tickB.completed).toBe(1);

    expect(executions.get('scaffold')).toBe(1); // NEVER re-ran
    expect(executions.get('data-model')).toBe(2); // cancelled attempt + resume
    const final = await harness.store.readRun(runId);
    expect(projectRun(final, runId).status).toBe('completed');
    expect(projectRun(final, runId).executionState).toBe('completed');
    for (const ticket of projectTickets(final, runId).tickets) {
      expect(ticket.state, `ticket ${ticket.ticketId}`).toBe('completed');
    }
  });

  it('pause mid-DAG yields safely; resume completes the rest without re-running', async () => {
    const executions = new Map<string, number>();
    const gated = gatedRecordingAdapter({ executions });
    const { app, store, daemon } = makeHarness({ adapter: gated });
    const runId = await createPlannedRun(app);
    await startRun(app, runId);

    const tick = daemon.tick();
    await gated.whenStarted(1);
    const paused = await app.handle(req('POST', `/api/runs/${runId}/pause`, authedHeaders(), {}));
    expect(paused.status).toBe(200);
    gated.release('scaffold'); // in-flight work settles safely after the pause
    await tick;

    const afterPause = await store.readRun(runId);
    expect(projectTickets(afterPause, runId).byId['scaffold']?.state).toBe('completed');
    expect(gated.started).toEqual(['scaffold']); // nothing new started
    const job = projectExecutionQueue(afterPause, runId).jobs[0];
    expect(job.status).toBe('queued');
    expect(job.attempt).toBe(2);

    // While paused the daemon claims nothing.
    const tickWhilePaused = await daemon.tick();
    expect(tickWhilePaused.claimed).toBe(0);

    const resumed = await app.handle(req('POST', `/api/runs/${runId}/resume`, authedHeaders(), {}));
    expect(resumed.status).toBe(200);
    const resumeTick = daemon.tick();
    await drainTick(gated, resumeTick);

    expect(executions.get('scaffold')).toBe(1); // completed work never re-ran
    const final = await store.readRun(runId);
    expect(projectRun(final, runId).executionState).toBe('completed');
    expect(projectRun(final, runId).status).toBe('completed');
  });
});

/* ----------------------------------------------------------------------------
 * 7. Fail-closed edges: unready workspace, failed tickets stay retryable,
 *    and gate re-runs stay honestly deferred (U7)
 * ------------------------------------------------------------------------- */

describe('scheduler-backed executor: fail-closed edges', () => {
  it('a source-backed run without a ready workspace blocks instead of inventing one', async () => {
    const adapter = immediateAdapter();
    const { app, store, daemon, ensured } = makeHarness({ adapter });
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: MARKETPLACE_PROMPT,
        githubRepo: 'octo/app',
      }),
    );
    const runId = record(res).runId as string;
    // Bypass preflight (which would also catch this): the executor fails closed.
    await enqueueDirectly(store, runId);

    const tick = await daemon.tick();
    expect(tick.blocked).toBe(1);
    expect(adapter.started).toHaveLength(0);
    expect(ensured).toHaveLength(0); // no fresh workspace invented for a repo run
    const open = projectInterventions(await store.readRun(runId)).open;
    expect(open.some((item) => item.kind === 'source_choice')).toBe(true);
  });

  it('adapter failures fail the attempt with per-ticket reasons and stay retryable', async () => {
    let failData = true;
    const executions = new Map<string, number>();
    const flaky: ExecutionAdapter = {
      id: 'fake-flaky',
      family: 'codex',
      detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 10 }),
      execute: (task) => {
        executions.set(task.ticketId, (executions.get(task.ticketId) ?? 0) + 1);
        if (task.ticketId === 'data-model' && failData) {
          return Promise.resolve({
            ok: false,
            error: AdapterError.toolDenied('db.migrate tool not allowed'),
          });
        }
        return Promise.resolve({ ok: true, output: `done:${task.ticketId}`, artifacts: [] });
      },
      reportCapacity: () => 10,
    };
    const { app, store, daemon } = makeHarness({ adapter: flaky });
    const runId = await createPlannedRun(app);
    await startRun(app, runId);

    const tick = await daemon.tick();
    expect(tick.failed).toBe(1);

    let run = projectRun(await store.readRun(runId), runId);
    expect(run.executionState).toBe('failed');
    // Explainable: the failure reason names the ticket and the adapter error.
    expect(run.executionReason).toContain('data-model');
    expect(run.executionReason).toContain('db.migrate');
    expect(projectTickets(await store.readRun(runId), runId).byId['data-model']?.state).toBe(
      'failed',
    );

    // Operator retry re-runs ONLY unfinished work and completes the run.
    failData = false;
    const retry = await app.handle(req('POST', `/api/runs/${runId}/retry`, authedHeaders(), {}));
    expect(retry.status).toBe(202);
    await daemon.tick();

    expect(executions.get('scaffold')).toBe(1); // completed before the failure
    expect(executions.get('data-model')).toBe(2);
    run = projectRun(await store.readRun(runId), runId);
    expect(run.executionState).toBe('completed');
    expect(run.status).toBe('completed');
  });

  it('gate-rerun jobs stay honestly blocked until U7', async () => {
    const adapter = immediateAdapter();
    const { app, store, daemon } = makeHarness({ adapter });
    const runId = await createPlannedRun(app);
    const res = await app.handle(
      req('POST', `/api/runs/${runId}/gates/rerun`, authedHeaders(), {}),
    );
    expect(res.status).toBe(202);

    const tick = await daemon.tick();
    expect(tick.blocked).toBe(1);
    expect(adapter.started).toHaveLength(0);
    const open = projectInterventions(await store.readRun(runId)).open;
    expect(
      open.some((item) => item.kind === 'retry_choice' && item.reason.includes('U7')),
    ).toBe(true);
  });
});
