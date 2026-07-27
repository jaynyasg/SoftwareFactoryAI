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
function mockFetch(handler: (call: RecordedCall) => { status: number; body: unknown }): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const rawBody = init?.body;
    const body =
      typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
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
      body: {
        runId: 'run-1',
        events: [evt(1, 'run.created'), evt(2, 'run.planned'), evt(3, 'run.started')],
      },
    }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });

    const all = await client.getEvents('run-1');
    expect(all.events.map((e) => e.sequence)).toEqual([1, 2, 3]);

    const resumed = await client.getEvents('run-1', { sinceSequence: 2 });
    expect(resumed.events.map((e) => e.sequence)).toEqual([3]);
  });

  it('cancelRun and review send expectedVersion for the stale-command guard', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: { runId: 'run-1', run: {} },
    }));
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

  it('review surfaces the stage-resume outcome of an approval (and drops junk)', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: {
        runId: 'run-1',
        run: { runId: 'run-1', status: 'running' },
        resumed: {
          stage: 'gates',
          resolvedInterventions: ['i-1', 42, 'i-2'],
          queued: true,
          extra: 'ignored',
        },
      },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    const result = await client.review('run-1', {
      decision: 'approved',
      riskTier: 'low',
      expectedVersion: 7,
    });
    expect(result.resumed).toEqual({
      stage: 'gates',
      resolvedInterventions: ['i-1', 'i-2'],
      queued: true,
    });
  });

  it('review leaves resumed absent when the server resumed nothing (null)', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { runId: 'run-1', run: {}, resumed: null },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    const result = await client.review('run-1', {
      decision: 'rejected',
      riskTier: 'low',
      expectedVersion: 7,
    });
    expect(result.resumed).toBeUndefined();
  });
});

describe('execution command extraction', () => {
  const CANNED_BODY = {
    runId: 'run-9',
    queued: true,
    alreadyQueued: false,
    execution: { state: 'queued', reason: 'preflight passed' },
    job: {
      jobId: 'run-9:execution',
      jobKind: 'run-execution',
      attempt: 2,
      status: 'queued',
      reason: 'retry',
    },
    run: { runId: 'run-9', status: 'running' },
    unexpected: 'must not leak into the typed result',
  };

  it('startRun destructures the documented fields and drops unknown ones', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 202, body: CANNED_BODY }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    const result = await client.startRun('run-9', { expectedVersion: 4, reason: 'go' });
    expect(calls[0].url).toBe('http://x/api/runs/run-9/start');
    expect(calls[0].body).toEqual({ expectedVersion: 4, reason: 'go' });
    expect(result.runId).toBe('run-9');
    expect(result.queued).toBe(true);
    expect(result.alreadyQueued).toBe(false);
    expect(result.execution).toEqual({ state: 'queued', reason: 'preflight passed' });
    expect(result.job).toEqual({
      jobId: 'run-9:execution',
      jobKind: 'run-execution',
      attempt: 2,
      status: 'queued',
      reason: 'retry',
    });
    expect('unexpected' in result).toBe(false);
  });

  it('pauseRun/resumeRun map their booleans and degrade malformed sub-shapes', async () => {
    const { fetchImpl, calls } = mockFetch((call) => ({
      status: 200,
      body: call.url.endsWith('/pause')
        ? { runId: 'run-2', paused: true, execution: { state: 'paused' } }
        : { resumed: true, execution: 'not-an-object', job: { jobId: 'missing-fields' } },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    const paused = await client.pauseRun('run-2');
    expect(paused).toMatchObject({ runId: 'run-2', paused: true, execution: { state: 'paused' } });

    const resumed = await client.resumeRun('run-2');
    // No runId in the body: falls back to the requested run id.
    expect(resumed.runId).toBe('run-2');
    expect(resumed.resumed).toBe(true);
    // Malformed nested shapes degrade to absent, not lying types.
    expect(resumed.execution).toBeUndefined();
    expect(resumed.job).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      'http://x/api/runs/run-2/pause',
      'http://x/api/runs/run-2/resume',
    ]);
  });

  it('retryRun forwards ticketId and rerunGates hits the gates endpoint', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 202,
      body: { runId: 'run-3', queued: true },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    const retried = await client.retryRun('run-3', { ticketId: 't-1', reason: 'fix data model' });
    expect(calls[0].url).toBe('http://x/api/runs/run-3/retry');
    expect(calls[0].body).toEqual({ ticketId: 't-1', reason: 'fix data model' });
    expect(retried).toMatchObject({ runId: 'run-3', queued: true });

    const gates = await client.rerunGates('run-3');
    expect(calls[1].url).toBe('http://x/api/runs/run-3/gates/rerun');
    expect(gates).toMatchObject({ runId: 'run-3', queued: true });
  });

  it('surfaces execution-command denials as typed ApiError (stale guard)', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 409,
      body: { error: 'stale_subject_version', message: 'stale' },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    try {
      await client.startRun('run-4', { expectedVersion: 1 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).isStale).toBe(true);
    }
  });
});

