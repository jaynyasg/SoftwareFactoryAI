import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  emitPlan,
  projectRun,
  type EventStore,
  type FactoryEvent,
} from '@software-factory/core';
import { ApiError } from '../src/api-client';
import type { ApiClient, CreateRunInput } from '../src/api-client';
import { runCommand } from '../src/commands/run';
import { eventsCommand } from '../src/commands/events';
import { statusCommand } from '../src/commands/status';
import { startCommand } from '../src/commands/start';
import type { FetchLike } from '../src/commands/start';
import { streamRunEvents } from '../src/stream';
import type { CliIo } from '../src/cli-io';

function fetchReturning(ok: boolean): FetchLike {
  return (async () => new Response('{}', { status: ok ? 200 : 503 })) as unknown as FetchLike;
}

function makeIo(): { io: CliIo; outText: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    outText: () => out.join('\n'),
    errText: () => err.join('\n'),
  };
}

const PLAN = {
  intent: 'ai-services-marketplace' as const,
  decisions: [{ decision: 'plan-run', rationale: 'recognized intent', confidence: 0.9 }],
  tickets: [
    {
      id: 'scaffold',
      title: 'Scaffold the marketplace app',
      kind: 'scaffold' as const,
      description: '',
      moduleId: 'scaffold-app',
      dependsOn: [] as string[],
      riskTier: 'low' as const,
    },
    {
      id: 'data-model',
      title: 'Define the data model',
      kind: 'data-model' as const,
      description: '',
      moduleId: 'data-model',
      dependsOn: ['scaffold'],
      riskTier: 'medium' as const,
    },
  ],
};

interface FakeBackend {
  readonly client: ApiClient;
  readonly store: EventStore;
  readonly createCalls: CreateRunInput[];
  getEventsCalls(): number;
}

/**
 * A fake backend that mimics the real run flow: `createRun` appends `run.created`
 * and synchronously plans the run (like the U10 backend), and `getEvents`
 * resumes by sequence. Token mismatch is simulated by `failCreateWith`.
 */
