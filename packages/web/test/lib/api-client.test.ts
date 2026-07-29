/**
 * Browser api-client extraction tests: fetchFloorStatus must validate the
 * polled JSON shape item by item (Record + array + field checks) so a drifting
 * or malformed payload degrades to dropped rows — never `undefined` rendered
 * into the operator queue. fetchExecutionOverview shares the same contract via
 * the shared parseExecutionOverview (structural degrade, typed HTTP error).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchExecutionOverview, fetchFloorStatus, fetchRunList } from '../../src/lib/api-client';

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
            resetGeneration: 1,
          }),
        ),
      ),
    );
    await expect(fetchExecutionOverview()).resolves.toEqual({
      execution: { enabled: true, held: true, running: true },
      queue: { queued: 2, leased: 1 },
      resetGeneration: 1,
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
      resetGeneration: 0,
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

describe('fetchRunList (U5 live run list)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const RUN_ROW = {
    runId: 'run-old',
    status: 'completed',
    lastSequence: 10,
    startedAt: 1000,
    archived: false,
  };

  it('drops malformed and archived rows and sorts newest-first like loadRunList', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          runs: [
            RUN_ROW,
            { ...RUN_ROW, runId: 'run-new', startedAt: 2000 },
            { ...RUN_ROW, runId: 'run-archived', archived: true }, // hidden (R7)
            { runId: 42 }, // wrong types
            'junk',
            null,
            { ...RUN_ROW, runId: 'run-bad-seq', lastSequence: 'nope' },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const runs = await fetchRunList();
    expect(fetchMock).toHaveBeenCalledWith('/api/runs', expect.anything());
    expect(runs.map((run) => run.runId)).toEqual(['run-new', 'run-old']);
  });

  it('includeArchived hits ?includeArchived=1 and KEEPS archived rows (U6 history one-shot)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          runs: [RUN_ROW, { ...RUN_ROW, runId: 'run-archived', lastSequence: 9, archived: true }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const runs = await fetchRunList({ includeArchived: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/runs?includeArchived=1', expect.anything());
    expect(runs.map((run) => run.runId)).toEqual(['run-old', 'run-archived']);
    expect(runs[1].archived).toBe(true);
  });

  it('FAILS the tick on a body without a runs array (never a synthetic empty floor)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ nope: true }))),
    );
    // An empty list drives focus changes, so it must never be fabricated from
    // a malformed body — the poll reports reconnecting instead.
    await expect(fetchRunList()).rejects.toThrow('runs_parse_failed');
  });

  it('throws a typed error on an HTTP failure (poll loop reports reconnecting)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}, 503))),
    );
    await expect(fetchRunList()).rejects.toThrow('runs_fetch_failed:503');
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
    );
    vi.stubGlobal('fetch', fetchMock);

    const floor = await fetchFloorStatus();
    expect(fetchMock).toHaveBeenCalledWith('/api/floor', expect.anything());
    expect(floor.overview).toEqual({
      execution: { enabled: true, held: true, running: false },
      queue: { queued: 3, leased: 1 },
      resetGeneration: 0,
    });
    // Well-formed rows extract; malformed rows drop — never `undefined` in the queue.
    expect(floor.interventionQueue.interventions.map((item) => item.interventionId)).toEqual([
      'i-1',
      'i-2',
    ]);
    expect(floor.interventionQueue.interventions[0]).toMatchObject({
      status: 'open',
      sequence: 12,
    });
    expect(floor.interventionQueue.interventions[1]).toMatchObject({
      status: 'resolved',
      resolution: 'done',
    });
    expect(floor.interventionQueue.openCount).toBe(1);
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
        resetGeneration: 0,
      },
      interventionQueue: { interventions: [], openCount: 0 },
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
