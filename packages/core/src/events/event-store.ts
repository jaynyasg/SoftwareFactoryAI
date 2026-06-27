/**
 * Append-only event store.
 *
 * `EventStore` is the backend-agnostic interface (so a relational store can
 * replace the dev filesystem store later). This module ships two
 * implementations: an in-memory store (fast, for tests/projection wiring) and a
 * JSONL filesystem store under a configurable base dir (the V1 dev default,
 * e.g. `.factory/<runId>.jsonl`).
 *
 * Both implementations guarantee:
 *  - strictly increasing per-run `sequence` numbers, and
 *  - idempotency: appending with a previously-seen `idempotencyKey` returns the
 *    original event instead of creating a duplicate.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EVENT_ENVELOPE_VERSION, compareEventsBySequence, isFactoryEvent } from './event-types';
import type { AppendableEvent, EventEnvelope, FactoryEvent } from './event-types';
import { createSequenceAllocator } from './sequence';

/** Result of an append: the stored event plus whether it was a dedup hit. */
export interface AppendResult {
  readonly event: FactoryEvent;
  readonly deduplicated: boolean;
}

/** The append-only event store contract. */
export interface EventStore {
  /** Append an event, assigning version/sequence and (if omitted) id/timestamp. */
  append(event: AppendableEvent): Promise<AppendResult>;
  /** All events for a run, ordered by sequence. */
  readRun(runId: string): Promise<FactoryEvent[]>;
  /** All events across every run, ordered by (runId-grouped) sequence. */
  readAll(): Promise<FactoryEvent[]>;
  /** The distinct run ids known to the store. */
  listRuns(): Promise<string[]>;
}

/** Injectable, deterministic-in-tests dependencies common to all stores. */
export interface EventStoreOptions {
  /** Wall-clock source (epoch ms). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Event id source. Defaults to `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
}

export interface FileSystemEventStoreOptions extends EventStoreOptions {
  /** Base directory for JSONL files (e.g. `.factory`). */
  readonly baseDir: string;
}

function assertAppendable(input: AppendableEvent): void {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('Event input must be an object.');
  }
  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    throw new TypeError('Event input requires a non-empty runId.');
  }
  if (typeof input.type !== 'string') {
    throw new TypeError('Event input requires a type.');
  }
  if (typeof input.actor !== 'object' || input.actor === null) {
    throw new TypeError('Event input requires an actor.');
  }
  if (typeof input.subject !== 'object' || input.subject === null) {
    throw new TypeError('Event input requires a subject.');
  }
  if (typeof input.payload !== 'object' || input.payload === null) {
    throw new TypeError('Event input requires a payload.');
  }
}

