/**
 * Scheduler + runner behavior and the pure building blocks underneath it.
 *
 * Covers: stopping before execution on adapter setup/auth failure (surfacing
 * setup actions), cancellation propagating to adapter + worker + ledger without
 * corrupting projections, bounded retry on retryable adapter errors, DAG
 * dependency ordering, and unit coverage for `computeEffectiveCapacity`,
 * write-scope conflicts, and composable cancellation.
 */
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  createInMemoryEventStore,
  projectRun,
  projectTickets,
} from '@software-factory/core';
import type { ExecutionAdapter } from '@software-factory/core';
import {
  computeEffectiveCapacity,
  conflicts,
  createCancellation,
  createWriteScopeTracker,
  pathsOverlap,
  runScheduler,
  runTicket,
} from '../../src/index';
import { createGatedAdapter } from '../_helpers/gated-adapter';
import { flushMicrotasks } from '../_helpers/deferred';
import { makeCompileInput, makeIndependentNodes, makeNode } from '../_helpers/nodes';

function flakyAdapter(retryableFailures: number): ExecutionAdapter {
  let calls = 0;
  return {
    id: 'flaky',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 1 }),
    execute: (_task, opts) => {
      calls += 1;
      opts.onEvent({ kind: 'progress', message: `attempt ${calls}` });
      if (calls <= retryableFailures) {
        return Promise.resolve({ ok: false, error: AdapterError.rateLimited('slow down') });
      }
      return Promise.resolve({ ok: true, output: 'ok', artifacts: [] });
    },
    reportCapacity: () => 1,
  };
}

function terminalAdapter(): ExecutionAdapter {
  return {
    id: 'terminal',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 1 }),
    execute: () =>
      Promise.resolve({ ok: false, error: AdapterError.toolDenied('write tool not allowed') }),
    reportCapacity: () => 1,
  };
}

describe('scheduler: adapter setup gating', () => {
  it('stops before execution and surfaces setup actions on auth failure', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({
      setup: {
        available: true,
        authenticated: false,
        capacity: 0,
        setupActions: [{ id: 'login', title: 'Authenticate the CLI', command: 'codex login' }],
        detail: 'no active session',
      },
    });

    const result = await runScheduler({
      runId: 'run-setup',
      tickets: makeIndependentNodes(3),
      adapter,
      store,
      config: { requestedCap: 5 },
    });

    expect(result.setupFailed).toBe(true);
    expect(result.completed).toEqual([]);

    const events = await store.readRun('run-setup');
    expect(events.some((event) => event.type === 'worker.started')).toBe(false);
    expect(events.some((event) => event.type === 'adapter.auth_failed')).toBe(true);

    const setupRequired = events.filter((event) => event.type === 'adapter.setup_required');
    expect(setupRequired).toHaveLength(1);
    expect((setupRequired[0].payload as { action: string }).action).toBe('Authenticate the CLI');
  });

  it('stops and surfaces config actions when the adapter is unavailable', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({
      setup: {
        available: false,
        authenticated: false,
        capacity: 0,
        setupActions: [{ id: 'i', title: 'Install it' }],
      },
    });

    const result = await runScheduler({
      runId: 'run-unavail',
      tickets: makeIndependentNodes(2),
      adapter,
      store,
      config: { requestedCap: 5 },
    });

    expect(result.setupFailed).toBe(true);
    const events = await store.readRun('run-unavail');
    expect(events.some((event) => event.type === 'worker.started')).toBe(false);
    // Unavailable (not merely unauthenticated) => no auth_failed, but setup_required.
    expect(events.some((event) => event.type === 'adapter.auth_failed')).toBe(false);
    expect(events.some((event) => event.type === 'adapter.setup_required')).toBe(true);
  });
});

