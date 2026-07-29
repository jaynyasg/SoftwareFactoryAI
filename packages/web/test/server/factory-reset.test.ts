/**
 * Factory Reset command tests (session lifecycle U4, flow F3, AE3).
 *
 * TEST-FIRST discipline: the refusal tests (wrong phrase, leased job) and the
 * allowlist tests (what may be deleted, what must survive) pin the highest-
 * blast-radius surface in the plan BEFORE the deletion code exists.
 *
 * Every test runs against an ISOLATED temp factory dir (never the repo's real
 * `.factory/`) with a REAL filesystem event store, because the whole point of
 * the unit is disk deletion + singleton dispose/rebuild semantics. The harness
 * mirrors the production `instance.ts` shape: requests always dispatch through
 * the CURRENT app (like the Next catch-all calling `getApp()` per request),
 * and the injected `FactoryResetRuntime.rebuild()` swaps store + daemon + app
 * exactly like the globalThis singleton dispose does.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileSystemEventStore,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
} from '@software-factory/core';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { createExecutionDaemon, type ExecutionDaemon } from '../../src/server/execution/daemon';
import {
  claimJob,
  enqueueJob,
  executionJobId,
  projectExecutionQueue,
} from '../../src/server/execution/queue';
import {
  FACTORY_RESET_PHRASE,
  FactoryResetWipeError,
  executeFactoryReset,
  factoryResetAllowlist,
  type FactoryResetRuntime,
} from '../../src/server/factory-reset';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

const MARKETPLACE_PROMPT =
  'Build an AI services marketplace with providers, proposals, and customer requests';

/** Timers that never fire — the daemon is never driven in these tests. */
function noopTimers() {
  return {
    setInterval: () => null,
    clearInterval: () => undefined,
  };
}

function authedHeaders(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN, ...extra };
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

/* ----------------------------------------------------------------------------
 * Isolated temp factory dirs — NEVER the repo's real .factory/.
 * ------------------------------------------------------------------------- */

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/* ----------------------------------------------------------------------------
 * Harness: filesystem store + real (held, unstarted) daemon + reset runtime
 * that swaps store/daemon/app the way instance.ts swaps globalThis singletons.
 * ------------------------------------------------------------------------- */

interface ResetHarness {
  readonly factoryDir: string;
  /** Dispatch through the CURRENT app (mirrors `getApp()` per request). */
  handle(request: ApiRequest): Promise<ApiResponse>;
  /** The CURRENT store (swapped by a successful reset). */
  store(): EventStore;
  /** The CURRENT daemon (swapped by a successful reset). */
  daemon(): ExecutionDaemon;
  /** How many times the reset runtime rebuilt the singletons. */
  rebuilds(): number;
}

function makeResetHarness(
  factoryDir: string,
  options: { readonly wipe?: FactoryResetRuntime['wipe'] } = {},
): ResetHarness {
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let rebuilds = 0;

  const buildStore = (): EventStore =>
    createFileSystemEventStore({ baseDir: join(factoryDir, 'events') });
  const buildDaemon = (target: EventStore): ExecutionDaemon =>
    createExecutionDaemon({
      store: target,
      timers: noopTimers(),
      ownerId: 'daemon-test',
      // Server-runtime semantics: the daemon boots HELD.
      config: { autoStart: false },
    });

  const resetRuntime: FactoryResetRuntime = {
    factoryDir,
    rebuild: () => {
      rebuilds += 1;
      store = buildStore();
      daemon = buildDaemon(store);
      app = buildApp(store, daemon);
      return Promise.resolve(store);
    },
    ...(options.wipe !== undefined ? { wipe: options.wipe } : {}),
  };

  const buildApp = (target: EventStore, owner: ExecutionDaemon): App =>
    createApp({
      store: target,
      operatorToken: provider,
      config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
      execution: owner,
      factoryReset: resetRuntime,
    });

  let store = buildStore();
  let daemon = buildDaemon(store);
  let app = buildApp(store, daemon);

  return {
    factoryDir,
    handle: (request) => app.handle(request),
    store: () => store,
    daemon: () => daemon,
    rebuilds: () => rebuilds,
  };
}

