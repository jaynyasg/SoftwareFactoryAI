import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileSystemEventStore,
  createInMemoryEventStore,
  type AppendableEvent,
  type EventStore,
  type EventStoreOptions,
  type FileSystemEventStoreOptions,
} from '../../src/index';

function deterministic(): Required<EventStoreOptions> {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

function runCreated(runId: string, idempotencyKey?: string): AppendableEvent {
  return {
    runId,
    type: 'run.created',
    actor: { kind: 'operator', id: 'op-1' },
    subject: { kind: 'run', id: runId, version: 0 },
    severity: 'info',
    idempotencyKey,
    payload: { prompt: 'build a marketplace' },
  };
}

function workerProgress(runId: string, ticketId: string, message: string): AppendableEvent {
  return {
    runId,
    ticketId,
    type: 'worker.progress',
    actor: { kind: 'worker', id: 'w-1' },
    subject: { kind: 'ticket', id: ticketId },
    severity: 'info',
    payload: { message },
  };
}

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'sf-events-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function fsStore(overrides: Partial<FileSystemEventStoreOptions> = {}): EventStore {
  return createFileSystemEventStore({ baseDir, ...deterministic(), ...overrides });
}

describe('event store (filesystem)', () => {
  it('assigns strictly increasing per-run sequence numbers', async () => {
    const store = fsStore();
    await store.append(runCreated('run-1'));
    await store.append(workerProgress('run-1', 't-1', 'a'));
    await store.append(workerProgress('run-1', 't-1', 'b'));

    const events = await store.readRun('run-1');
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.version === 1)).toBe(true);
  });

  it('keeps sequence counters independent per run', async () => {
    const store = fsStore();
    await store.append(runCreated('run-1'));
    await store.append(runCreated('run-2'));
    await store.append(workerProgress('run-2', 't-1', 'x'));

    expect((await store.readRun('run-1')).map((e) => e.sequence)).toEqual([1]);
    expect((await store.readRun('run-2')).map((e) => e.sequence)).toEqual([1, 2]);
    expect((await store.listRuns()).sort()).toEqual(['run-1', 'run-2']);
  });

  it('returns the original event for a duplicate idempotency key', async () => {
    const store = fsStore();
    const first = await store.append(runCreated('run-1', 'create-key'));
    const second = await store.append(runCreated('run-1', 'create-key'));

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.event.sequence).toBe(first.event.sequence);
    expect(await store.readRun('run-1')).toHaveLength(1);
  });

  it('does not create duplicate runs when run creation is retried with a key', async () => {
    const store = fsStore();
    await store.append(runCreated('run-1', 'idem-run'));
    await store.append(runCreated('run-1', 'idem-run'));
    await store.append(runCreated('run-1', 'idem-run'));

    expect(await store.listRuns()).toEqual(['run-1']);
    expect(await store.readRun('run-1')).toHaveLength(1);
  });

  it('persists across store instances and continues the sequence', async () => {
    const first = fsStore();
    await first.append(runCreated('run-1', 'idem-run'));
    await first.append(workerProgress('run-1', 't-1', 'a'));

    // A fresh instance over the same directory hydrates from disk.
    const second = fsStore();
    const reloaded = await second.readRun('run-1');
    expect(reloaded.map((e) => e.sequence)).toEqual([1, 2]);

    // New appends continue the sequence instead of restarting at 1.
    await second.append(workerProgress('run-1', 't-1', 'b'));
    expect((await second.readRun('run-1')).map((e) => e.sequence)).toEqual([1, 2, 3]);

    // Idempotency holds across instances (global dedup).
    const dup = await second.append(runCreated('run-1', 'idem-run'));
    expect(dup.deduplicated).toBe(true);
    expect((await second.readRun('run-1')).filter((e) => e.type === 'run.created')).toHaveLength(1);
  });

  it('rejects malformed append input', async () => {
    const store = fsStore();
    const bad = { type: 'run.created', payload: {} } as unknown as AppendableEvent;
    await expect(store.append(bad)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('event store (in-memory)', () => {
  it('satisfies the same sequencing and idempotency contract', async () => {
    const store = createInMemoryEventStore(deterministic());
    await store.append(runCreated('run-1'));
    await store.append(workerProgress('run-1', 't-1', 'a'));
    const dupFirst = await store.append(runCreated('run-1', 'k'));
    const dupSecond = await store.append(runCreated('run-1', 'k'));

    expect((await store.readRun('run-1')).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(dupSecond.deduplicated).toBe(true);
    expect(dupSecond.event.eventId).toBe(dupFirst.event.eventId);
  });
});
