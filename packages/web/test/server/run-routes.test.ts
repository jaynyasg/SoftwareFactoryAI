import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
  type RunProjection,
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

function makeApp(): { app: App; store: EventStore } {
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
  return { app, store };
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

describe('POST /api/runs', () => {
  // The run flow (U10) plans the run into the SAME store right after run.created:
  // a marketplace prompt yields the full 12-ticket DAG + run.planned capstone.
  it('creates a run, plans the ticket DAG, and returns the planned run', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: 'Build an AI services marketplace with providers, proposals, and customer requests',
      }),
    );

    expect(res.status).toBe(201);
    expect(record(res).runId).toBe('run-1');
    const run = record(res).run as RunProjection;
    expect(run.status).toBe('planned');
    expect(run.plannedTicketCount).toBe(12);

    const events = await store.readRun('run-1');
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('supervisor.decision');
    expect(types).toContain('run.planned');
    expect(events.filter((e) => e.type === 'ticket.created')).toHaveLength(12);
  });

  it('records the caller family on run.created for nested-agent provenance', async () => {
    const { app, store } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'x', callerFamily: 'codex' }));
    const created = (await store.readRun('run-1')).find((e) => e.type === 'run.created');
    expect(created?.type).toBe('run.created');
    expect((created?.payload as { callerFamily?: string }).callerFamily).toBe('codex');
  });

  it('does not re-create or re-plan a run for a duplicate idempotency key', async () => {
    const { app, store } = makeApp();
    const first = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', idempotencyKey: 'k1' }),
    );
    const second = await app.handle(
      req('POST', '/api/runs', authedHeaders(), { prompt: 'x', idempotencyKey: 'k1' }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(record(second).deduplicated).toBe(true);
    expect(record(first).runId).toBe(record(second).runId);

    expect(await store.listRuns()).toEqual(['run-1']);
    const events = await store.readRun('run-1');
    expect(events.filter((e) => e.type === 'run.created')).toHaveLength(1);
    // emitPlan is idempotent: the second create re-plans but appends no dupes.
    expect(events.filter((e) => e.type === 'run.planned')).toHaveLength(1);
  });

  it('guard failure emits the security event and starts nothing', async () => {
    const { app, store } = makeApp();
    const res = await app.handle(
      req('POST', '/api/runs', { origin: ORIGIN, 'x-csrf-token': CSRF }, { prompt: 'x' }),
    );
    expect(res.status).toBe(401);

    const events = await store.readRun('run-1');
    expect(events.map((e) => e.type)).toEqual(['security.block']);
    expect(events.some((e) => e.type === 'run.created' || e.type === 'worker.started')).toBe(false);
  });
});

describe('GET /api/runs (read-only)', () => {
  it('returns projected runs without requiring auth', async () => {
    const { app } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'a' }));

    const res = await app.handle(req('GET', '/api/runs', {}));
    expect(res.status).toBe(200);
    const runs = record(res).runs as RunProjection[];
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-1');
    expect(runs[0].status).toBe('planned');
  });
});

describe('read-only run inspection routes', () => {
  it('returns the ordered event log and the planned run projection', async () => {
    const { app } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'a' }));

    const eventsRes = await app.handle(req('GET', '/api/runs/run-1/events', {}));
    expect(eventsRes.status).toBe(200);
    const events = record(eventsRes).events as { type: string }[];
    expect(events[0].type).toBe('run.created');
    expect(events.map((e) => e.type)).toContain('run.planned');

    const runRes = await app.handle(req('GET', '/api/runs/run-1', {}));
    expect(runRes.status).toBe(200);
    expect((record(runRes).run as RunProjection).status).toBe('planned');
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('GET', '/api/runs/missing/events', {}));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/runs/:id/cancel', () => {
  it('cancels a run with valid auth', async () => {
    const { app, store } = makeApp();
    await app.handle(req('POST', '/api/runs', authedHeaders(), { prompt: 'a' }));

    const res = await app.handle(
      req('POST', '/api/runs/run-1/cancel', authedHeaders(), { reason: 'operator stop' }),
    );
    expect(res.status).toBe(200);
    expect((record(res).run as RunProjection).status).toBe('cancelled');

    const events = await store.readRun('run-1');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('run.created');
    expect(types).toContain('run.planned');
    expect(types[types.length - 1]).toBe('run.cancelled');
  });
});

describe('GET /api/setup (read-only)', () => {
  it('reports operator-token presence and conservative placeholders', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('GET', '/api/setup', {}));
    expect(res.status).toBe(200);
    const body = record(res);
    expect(body.operatorToken).toEqual({ present: true });
    expect(body.deploy).toEqual({ status: 'required' });
  });
});