async function makeHarness(): Promise<ResetHarness> {
  return makeResetHarness(await makeTempDir('sf-factory-reset-'));
}

/** Create a planned run through the API (genome planner, real ledger files). */
async function createRun(harness: ResetHarness): Promise<string> {
  const res = await harness.handle(
    req('POST', '/api/runs', authedHeaders(), { prompt: MARKETPLACE_PROMPT }),
  );
  expect(res.status).toBe(201);
  return record(res).runId as string;
}

/** Seed a LEASED queue job on the ledger (lease far in the future). */
async function seedLeasedJob(harness: ResetHarness, runId: string): Promise<string> {
  const jobId = executionJobId(runId);
  await enqueueJob(harness.store(), {
    runId,
    jobId,
    jobKind: 'run-execution',
    attempt: 1,
    reason: 'test seed',
  });
  const job = projectExecutionQueue(await harness.store().readRun(runId), runId).byJobId[jobId];
  expect(job).toBeDefined();
  await claimJob(harness.store(), job, {
    leaseId: 'lease-live',
    ownerId: 'owner-elsewhere',
    leaseExpiresAt: Date.now() + 600_000,
  });
  return jobId;
}

function resetRequest(confirm?: unknown): ApiRequest {
  return req(
    'POST',
    '/api/execution/factory-reset',
    authedHeaders(),
    confirm === undefined ? {} : { confirm },
  );
}

/* ----------------------------------------------------------------------------
 * Refusal paths FIRST (AE3): wrong phrase, missing phrase, leased job, guard.
 * Nothing may be deleted on ANY refusal.
 * ------------------------------------------------------------------------- */

describe('POST /api/execution/factory-reset — refusals (AE3)', () => {
  it('rejects a wrong confirmation phrase, deletes NOTHING, and enumerates what a reset WOULD destroy', async () => {
    const harness = await makeHarness();
    const runId = await createRun(harness);
    const before = await harness.store().readAll();

    const res = await harness.handle(resetRequest('delete everything'));
    expect(res.status).toBe(400);
    const body = record(res);
    expect(body.error).toBe('confirmation_mismatch');
    // The error message documents the exact required phrase (R9/AE3 UI copy).
    expect(String(body.message)).toContain(FACTORY_RESET_PHRASE);
    expect(body.requiredPhrase).toBe(FACTORY_RESET_PHRASE);

    // Pre-flight enumeration rides on the refusal so the UI confirmation can
    // render what is at stake BEFORE the operator types the phrase.
    const wouldDestroy = body.wouldDestroy as Record<string, unknown>;
    expect(wouldDestroy.runCount).toBe(1);
    expect(wouldDestroy.archivedRunCount).toBe(0);
    expect(wouldDestroy.eventCount).toBe(before.length);
    expect(wouldDestroy.resetGeneration).toBe(0);
    expect(wouldDestroy.paths).toEqual([join(harness.factoryDir, 'events')]);
    expect(wouldDestroy.workspacePaths).toEqual([]);

    // NOTHING was deleted or rebuilt: ledger intact, files intact, run listed.
    expect(harness.rebuilds()).toBe(0);
    expect(existsSync(join(harness.factoryDir, 'events'))).toBe(true);
    expect(await harness.store().readAll()).toEqual(before);
    const list = await harness.handle(req('GET', '/api/runs', {}));
    expect((record(list).runs as { runId: string }[]).map((run) => run.runId)).toContain(runId);
  });

  it('rejects a missing confirmation phrase identically (nothing deleted)', async () => {
    const harness = await makeHarness();
    await createRun(harness);
    const before = await harness.store().readAll();

    const res = await harness.handle(resetRequest());
    expect(res.status).toBe(400);
    expect(record(res).error).toBe('confirmation_mismatch');
    expect(record(res).wouldDestroy).toBeDefined();
    expect(harness.rebuilds()).toBe(0);
    expect(await harness.store().readAll()).toEqual(before);
  });

  it('refuses while a queue-job lease is active, listing the leased jobs; nothing deleted', async () => {
    const harness = await makeHarness();
    const runId = await createRun(harness);
    const jobId = await seedLeasedJob(harness, runId);
    const before = await harness.store().readAll();

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(409);
    const body = record(res);
    expect(body.error).toBe('jobs_leased');
    const leased = body.leasedJobs as Record<string, unknown>[];
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({
      jobId,
      runId,
      jobKind: 'run-execution',
      attempt: 1,
      ownerId: 'owner-elsewhere',
    });

    // The refusal changed nothing: no wipe, no rebuild, gate untouched.
    expect(harness.rebuilds()).toBe(0);
    expect(existsSync(join(harness.factoryDir, 'events'))).toBe(true);
    expect(await harness.store().readAll()).toEqual(before);
  });

  it('guard rejection (bad token) deletes nothing and audits on the factory stream', async () => {
    const harness = await makeHarness();
    await createRun(harness);

    const res = await harness.handle(
      req(
        'POST',
        '/api/execution/factory-reset',
        authedHeaders({ 'x-operator-token': 'wrong-token' }),
        { confirm: FACTORY_RESET_PHRASE },
      ),
    );
    expect(res.status).toBe(401);
    expect(harness.rebuilds()).toBe(0);
    expect(existsSync(join(harness.factoryDir, 'events'))).toBe(true);

    // The denial is audit-visible on the reserved 'factory' stream (an
    // invalid-token denial appends `security.block`; stale commands would
    // append `security.command_rejected` — see command-guard.ts).
    const denials = (await harness.store().readAll()).filter(
      (event) =>
        event.runId === 'factory' &&
        (event.type === 'security.block' || event.type === 'security.command_rejected'),
    );
    expect(denials).toHaveLength(1);
    expect(denials[0]?.type).toBe('security.block');
  });

  it('fails closed (503) when no reset runtime or no daemon is wired', async () => {
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
    });
    const store = createInMemoryEventStore();
    // No factoryReset capability injected.
    const noRuntime = createApp({
      store,
      operatorToken: provider,
      config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
      execution: createExecutionDaemon({
        store,
        timers: noopTimers(),
        config: { autoStart: false },
      }),
    });
    const res = await noRuntime.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(503);
    expect(record(res).error).toBe('factory_reset_disabled');

    // No daemon: fail closed the same way the other factory commands do.
    const noDaemon = createApp({
      store,
      operatorToken: provider,
      config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
      execution: null,
      factoryReset: { factoryDir: 'unused', rebuild: () => Promise.resolve(store) },
    });
    const res2 = await noDaemon.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res2.status).toBe(503);
    expect(record(res2).error).toBe('execution_disabled');
  });
});