function buildEnvelope(
  input: AppendableEvent,
  sequence: number,
  clock: () => number,
  idGenerator: () => string,
): FactoryEvent {
  const envelope: EventEnvelope = {
    version: EVENT_ENVELOPE_VERSION,
    eventId: input.eventId ?? idGenerator(),
    runId: input.runId,
    ticketId: input.ticketId,
    actor: input.actor,
    subject: input.subject,
    type: input.type,
    sequence,
    timestamp: input.timestamp ?? clock(),
    severity: input.severity,
    evidence: input.evidence,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  };
  // The construction binds `type` to its payload by contract; the assertion
  // narrows the loose envelope back to the discriminated union.
  return envelope as FactoryEvent;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

export function createInMemoryEventStore(options: EventStoreOptions = {}): EventStore {
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const allocator = createSequenceAllocator();
  const byRun = new Map<string, FactoryEvent[]>();
  const byIdempotencyKey = new Map<string, FactoryEvent>();

  return {
    append(input) {
      try {
        assertAppendable(input);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (input.idempotencyKey !== undefined) {
        const existing = byIdempotencyKey.get(input.idempotencyKey);
        if (existing) {
          return Promise.resolve({ event: existing, deduplicated: true });
        }
      }
      const event = buildEnvelope(input, allocator.next(input.runId), clock, idGenerator);
      const list = byRun.get(event.runId) ?? [];
      list.push(event);
      byRun.set(event.runId, list);
      if (event.idempotencyKey !== undefined) {
        byIdempotencyKey.set(event.idempotencyKey, event);
      }
      return Promise.resolve({ event, deduplicated: false });
    },
    readRun(runId) {
      const list = byRun.get(runId) ?? [];
      return Promise.resolve([...list].sort(compareEventsBySequence));
    },
    readAll() {
      const all = [...byRun.values()].flat();
      return Promise.resolve(all.sort(compareEventsBySequence));
    },
    listRuns() {
      return Promise.resolve([...byRun.keys()]);
    },
  };
}

export function createFileSystemEventStore(options: FileSystemEventStoreOptions): EventStore {
  const { baseDir } = options;
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const allocator = createSequenceAllocator();
  const cache = new Map<string, FactoryEvent[]>();
  const hydratedRuns = new Set<string>();
  const byIdempotencyKey = new Map<string, FactoryEvent>();
  let allHydrated = false;
  // Serialize all operations so sequence allocation and file appends never race.
  let chain: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function runFile(runId: string): string {
    // Sanitize to a filesystem-safe name. The authoritative runId lives inside
    // each event, so reads re-filter by `event.runId` to tolerate collisions.
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(baseDir, `${safe}.jsonl`);
  }

  async function loadFile(path: string): Promise<FactoryEvent[]> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
    const events: FactoryEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isFactoryEvent(parsed)) {
        events.push(parsed);
      }
    }
    return events;
  }

  function register(event: FactoryEvent): void {
    allocator.observe(event.runId, event.sequence);
    if (event.idempotencyKey !== undefined && !byIdempotencyKey.has(event.idempotencyKey)) {
      byIdempotencyKey.set(event.idempotencyKey, event);
    }
  }

  async function hydrateRun(runId: string): Promise<void> {
    if (allHydrated || hydratedRuns.has(runId)) {
      return;
    }
    const events = (await loadFile(runFile(runId))).filter((event) => event.runId === runId);
    for (const event of events) {
      register(event);
    }
    cache.set(runId, events);
    hydratedRuns.add(runId);
  }

  async function hydrateAll(): Promise<void> {
    if (allHydrated) {
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(baseDir);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        allHydrated = true;
        return;
      }
      throw error;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      for (const event of await loadFile(join(baseDir, name))) {
        if (hydratedRuns.has(event.runId)) {
          continue;
        }
        const list = cache.get(event.runId) ?? [];
        list.push(event);
        cache.set(event.runId, list);
        register(event);
      }
    }
    for (const runId of cache.keys()) {
      hydratedRuns.add(runId);
    }
    allHydrated = true;
  }

  return {
    append(input) {
      return enqueue(async () => {
        assertAppendable(input);
        await hydrateRun(input.runId);
        if (input.idempotencyKey !== undefined) {
          // Global dedup (across runs) so duplicate run creation is caught even
          // when a fresh runId would otherwise be allocated.
          await hydrateAll();
          const existing = byIdempotencyKey.get(input.idempotencyKey);
          if (existing) {
            return { event: existing, deduplicated: true };
          }
        }
        const event = buildEnvelope(input, allocator.next(input.runId), clock, idGenerator);
        await mkdir(baseDir, { recursive: true });
        await appendFile(runFile(event.runId), `${JSON.stringify(event)}\n`, 'utf8');
        const list = cache.get(event.runId) ?? [];
        list.push(event);
        cache.set(event.runId, list);
        if (event.idempotencyKey !== undefined) {
          byIdempotencyKey.set(event.idempotencyKey, event);
        }
        return { event, deduplicated: false };
      });
    },
    readRun(runId) {
      return enqueue(async () => {
        await hydrateRun(runId);
        return [...(cache.get(runId) ?? [])].sort(compareEventsBySequence);
      });
    },
    readAll() {
      return enqueue(async () => {
        await hydrateAll();
        return [...cache.values()].flat().sort(compareEventsBySequence);
      });
    },
    listRuns() {
      return enqueue(async () => {
        await hydrateAll();
        return [...cache.keys()];
      });
    },
  };
}
