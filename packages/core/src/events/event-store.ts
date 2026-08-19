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
 *
 * MIGRATION SEAM (full-factory U11): `EventStore` is the replacement boundary
 * for hosted scale. A database-backed implementation (e.g. Postgres) plugs in
 * at the construction sites — `packages/web/src/server/instance.ts#getStore`
 * and `packages/web/src/server/standalone.ts` — behind this same interface.
 * The `EventReader`/`EventWriter` facades, every projection, the command
 * guard's stale-version check, and the execution queue fold consume ONLY this
 * contract, so nothing above the store changes. Beyond the two guarantees
 * above, a replacement backend MUST preserve:
 *  - APPEND ATOMICITY: sequence assignment + persistence are one atomic step;
 *    two concurrent appends can never share a (runId, sequence) pair. (SQL
 *    shape: allocate the per-run sequence inside the insert transaction.)
 *  - GLOBAL IDEMPOTENCY: `idempotencyKey` dedup spans ALL runs, survives
 *    restarts, and returns the ORIGINAL stored event. (SQL shape: unique
 *    index on idempotencyKey; on conflict, return the existing row.)
 *  - PER-RUN ORDERING: `readRun` returns events ordered by sequence, and
 *    `readAll` ordering is deterministic (sequence, then eventId tie-break).
 *  - RESTART CONTINUATION: a fresh store instance over the same persisted
 *    state continues each run's sequence from the high-water mark.
 * The executable form of this contract lives in
 * `packages/core/test/events/event-store-contract.ts`; any replacement
 * backend must pass that suite unchanged. See ARCHITECTURE.md
 * ("Hosted Scale Migration Seam") for the full upgrade path.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  /**
   * Permanently delete every event for the given runs (the operator
   * "clear everything" command). Destructive and NOT append-only by design:
   * this is the one operator escape hatch for purging terminal-run history
   * (e.g. accumulated e2e fixtures) from the ledger. Returns the run ids that
   * actually had events; unknown ids are ignored. Idempotency keys and
   * sequence state for deleted runs are forgotten, so a reused run id starts
   * fresh.
   */
  deleteRuns(runIds: readonly string[]): Promise<{ deleted: string[] }>;
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

/**
 * Structured persistence failure for the filesystem store: carries the errno
 * code (`EBUSY`, `ENOSPC`, …) and the ledger file path so callers (e.g. the
 * execution daemon) can release leases cleanly and surface an actionable
 * diagnostic instead of an opaque throw.
 */
export class EventStorePersistenceError extends Error {
  /** The underlying errno code, when the failure was an fs error. */
  readonly code?: string;
  /** The ledger file (or base directory) the write targeted. */
  readonly path: string;

  constructor(message: string, options: { readonly code?: string; readonly path: string }) {
    super(message);
    this.name = 'EventStorePersistenceError';
    this.code = options.code;
    this.path = options.path;
  }
}