describe('scheduler: cancellation', () => {
  it('propagates to adapter + worker + ledger without corrupting projections', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({ capacity: 10 });
    const tickets = makeIndependentNodes(5);
    const token = createCancellation();

    const run = runScheduler({
      runId: 'run-cancel',
      tickets,
      adapter,
      store,
      config: { requestedCap: 5 },
      cancellation: token,
    });

    await adapter.whenStarted(5);
    expect(adapter.inFlight).toBe(5);

    token.cancel('operator stop');
    const result = await run;

    expect(result.cancelledRun).toBe(true);
    expect([...result.cancelled].sort()).toEqual(tickets.map((t) => t.id).sort());

    const events = await store.readRun('run-cancel');
    expect(events.some((event) => event.type === 'worker.cancelled')).toBe(true);

    // Projections must stay coherent: no gaps, no corrupt/unknown events.
    const runView = projectRun(events, 'run-cancel');
    const ticketView = projectTickets(events, 'run-cancel');
    expect(runView.diagnostics).toEqual([]);
    expect(ticketView.diagnostics).toEqual([]);
    for (const ticket of tickets) {
      expect(ticketView.byId[ticket.id]?.state).toBe('cancelled');
    }
  });

  it('emits worker.cancelled when the signal is already aborted before start', async () => {
    const store = createInMemoryEventStore();
    const controller = new AbortController();
    controller.abort();
    const adapter = createGatedAdapter({ capacity: 1 });

    const result = await runTicket(
      {
        runId: 'run-pre-cancel',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: controller.signal,
      },
      { store, adapter },
    );

    expect(result.outcome).toBe('cancelled');
    const events = await store.readRun('run-pre-cancel');
    expect(events.some((event) => event.type === 'worker.started')).toBe(false);
    expect(events.some((event) => event.type === 'worker.cancelled')).toBe(true);
  });
});

describe('runner: bounded retry', () => {
  it('retries retryable failures then completes, emitting worker.retry per retry', async () => {
    const store = createInMemoryEventStore();
    const result = await runTicket(
      {
        runId: 'run-retry-ok',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 3,
      },
      { store, adapter: flakyAdapter(2) },
    );

    expect(result.outcome).toBe('completed');
    expect(result.attempts).toBe(3);

    const events = await store.readRun('run-retry-ok');
    const retries = events.filter((event) => event.type === 'worker.retry');
    expect(retries).toHaveLength(2);
    expect((retries[0].payload as { attempt: number }).attempt).toBe(2);
    expect(events.some((event) => event.type === 'worker.completed')).toBe(true);
  });

  it('fails after the retry budget is exhausted', async () => {
    const store = createInMemoryEventStore();
    const result = await runTicket(
      {
        runId: 'run-retry-exhausted',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 2,
      },
      { store, adapter: flakyAdapter(5) },
    );

    expect(result.outcome).toBe('failed');
    expect(result.attempts).toBe(2);

    const events = await store.readRun('run-retry-exhausted');
    expect(events.filter((event) => event.type === 'worker.retry')).toHaveLength(1);
    expect(events.some((event) => event.type === 'worker.failed')).toBe(true);
  });

  it('does NOT retry a terminal (non-retryable) failure', async () => {
    const store = createInMemoryEventStore();
    const result = await runTicket(
      {
        runId: 'run-terminal',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 3,
      },
      { store, adapter: terminalAdapter() },
    );

    expect(result.outcome).toBe('failed');
    expect(result.attempts).toBe(1);
    const events = await store.readRun('run-terminal');
    expect(events.some((event) => event.type === 'worker.retry')).toBe(false);
  });
});

describe('scheduler: DAG ordering', () => {
  it('starts a dependent ticket only after its dependency completes', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({ capacity: 10 });
    const a = makeNode('a', { writeScope: ['src/a.ts'] });
    const b = makeNode('b', { dependsOn: ['a'], writeScope: ['src/b.ts'] });

    const run = runScheduler({
      runId: 'run-dag',
      tickets: [a, b],
      adapter,
      store,
      config: { requestedCap: 10 },
    });

    await adapter.whenStarted(1);
    await flushMicrotasks();
    expect(adapter.started).toEqual(['a']); // b is gated on a

    adapter.release('a');
    await adapter.whenStarted(2);
    expect(adapter.started).toEqual(['a', 'b']);

    adapter.release('b');
    const result = await run;
    expect([...result.completed].sort()).toEqual(['a', 'b']);
  });
});

