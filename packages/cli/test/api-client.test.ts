import { describe, expect, it } from 'vitest';
import type { FactoryEvent } from '@software-factory/core';
import { ApiError, createApiClient } from '../src/api-client';
import type { FetchLike } from '../src/api-client';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

/** Build a mock `fetch` that records calls and returns canned JSON responses. */
function mockFetch(
  handler: (call: RecordedCall) => { status: number; body: unknown },
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
    const call: RecordedCall = {
      url,
      method: String(init?.method ?? 'GET'),
      headers,
      body,
    };
    calls.push(call);
    const { status, body: responseBody } = handler(call);
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

function evt(sequence: number, type: string, payload: Record<string, unknown> = {}): FactoryEvent {
  return {
    version: 1,
    eventId: `e${sequence}`,
    runId: 'run-1',
    actor: { kind: 'system', id: 's' },
    subject: { kind: 'run', id: 'run-1' },
    type,
    sequence,
    timestamp: 1000 + sequence,
    severity: 'info',
    payload,
  } as FactoryEvent;
}

describe('createApiClient', () => {
  it('createRun sends a guarded POST with operator + CSRF headers and the body fields', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 201,
      body: { runId: 'run-1', deduplicated: false, run: { runId: 'run-1', status: 'planned' } },
    }));
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:9/',
      operatorToken: 'tok',
      csrfToken: 'csrf',
      fetchImpl,
    });

    const result = await client.createRun({ prompt: 'hi', callerFamily: 'codex' });
    expect(result.runId).toBe('run-1');
    expect(result.deduplicated).toBe(false);

    const call = calls[0];
    expect(call.url).toBe('http://127.0.0.1:9/api/runs');
    expect(call.method).toBe('POST');
    expect(call.headers['x-operator-token']).toBe('tok');
    expect(call.headers['x-csrf-token']).toBe('csrf');
    // Non-browser caller: no Origin header is sent.
    expect(call.headers.origin).toBeUndefined();
    expect((call.body as Record<string, unknown>).prompt).toBe('hi');
    expect((call.body as Record<string, unknown>).callerFamily).toBe('codex');
  });

  it('omits the CSRF header when no CSRF token is configured (standalone backend)', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 201,
      body: { runId: 'run-1', run: {} },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    await client.createRun({ prompt: 'hi' });
    expect(calls[0].headers['x-operator-token']).toBe('tok');
    expect(calls[0].headers['x-csrf-token']).toBeUndefined();
  });

  it('getEvents resumes by sequence (returns only events after sinceSequence)', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { runId: 'run-1', events: [evt(1, 'run.created'), evt(2, 'run.planned'), evt(3, 'run.started')] },
    }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });

    const all = await client.getEvents('run-1');
    expect(all.events.map((e) => e.sequence)).toEqual([1, 2, 3]);

    const resumed = await client.getEvents('run-1', { sinceSequence: 2 });
    expect(resumed.events.map((e) => e.sequence)).toEqual([3]);
  });

  it('cancelRun and review send expectedVersion for the stale-command guard', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 200, body: { runId: 'run-1', run: {} } }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    await client.cancelRun('run-1', { expectedVersion: 5, reason: 'stop' });
    expect((calls[0].body as Record<string, unknown>).expectedVersion).toBe(5);

    await client.review('run-1', { decision: 'approved', riskTier: 'low', expectedVersion: 7 });
    expect((calls[1].body as Record<string, unknown>).expectedVersion).toBe(7);
    expect((calls[1].body as Record<string, unknown>).decision).toBe('approved');
  });

  it('surfaces auth failures as a typed ApiError', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      body: { error: 'invalid_token', message: 'Operator token is invalid.' },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'wrong', fetchImpl });

    await expect(client.createRun({ prompt: 'x' })).rejects.toBeInstanceOf(ApiError);
    try {
      await client.createRun({ prompt: 'x' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(401);
      expect(apiError.code).toBe('invalid_token');
      expect(apiError.isAuthFailure).toBe(true);
    }
  });

  it('maps a stale-command rejection to ApiError.isStale', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 409,
      body: { error: 'stale_subject_version', message: 'stale' },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    try {
      await client.cancelRun('run-1', { expectedVersion: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ApiError).isStale).toBe(true);
    }
  });

  it('reads the setup status', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: {
        operatorToken: { present: true },
        sandbox: { status: 'unknown' },
        adapters: { status: 'unknown', detected: [] },
        deploy: { status: 'required' },
      },
    }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });
    const setup = await client.getSetup();
    expect(setup.operatorToken.present).toBe(true);
    expect(setup.deploy.status).toBe('required');
  });
});
