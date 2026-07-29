/**
 * Session lifecycle e2e (U8) — proves the composed flows F1–F3 (AE1–AE5)
 * against real servers.
 *
 * Server strategy (binding):
 *   - Gate-flipping and destructive commands (New Session, Factory Reset) run
 *     on ISOLATED servers only — the factory-gate.spec.ts precedent. New
 *     Session holds the gate and archives EVERY visible run, so running it on
 *     the shared dev server would destroy every other spec's seeded state
 *     mid-suite. Each test boots its own server INSIDE the test body (never
 *     `beforeAll`), so `fullyParallel` can never share mutated state.
 *   - The Factory Reset spec uses `startStandaloneServer` over a throwaway
 *     mkdtemp factory dir: it is the ONE runtime whose dispose/rebuild seam
 *     (mutable store/daemon/app triple behind `serveApp`) had no direct
 *     coverage after U7 — wrong phrase, `{confirm: ''}` pre-flight, the real
 *     wipe, fresh operator token, held daemon, generation bump on BOTH poll
 *     routes, and a SECOND reset (the self-referencing rebuild) are all
 *     asserted here over real HTTP against the real filesystem store.
 *   - Browser specs run on the shared dev server but perform ONLY
 *     own-run-scoped actions (seed → focus → resolve/cancel/archive their own
 *     run), which is exactly how the existing factory-floor specs coexist.
 *     New Session and Factory Reset therefore have NO browser e2e by design:
 *     they are factory-wide destructive on the shared server, and isolated
 *     servers serve no UI — the U6 jsdom suite carries that UI contract.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  AdapterError,
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import type { EventStore, ExecutionAdapter, FactoryEvent } from '@software-factory/core';
import { createApp } from '../../packages/web/src/server/app';
import { createExecutionDaemon } from '../../packages/web/src/server/execution/daemon';
import { startStandaloneServer } from '../../packages/web/src/server/standalone';
import { seedMarketplaceRun, seedRun } from './seed-run';

const TOKEN = 'e2e-session-operator-token';
const CSRF = 'e2e-session-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

/**
 * Same prompt the CLI/MCP suites use: the genome planner derives ticket risk
 * from the prompt, and this one plans work whose preflight passes without a
 * prior review approval — so `/start` reliably enqueues (executionState
 * queued → "active" for the New Session ask-once rule).
 */
const MARKETPLACE_PROMPT = 'Build an AI services marketplace with providers and proposals';

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN, ...extra };
}

/** Timers that never fire — no daemon background work runs inside these specs. */
function noopTimers(): { setInterval: () => null; clearInterval: () => undefined } {
  return { setInterval: () => null, clearInterval: () => undefined };
}

/** A deterministic, always-ready fake adapter for the preflight catalog. */
function readyFakeAdapter(): ExecutionAdapter {
  return {
    id: 'fake-ready',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 4 }),
    execute: () =>
      Promise.resolve({ ok: false as const, error: AdapterError.unavailable('not used') }),
    reportCapacity: () => 4,
  };
}

interface IsolatedServer {
  readonly baseURL: string;
  readonly store: EventStore;
  close(): Promise<void>;
}

/**
 * Boot a private in-memory API server (factory-gate pattern: `app.listen(0)`,
 * known operator token, daemon booted HELD like the server-runtime default).
 * Booted per TEST, never per file — `fullyParallel` may split tests across
 * workers, and shared mutable servers would make test order load-bearing.
 */