/* ----------------------------------------------------------------------------
 * Allowlist: exactly `events/`, `workspaces/`, `operator-token.json` under the
 * factory dir — and NOTHING else, ever.
 * ------------------------------------------------------------------------- */

describe('POST /api/execution/factory-reset — allowlist', () => {
  it('the allowlist is exactly events/, workspaces/, operator-token.json under the factory dir', () => {
    expect(factoryResetAllowlist('/tmp/factory')).toEqual([
      join('/tmp/factory', 'events'),
      join('/tmp/factory', 'workspaces'),
      join('/tmp/factory', 'operator-token.json'),
    ]);
  });

  it('wipes allowlisted paths, but user localFolder targets and non-allowlisted factory-dir files survive', async () => {
    const harness = await makeHarness();
    await createRun(harness);

    // Factory-managed state that MUST be destroyed.
    const workspaceCheckout = join(harness.factoryDir, 'workspaces', 'run-x');
    await mkdir(workspaceCheckout, { recursive: true });
    await writeFile(join(workspaceCheckout, 'artifact.txt'), 'generated', 'utf8');
    const tokenFile = join(harness.factoryDir, 'operator-token.json');
    await writeFile(tokenFile, JSON.stringify({ token: 'file-token' }), 'utf8');

    // NOT factory-managed: a stray operator file inside the factory dir but
    // outside the allowlist…
    const strayFile = join(harness.factoryDir, 'notes.txt');
    await writeFile(strayFile, 'operator notes', 'utf8');
    // …and a user-supplied localFolder workspace target OUTSIDE the factory
    // dir (the plan's hard rule: NEVER in the allowlist).
    const localFolder = await makeTempDir('sf-user-local-folder-');
    const userFile = join(localFolder, 'user-code.ts');
    await writeFile(userFile, 'export const mine = true;', 'utf8');

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(200);

    const destroyed = record(res).destroyed as Record<string, unknown>;
    expect(destroyed.paths).toEqual([
      join(harness.factoryDir, 'events'),
      join(harness.factoryDir, 'workspaces'),
      tokenFile,
    ]);
    expect(destroyed.workspacePaths).toEqual([workspaceCheckout]);
    // The response also reports what was ACTUALLY deleted (A4 audit surface).
    expect(record(res).deletedPaths).toEqual([
      join(harness.factoryDir, 'events'),
      join(harness.factoryDir, 'workspaces'),
      tokenFile,
    ]);

    // Allowlisted paths are gone (events/ is re-created by the fresh markers).
    expect(existsSync(join(harness.factoryDir, 'workspaces'))).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);

    // Everything outside the allowlist survived.
    expect(existsSync(strayFile)).toBe(true);
    expect(existsSync(localFolder)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
  });
});

