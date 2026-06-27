import { describe, expect, it } from 'vitest';
import {
  checkCommand,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  isMutatingMethod,
  type CommandGuardContext,
  type EventStore,
  type OperatorTokenProvider,
} from '@software-factory/core';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

function deterministic() {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

function makeApp(): { app: App; store: EventStore; provider: OperatorTokenProvider } {
  const store = createInMemoryEventStore(deterministic());
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF },
  });
  return { app, store, provider };
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

function errorOf(res: ApiResponse): unknown {
  return (res.body as { error?: unknown }).error;
}

async function types(store: EventStore, runId: string): Promise<string[]> {
  return (await store.readRun(runId)).map((event) => event.type);
}

describe('checkCommand (pure policy)', () => {
  const context: CommandGuardContext = {
    verifyToken: (token) => token === TOKEN,
    allowedOrigins: [ORIGIN],
    csrfToken: CSRF,
    currentSubjectVersion: 3,
  };

  it('allows a fully valid mutating command', () => {
    const result = checkCommand(
      {
        method: 'POST',
        token: TOKEN,
        origin: ORIGIN,
        csrfHeader: CSRF,
        subject: { kind: 'run', id: 'r', version: 3 },
      },
      context,
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks missing and invalid tokens before anything else', () => {
    expect(checkCommand({ method: 'POST' }, context)).toMatchObject({
      allowed: false,
      reason: 'missing_token',
      event: 'security.block',
    });
    expect(checkCommand({ method: 'POST', token: 'bad' }, context)).toMatchObject({
      allowed: false,
      reason: 'invalid_token',
      event: 'security.block',
    });
  });

  it('rejects disallowed origins and CSRF-suspicious requests', () => {
    expect(
      checkCommand({ method: 'POST', token: TOKEN, origin: 'http://evil.example' }, context),
    ).toMatchObject({ allowed: false, reason: 'origin_not_allowed' });
    expect(
      checkCommand({ method: 'POST', token: TOKEN, origin: ORIGIN, csrfHeader: 'nope' }, context),
    ).toMatchObject({ allowed: false, reason: 'csrf_failed' });
    expect(checkCommand({ method: 'POST', token: TOKEN, origin: ORIGIN }, context)).toMatchObject({
      allowed: false,
      reason: 'csrf_failed',
    });
  });

  it('rejects a stale subject version as a command rejection', () => {
    const result = checkCommand(
      {
        method: 'POST',
        token: TOKEN,
        origin: ORIGIN,
        csrfHeader: CSRF,
        subject: { kind: 'run', id: 'r', version: 1 },
      },
      context,
    );
    expect(result).toMatchObject({
      allowed: false,
      reason: 'stale_subject_version',
      event: 'security.command_rejected',
    });
  });

  it('permits requests with no Origin (CLI/curl) and no CSRF when unconfigured', () => {
    expect(
      checkCommand(
        { method: 'POST', token: TOKEN, subject: { kind: 'run', id: 'r', version: 3 } },
        { verifyToken: () => true, allowedOrigins: [ORIGIN] },
      ),
    ).toEqual({ allowed: true });
  });

  it('classifies mutating methods', () => {
    expect(isMutatingMethod('GET')).toBe(false);
    expect(isMutatingMethod('post')).toBe(true);
    expect(isMutatingMethod('DELETE')).toBe(true);
  });
});

describe('command guard over mutating routes', () => {
  it('blocks a missing token and appends only a security.block', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', { origin: ORIGIN, 'x-csrf-token': CSRF }, { prompt: 'x' }),
    );
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('missing_token');
    expect(await types(store, 'run-1')).toEqual(['security.block']);
  });

  it('blocks an invalid token', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders({ 'x-operator-token': 'wrong' }), { prompt: 'x' }),
    );
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('invalid_token');
    expect(await types(store, 'run-1')).toEqual(['security.block']);
  });

  it('blocks a rotated (now-mismatched) token', async () => {
    const { app, store, provider } = makeApp();
    await provider.rotate();
    const res = await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'x' }));
    expect(res.status).toBe(401);
    expect(errorOf(res)).toBe('invalid_token');
    expect(await types(store, 'run-1')).toEqual(['security.block']);
  });

  it('rejects cross-origin requests before side effects', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders({ origin: 'http://evil.example' }), { prompt: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe('origin_not_allowed');
    expect(await types(store, 'run-1')).toEqual(['security.block']);
  });

  it('rejects CSRF-suspicious requests before side effects', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders({ 'x-csrf-token': undefined }), { prompt: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(errorOf(res)).toBe('csrf_failed');
    expect(await types(store, 'run-1')).toEqual(['security.block']);
  });

  it('rejects a stale review command and appends security.command_rejected, not review.decided', async () => {
    const { app, store } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'x' }));
    // Current version after run.created is 1; submit a stale version 0.
    const res = await app.handle(
      req('POST', '/api/runs/run-1/review', authedHeaders(), {
        decision: 'approved',
        riskTier: 'low',
        expectedVersion: 0,
      }),
    );
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('stale_subject_version');
    const seen = await types(store, 'run-1');
    expect(seen).toEqual(['run.created', 'security.command_rejected']);
    expect(seen).not.toContain('review.decided');
  });

  it('allows a fully valid command and appends the real event', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'x' }));
    expect(res.status).toBe(201);
    expect(await types(store, 'run-1')).toEqual(['run.created']);
  });
});