describe('factory-wide gate + cancel-all extraction', () => {
  it('getExecutionOverview reads the drain gate and cross-run queue counts', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: {
        execution: { enabled: true, held: true, running: false },
        queue: { queued: 3, leased: 1 },
      },
    }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });

    const overview = await client.getExecutionOverview();
    expect(calls[0].url).toBe('http://x/api/execution');
    expect(calls[0].method).toBe('GET');
    expect(overview.execution).toEqual({ enabled: true, held: true, running: false });
    expect(overview.queue).toEqual({ queued: 3, leased: 1 });
  });

  it('getExecutionOverview degrades a malformed body to a disabled/empty shape', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: { execution: 'junk' } }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });
    const overview = await client.getExecutionOverview();
    expect(overview.execution).toEqual({ enabled: false, held: false, running: false });
    expect(overview.queue).toEqual({ queued: 0, leased: 0 });
  });

  it('resumeExecution/holdExecution post guarded gate commands and map repeats', async () => {
    const { fetchImpl, calls } = mockFetch((call) => ({
      status: 200,
      body: call.url.endsWith('/resume') ? { alreadyActive: true, held: false } : { held: true },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    const resumed = await client.resumeExecution();
    expect(calls[0].url).toBe('http://x/api/execution/resume');
    expect(calls[0].headers['x-operator-token']).toBe('tok');
    expect(resumed.alreadyActive).toBe(true);
    expect(resumed.held).toBe(false);
    expect(resumed.resumed).toBeUndefined();

    const held = await client.holdExecution();
    expect(calls[1].url).toBe('http://x/api/execution/hold');
    expect(held.held).toBe(true);
    expect(held.alreadyHeld).toBeUndefined();
  });

  it('surfaces the no-daemon 503 as a typed execution_disabled ApiError', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 503,
      body: { error: 'execution_disabled', message: 'no daemon' },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    try {
      await client.resumeExecution();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('execution_disabled');
    }
  });

  it('cancelAllRuns posts the reason and extracts the batch arrays + errors', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: {
        cancelled: ['run-1', 'run-2', 42],
        alreadyCancelled: ['run-0'],
        skippedTerminal: [],
        cancelledCount: 2,
        errors: [{ runId: 'run-9', message: 'boom' }, { junk: true }],
      },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    const result = await client.cancelAllRuns({ reason: 'shutdown' });
    expect(calls[0].url).toBe('http://x/api/runs/cancel-all');
    expect(calls[0].body).toEqual({ reason: 'shutdown' });
    // Non-string ids and malformed error entries are dropped, never surfaced.
    expect(result.cancelled).toEqual(['run-1', 'run-2']);
    expect(result.alreadyCancelled).toEqual(['run-0']);
    expect(result.skippedTerminal).toEqual([]);
    expect(result.cancelledCount).toBe(2);
    expect(result.errors).toEqual([{ runId: 'run-9', message: 'boom' }]);
  });
});

describe('intervention extraction', () => {
  const GOOD_ITEM = {
    interventionId: 'i-1',
    runId: 'run-1',
    kind: 'missing_credentials',
    severity: 'warn',
    blockingStage: 'deploy',
    reason: 'needs credentials',
    requiredAction: 'add the render credentials',
    status: 'open',
    sequence: 7,
  };

  it('listInterventions builds the query string and validates item shapes', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: {
        interventions: [GOOD_ITEM, { interventionId: 'broken-only-id' }, 'junk', null],
        openCount: 1,
      },
    }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });

    const result = await client.listInterventions({
      runId: 'run-1',
      kind: 'missing_credentials',
      severity: 'warn',
      blockingStage: 'deploy',
      open: true,
    });
    expect(calls[0].url).toBe(
      'http://x/api/interventions?runId=run-1&kind=missing_credentials&severity=warn&blockingStage=deploy&open=1',
    );
    // Malformed rows are dropped instead of surfacing undefined fields.
    expect(result.interventions).toEqual([GOOD_ITEM]);
    // The ledger `sequence` (FIFO/ordering signal shown in the UI) is preserved.
    expect(result.interventions[0].sequence).toBe(7);
    expect(result.openCount).toBe(1);
  });

  it('listInterventions degrades a malformed body to an empty result', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { interventions: 'nope', openCount: 'many' },
    }));
    const client = createApiClient({ baseUrl: 'http://x', fetchImpl });
    await expect(client.listInterventions()).resolves.toEqual({
      interventions: [],
      openCount: 0,
    });
  });

  it('resolveIntervention posts the resolution and extracts the summary', async () => {
    const resolvedItem = { ...GOOD_ITEM, status: 'resolved', resolution: 'credentials added' };
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: { alreadyResolved: false, intervention: resolvedItem, junk: true },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });

    const result = await client.resolveIntervention('i-1', {
      resolution: 'credentials added',
      note: 'render token rotated',
      expectedVersion: 3,
    });
    expect(calls[0].url).toBe('http://x/api/interventions/i-1/resolve');
    expect(calls[0].body).toEqual({
      resolution: 'credentials added',
      note: 'render token rotated',
      expectedVersion: 3,
    });
    expect(result.alreadyResolved).toBe(false);
    expect(result.intervention).toEqual(resolvedItem);
  });

  it('resolveIntervention degrades malformed fields and raises typed errors', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { alreadyResolved: 'yes', intervention: { interventionId: 1 } },
    }));
    const client = createApiClient({ baseUrl: 'http://x', operatorToken: 'tok', fetchImpl });
    const result = await client.resolveIntervention('i-9', { resolution: 'done' });
    expect(result.alreadyResolved).toBeUndefined();
    expect(result.intervention).toBeUndefined();

    const { fetchImpl: failImpl } = mockFetch(() => ({
      status: 404,
      body: { error: 'intervention_not_found', message: 'nope' },
    }));
    const failing = createApiClient({
      baseUrl: 'http://x',
      operatorToken: 'tok',
      fetchImpl: failImpl,
    });
    await expect(failing.resolveIntervention('i-x', { resolution: 'r' })).rejects.toMatchObject({
      status: 404,
      code: 'intervention_not_found',
    });
  });
});
