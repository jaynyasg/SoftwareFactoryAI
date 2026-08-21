/**
 * Factory-wide drain gate e2e — exercises the gate routes over REAL HTTP on an
 * ISOLATED server (operator-access.spec.ts pattern: `app.listen(0)`, in-memory
 * store, known operator token, no browser). The gate is process-local by
 * design, so flipping it must never happen on the shared factory-floor dev
 * server — a resume there drains every other spec's seeded queued work
 * mid-suite. Here the daemon is private to this spec, so resume/hold flips
 * observe the real route + daemon behavior without cross-spec interference.
 */
import { expect, test } from '@playwright/test';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import { createApp, type RunningServer } from '../../packages/web/src/server/app';
import { createExecutionDaemon } from '../../packages/web/src/server/execution/daemon';

const TOKEN = 'e2e-gate-operator-token';
const CSRF = 'e2e-gate-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

let server: RunningServer | undefined;
let baseURL = '';

test.beforeAll(async () => {
  const store = createInMemoryEventStore();
  const operatorToken = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: Date.now() }),
  });
  let runSeq = 0;
  // Boot the daemon HELD (autoStart off) — the server-runtime default this
  // gate exists for. The daemon is never start()ed: gate state and route
  // behavior are what this spec pins, not drain passes.
  const daemon = createExecutionDaemon({
    store,
    ownerId: 'e2e-gate-daemon',
    config: { autoStart: false },
  });
  const app = createApp({
    store,
    operatorToken,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
    execution: daemon,
  });
  server = await app.listen(0);
  baseURL = server.url;
});

test.afterAll(async () => {
  await server?.close();
});

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN, ...extra };
}

test('boots held: GET /api/execution reports the engaged gate', async ({ request }) => {
  const res = await request.get(`${baseURL}/api/execution`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    execution: { enabled: boolean; held: boolean };
    queue: { queued: number; leased: number };
  };
  expect(body.execution).toMatchObject({ enabled: true, held: true });
  expect(body.queue).toMatchObject({ queued: 0, leased: 0 });
});

test('unauthorized resume is rejected and leaves the gate engaged', async ({ request }) => {
  const denied = await request.post(`${baseURL}/api/execution/resume`, {
    headers: { 'x-csrf-token': CSRF, origin: ORIGIN },
    data: {},
  });
  expect(denied.status()).toBe(401);
  const after = await request.get(`${baseURL}/api/execution`);
  expect(((await after.json()) as { execution: { held: boolean } }).execution.held).toBe(true);
});

test('resume releases the gate, converges on repeat, and hold re-engages it', async ({
  request,
}) => {
  const resumed = await request.post(`${baseURL}/api/execution/resume`, {
    headers: authed(),
    data: {},
  });
  expect(resumed.status()).toBe(200);
  expect((await resumed.json()) as Record<string, unknown>).toMatchObject({
    resumed: true,
    held: false,
  });
  const active = await request.get(`${baseURL}/api/execution`);
  expect(((await active.json()) as { execution: { held: boolean } }).execution.held).toBe(false);

  // Repeat resume converges instead of erroring.
  const again = await request.post(`${baseURL}/api/execution/resume`, {
    headers: authed(),
    data: {},
  });
  expect(again.status()).toBe(200);
  expect((await again.json()) as Record<string, unknown>).toMatchObject({ alreadyActive: true });

  // Hold re-engages; repeat hold converges.
  const held = await request.post(`${baseURL}/api/execution/hold`, { headers: authed(), data: {} });
  expect(held.status()).toBe(200);
  expect((await held.json()) as Record<string, unknown>).toMatchObject({ held: true });
  const reHeld = await request.post(`${baseURL}/api/execution/hold`, {
    headers: authed(),
    data: {},
  });
  expect(reHeld.status()).toBe(200);
  expect((await reHeld.json()) as Record<string, unknown>).toMatchObject({ alreadyHeld: true });
});

test('unauthorized cancel-all is rejected before any side effects', async ({ request }) => {
  const denied = await request.post(`${baseURL}/api/runs/cancel-all`, {
    headers: { 'x-csrf-token': CSRF, origin: ORIGIN },
    data: {},
  });
  expect(denied.status()).toBe(401);
});
