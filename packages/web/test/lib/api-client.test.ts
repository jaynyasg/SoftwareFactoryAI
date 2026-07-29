/**
 * Browser api-client extraction tests: fetchInterventions must validate the
 * polled JSON shape item by item (Record + array + field checks) so a drifting
 * or malformed payload degrades to dropped rows — never `undefined` rendered
 * into the operator queue. fetchExecutionOverview shares the same contract via
 * the shared parseExecutionOverview (structural degrade, typed HTTP error).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchExecutionOverview,
  fetchFloorStatus,
  fetchInterventions,
} from '../../src/lib/api-client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GOOD_ITEM = {
  interventionId: 'i-1',
  runId: 'run-1',
  kind: 'approval',
  severity: 'warn',
  blockingStage: 'deploy',
  reason: 'needs credentials',
  requiredAction: 'add the render credentials',
  raisedAt: 1000,
  sequence: 12,
  status: 'open',
};

describe('fetchInterventions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts well-formed items and drops malformed rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            interventions: [
              GOOD_ITEM,
              { ...GOOD_ITEM, interventionId: 'i-2', status: 'resolved', resolution: 'done' },
              { interventionId: 42 }, // wrong types
              'junk',
              null,
              { ...GOOD_ITEM, interventionId: 'i-3', sequence: 'not-a-number' },
              { ...GOOD_ITEM, interventionId: 'i-4', status: 'weird-status' },
            ],
            openCount: 1,
          }),
        ),
      ),
    );

    const snapshot = await fetchInterventions();
    expect(snapshot.interventions.map((item) => item.interventionId)).toEqual(['i-1', 'i-2']);
    expect(snapshot.interventions[0]).toMatchObject({ status: 'open', sequence: 12 });
    expect(snapshot.interventions[1]).toMatchObject({ status: 'resolved', resolution: 'done' });
    expect(snapshot.openCount).toBe(1);
  });

  it('degrades a non-array body to an empty queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ interventions: 'nope', openCount: 'many' }))),
    );
    await expect(fetchInterventions()).resolves.toEqual({ interventions: [], openCount: 0 });
  });

  it('throws a typed error on an HTTP failure (poll loop reports reconnecting)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 503))),
    );
    await expect(fetchInterventions()).rejects.toThrow('interventions_fetch_failed:503');
  });
});

describe('fetchExecutionOverview', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a well-formed overview through the shared structural parser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            execution: { enabled: true, held: true, running: true },
            queue: { queued: 2, leased: 1 },
          }),
        ),
      ),
    );
    await expect(fetchExecutionOverview()).resolves.toEqual({
      execution: { enabled: true, held: true, running: true },
      queue: { queued: 2, leased: 1 },
    });
  });

  it('degrades a malformed body to the disabled overview instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ execution: 'nope', queue: 42 }))),
    );
    await expect(fetchExecutionOverview()).resolves.toEqual({
      execution: { enabled: false, held: false, running: false },
      queue: { queued: 0, leased: 0 },
    });
  });

  it('throws a typed error on an HTTP failure (poll loop reports reconnecting)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 502))),
    );
    await expect(fetchExecutionOverview()).rejects.toThrow('execution_fetch_failed:502');
  });
});

describe('fetchFloorStatus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the combined union body with the SAME validators as the standalone endpoints', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          execution: { enabled: true, held: true, running: false },
          queue: { queued: 3, leased: 1 },
          interventions: [GOOD_ITEM, { interventionId: 42 }, 'junk'],
          openCount: 1,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const floor = await fetchFloorStatus();
    expect(fetchMock).toHaveBeenCalledWith('/api/floor', expect.anything());
    expect(floor.overview).toEqual({
      execution: { enabled: true, held: true, running: false },
      queue: { queued: 3, leased: 1 },
    });
    // Malformed intervention rows drop exactly as fetchInterventions drops them.
    expect(floor.queue.interventions.map((item) => item.interventionId)).toEqual(['i-1']);
    expect(floor.queue.openCount).toBe(1);
  });

  it('degrades a malformed body to disabled overview + empty queue instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ execution: 'nope', interventions: 'nope' }))),
    );
    await expect(fetchFloorStatus()).resolves.toEqual({
      overview: {
        execution: { enabled: false, held: false, running: false },
        queue: { queued: 0, leased: 0 },
      },
      queue: { interventions: [], openCount: 0 },
    });
  });

  it('throws a typed error on an HTTP failure (poll loop reports reconnecting)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 500))),
    );
    await expect(fetchFloorStatus()).rejects.toThrow('floor_fetch_failed:500');
  });
});