async function startIsolatedServer(): Promise<IsolatedServer> {
  const store = createInMemoryEventStore();
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;
  const daemon = createExecutionDaemon({
    store,
    idGenerator: () => `e2e-lease-${(leaseSeq += 1)}`,
    ownerId: 'e2e-session-daemon',
    timers: noopTimers(),
    config: { autoStart: false },
  });
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `e2e-run-${(runSeq += 1)}-${Math.floor(Math.random() * 1e6)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
    adapterCatalog: createAdapterCatalog([readyFakeAdapter()]),
  });
  const server = await app.listen(0);
  return { baseURL: server.url, store, close: () => server.close() };
}

async function createRun(request: APIRequestContext, baseURL: string): Promise<string> {
  const res = await request.post(`${baseURL}/api/runs`, {
    headers: authed(),
    data: { prompt: MARKETPLACE_PROMPT },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { runId?: string };
  expect(typeof body.runId).toBe('string');
  return body.runId as string;
}

interface RunRow {
  readonly runId: string;
  readonly status: string;
  readonly archived: boolean;
}

async function listRuns(
  request: APIRequestContext,
  baseURL: string,
  includeArchived = false,
): Promise<RunRow[]> {
  const res = await request.get(
    `${baseURL}/api/runs${includeArchived ? '?includeArchived=1' : ''}`,
  );
  expect(res.status()).toBe(200);
  return ((await res.json()) as { runs: RunRow[] }).runs;
}

/** Ordered event types on one run's ledger (404 → empty stream). */
async function eventTypes(
  request: APIRequestContext,
  baseURL: string,
  runId: string,
): Promise<string[]> {
  const res = await request.get(`${baseURL}/api/runs/${runId}/events`);
  if (res.status() === 404) {
    return [];
  }
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { events: { type: string }[] };
  return body.events.map((event) => event.type);
}

/* ----------------------------------------------------------------------------
 * AE1 / F2 — New Session on an isolated request-API server
 * ------------------------------------------------------------------------- */

test.describe('new session (AE1 / F2) — isolated server', () => {
  test('ask-once 409 changes nothing; confirmed command archives all, holds the gate, clears the queue, and records the marker', async ({
    request,
  }) => {
    const server = await startIsolatedServer();
    try {
      const { baseURL } = server;
      // Seeded multi-run state: two idle (planned) runs + one ACTIVE run
      // (started → queued behind the held gate).
      const idleA = await createRun(request, baseURL);
      const idleB = await createRun(request, baseURL);
      const active = await createRun(request, baseURL);
      const started = await request.post(`${baseURL}/api/runs/${active}/start`, {
        headers: authed(),
        data: {},
      });
      expect(started.status()).toBe(202);
      expect((await started.json()) as Record<string, unknown>).toMatchObject({
        queued: true,
        held: true,
      });

      // Ask-once (AE1): actives present without confirmActive → 409 naming
      // them, and NOTHING changed — no hold flip, no cancel, no marker.
      const refused = await request.post(`${baseURL}/api/execution/new-session`, {
        headers: authed(),
        data: {},
      });
      expect(refused.status()).toBe(409);
      const refusal = (await refused.json()) as {
        error: string;
        activeRuns: { runId: string }[];
      };
      expect(refusal.error).toBe('active_runs_present');
      expect(refusal.activeRuns.map((run) => run.runId)).toEqual([active]);
      expect(await listRuns(request, baseURL)).toHaveLength(3);
      expect(await eventTypes(request, baseURL, active)).not.toContain('run.cancelled');
      expect(await eventTypes(request, baseURL, 'factory')).toEqual([]);

      // Confirmed: ONE atomic command — hold, cancel actives, release queued
      // work, archive every visible run, record the session marker.
      const confirmed = await request.post(`${baseURL}/api/execution/new-session`, {
        headers: authed(),
        data: { confirmActive: true },
      });
      expect(confirmed.status()).toBe(200);
      const outcome = (await confirmed.json()) as {
        archived: string[];
        cancelled: string[];
        held: boolean;
        errors?: unknown[];
      };
      expect([...outcome.archived].sort()).toEqual([idleA, idleB, active].sort());
      expect(outcome.cancelled).toEqual([active]);
      expect(outcome.held).toBe(true);
      expect(outcome.errors).toBeUndefined();

      // The floor is clean: default list empty; history opts back in (R7).
      expect(await listRuns(request, baseURL)).toEqual([]);
      const history = await listRuns(request, baseURL, true);
      expect(history.map((run) => run.runId).sort()).toEqual([idleA, idleB, active].sort());
      expect(history.every((run) => run.archived)).toBe(true);

      // Gate held, queue truly empty (R8).
      const overview = await request.get(`${baseURL}/api/execution`);
      expect((await overview.json()) as Record<string, unknown>).toMatchObject({
        execution: expect.objectContaining({ held: true }) as unknown,
        queue: { queued: 0, leased: 0 },
        resetGeneration: 0,
      });

      // The marker records what the command did (R12), on the reserved
      // 'factory' stream that never joins run lists.
      const factoryEvents = await request.get(`${baseURL}/api/runs/factory/events`);
      expect(factoryEvents.status()).toBe(200);
      const marker = ((await factoryEvents.json()) as { events: FactoryEvent[] }).events.find(
        (event) => event.type === 'session.started',
      );
      expect(marker).toBeDefined();
      expect(
        [...((marker?.payload as { archivedRunIds: string[] }).archivedRunIds ?? [])].sort(),
      ).toEqual([idleA, idleB, active].sort());

      // Ledger ordering on the active run's stream: cancel → queued-job
      // release → archive (the R16 discipline, observable in the ledger).
      const activeTypes = await eventTypes(request, baseURL, active);
      const cancelledAt = activeTypes.indexOf('run.cancelled');
      const releasedAt = activeTypes.indexOf('queue.released');
      const archivedAt = activeTypes.indexOf('run.archived');
      expect(cancelledAt).toBeGreaterThan(-1);
      expect(releasedAt).toBeGreaterThan(cancelledAt);
      expect(archivedAt).toBeGreaterThan(releasedAt);
    } finally {
      await server.close();
    }
  });
});

/* ----------------------------------------------------------------------------
 * AE4 / F1 (request level) — needs-you truth on the floor payload
 * ------------------------------------------------------------------------- */

test.describe('needs-you / idle (AE4 / F1) — isolated server payloads', () => {
  test('floor payload carries the pending intervention and empties on resolve', async ({
    request,
  }) => {
    const server = await startIsolatedServer();
    try {
      const { baseURL, store } = server;
      const runId = 'e2e-needs-you-run';
      const interventionId = `${runId}:deploy:setup:1`;
      await store.append({
        runId,
        type: 'run.created',
        actor: { kind: 'operator', id: 'operator' },
        subject: { kind: 'run', id: runId, version: 0 },
        severity: 'info',
        payload: { prompt: 'Needs-you e2e: one open intervention.', reviewMode: 'human' },
      });
      await store.append({
        runId,
        type: 'intervention.raised',
        actor: { kind: 'system', id: 'execution-daemon' },
        subject: { kind: 'intervention', id: interventionId },
        severity: 'warn',
        payload: {
          interventionId,
          kind: 'deploy_setup',
          blockingStage: 'deploy',
          reason: 'Render deploy credentials are not configured for this factory.',
          requiredAction: 'Connect Render credentials, then re-run the deploy stage.',
        },
      });

      // The single poll endpoint reports the item that needs the operator.
      const before = await request.get(`${baseURL}/api/floor`);
      expect(before.status()).toBe(200);
      const beforeBody = (await before.json()) as {
        openCount: number;
        interventions: { interventionId: string; runId: string; status: string }[];
      };
      expect(beforeBody.openCount).toBe(1);
      expect(beforeBody.interventions[0]).toMatchObject({
        interventionId,
        runId,
        status: 'open',
      });

      // Resolve through the real guarded route → the explicit idle truth:
      // zero open items, resolution recorded on the ledger.
      const resolved = await request.post(
        `${baseURL}/api/interventions/${interventionId}/resolve`,
        { headers: authed(), data: { resolution: 'Connected Render credentials.' } },
      );
      expect(resolved.status()).toBe(200);
      expect((await resolved.json()) as Record<string, unknown>).toMatchObject({
        alreadyResolved: false,
      });

      const after = await request.get(`${baseURL}/api/floor`);
      const afterBody = (await after.json()) as { openCount: number };
      expect(afterBody.openCount).toBe(0);
      expect(await eventTypes(request, baseURL, runId)).toContain('intervention.resolved');
    } finally {
      await server.close();
    }
  });
});

/* ----------------------------------------------------------------------------
 * AE5 + AE2 (request level) — cancel-and-archive, replayable archive
 * ------------------------------------------------------------------------- */

test.describe('archive lifecycle (AE2 / AE5) — isolated server', () => {
  test('cancel with archive:true is ONE command and the run is archived immediately (AE5)', async ({
    request,
  }) => {
    const server = await startIsolatedServer();
    try {
      const { baseURL } = server;
      const runId = await createRun(request, baseURL);

      const res = await request.post(`${baseURL}/api/runs/${runId}/cancel`, {
        headers: authed(),
        data: { archive: true },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { archived?: boolean; run: RunRow };
      expect(body.archived).toBe(true);
      expect(body.run).toMatchObject({ status: 'cancelled', archived: true });

      // Both events landed from the single command; the run left the default
      // view in the same moment (R10).
      const types = await eventTypes(request, baseURL, runId);
      expect(types).toContain('run.cancelled');
      expect(types).toContain('run.archived');
      expect(await listRuns(request, baseURL)).toEqual([]);
      const history = await listRuns(request, baseURL, true);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ runId, status: 'cancelled', archived: true });
    } finally {
      await server.close();
    }
  });

  test('archived run events stay readable; unarchive restores visibility only (AE2, R13)', async ({
    request,
  }) => {
    const server = await startIsolatedServer();
    try {
      const { baseURL } = server;
      const runId = await createRun(request, baseURL);

      // Archive of a non-terminal (planned) run cancels first (R16).
      const archived = await request.post(`${baseURL}/api/runs/${runId}/archive`, {
        headers: authed(),
        data: {},
      });
      expect(archived.status()).toBe(200);
      // The response reports the R16 side effect (`cancelled: true`) and the
      // archived state on the projected run itself.
      const archiveBody = (await archived.json()) as { cancelled?: boolean; run: RunRow };
      expect(archiveBody.cancelled).toBe(true);
      expect(archiveBody.run).toMatchObject({ archived: true, status: 'cancelled' });

      // Replay path: the archived run's full event log and projection remain
      // readable through the detail routes (AE2).
      const types = await eventTypes(request, baseURL, runId);
      expect(types[0]).toBe('run.created');
      expect(types).toContain('run.cancelled');
      expect(types).toContain('run.archived');
      const detail = await request.get(`${baseURL}/api/runs/${runId}`);
      expect(detail.status()).toBe(200);
      expect(((await detail.json()) as { run: RunRow }).run).toMatchObject({
        archived: true,
        status: 'cancelled',
      });

      // Unarchive: visible again, but cancelled STAYS terminal (R13).
      const unarchived = await request.post(`${baseURL}/api/runs/${runId}/unarchive`, {
        headers: authed(),
        data: {},
      });
      expect(unarchived.status()).toBe(200);
      const visible = await listRuns(request, baseURL);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({ runId, status: 'cancelled', archived: false });
    } finally {
      await server.close();
    }
  });
});

/* ----------------------------------------------------------------------------
 * AE3 / F3 — Factory Reset on an isolated STANDALONE server (mkdtemp dir)
 * ------------------------------------------------------------------------- */

test.describe('factory reset (AE3 / F3) — isolated standalone server', () => {
  test('wrong phrase and pre-flight change nothing; the exact phrase wipes, re-keys, and bumps the generation — twice', async ({
    request,
  }) => {
    // The standalone runtime reads process.env; pin the local-mode defaults so
    // a developer machine's SF_* variables can never leak into this spec
    // (e.g. SF_OPERATOR_TOKEN would defeat the fresh-token assertion).
    delete process.env.SF_OPERATOR_TOKEN;
    delete process.env.SF_FACTORY_DIR;
    delete process.env.SF_RUNTIME;
    delete process.env.SF_CSRF_TOKEN;
    delete process.env.SF_EXEC_AUTOSTART;

    const base = await mkdtemp(join(tmpdir(), 'sf-e2e-reset-'));
    const factoryDir = join(base, 'factory');
    const userDir = join(base, 'user-data');
    const userFile = join(userDir, 'keep.txt');
    const strayFile = join(factoryDir, 'user-notes.txt');
    const standalone = await startStandaloneServer({ port: 0, factoryDir });
    try {
      const baseURL = standalone.server.url;
      const oldToken = standalone.operatorToken;
      const tokenHeaders = (token: string): Record<string, string> => ({
        'x-operator-token': token,
      });

      // One real run on the real filesystem store, plus user-supplied paths
      // the reset must never touch: a file OUTSIDE the factory dir and a
      // non-allowlisted file INSIDE it.
      const created = await request.post(`${baseURL}/api/runs`, {
        headers: tokenHeaders(oldToken),
        data: { prompt: MARKETPLACE_PROMPT },
      });
      expect(created.ok()).toBe(true);
      const runId = ((await created.json()) as { runId: string }).runId;
      await mkdir(userDir, { recursive: true });
      await writeFile(userFile, 'user data outside the factory dir\n');
      await writeFile(strayFile, 'operator note inside the factory dir\n');

      // AE3: wrong phrase → 400 naming the required phrase; NOTHING deleted.
      const wrong = await request.post(`${baseURL}/api/execution/factory-reset`, {
        headers: tokenHeaders(oldToken),
        data: { confirm: 'reset everything' },
      });
      expect(wrong.status()).toBe(400);
      const wrongBody = (await wrong.json()) as {
        error: string;
        requiredPhrase: string;
        wouldDestroy: { runCount: number; eventCount: number };
      };
      expect(wrongBody.error).toBe('confirmation_mismatch');
      expect(wrongBody.requiredPhrase).toBe('reset the factory');
      expect(wrongBody.wouldDestroy.runCount).toBe(1);
      expect(await listRuns(request, baseURL)).toHaveLength(1);
      expect(existsSync(join(factoryDir, 'events'))).toBe(true);

      // The UI pre-flight contract: `{confirm: ''}` returns the enumeration
      // of what WOULD be destroyed, contractually without deleting anything.
      const preflight = await request.post(`${baseURL}/api/execution/factory-reset`, {
        headers: tokenHeaders(oldToken),
        data: { confirm: '' },
      });
      expect(preflight.status()).toBe(400);
      const preflightBody = (await preflight.json()) as {
        wouldDestroy: { runCount: number; eventCount: number; paths: string[] };
      };
      expect(preflightBody.wouldDestroy.runCount).toBe(1);
      expect(preflightBody.wouldDestroy.eventCount).toBeGreaterThan(0);
      expect(preflightBody.wouldDestroy.paths).toContain(join(factoryDir, 'events'));
      expect(await listRuns(request, baseURL)).toHaveLength(1);

      // F3: the exact phrase wipes the allowlist and re-opens fresh.
      const reset = await request.post(`${baseURL}/api/execution/factory-reset`, {
        headers: tokenHeaders(oldToken),
        data: { confirm: 'reset the factory' },
      });
      expect(reset.status()).toBe(200);
      expect((await reset.json()) as Record<string, unknown>).toMatchObject({
        reset: true,
        resetGeneration: 1,
        held: true,
      });

      // The fresh ledger explains itself: EXACTLY the reset marker + the
      // session marker, nothing resurrected. (Read BEFORE the old-token
      // probe below — guard denials also land on the 'factory' stream.)
      const factoryRes = await request.get(`${baseURL}/api/runs/factory/events`);
      expect(factoryRes.status()).toBe(200);
      const factoryEvents = ((await factoryRes.json()) as { events: FactoryEvent[] }).events;
      expect(factoryEvents.map((event) => event.type)).toEqual([
        'factory.reset_completed',
        'session.started',
      ]);
      expect(factoryEvents[0]?.payload).toMatchObject({ resetGeneration: 1, wipedRunCount: 1 });
      expect(await listRuns(request, baseURL)).toEqual([]);
      const oldRunEvents = await request.get(`${baseURL}/api/runs/${runId}/events`);
      expect(oldRunEvents.status()).toBe(404);

      // R15: the bumped generation rides on BOTH poll routes; the rebuilt
      // daemon boots HELD.
      const overview = await request.get(`${baseURL}/api/execution`);
      expect((await overview.json()) as Record<string, unknown>).toMatchObject({
        resetGeneration: 1,
        execution: expect.objectContaining({ held: true }) as unknown,
      });
      const floor = await request.get(`${baseURL}/api/floor`);
      expect((await floor.json()) as Record<string, unknown>).toMatchObject({
        resetGeneration: 1,
      });

      // R15 re-auth: the OLD operator token is dead; a FRESH one was minted.
      const oldTokenProbe = await request.post(`${baseURL}/api/execution/hold`, {
        headers: tokenHeaders(oldToken),
        data: {},
      });
      expect(oldTokenProbe.status()).toBe(401);
      const session = JSON.parse(
        await readFile(join(factoryDir, 'operator-token.json'), 'utf8'),
      ) as { token: string };
      expect(session.token).not.toBe(oldToken);
      const freshTokenProbe = await request.post(`${baseURL}/api/execution/hold`, {
        headers: tokenHeaders(session.token),
        data: {},
      });
      expect(freshTokenProbe.status()).toBe(200);
      expect((await freshTokenProbe.json()) as Record<string, unknown>).toMatchObject({
        held: true,
      });

      // Allowlist-only destruction: user-supplied paths survive — outside the
      // factory dir AND non-allowlisted files inside it.
      expect(existsSync(userFile)).toBe(true);
      expect(existsSync(strayFile)).toBe(true);

      // The standalone rebuild is SELF-REFERENCING: the swapped-in app can
      // reset again (the seam U7 left for e2e). Generation bumps monotonic.
      const secondReset = await request.post(`${baseURL}/api/execution/factory-reset`, {
        headers: tokenHeaders(session.token),
        data: { confirm: 'reset the factory' },
      });
      expect(secondReset.status()).toBe(200);
      expect((await secondReset.json()) as Record<string, unknown>).toMatchObject({
        reset: true,
        resetGeneration: 2,
      });
      const afterSecond = await request.get(`${baseURL}/api/execution`);
      expect((await afterSecond.json()) as Record<string, unknown>).toMatchObject({
        resetGeneration: 2,
      });
    } finally {
      await standalone.close();
      await rm(base, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

/* ----------------------------------------------------------------------------
 * Browser specs — shared dev server, own-run-scoped actions only
 * ------------------------------------------------------------------------- */

/** Focus a specific seeded run from the run board (factory-floor precedent). */
async function focusRun(page: Page, runId: string): Promise<void> {
  const marker = page.getByTestId('blueprint-run').locator(`[data-full="${runId}"]`);
  if ((await marker.count()) === 0) {
    await page
      .getByLabel('Runs')
      .getByRole('button', { name: `Focus run ${runId}` })
      .click();
  }
  await expect(page.getByTestId('blueprint-loading')).toBeHidden({ timeout: 10_000 });
  await expect(marker).toBeVisible({ timeout: 10_000 });
}

/**
 * Minimal seeded run for the AE4 browser flow: ONE open intervention and ZERO
 * pending reviews, so resolving that single item is exactly the transition
 * from "needs you" to the designed idle state. (The shared full-factory
 * fixture also carries an undecided high-risk review, which would keep the
 * needs-you union non-empty — correct behavior, wrong fixture for AE4.)
 */
function buildNeedsYouRunEvents(runId: string): FactoryEvent[] {
  const interventionId = `${runId}:deploy:setup:1`;
  const base = 1_700_000_000_000;
  return [
    {
      version: 1,
      eventId: 'evt-1',
      runId,
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: runId, version: 0 },
      type: 'run.created',
      sequence: 1,
      timestamp: base + 1000,
      severity: 'info',
      payload: {
        prompt: 'Session lifecycle e2e: one open intervention, no pending reviews.',
        reviewMode: 'human',
      },
    } satisfies FactoryEvent,
    {
      version: 1,
      eventId: 'evt-2',
      runId,
      actor: { kind: 'system', id: 'execution-daemon' },
      subject: { kind: 'intervention', id: interventionId },
      type: 'intervention.raised',
      sequence: 2,
      timestamp: base + 2000,
      severity: 'warn',
      payload: {
        interventionId,
        kind: 'deploy_setup',
        blockingStage: 'deploy',
        reason: 'Render deploy credentials are not configured for this factory.',
        requiredAction: 'Connect Render credentials, then re-run the deploy stage.',
      },
    } satisfies FactoryEvent,
  ];
}

test('AE4 / F1 (browser): pending intervention reads in the headline; resolving reaches the explicit idle state', async ({
  page,
}) => {
  const runId = `e2e-needs-you-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const interventionId = `${runId}:deploy:setup:1`;
  await seedRun(page.request, buildNeedsYouRunEvents(runId));

  await page.goto('/');
  await focusRun(page, runId);

  // R3: the headline says ONE item needs the operator, one expand away.
  await expect(page.getByTestId('status-headline')).toBeVisible();
  const needsYou = page.getByTestId('headline-needs-you');
  await expect(needsYou).toBeVisible();
  await expect(needsYou).toContainText('1 needs you');
  await needsYou.locator('summary').click();
  await expect(page.getByTestId('needs-you-item')).toContainText('Render');

  // Resolve the item through the real intervention queue UI (own-run scope).
  const item = page.getByLabel('Operator interventions').locator(`[data-run-id="${runId}"]`);
  await item.getByRole('button', { name: `Resolve intervention ${interventionId}` }).click();
  await item
    .getByLabel(`Resolution for ${interventionId}`)
    .fill('Connected Render credentials for the e2e factory.');
  await item.getByRole('button', { name: 'Record' }).click();

  // R5 / AE4: the explicit designed idle state — never absence of content.
  await expect(page.getByTestId('headline-idle')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('headline-idle')).toContainText('nothing needs you in this run');
  await expect(page.getByTestId('headline-needs-you')).toHaveCount(0);
});