describe('computeEffectiveCapacity', () => {
  const base = {
    readyTickets: 10,
    requestedCap: 10,
    adapterCapacity: 10,
    sandboxCapacity: 10,
    resourceBudget: 10,
    writeScopeAvailable: 10,
    reviewPolicyLimit: 10,
  };

  it('returns the minimum across all constraints', () => {
    const result = computeEffectiveCapacity({ ...base, adapterCapacity: 4 });
    expect(result.capacity).toBe(4);
    expect(result.boundBy).toBe('adapter_capacity');
    expect(result.systemThrottled).toBe(true);
    expect(result.reason).toMatch(/adapter capacity/i);
  });

  it('clamps the requested cap to [1, 10]', () => {
    expect(computeEffectiveCapacity({ ...base, requestedCap: 25 }).requested).toBe(10);
    expect(computeEffectiveCapacity({ ...base, requestedCap: 0 }).requested).toBe(1);
  });

  it('is demand-bound (not system-throttled) when fewer tickets are ready', () => {
    const result = computeEffectiveCapacity({ ...base, readyTickets: 3 });
    expect(result.capacity).toBe(3);
    expect(result.boundBy).toBe('ready_tickets');
    expect(result.systemThrottled).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('is requested-bound (not throttled) when the cap is the smallest', () => {
    const result = computeEffectiveCapacity({ ...base, requestedCap: 5 });
    expect(result.capacity).toBe(5);
    expect(result.boundBy).toBe('requested_cap');
    expect(result.systemThrottled).toBe(false);
  });

  it('does not flag a throttle when a system constraint only matches demand', () => {
    // demand 2 < requested 10, adapter 5: capacity is demand-bound, not throttled.
    const result = computeEffectiveCapacity({ ...base, readyTickets: 2, adapterCapacity: 5 });
    expect(result.capacity).toBe(2);
    expect(result.systemThrottled).toBe(false);
  });
});

describe('write-scope conflicts', () => {
  it('detects identical paths as conflicting', () => {
    expect(pathsOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(
      conflicts({ ticketId: 'a', paths: ['src/a.ts'] }, { ticketId: 'b', paths: ['src/a.ts'] }),
    ).toBe(true);
  });

  it('detects directory containment as conflicting', () => {
    expect(pathsOverlap('src', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/a.ts', 'src')).toBe(true);
  });

  it('matches globs', () => {
    expect(pathsOverlap('src/**', 'src/deep/x.ts')).toBe(true);
    expect(pathsOverlap('src/*.ts', 'src/a.ts')).toBe(true);
    expect(pathsOverlap('src/*.ts', 'src/deep/a.ts')).toBe(false);
  });

  it('treats disjoint paths and empty scopes as non-conflicting', () => {
    expect(pathsOverlap('src/a.ts', 'src/b.ts')).toBe(false);
    expect(conflicts({ ticketId: 'a', paths: [] }, { ticketId: 'b', paths: ['src/a.ts'] })).toBe(
      false,
    );
  });

  it('tracker serializes a conflicting scope and frees it on release', () => {
    const tracker = createWriteScopeTracker();
    expect(tracker.acquire({ ticketId: 'a', paths: ['src/shared.ts'] })).toBe(true);
    expect(tracker.canStart({ ticketId: 'b', paths: ['src/shared.ts'] })).toBe(false);
    tracker.release('a');
    expect(tracker.canStart({ ticketId: 'b', paths: ['src/shared.ts'] })).toBe(true);
  });
});

describe('composable cancellation', () => {
  it('cancels a child when the parent is cancelled', () => {
    const parent = createCancellation();
    const child = parent.child();
    expect(child.aborted).toBe(false);
    parent.cancel('stop');
    expect(child.aborted).toBe(true);
    expect(child.signal.aborted).toBe(true);
  });

  it('cancelling a child does not cancel the parent', () => {
    const parent = createCancellation();
    const child = parent.child();
    child.cancel('one worker');
    expect(child.aborted).toBe(true);
    expect(parent.aborted).toBe(false);
  });

  it('fires onCancel listeners with the reason', () => {
    const scope = createCancellation();
    let captured: string | undefined = 'unset';
    scope.onCancel((reason) => {
      captured = reason;
    });
    scope.cancel('because');
    expect(captured).toBe('because');
  });
});