/* ----------------------------------------------------------------------------
 * Happy path (F3) + fresh-state semantics.
 * ------------------------------------------------------------------------- */

describe('POST /api/execution/factory-reset — happy path (F3)', () => {
  it('wipes the factory and opens fresh state with the reset + session markers', async () => {
    const harness = await makeHarness();
    const runId = await createRun(harness);
    const archivedId = await createRun(harness);
    const archive = await harness.handle(
      req('POST', `/api/runs/${archivedId}/archive`, authedHeaders(), {}),
    );
    expect(archive.status).toBe(200);

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(200);
    const body = record(res);
    expect(body.reset).toBe(true);
    expect(body.resetGeneration).toBe(1);
    expect(body.held).toBe(true);
    const destroyed = body.destroyed as Record<string, unknown>;
    expect(destroyed.runCount).toBe(1);
    expect(destroyed.archivedRunCount).toBe(1);

    // The fresh ledger contains EXACTLY the two markers, in order, on the
    // reserved 'factory' stream — the discontinuity explains itself (R12).
    const fresh = await harness.store().readAll();
    expect(fresh.map((event) => event.type)).toEqual([
      'factory.reset_completed',
      'session.started',
    ]);
    expect(fresh.every((event) => event.runId === 'factory')).toBe(true);
    expect(fresh[0].payload).toMatchObject({ resetGeneration: 1, wipedRunCount: 2 });

    // The wiped runs are gone from every view served by the rebuilt app.
    const list = await harness.handle(req('GET', '/api/runs', {}));
    expect(record(list).runs).toEqual([]);
    const detail = await harness.handle(req('GET', `/api/runs/${runId}`, {}));
    expect(detail.status).toBe(404);
  });

  it('rebuilds singletons: post-reset appends start at sequence 1 with no resurrection', async () => {
    const harness = await makeHarness();
    // Seed enough events that a surviving sequence high-water mark would show.
    await createRun(harness);
    await createRun(harness);

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(200);
    expect(harness.rebuilds()).toBe(1);

    // Fresh factory stream restarts at sequence 1 — the pre-wipe store's
    // allocator high-water marks did NOT survive the rebuild.
    const fresh = await harness.store().readAll();
    expect(fresh.map((event) => event.sequence)).toEqual([1, 2]);

    // A brand-new run through the REBUILT app also starts at sequence 1, and
    // the old runs never resurrect into the fresh readAll.
    const newRunId = await createRun(harness);
    const newRunEvents = await harness.store().readRun(newRunId);
    expect(newRunEvents[0]?.sequence).toBe(1);
    expect(newRunEvents[0]?.type).toBe('run.created');
    const all = await harness.store().readAll();
    const runIds = new Set(all.map((event) => event.runId));
    expect(runIds).toEqual(new Set(['factory', newRunId]));
  });

  it('surfaces the reset generation through GET /api/execution AND GET /api/floor', async () => {
    const harness = await makeHarness();
    await createRun(harness);

    const beforeOverview = await harness.handle(req('GET', '/api/execution', {}));
    expect(record(beforeOverview).resetGeneration).toBe(0);

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(record(res).resetGeneration).toBe(1);

    const overview = await harness.handle(req('GET', '/api/execution', {}));
    expect(overview.status).toBe(200);
    expect(record(overview).resetGeneration).toBe(1);
    // The fresh daemon boots HELD (server-runtime semantics).
    expect(record(overview).execution).toMatchObject({ enabled: true, held: true });
    expect(record(overview).queue).toEqual({ queued: 0, leased: 0 });

    // The floor union carries the same generation (stale-tab detection, R15).
    const floor = await harness.handle(req('GET', '/api/floor', {}));
    expect(floor.status).toBe(200);
    expect(record(floor).resetGeneration).toBe(1);
    expect(record(floor).openCount).toBe(0);
  });

  it('the reset generation is monotonic across TWO resets (ledger-persisted, not process state)', async () => {
    const harness = await makeHarness();
    await createRun(harness);

    const first = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(first.status).toBe(200);
    expect(record(first).resetGeneration).toBe(1);

    const second = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(second.status).toBe(200);
    expect(record(second).resetGeneration).toBe(2);

    // The second fresh ledger's marker carries generation 2 and the overview
    // agrees — the generation was read from the persisted marker, not memory.
    const fresh = await harness.store().readAll();
    expect(fresh[0]?.type).toBe('factory.reset_completed');
    expect(fresh[0]?.payload).toMatchObject({ resetGeneration: 2 });
    const overview = await harness.handle(req('GET', '/api/execution', {}));
    expect(record(overview).resetGeneration).toBe(2);
  });
});