test('AE5 + AE2 (browser): cancel offers archive in the same moment; history shows, replays, and unarchive restores', async ({
  page,
}) => {
  // One composed flow: cancel → offer → archive → history → replay → unarchive
  // → restored. Two full page loads plus four poll round-trips legitimately
  // exceed the default 30s budget on a cold dev server; triple it.
  test.slow();
  const runId = await seedMarketplaceRun(page.request, 'e2e-lifecycle');
  await page.goto('/');
  await focusRun(page, runId);

  // AE5: single-click cancel → the archive offer appears in the SAME moment,
  // confirmed from the cancel response (no optimistic UI).
  await page.getByRole('button', { name: `Cancel run ${runId}` }).click();
  const offer = page.getByTestId('archive-offer');
  await expect(offer).toBeVisible({ timeout: 10_000 });
  await offer.getByTestId('archive-offer-accept').click();

  // The archived run leaves the default board (visibility lifecycle, R7).
  await expect(
    page.getByLabel('Runs').getByRole('button', { name: `Focus run ${runId}` }),
  ).toHaveCount(0, { timeout: 10_000 });

  // AE2: history reveals it; the row is explicitly labeled archived. Long run
  // ids render Mono-truncated, so match on the row's data-run-id attribute,
  // never on visible text.
  await page.getByTestId('history-toggle').click();
  const archivedRow = page.locator(`[data-testid="archived-run"][data-run-id="${runId}"]`);
  await expect(archivedRow).toBeVisible({ timeout: 10_000 });
  await expect(archivedRow).toContainText('archived');

  // AE2: replay — the archived run's events render in the detail view.
  await expect(archivedRow.getByRole('link', { name: `Replay run ${runId}` })).toHaveAttribute(
    'href',
    `/runs/${runId}`,
  );
  await archivedRow.getByRole('link', { name: `Replay run ${runId}` }).click();
  const ledger = page.getByRole('log', { name: 'Run event stream' });
  await expect(ledger.getByText('run.cancelled')).toBeVisible({ timeout: 10_000 });
  await expect(ledger.getByText('run.archived')).toBeVisible();

  // R13: unarchive restores visibility only — the run returns to the default
  // list still cancelled (verified against the live API, not the DOM alone).
  await page.goto('/');
  await page.getByTestId('history-toggle').click();
  const rowAgain = page.locator(`[data-testid="archived-run"][data-run-id="${runId}"]`);
  await expect(rowAgain).toBeVisible({ timeout: 10_000 });
  await rowAgain.getByRole('button', { name: `Unarchive run ${runId}` }).click();
  await expect(
    page.getByLabel('Runs').getByRole('button', { name: `Focus run ${runId}` }),
  ).toBeVisible({ timeout: 10_000 });
  const restored = await page.request.get('/api/runs');
  const runs = ((await restored.json()) as { runs: { runId: string; status: string }[] }).runs;
  expect(runs.find((run) => run.runId === runId)).toMatchObject({ status: 'cancelled' });
});
