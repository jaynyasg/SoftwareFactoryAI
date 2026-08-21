/**
 * Adaptive concurrency scenarios, asserted DETERMINISTICALLY.
 *
 * Workers block on a gated adapter we resolve on command, so we can prove the
 * exact number in flight before anything completes — no timers, no sleeps. We
 * cover: full cap=10 concurrency, an 11th ticket queued until a slot frees, a
 * system-throttled run (capacity-reduction event), and write-scope
 * serialization despite free worker slots.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import { runScheduler } from '../../src/index';
import type { SchedulerResult } from '../../src/index';
import { createGatedAdapter, type GatedAdapter } from '../_helpers/gated-adapter';
import { flushMicrotasks } from '../_helpers/deferred';
import { makeIndependentNodes, makeNode } from '../_helpers/nodes';

/** Release waves of gated workers until the scheduler run resolves. */
async function drain(
  adapter: GatedAdapter,
  run: Promise<SchedulerResult>,
): Promise<SchedulerResult> {
  let done = false;
  const settled = run.then((value) => {
    done = true;
    return value;
  });
  while (!done) {
    adapter.releaseAll();
    await flushMicrotasks();
  }
  return settled;
}

function capacityEvents(events: readonly FactoryEvent[]): FactoryEvent[] {
  return events.filter((event) => event.type === 'adapter.capacity_changed');
}

describe('adaptive concurrency', () => {
  it('runs ten independent ready tickets concurrently at cap=10', async () => {
    const store: EventStore = createInMemoryEventStore();
    const adapter = createGatedAdapter({ capacity: 10 });
    const tickets = makeIndependentNodes(10);

    const run = runScheduler({
      runId: 'run-10',
      tickets,
      adapter,
      store,
      config: { requestedCap: 10 },
    });

    await adapter.whenStarted(10);
    expect(adapter.inFlight).toBe(10);
    expect(adapter.maxConcurrent).toBe(10);
    expect(adapter.settledCount).toBe(0); // none completed before all ten were in flight

    adapter.releaseAll();
    const result = await run;
    expect([...result.completed].sort()).toEqual(tickets.map((t) => t.id).sort());
    expect(result.failed).toEqual([]);
  });

  it('keeps an eleventh ready ticket queued until a slot frees, then runs it', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({ capacity: 11 });
    const tickets = makeIndependentNodes(11);

    const run = runScheduler({
      runId: 'run-11',
      tickets,
      adapter,
      store,
      config: { requestedCap: 10 },
    });

    await adapter.whenStarted(10);
    await flushMicrotasks();
    expect(adapter.inFlight).toBe(10);
    expect(adapter.started).toHaveLength(10); // the 11th has NOT started

    // Free exactly one slot; the 11th must then start.
    const firstStarted = adapter.started[0];
    adapter.release(firstStarted);
    await adapter.whenStarted(11);
    expect(adapter.started).toHaveLength(11);
    expect(adapter.started).toContain('t11');

    const result = await drain(adapter, run);
    expect(result.completed).toHaveLength(11);
  });

  it('throttles an under-capacity system and emits a capacity-reduction event with reason', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({ capacity: 10 });
    const tickets = makeIndependentNodes(10);

    const run = runScheduler({
      runId: 'run-throttle',
      tickets,
      adapter,
      store,
      config: { requestedCap: 10 },
      constraints: { resourceBudget: 3 },
    });

    await adapter.whenStarted(3);
    await flushMicrotasks();
    expect(adapter.inFlight).toBe(3); // throttled to the resource budget

    const emitted = capacityEvents(await store.readRun('run-throttle'));
    expect(emitted).toHaveLength(1);
    const payload = emitted[0].payload as { capacity: number; reason?: string };
    expect(payload.capacity).toBe(3);
    expect(payload.reason ?? '').toMatch(/resource budget/i);

    const result = await drain(adapter, run);
    expect(result.completed).toHaveLength(10);
    expect(result.capacityReductions[0]).toMatchObject({ capacity: 3, boundBy: 'resource_budget' });
  });

  it('serializes write-scope-conflicting tickets even when worker slots are free', async () => {
    const store = createInMemoryEventStore();
    const adapter = createGatedAdapter({ capacity: 10 });
    const a = makeNode('a', { writeScope: ['src/shared.ts'] });
    const b = makeNode('b', { writeScope: ['src/shared.ts'] });

    const run = runScheduler({
      runId: 'run-scope',
      tickets: [a, b],
      adapter,
      store,
      config: { requestedCap: 10 },
    });

    await adapter.whenStarted(1);
    await flushMicrotasks();
    expect(adapter.inFlight).toBe(1); // b waits despite 9 free slots
    expect(adapter.started).toEqual(['a']);

    adapter.release('a');
    await adapter.whenStarted(2);
    expect(adapter.started).toEqual(['a', 'b']);

    adapter.release('b');
    const result = await run;
    expect([...result.completed].sort()).toEqual(['a', 'b']);
    expect(adapter.maxConcurrent).toBe(1); // the two never overlapped
  });
});