export function createInMemoryEventStore(options: EventStoreOptions = {}): EventStore {
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? randomUUID;
  const allocator = createSequenceAllocator();
  const byRun = new Map<string, FactoryEvent[]>();
  const byIdempotencyKey = new Map<string, FactoryEvent>();
  // Flattened+sorted readAll cache: invalidated on every (non-dedup) append,
  // returned as a copy so callers can never mutate the cached array.
  let readAllCache: FactoryEvent[] | null = null;

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
      readAllCache = null;
      return Promise.resolve({ event, deduplicated: false });
    },
    readRun(runId) {
      const list = byRun.get(runId) ?? [];
      return Promise.resolve([...list].sort(compareEventsBySequence));
    },
    readAll() {
      readAllCache ??= [...byRun.values()].flat().sort(compareEventsBySequence);
      return Promise.resolve([...readAllCache]);
    },
    listRuns() {
      return Promise.resolve([...byRun.keys()]);
    },
    deleteRuns(runIds) {
      const targets = new Set(runIds);
      const deleted: string[] = [];
      for (const runId of targets) {
        if (byRun.delete(runId)) {
          deleted.push(runId);
          allocator.reset(runId);
        }
      }
      if (deleted.length > 0) {
        for (const [key, event] of byIdempotencyKey) {
          if (targets.has(event.runId)) {
            byIdempotencyKey.delete(key);
          }
        }
        readAllCache = null;
      }
      return Promise.resolve({ deleted });
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
  // Files whose hydrated content ended in a torn (partial) line: the next
  // append to such a file must start on a FRESH line so the new event is not
  // concatenated onto the partial one (which would silently lose it on the
  // next restart).
  const tornTailFiles = new Set<string>();
  // Flattened+sorted readAll cache: invalidated on every (non-dedup) append,
  // returned as a copy so callers can never mutate the cached array.
  let readAllCache: FactoryEvent[] | null = null;
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
      // ENOTDIR: a path component is a file, so the run file cannot exist —
      // the same "nothing persisted yet" case as ENOENT (the append path
      // reports the underlying problem as a structured persistence error).
      if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        return [];
      }
      throw error;
    }
    const lines = raw.split('\n');
    const events: FactoryEvent[] = [];
    let lastNonEmptyParsed = true;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      lastNonEmptyParsed = false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (isFactoryEvent(parsed)) {
        events.push(parsed);
        lastNonEmptyParsed = true;
      }
    }
    // Torn-tail recovery: a crash mid-write leaves a partial (non-newline-
    // terminated or unparseable) last line. Surface the diagnostic and make
    // sure the NEXT append starts on a fresh line — otherwise the new event
    // would concatenate onto the partial line and be silently lost (with a
    // reallocated sequence) on the following restart.
    const endsWithNewline = raw.length === 0 || raw.endsWith('\n');
    if (!endsWithNewline || !lastNonEmptyParsed) {
      tornTailFiles.add(path);
      console.warn(
        `[software-factory] event ledger ${path} has a corrupt tail (crash mid-write?); ` +
          'the partial line was skipped and the next append will start on a fresh line.',
      );
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
      if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
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
        const sequenceBefore = allocator.peek(input.runId);
        const event = buildEnvelope(input, allocator.next(input.runId), clock, idGenerator);
        const path = runFile(event.runId);
        try {
          await mkdir(baseDir, { recursive: true });
          // Torn-tail recovery: start on a fresh line when hydration found a
          // partial last line, so the new event is never concatenated onto it.
          const prefix = tornTailFiles.has(path) ? '\n' : '';
          await appendFile(path, `${prefix}${JSON.stringify(event)}\n`, 'utf8');
          tornTailFiles.delete(path);
        } catch (error) {
          // Persistence failed (EBUSY/ENOSPC/…): nothing was recorded, so roll
          // the sequence allocator back to its pre-append high-water mark (the
          // enqueue chain serializes appends, so no concurrent allocation can
          // interleave) and rethrow a STRUCTURED error carrying errno + path.
          allocator.reset(event.runId);
          allocator.observe(event.runId, sequenceBefore);
          const code = isErrnoException(error) ? error.code : undefined;
          const message = error instanceof Error ? error.message : String(error);
          throw new EventStorePersistenceError(
            `Failed to persist event ${event.type} for run ${event.runId} to ${path}` +
              `${code !== undefined ? ` (${code})` : ''}: ${message}`,
            { code, path },
          );
        }
        const list = cache.get(event.runId) ?? [];
        list.push(event);
        cache.set(event.runId, list);
        if (event.idempotencyKey !== undefined) {
          byIdempotencyKey.set(event.idempotencyKey, event);
        }
        readAllCache = null;
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
        readAllCache ??= [...cache.values()].flat().sort(compareEventsBySequence);
        return [...readAllCache];
      });
    },
    listRuns() {
      return enqueue(async () => {
        await hydrateAll();
        // Only runs with at least one event: `readRun`/`hydrateRun` caches an
        // empty [] for a run that was merely ASKED about (or deleted), and a
        // never-persisted run id must not leak into the run list.
        return [...cache.entries()]
          .filter(([, events]) => events.length > 0)
          .map(([runId]) => runId);
      });
    },
    deleteRuns(runIds) {
      return enqueue(async () => {
        await hydrateAll();
        const targets = new Set(runIds);
        const deleted = [...targets].filter((runId) => cache.has(runId));
        if (deleted.length === 0) {
          return { deleted };
        }
        // Filenames are sanitized, so distinct run ids CAN collide on one
        // file; a file is unlinked only when every run stored in it is being
        // deleted, otherwise it is rewritten with the surviving events.
        const survivorsByFile = new Map<string, FactoryEvent[]>();
        for (const [runId, events] of cache) {
          if (targets.has(runId)) {
            continue;
          }
          const path = runFile(runId);
          const list = survivorsByFile.get(path) ?? [];
          list.push(...events);
          survivorsByFile.set(path, list);
        }
        for (const runId of deleted) {
          const path = runFile(runId);
          const survivors = survivorsByFile.get(path);
          try {
            if (survivors === undefined) {
              await rm(path, { force: true });
              tornTailFiles.delete(path);
            } else {
              const lines = survivors
                .sort(compareEventsBySequence)
                .map((event) => JSON.stringify(event))
                .join('\n');
              await writeFile(path, `${lines}\n`, 'utf8');
              tornTailFiles.delete(path);
              // The file was rewritten once; colliding survivors stay put and
              // later deleted run ids mapping here see survivors again.
            }
          } catch (error) {
            const code = isErrnoException(error) ? error.code : undefined;
            const message = error instanceof Error ? error.message : String(error);
            throw new EventStorePersistenceError(
              `Failed to delete run ${runId} ledger at ${path}` +
                `${code !== undefined ? ` (${code})` : ''}: ${message}`,
              { code, path },
            );
          }
        }
        for (const runId of deleted) {
          for (const event of cache.get(runId) ?? []) {
            if (
              event.idempotencyKey !== undefined &&
              byIdempotencyKey.get(event.idempotencyKey)?.runId === runId
            ) {
              byIdempotencyKey.delete(event.idempotencyKey);
            }
          }
          cache.delete(runId);
          hydratedRuns.delete(runId);
          allocator.reset(runId);
        }
        readAllCache = null;
        return { deleted };
      });
    },
  };
}
