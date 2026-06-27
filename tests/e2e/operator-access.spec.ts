/**
 * Operator-access e2e — exercises the local API over REAL HTTP.
 *
 * This spec uses ONLY Playwright's API `request` fixture (no browser page), so
 * it needs no browser binaries. In `beforeAll` it boots the framework-agnostic
 * app on an ephemeral loopback port via `app.listen(0)` with an in-memory event
 * store and a known operator token; `afterAll` closes it. Every assertion goes
 * through the started server's absolute URL (not the config baseURL).
 */
import { expect, test } from '@playwright/test';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import { createApp, type RunningServer } from '../../packages/web/src/server/app';

const TOKEN = 'e2e-operator-token';
const CSRF = 'e2e-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

let server: RunningServer | undefined;
let baseURL = '';

test.beforeAll(async () => {
  const store = createInMemoryEventStore();
  const operatorToken = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: Date.now() }),
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
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

test('binds to loopback', () => {
  expect(baseURL.startsWith('http://127.0.0.1:')).toBe(true);
});

test('blocks mutating routes without a valid operator token', async ({ request }) => {
  const missing = await request.post(`${baseURL}/api/runs`, {
    headers: { 'x-csrf-token': CSRF, origin: ORIGIN },
    data: { prompt: 'x' },
  });
  expect(missing.status()).toBe(401);
  expect((await missing.json()).error).toBe('missing_token');

  const invalid = await request.post(`${baseURL}/api/runs`, {
    headers: authed({ 'x-operator-token': 'wrong-token' }),
    data: { prompt: 'x' },
  });
  expect(invalid.status()).toBe(401);
  expect((await invalid.json()).error).toBe('invalid_token');
});

test('rejects cross-origin and CSRF-suspect mutating requests', async ({ request }) => {
  const crossOrigin = await request.post(`${baseURL}/api/runs`, {
    headers: authed({ origin: 'http://evil.example' }),
    data: { prompt: 'x' },
  });
  expect(crossOrigin.status()).toBe(403);
  expect((await crossOrigin.json()).error).toBe('origin_not_allowed');

  const noCsrf = await request.post(`${baseURL}/api/runs`, {
    headers: { 'x-operator-token': TOKEN, origin: ORIGIN },
    data: { prompt: 'x' },
  });
  expect(noCsrf.status()).toBe(403);
  expect((await noCsrf.json()).error).toBe('csrf_failed');
});

test('allows a valid run creation and keeps read-only routes reachable', async ({ request }) => {
  const created = await request.post(`${baseURL}/api/runs`, {
    headers: authed(),
    data: { prompt: 'build a marketplace', reviewMode: 'human' },
  });
  expect(created.status()).toBe(201);
  const runId = (await created.json()).runId as string;
  expect(runId).toBeTruthy();

  // Read-only event route requires no operator token.
  const events = await request.get(`${baseURL}/api/runs/${runId}/events`);
  expect(events.status()).toBe(200);
  const eventTypes = (await events.json()).events.map((event: { type: string }) => event.type);
  expect(eventTypes).toContain('run.created');

  // Setup route reports operator-token presence.
  const setup = await request.get(`${baseURL}/api/setup`);
  expect(setup.status()).toBe(200);
  expect((await setup.json()).operatorToken.present).toBe(true);
});

test('rejects a stale review command, then accepts it after reloading state', async ({
  request,
}) => {
  const created = await request.post(`${baseURL}/api/runs`, {
    headers: authed(),
    data: { prompt: 'review me' },
  });
  const runId = (await created.json()).runId as string;

  // A decision made against an outdated version is rejected without side effects.
  const stale = await request.post(`${baseURL}/api/runs/${runId}/review`, {
    headers: authed(),
    data: { decision: 'approved', riskTier: 'low', expectedVersion: 0 },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toBe('stale_subject_version');

  const afterReject = await request.get(`${baseURL}/api/runs/${runId}/events`);
  const rejectedTypes = (await afterReject.json()).events.map(
    (event: { type: string }) => event.type,
  );
  expect(rejectedTypes).toContain('security.command_rejected');
  expect(rejectedTypes).not.toContain('review.decided');

  // Reload current projected state and retry with the fresh version.
  const reload = await request.get(`${baseURL}/api/runs/${runId}`);
  expect(reload.status()).toBe(200);
  const currentVersion = (await reload.json()).run.lastSequence as number;

  const ok = await request.post(`${baseURL}/api/runs/${runId}/review`, {
    headers: authed(),
    data: { decision: 'approved', riskTier: 'low', expectedVersion: currentVersion },
  });
  expect(ok.status()).toBe(200);
  expect((await ok.json()).decision).toBe('approved');
});
