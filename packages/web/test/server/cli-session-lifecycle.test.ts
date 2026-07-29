/**
 * CLI session-lifecycle parity against a REAL in-process HTTP server (U7).
 *
 * The MCP bridge is covered by mcp.test.ts through `app.handle`; the CLI's
 * calling convention is different — plain HTTP over loopback with the
 * operator token and NO Origin header — so these tests boot `app.listen(0)`
 * and drive the actual `@software-factory/cli` commands over fetch:
 *
 *   - New Session (AE1): ask-once refusal on active runs, then the confirmed
 *     command archives everything, holds the gate, and records the marker.
 *   - `cancel --archive`: cancel-then-archive in ONE guarded command (R10).
 *
 * This also exercises the `serveApp` extraction the standalone Factory Reset
 * wiring depends on (the CLI path IS the HTTP path).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterError,
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  type EventStore,
  type ExecutionAdapter,
} from '@software-factory/core';
import {
  ApiError,
  cancelRunCommand,
  createApiClient,
  newSessionCommand,
} from '@software-factory/cli';
import type { ApiClient } from '@software-factory/cli';
import { createApp } from '../../src/server/app';
import type { RunningServer } from '../../src/server/app';
import { createExecutionDaemon } from '../../src/server/execution/daemon';

const TOKEN = 'cli-operator-token';
const CSRF = 'cli-csrf-token';

/**
 * Same prompt the MCP suite uses: the genome planner derives ticket risk from
 * the prompt, and this one plans work whose preflight passes without a prior
 * review approval — so `startRun` reliably enqueues (executionState queued).
 */
const MARKETPLACE_PROMPT = 'Build an AI services marketplace with providers and proposals';

/** Timers that never fire — no daemon work runs inside these tests. */
function noopTimers(): { setInterval: () => null; clearInterval: () => undefined } {
  return { setInterval: () => null, clearInterval: () => undefined };
}

/** A deterministic, always-ready fake adapter for the preflight catalog. */
function readyFakeAdapter(): ExecutionAdapter {
  return {
    id: 'fake-ready',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 4 }),
    execute: () =>
      Promise.resolve({ ok: false as const, error: AdapterError.unavailable('not used') }),
    reportCapacity: () => 4,
  };
}

interface CliServerContext {
  readonly client: ApiClient;
  readonly store: EventStore;
  readonly server: RunningServer;
}

let openServer: RunningServer | null = null;

afterEach(async () => {
  if (openServer !== null) {
    await openServer.close();
    openServer = null;
  }
});

async function startCliServer(): Promise<CliServerContext> {
  const store = createInMemoryEventStore();
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  let runSeq = 0;
  let leaseSeq = 0;
  const daemon = createExecutionDaemon({
    store,
    idGenerator: () => `cli-lease-${(leaseSeq += 1)}`,
    ownerId: 'daemon-cli-test',
    timers: noopTimers(),
  });
  const app = createApp({
    store,
    operatorToken: provider,
    idGenerator: () => `cli-run-${(runSeq += 1)}`,
    config: { allowedOrigins: [], csrfToken: CSRF },
    execution: daemon,
    adapterCatalog: createAdapterCatalog([readyFakeAdapter()]),
  });
  const server = await app.listen(0);
  openServer = server;
  // The CLI convention: operator token + CSRF token headers, no Origin.
  const client = createApiClient({ baseUrl: server.url, operatorToken: TOKEN, csrfToken: CSRF });
  return { client, store, server };
}

function makeIo(): {
  io: { out(line: string): void; err(line: string): void };
  outText: () => string;
  errText: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    outText: () => out.join('\n'),
    errText: () => err.join('\n'),
  };
}

describe('CLI new-session against a seeded in-process server (AE1)', () => {
  it('asks once about actives, then archives everything and holds the gate', async () => {
    const { client, store } = await startCliServer();
    const idle = (await client.createRun({ prompt: MARKETPLACE_PROMPT })).runId;
    const active = (await client.createRun({ prompt: MARKETPLACE_PROMPT })).runId;
    await client.startRun(active);

    // Ask-once (AE1): the refusal changes NOTHING and lists the active run.
    const { io: refusedIo, errText } = makeIo();
    await expect(newSessionCommand({}, { client, io: refusedIo })).rejects.toMatchObject({
      code: 'active_runs_present',
    });
    expect(errText()).toContain(active);
    expect(errText()).toContain('--confirm-active');
    expect((await store.readRun(active)).map((event) => event.type)).not.toContain('run.cancelled');

    // Confirmed: cancel the active, archive both, hold, record the marker.
    const { io } = makeIo();
    const result = await newSessionCommand({ confirmActive: true }, { client, io });
    expect(result.archived).toEqual(expect.arrayContaining([idle, active]));
    expect(result.cancelled).toEqual([active]);
    expect(result.held).toBe(true);
    expect((await store.readRun('factory')).map((event) => event.type)).toContain(
      'session.started',
    );

    // The floor is clean: the default list hides archived runs; the gate holds.
    const overview = await client.getExecutionOverview();
    expect(overview.execution.held).toBe(true);
    expect(overview.queue.queued).toBe(0);
  });

  it('surfaces auth failures as typed ApiErrors over real HTTP', async () => {
    const { server } = await startCliServer();
    const badClient = createApiClient({
      baseUrl: server.url,
      operatorToken: 'wrong-token',
      csrfToken: CSRF,
    });
    const { io } = makeIo();
    const rejection = await newSessionCommand({}, { client: badClient, io }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(ApiError);
    expect((rejection as ApiError).isAuthFailure).toBe(true);
  });
});

describe('CLI cancel --archive against a real server (R10)', () => {
  it('performs cancel-then-archive in one guarded command', async () => {
    const { client, store } = await startCliServer();
    const runId = (await client.createRun({ prompt: MARKETPLACE_PROMPT })).runId;

    const { io, outText } = makeIo();
    const result = await cancelRunCommand({ runId, archive: true }, { client, io });
    expect(result.archived).toBe(true);
    expect(outText()).toContain('cancelled and archived');

    const seen = (await store.readRun(runId)).map((event) => event.type);
    expect(seen).toContain('run.cancelled');
    expect(seen).toContain('run.archived');
  });
});
