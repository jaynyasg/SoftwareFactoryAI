import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventStorePersistenceError,
  createFileSystemEventStore,
  createInMemoryEventStore,
  type AppendableEvent,
  type EventStore,
  type EventStoreOptions,
  type FileSystemEventStoreOptions,
} from '../../src/index';
import { describeEventStoreContract } from './event-store-contract';

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

  it('rethrows a persistence failure as a STRUCTURED error and stays consistent afterwards', async () => {
    // Block persistence: a FILE where the store expects its base directory
    // makes `mkdir` fail (the same shape as an EBUSY/ENOSPC append failure).
    const blockedDir = join(baseDir, 'blocked');
    await writeFile(blockedDir, 'not a directory', 'utf8');
    const store = createFileSystemEventStore({ baseDir: blockedDir, ...deterministic() });

    let thrown: unknown;
    try {
      await store.append(runCreated('run-1'));
      expect.unreachable('append over a blocked base dir must reject');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EventStorePersistenceError);
    const structured = thrown as EventStorePersistenceError;
    expect(structured.path).toContain('run-1.jsonl');
    expect(typeof structured.code).toBe('string');
    expect(structured.message).toContain('run-1');

    // The failed append corrupted nothing: once the blocker is removed, the
    // next append starts at sequence 1 (no gap from the failed allocation)
    // and hydration sees exactly the persisted events.
    await rm(blockedDir, { force: true });
    await store.append(runCreated('run-1'));
    expect((await store.readRun('run-1')).map((e) => e.sequence)).toEqual([1]);
  });

  it('recovers a torn JSONL tail: warns, keeps the new append on a fresh line, stable sequences', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const first = fsStore();
      await first.append(runCreated('run-1'));
      // Crash mid-write: a partial, non-newline-terminated last line.
      await appendFile(join(baseDir, 'run-1.jsonl'), '{"eventId":"torn-partial', 'utf8');

      // A fresh instance hydrates, surfaces the corrupt-tail diagnostic, and
      // the NEXT append starts on a fresh line instead of concatenating onto
      // the partial line (which would silently lose the new event later).
      const second = fsStore();
      await second.append(workerProgress('run-1', 't-1', 'after the tear'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt tail'));

      const raw = await readFile(join(baseDir, 'run-1.jsonl'), 'utf8');
      expect(raw).toContain('{"eventId":"torn-partial\n');

      // Re-hydrate from disk: the NEW event survived with a stable sequence
      // continuing from the last durable event (the torn write was never
      // acknowledged, so only IT is absent).
      const third = fsStore();
      const events = await third.readRun('run-1');
      expect(events.map((e) => e.sequence)).toEqual([1, 2]);
      expect(events[1].type).toBe('worker.progress');
    } finally {
      warn.mockRestore();
    }
  });

  it('caches readAll and invalidates the cache on append (returned arrays are copies)', async () => {
    const store = fsStore();
    await store.append(runCreated('run-1'));

    const firstRead = await store.readAll();
    expect(firstRead).toHaveLength(1);
    // Mutating the returned array must not poison later reads.
    firstRead.pop();
    expect(await store.readAll()).toHaveLength(1);

    // An append invalidates the cache: the next read sees the new event.
    await store.append(workerProgress('run-1', 't-1', 'x'));
    expect((await store.readAll()).map((e) => e.sequence)).toEqual([1, 2]);
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

/* ----------------------------------------------------------------------------
 * U11 — EventStore contract suite (the database migration seam, executable).
 *
 * Both shipping implementations must pass the identical contract; a future
 * database-backed store (e.g. Postgres) is added HERE with its own harness and
 * must pass unchanged. `reopen` simulates a single-instance cloud restart over
 * the same persisted state; the in-memory store has no persistence, so its
 * restart/replay section is skipped by the contract.
 * ------------------------------------------------------------------------- */
describeEventStoreContract({
  name: 'filesystem (JSONL)',
  create: () => fsStore(),
  // A NEW instance over the same baseDir — the restart path cloud mode takes.
  reopen: () => fsStore(),
});

describeEventStoreContract({
  name: 'in-memory',
  create: () => createInMemoryEventStore(deterministic()),
});