function makeFakeBackend(opts: { failCreateWith?: ApiError } = {}): FakeBackend {
  const store = createInMemoryEventStore();
  const createCalls: CreateRunInput[] = [];
  let getEventsCalls = 0;
  let runSeq = 0;

  const client: ApiClient = {
    baseUrl: 'http://fake',
    eventsUrl: (runId) => `http://fake/api/runs/${runId}/events`,
    async createRun(input) {
      createCalls.push(input);
      if (opts.failCreateWith !== undefined) {
        throw opts.failCreateWith;
      }
      const runId = `run-${(runSeq += 1)}`;
      await store.append({
        runId,
        type: 'run.created',
        actor: { kind: 'operator', id: 'operator' },
        subject: { kind: 'run', id: runId, version: 0 },
        severity: 'info',
        payload: {
          prompt: input.prompt,
          prdRef: input.prdRef,
          reviewMode: input.reviewMode,
          callerFamily: input.callerFamily,
        },
      });
      await emitPlan(store, runId, PLAN);
      return { runId, deduplicated: false, run: projectRun(await store.readRun(runId), runId) };
    },
    async getRun(runId) {
      return projectRun(await store.readRun(runId), runId);
    },
    async getEvents(runId, options) {
      getEventsCalls += 1;
      const all = await store.readRun(runId);
      const since = options?.sinceSequence ?? 0;
      return { runId, events: since > 0 ? all.filter((e) => e.sequence > since) : all };
    },
    cancelRun() {
      return Promise.reject(new Error('not used'));
    },
    review() {
      return Promise.reject(new Error('not used'));
    },
    getSetup() {
      return Promise.resolve({
        operatorToken: { present: true },
        sandbox: { status: 'unknown' },
        adapters: { status: 'unknown', detected: [] },
        deploy: { status: 'required' },
        workspace: { root: 'C:\\repo\\software-factory' },
      });
    },
  };

  return { client, store, createCalls, getEventsCalls: () => getEventsCalls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('run command', () => {
  it('creates a run from a prompt, streams the planned DAG, and returns the contract', async () => {
    const be = makeFakeBackend();
    const { io, outText, errText } = makeIo();

    const outputs = await runCommand(
      {
        prompt: 'Build an AI services marketplace',
        follow: true,
        json: true,
        pollIntervalMs: 0,
        maxWaitMs: 2000,
      },
      { client: be.client, io, sleep: noSleep },
    );

    expect(outputs.runId).toBe('run-1');
    expect(outputs.status).toBe('planned');
    expect(outputs.plannedTicketCount).toBe(2);
    expect(outputs.tickets.map((t) => t.id)).toEqual(['scaffold', 'data-model']);
    expect(outputs.eventsUrl).toBe('http://fake/api/runs/run-1/events');

    // Streamed events went to stderr (progress); the JSON contract to stdout.
    expect(errText()).toContain('ticket.created');
    expect(errText()).toContain('run.planned');
    const parsed = JSON.parse(outText()) as { runId: string; plannedTicketCount: number };
    expect(parsed.runId).toBe('run-1');
    expect(parsed.plannedTicketCount).toBe(2);
  });

  it('creates a run from a PRD file path (reads the file, keeps the path as prdRef)', async () => {
    const be = makeFakeBackend();
    const { io } = makeIo();
    const readFile = (path: string): Promise<string> =>
      path === '/tmp/prd.md'
        ? Promise.resolve('Build an AI services marketplace with providers and proposals.')
        : Promise.reject(new Error(`unexpected path ${path}`));

    const outputs = await runCommand(
      { prdPath: '/tmp/prd.md', follow: false, json: true },
      { client: be.client, io, readFile },
    );

    expect(be.createCalls[0].prompt).toContain('AI services marketplace');
    expect(be.createCalls[0].prdRef).toBe('/tmp/prd.md');
    expect(outputs.runId).toBe('run-1');
  });

  it('creates a run from an inline JSON request', async () => {
    const be = makeFakeBackend();
    const { io } = makeIo();
    await runCommand(
      {
        requestJson: JSON.stringify({ prompt: 'JSON marketplace', reviewMode: 'autonomous' }),
        follow: false,
        json: true,
      },
      { client: be.client, io },
    );
    expect(be.createCalls[0].prompt).toBe('JSON marketplace');
    expect(be.createCalls[0].reviewMode).toBe('autonomous');
  });

  it('forwards --caller-family and records it on the run for nested-agent metadata', async () => {
    const be = makeFakeBackend();
    const { io } = makeIo();
    const outputs = await runCommand(
      { prompt: 'x', callerFamily: 'claude', follow: false, json: true },
      { client: be.client, io },
    );
    expect(be.createCalls[0].callerFamily).toBe('claude');
    const created = (await be.store.readRun('run-1')).find((e) => e.type === 'run.created');
    expect((created?.payload as { callerFamily?: string }).callerFamily).toBe('claude');
    expect(outputs.callerFamily).toBe('claude');
  });

  it('token mismatch blocks the mutating command before any side effects', async () => {
    const be = makeFakeBackend({
      failCreateWith: new ApiError(401, 'invalid_token', 'Operator token is invalid.'),
    });
    const { io } = makeIo();

    await expect(
      runCommand(
        { prompt: 'x', follow: true, json: true },
        { client: be.client, io, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(ApiError);

    // The create was attempted, but nothing downstream ran: no streaming, no
    // contract build (getEvents never called) — i.e. blocked before side effects.
    expect(be.createCalls).toHaveLength(1);
    expect(be.getEventsCalls()).toBe(0);
  });
});

describe('status + events commands', () => {
  it('status returns the same contract for an existing run', async () => {
    const be = makeFakeBackend();
    const { io } = makeIo();
    await runCommand({ prompt: 'x', follow: false, json: true }, { client: be.client, io });

    const status = await statusCommand({ runId: 'run-1', json: true }, { client: be.client, io });
    expect(status.runId).toBe('run-1');
    expect(status.status).toBe('planned');
    expect(status.plannedTicketCount).toBe(2);
  });

  it('events prints each ledger event once and resumes by sequence (no duplicates)', async () => {
    const be = makeFakeBackend();
    const { io } = makeIo();
    await runCommand({ prompt: 'x', follow: false, json: true }, { client: be.client, io });

    const seen = await eventsCommand(
      { runId: 'run-1', follow: true, json: true, pollIntervalMs: 0, maxWaitMs: 2000 },
      { client: be.client, io, sleep: noSleep },
    );
    const sequences = seen.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(seen.some((e) => e.type === 'run.planned')).toBe(true);
  });
});

describe('start command', () => {
  it('connects to an already-reachable backend without spawning', async () => {
    const { io, outText } = makeIo();
    let spawned = false;
    const result = await startCommand(
      { baseUrl: 'http://127.0.0.1:3000', json: true },
      {
        io,
        fetchImpl: fetchReturning(true),
        spawnStandalone: () => {
          spawned = true;
          return Promise.resolve({});
        },
      },
    );
    expect(result.status).toBe('connected');
    expect(spawned).toBe(false);
    expect(JSON.parse(outText()).status).toBe('connected');
  });

  it('boots a standalone backend when none is reachable, then reports it spawned', async () => {
    const { io } = makeIo();
    let calls = 0;
    // First probe fails (unreachable); after "spawning", probes succeed.
    let spawnedFlag = false;
    const fetchImpl = (async () => {
      calls += 1;
      const ok = spawnedFlag;
      return new Response('{}', { status: ok ? 200 : 503 });
    }) as unknown as FetchLike;

    const result = await startCommand(
      { baseUrl: 'http://127.0.0.1:3000', json: true, waitMs: 1000, pollIntervalMs: 0 },
      {
        io,
        fetchImpl,
        sleep: noSleep,
        spawnStandalone: () => {
          spawnedFlag = true;
          return Promise.resolve({ url: 'http://127.0.0.1:3000' });
        },
      },
    );
    expect(result.status).toBe('spawned');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('reports guidance when unreachable and spawning is disabled', async () => {
    const { io } = makeIo();
    const result = await startCommand(
      { baseUrl: 'http://127.0.0.1:3000', spawn: false },
      { io, fetchImpl: fetchReturning(false) },
    );
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('pnpm dev');
  });

  it('reports cloud guidance for unreachable remote backends', async () => {
    const { io } = makeIo();
    const result = await startCommand(
      { baseUrl: 'https://factory.example.com', spawn: false },
      { io, fetchImpl: fetchReturning(false) },
    );
    expect(result.status).toBe('unavailable');
    expect(result.message).toContain('cloud backend');
    expect(result.message).not.toContain('pnpm dev');
  });
});

describe('streamRunEvents resume + reconnect', () => {
  function evt(
    sequence: number,
    type: string,
    payload: Record<string, unknown> = {},
  ): FactoryEvent {
    return {
      version: 1,
      eventId: `e${sequence}`,
      runId: 'r',
      actor: { kind: 'system', id: 's' },
      subject: { kind: 'run', id: 'r' },
      type,
      sequence,
      timestamp: 1000 + sequence,
      severity: 'info',
      payload,
    } as FactoryEvent;
  }

  it('reveals events incrementally and fires onEvent exactly once per event', async () => {
    const log = [
      evt(1, 'run.created'),
      evt(2, 'ticket.created', { title: 't' }),
      evt(3, 'run.planned', { ticketCount: 1 }),
    ];
    let reveal = 1;
    const client = {
      getEvents(_runId: string, options?: { sinceSequence?: number }) {
        const since = options?.sinceSequence ?? 0;
        const visible = log.slice(0, reveal);
        reveal = Math.min(log.length, reveal + 1);
        return Promise.resolve({ runId: 'r', events: visible.filter((e) => e.sequence > since) });
      },
    } as unknown as ApiClient;

    const observed: number[] = [];
    const result = await streamRunEvents(client, 'r', {
      sleep: noSleep,
      pollIntervalMs: 0,
      maxWaitMs: 2000,
      onEvent: (event) => observed.push(event.sequence),
    });

    expect(observed).toEqual([1, 2, 3]);
    expect(result.settled).toBe(true);
  });

  it('retries on a failing poll and surfaces a reconnect notice', async () => {
    const log = [evt(1, 'run.created'), evt(2, 'run.planned', { ticketCount: 0 })];
    let call = 0;
    const reconnects: number[] = [];
    const client = {
      getEvents(_runId: string, options?: { sinceSequence?: number }) {
        call += 1;
        if (call === 1) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        const since = options?.sinceSequence ?? 0;
        return Promise.resolve({ runId: 'r', events: log.filter((e) => e.sequence > since) });
      },
    } as unknown as ApiClient;

    const result = await streamRunEvents(client, 'r', {
      sleep: noSleep,
      pollIntervalMs: 0,
      maxWaitMs: 2000,
      maxReconnects: 3,
      onReconnect: (attempt) => reconnects.push(attempt),
    });

    expect(reconnects).toEqual([1]);
    expect(result.settled).toBe(true);
    expect(result.events.map((e) => e.sequence)).toEqual([1, 2]);
  });
});
