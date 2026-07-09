/**
 * Browser api-client extraction tests: fetchInterventions must validate the
 * polled JSON shape item by item (Record + array + field checks) so a drifting
 * or malformed payload degrades to dropped rows — never `undefined` rendered
 * into the operator queue.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchInterventions } from '../../src/lib/api-client';

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