/* ----------------------------------------------------------------------------
 * Sealing the outgoing store (A1): an in-flight append on a pre-reset handle
 * must reject and must NOT re-create wiped `events/` (core's FS store append
 * is mkdir -p + appendFile — without the seal it would resurrect the dir).
 * ------------------------------------------------------------------------- */

describe('executeFactoryReset — seals the outgoing store before deletion', () => {
  it('an append on the pre-reset store handle rejects and does NOT recreate events/', async () => {
    const factoryDir = await makeTempDir('sf-factory-seal-');
    const oldStore = createFileSystemEventStore({ baseDir: join(factoryDir, 'events') });
    await oldStore.append({
      runId: 'run-seal',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-seal', version: 0 },
      severity: 'info',
      payload: {},
    });
    expect(existsSync(join(factoryDir, 'events'))).toBe(true);
    const daemon = createExecutionDaemon({
      store: oldStore,
      timers: noopTimers(),
      ownerId: 'daemon-seal-test',
      config: { autoStart: false },
    });
    // Rebuild returns an in-memory store so nothing recreates events/ on disk
    // — any reappearance of the dir can only come from the OLD handle.
    const runtime: FactoryResetRuntime = {
      factoryDir,
      rebuild: () => Promise.resolve(createInMemoryEventStore()),
    };

    const outcome = await executeFactoryReset({
      daemon,
      store: oldStore,
      runtime,
      nextGeneration: 1,
      wipedRunCount: 1,
    });
    expect(outcome.deletedPaths).toEqual([join(factoryDir, 'events')]);
    expect(existsSync(join(factoryDir, 'events'))).toBe(false);

    // The pre-reset handle is sealed: append/readAll reject loudly…
    await expect(
      oldStore.append({
        runId: 'run-seal',
        type: 'run.created',
        actor: { kind: 'operator', id: 'operator' },
        subject: { kind: 'run', id: 'run-seal', version: 0 },
        severity: 'info',
        payload: {},
      }),
    ).rejects.toThrow('factory_reset_in_progress');
    await expect(oldStore.readAll()).rejects.toThrow('factory_reset_in_progress');
    // …and the rejected append did NOT resurrect the wiped events dir.
    expect(existsSync(join(factoryDir, 'events'))).toBe(false);
  });

  it('route-level: the pre-reset store handle is unusable after a reset; nothing resurrects', async () => {
    const harness = await makeHarness();
    await createRun(harness);
    const preResetStore = harness.store();

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(200);

    await expect(
      preResetStore.append({
        runId: 'run-late-append',
        type: 'run.created',
        actor: { kind: 'operator', id: 'operator' },
        subject: { kind: 'run', id: 'run-late-append', version: 0 },
        severity: 'info',
        payload: {},
      }),
    ).rejects.toThrow('factory_reset_in_progress');

    // The fresh ledger holds EXACTLY the two markers — no late-append leak.
    const fresh = await harness.store().readAll();
    expect(fresh.map((event) => event.type)).toEqual([
      'factory.reset_completed',
      'session.started',
    ]);
  });
});

