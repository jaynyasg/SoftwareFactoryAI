/**
 * Usage-window wait-and-retry (waitable adapter failures).
 *
 * When a worker CLI reports an exhausted usage/plan window (`usage_limited`),
 * the runner must WAIT for the window to reset and retry automatically —
 * budgeted by total wait time, never by the bounded retry count — while
 * staying cancellable and leaving an honest `worker.retry` trail on the ledger.
 */
import { describe, expect, it } from 'vitest';
import { AdapterError, createInMemoryEventStore } from '@software-factory/core';
import type { ExecutionAdapter } from '@software-factory/core';
import { runTicket } from '../../src/index';
import { makeCompileInput } from '../_helpers/nodes';

/** Fails `failures` times with usage_limited (optionally hinted), then succeeds. */
function usageLimitedAdapter(failures: number, retryAfterMs?: number): ExecutionAdapter {
  let calls = 0;
  return {
    id: 'usage-limited',
    family: 'claude',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 1 }),
    execute: () => {
      calls += 1;
      if (calls <= failures) {
        return Promise.resolve({
          ok: false as const,
          error: AdapterError.usageLimited('usage limit reached', { retryAfterMs }),
        });
      }
      return Promise.resolve({ ok: true as const, output: 'ok', artifacts: [] });
    },
    reportCapacity: () => 1,
  };
}

// Millisecond-scale waits so tests run fast; production defaults are minutes.
const FAST_WAIT = { minDelayMs: 1, defaultDelayMs: 5, maxDelayMs: 10, maxTotalWaitMs: 1_000 };

describe('runner: usage-window wait-and-retry', () => {
  it('waits out usage_limited failures and completes WITHOUT consuming the retry budget', async () => {
    const store = createInMemoryEventStore();
    const result = await runTicket(
      {
        runId: 'run-usage-wait',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        // maxAttempts 1 proves usage waits are exempt from the bounded budget:
        // two usage_limited failures still end in a completed third attempt.
        maxAttempts: 1,
        usageWait: FAST_WAIT,
      },
      { store, adapter: usageLimitedAdapter(2) },
    );

    expect(result.outcome).toBe('completed');
    expect(result.attempts).toBe(3);

    const events = await store.readRun('run-usage-wait');
    const retries = events.filter((event) => event.type === 'worker.retry');
    expect(retries).toHaveLength(2);
    const reason = (retries[0].payload as { reason: string }).reason;
    expect(reason).toContain('usage_limited');
    expect(reason).toContain('waiting');
    expect(reason).toContain('retrying automatically');
    // The wait is visible as a retrying ticket state, so the UI shows it.
    const states = events
      .filter((event) => event.type === 'ticket.state_changed')
      .map((event) => (event.payload as { state: string }).state);
    expect(states).toContain('retrying');
    expect(states.at(-1)).toBe('completed');
  });

  it('honors the adapter-advertised reset hint, clamped to the per-hop ceiling', async () => {
    const store = createInMemoryEventStore();
    // Hint (3ms) is under maxDelayMs — used as-is; a huge hint would clamp.
    const result = await runTicket(
      {
        runId: 'run-usage-hint',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 1,
        usageWait: FAST_WAIT,
      },
      { store, adapter: usageLimitedAdapter(1, 3) },
    );
    expect(result.outcome).toBe('completed');
    expect(result.attempts).toBe(2);
  });

  it('fails with an honest budget note once the total wait budget is exhausted', async () => {
    const store = createInMemoryEventStore();
    const result = await runTicket(
      {
        runId: 'run-usage-exhausted',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: new AbortController().signal,
        maxAttempts: 3,
        usageWait: { ...FAST_WAIT, maxTotalWaitMs: 8 },
      },
      // Never recovers: the wait budget (8ms in 5ms hops) runs out first.
      { store, adapter: usageLimitedAdapter(Number.MAX_SAFE_INTEGER) },
    );

    expect(result.outcome).toBe('failed');
    expect(result.error?.kind).toBe('usage_limited');

    const events = await store.readRun('run-usage-exhausted');
    const failed = events.find((event) => event.type === 'worker.failed');
    expect(failed).toBeDefined();
    expect((failed?.payload as { reason: string }).reason).toContain(
      'without recovery',
    );
  });

  it('cancellation wins over an in-progress usage wait', async () => {
    const store = createInMemoryEventStore();
    const controller = new AbortController();
    const resultPromise = runTicket(
      {
        runId: 'run-usage-cancel',
        compileInput: makeCompileInput('t1'),
        workspaceDir: '/tmp/ws',
        signal: controller.signal,
        maxAttempts: 1,
        // A long single hop: the ticket would sleep ~10s without the abort.
        usageWait: { minDelayMs: 1, defaultDelayMs: 10_000, maxDelayMs: 10_000, maxTotalWaitMs: 60_000 },
      },
      { store, adapter: usageLimitedAdapter(Number.MAX_SAFE_INTEGER) },
    );
    // Let the first attempt fail and the wait begin, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await resultPromise;

    expect(result.outcome).toBe('cancelled');
    const events = await store.readRun('run-usage-cancel');
    expect(events.some((event) => event.type === 'worker.cancelled')).toBe(true);
  });
});