/* ----------------------------------------------------------------------------
 * Wipe failure (A4): rebuild ALWAYS runs (Windows EBUSY must not brick the
 * server) and the PARTIAL deletion is surfaced, never discarded.
 * ------------------------------------------------------------------------- */

describe('POST /api/execution/factory-reset — wipe failure (A4)', () => {
  it('rebuilds fresh singletons when the wipe throws and surfaces the partial deletion as 500', async () => {
    const factoryDir = await makeTempDir('sf-factory-wipefail-');
    const harness = makeResetHarness(factoryDir, {
      // Simulate Windows EBUSY AFTER events/ was already removed: a partial
      // deletion with a locked workspaces dir left behind.
      wipe: async (dir) => {
        await rm(join(dir, 'events'), { recursive: true, force: true });
        throw new FactoryResetWipeError(
          `could not delete "${join(dir, 'workspaces')}": EBUSY: resource busy or locked`,
          [join(dir, 'events')],
        );
      },
    });
    await createRun(harness);

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(500);
    const body = record(res);
    expect(body.error).toBe('factory_reset_failed');
    expect(String(body.message)).toContain('EBUSY');
    // The PARTIAL deletion is reported, not discarded.
    expect(body.deletedPaths).toEqual([join(factoryDir, 'events')]);
    expect(body.held).toBe(true);

    // The singletons were STILL rebuilt: a fresh held daemon, a working app
    // over the (now empty) rebuilt store, and no generation bump (the reset
    // did not complete, so no markers were appended).
    expect(harness.rebuilds()).toBe(1);
    expect(harness.daemon().held).toBe(true);
    const list = await harness.handle(req('GET', '/api/runs', {}));
    expect(list.status).toBe(200);
    expect(record(list).runs).toEqual([]);
    const overview = await harness.handle(req('GET', '/api/execution', {}));
    expect(record(overview).resetGeneration).toBe(0);
  });
});

/* ----------------------------------------------------------------------------
 * Gate discipline on refusal (A5): the route holds the gate FIRST and
 * re-checks leases UNDER the held gate; a refusal restores the prior state.
 * ------------------------------------------------------------------------- */

describe('POST /api/execution/factory-reset — gate discipline on refusal (A5)', () => {
  it('a lease refusal (409) restores a previously RELEASED gate', async () => {
    const harness = await makeHarness();
    const runId = await createRun(harness);
    const resumed = await harness.handle(req('POST', '/api/execution/resume', authedHeaders(), {}));
    expect(resumed.status).toBe(200);
    expect(harness.daemon().held).toBe(false);
    await seedLeasedJob(harness, runId);

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(409);
    expect(record(res).error).toBe('jobs_leased');
    // The refused reset left the gate exactly as it was: released.
    expect(harness.daemon().held).toBe(false);
    expect(harness.rebuilds()).toBe(0);
  });

  it('a confirmation mismatch (400) restores a previously RELEASED gate', async () => {
    const harness = await makeHarness();
    await createRun(harness);
    await harness.handle(req('POST', '/api/execution/resume', authedHeaders(), {}));
    expect(harness.daemon().held).toBe(false);

    const res = await harness.handle(resetRequest('not the phrase'));
    expect(res.status).toBe(400);
    expect(harness.daemon().held).toBe(false);
    expect(harness.rebuilds()).toBe(0);
  });

  it('a refusal on an already-HELD gate leaves it held', async () => {
    const harness = await makeHarness();
    const runId = await createRun(harness);
    expect(harness.daemon().held).toBe(true);
    await seedLeasedJob(harness, runId);

    const res = await harness.handle(resetRequest(FACTORY_RESET_PHRASE));
    expect(res.status).toBe(409);
    expect(harness.daemon().held).toBe(true);
  });
});
