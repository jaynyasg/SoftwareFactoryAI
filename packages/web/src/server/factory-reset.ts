/**
 * Factory Reset core (session lifecycle U4, flow F3 — R9/R12/R15, AE3).
 *
 * The ONE place that knows what a destructive factory reset may touch and in
 * what order. The route (`routes/execution.ts#factoryReset`) owns the HTTP
 * concerns (guard, typed-confirmation phrase, refuse-while-leased, response
 * shapes); this module owns the blast radius:
 *
 *   ALLOWLIST-ONLY DELETION. Exactly three factory-managed paths under the
 *   factory dir (`resolveFactoryDir`) may be deleted — `events/` (the JSONL
 *   ledger), `workspaces/` (factory-materialized checkouts), and
 *   `operator-token.json` (the file-backed operator session). Nothing else,
 *   ever: user-supplied `localFolder` workspace targets live OUTSIDE the
 *   factory dir and are never enumerated, and an operator-relocated checkout
 *   root (`SF_WORKSPACE_CHECKOUT_ROOT` pointing outside the factory dir) is
 *   deliberately NOT wiped — outside the factory dir means outside
 *   factory-managed scope by the allowlist rule.
 *
 *   RESET GENERATION IS LEDGER-DERIVED. The monotonic generation (stale-tab
 *   detection, R15) is not a counter file: it is the max
 *   `factory.reset_completed.resetGeneration` on the CURRENT ledger (0 when
 *   the marker has never been appended). The reset reads the pre-wipe value,
 *   wipes, and appends the marker with `previous + 1` as the FIRST event of
 *   the fresh ledger — so the generation survives server restarts (it is
 *   replayed from the marker) and always differs from the pre-reset value.
 *
 *   SEAL, THEN DELETE, THEN DISPOSE. The outgoing store is sealed IN PLACE
 *   (every method rejects with `factory_reset_in_progress`) before deletion,
 *   so an in-flight append on a stale handle cannot re-create wiped `events/`.
 *   `FactoryResetRuntime.rebuild()` is called AFTER the allowlisted paths are
 *   deleted, so the fresh store hydrates from an EMPTY directory — a rebuild
 *   before deletion would hydrate the doomed files and resurrect their
 *   sequence high-water marks into the "fresh" state. The rebuild still runs
 *   when the wipe fails (the sealed singletons must be replaced either way).
 */
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isRealRun, projectRun } from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import type { ExecutionDaemon } from './execution/daemon';
import { OPERATOR_TOKEN_FILENAME } from './runtime';

/**
 * The server-side typed confirmation phrase (AE3 — enforced HERE, not just in
 * UI). The route rejects any request whose `confirm` body field is not this
 * exact string, and the rejection message names it so every surface (UI modal,
 * CLI prompt, MCP error) renders the same contract.
 */
export const FACTORY_RESET_PHRASE = 'reset the factory';

/**
 * The dispose/rebuild capability a server entry point injects (via `createApp`
 * deps). `instance.ts` implements it over the globalThis singletons; tests
 * implement it over their own store/daemon/app triple. `rebuild()` MUST:
 *   1. drop every reference to the pre-wipe store (its in-memory event cache,
 *      idempotency map, and sequence high-water marks must not survive),
 *   2. drop the app/daemon bound to that store, and
 *   3. return a FRESH store over the (now empty) factory dir.
 * It is only ever called AFTER the allowlisted paths were deleted (or after
 * the deletion attempt failed — a failed wipe still disposes the sealed old
 * singletons; see `executeFactoryReset`).
 */
export interface FactoryResetRuntime {
  /** Absolute factory dir whose allowlisted children the reset wipes. */
  readonly factoryDir: string;
  /** Dispose the process singletons and rebuild the store; see above. */
  rebuild(): Promise<EventStore>;
  /**
   * Override the allowlisted-wipe implementation (defaults to
   * `wipeFactoryManagedState`). A test seam: reset tests inject deletion
   * failures (Windows EBUSY) without mocking node:fs for the whole suite.
   */
  wipe?(factoryDir: string): Promise<readonly string[]>;
}

/**
 * A wipe that failed partway. `deletedPaths` is what WAS removed before the
 * failure — the route surfaces it so a partial deletion is never silently
 * discarded (the operator must see what is already gone before retrying).
 */
export class FactoryResetWipeError extends Error {
  constructor(
    message: string,
    readonly deletedPaths: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FactoryResetWipeError';
  }
}

/**
 * Seal an OUTGOING store before deletion. Core's filesystem store `append`
 * re-creates the events dir (`mkdir -p` + appendFile), so an in-flight append
 * on a pre-reset handle racing the wipe could resurrect wiped `events/` (with
 * the old sequence high-water marks). The store contract exposes no seal API,
 * so the reset seals the handle IN PLACE: every method is replaced with a
 * rejection naming `factory_reset_in_progress`. Old handles held by in-flight
 * requests (or a stale app/daemon) fail loudly instead of writing to — or
 * reading from — a half-deleted ledger. Irreversible by design: `rebuild()`
 * mints the replacement store.
 */
export function sealEventStore(store: EventStore): void {
  const sealed = (): Promise<never> =>
    Promise.reject(
      new Error(
        'factory_reset_in_progress: this event store was disposed by a factory reset; ' +
          'acquire the rebuilt store instead.',
      ),
    );
  const mutable = store as {
    append: EventStore['append'];
    readRun: EventStore['readRun'];
    readAll: EventStore['readAll'];
    listRuns: EventStore['listRuns'];
  };
  mutable.append = sealed;
  mutable.readRun = sealed;
  mutable.readAll = sealed;
  mutable.listRuns = sealed;
}

/**
 * The full, closed list of paths a factory reset may delete. Adding a path
 * here is a reviewed decision — the allowlist test pins the exact contents.
 */
export function factoryResetAllowlist(factoryDir: string): readonly string[] {
  return [
    join(factoryDir, 'events'),
    join(factoryDir, 'workspaces'),
    join(factoryDir, OPERATOR_TOKEN_FILENAME),
  ];
}

/**
 * The current reset generation of a ledger: the max generation any
 * `factory.reset_completed` marker recorded, 0 for a never-reset factory.
 * Pure fold — the overview routes call it on every poll, and the reset itself
 * reads the pre-wipe value through it.
 */
export function currentResetGeneration(events: readonly FactoryEvent[]): number {
  let generation = 0;
  for (const event of events) {
    if (event.type === 'factory.reset_completed') {
      const value = event.payload.resetGeneration;
      if (Number.isFinite(value) && value > generation) {
        generation = value;
      }
    }
  }
  return generation;
}

/**
 * Pre-flight enumeration of what a reset destroys (R9/AE3): rendered by the
 * confirmation UI BEFORE the operator types the phrase, echoed on the success
 * response as the audit of what WAS destroyed.
 */
export interface FactoryResetEnumeration {
  /** Visible (non-archived) real runs the wipe destroys. */
  readonly runCount: number;
  /** Archived runs the wipe destroys (still real; hidden from default views). */
  readonly archivedRunCount: number;
  /** Total ledger events the wipe destroys (markers and phantoms included). */
  readonly eventCount: number;
  /** Allowlisted top-level paths that exist on disk and will be deleted. */
  readonly paths: readonly string[];
  /** Factory-managed workspace checkouts under `<factoryDir>/workspaces`. */
  readonly workspacePaths: readonly string[];
  /** The CURRENT (pre-wipe) generation; the fresh state records this + 1. */
  readonly resetGeneration: number;
}

/** Enumerate the destruction a reset of this ledger + factory dir would do. */
export async function enumerateFactoryReset(
  events: readonly FactoryEvent[],
  factoryDir: string,
): Promise<FactoryResetEnumeration> {
  const eventsByRun = new Map<string, FactoryEvent[]>();
  for (const event of events) {
    const runEvents = eventsByRun.get(event.runId);
    if (runEvents === undefined) {
      eventsByRun.set(event.runId, [event]);
    } else {
      runEvents.push(event);
    }
  }
  let runCount = 0;
  let archivedRunCount = 0;
  for (const [runId, runEvents] of eventsByRun) {
    const run = projectRun(runEvents, runId);
    if (!isRealRun(run)) {
      continue;
    }
    if (run.archived) {
      archivedRunCount += 1;
    } else {
      runCount += 1;
    }
  }

  const paths = factoryResetAllowlist(factoryDir).filter((path) => existsSync(path));
  const workspacesDir = join(factoryDir, 'workspaces');
  let workspacePaths: string[] = [];
  try {
    workspacePaths = (await readdir(workspacesDir)).map((name) => join(workspacesDir, name));
  } catch {
    // No workspaces dir (or unreadable): nothing factory-materialized to list.
  }

  return {
    runCount,
    archivedRunCount,
    eventCount: events.length,
    paths,
    workspacePaths,
    resetGeneration: currentResetGeneration(events),
  };
}

/**
 * Delete the allowlisted factory-managed paths — and ONLY those. Refuses a
 * non-absolute factory dir outright: this function must never be reachable
 * with a relative path that `rm -r` would resolve against an arbitrary cwd.
 * Returns the paths that existed and were deleted. A deletion failure (e.g.
 * Windows EBUSY on a locked workspace) raises `FactoryResetWipeError`
 * carrying the PARTIAL deletion list, never a bare error that loses it.
 */
export async function wipeFactoryManagedState(factoryDir: string): Promise<readonly string[]> {
  if (factoryDir.length === 0 || !isAbsolute(factoryDir)) {
    throw new Error(`Factory reset requires an absolute factory dir; got "${factoryDir}".`);
  }
  const deleted: string[] = [];
  for (const target of factoryResetAllowlist(factoryDir)) {
    if (!existsSync(target)) {
      continue;
    }
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FactoryResetWipeError(`could not delete "${target}": ${message}`, deleted, {
        cause: error,
      });
    }
    deleted.push(target);
  }
  return deleted;
}

export interface ExecuteFactoryResetOptions {
  /** The CURRENT (pre-wipe) daemon; held, then stopped before any deletion. */
  readonly daemon: ExecutionDaemon;
  /** The CURRENT (pre-wipe) store; sealed in place before any deletion. */
  readonly store: EventStore;
  readonly runtime: FactoryResetRuntime;
  /** The generation the fresh marker records (pre-wipe generation + 1). */
  readonly nextGeneration: number;
  /** How many runs (visible + archived) the wiped state contained. */
  readonly wipedRunCount: number;
}

export interface FactoryResetOutcome {
  /** The FRESH store the markers were appended to. */
  readonly store: EventStore;
  /** The allowlisted paths that existed and were deleted. */
  readonly deletedPaths: readonly string[];
}

/**
 * The destructive sequence, in the pinned order:
 *   hold gate -> stop daemon (awaits the chained passes, so no ledger append
 *   is in flight) -> SEAL the outgoing store (an in-flight append on a stale
 *   handle can no longer re-create wiped `events/`) -> delete allowlisted
 *   paths -> dispose/rebuild singletons (fresh store hydrates the EMPTY dir;
 *   sequence high-water marks reset) -> append `factory.reset_completed` then
 *   `session.started` as the first two events of the fresh 'factory' stream.
 *
 * The rebuild ALWAYS runs, even when the wipe throws (Windows EBUSY on a
 * locked workspace): the old store/daemon are already sealed and stopped, so
 * skipping the rebuild would brick the server. A failed wipe re-raises as
 * `FactoryResetWipeError` carrying the partial deletion list; the fresh
 * markers are NOT appended in that case (the reset did not complete, so the
 * generation must not bump).
 *
 * Callers verified the confirmation phrase and the no-active-lease rule BEFORE
 * calling this; from here the wipe is unconditional.
 */
export async function executeFactoryReset(
  options: ExecuteFactoryResetOptions,
): Promise<FactoryResetOutcome> {
  const { daemon, store: outgoingStore, runtime, nextGeneration, wipedRunCount } = options;

  daemon.hold();
  await daemon.stop();
  sealEventStore(outgoingStore);

  let deletedPaths: readonly string[] = [];
  let wipeFailed = false;
  let wipeError: unknown;
  try {
    deletedPaths = await (runtime.wipe ?? wipeFactoryManagedState)(runtime.factoryDir);
  } catch (error) {
    wipeFailed = true;
    wipeError = error;
  }
  // Dispose/rebuild ALWAYS (A4): the sealed old singletons must be replaced
  // whether or not the deletion succeeded.
  const store = await runtime.rebuild();
  if (wipeFailed) {
    if (wipeError instanceof FactoryResetWipeError) {
      throw wipeError;
    }
    const message = wipeError instanceof Error ? wipeError.message : String(wipeError);
    throw new FactoryResetWipeError(message, deletedPaths, { cause: wipeError });
  }

  // The reset marker is the FIRST event of the fresh state: the discontinuity
  // explains itself (R12), and the generation replays from here (R15).
  await store.append({
    runId: 'factory',
    type: 'factory.reset_completed',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'factory', id: 'reset' },
    severity: 'warn',
    payload: { resetGeneration: nextGeneration, wipedRunCount },
  });
  // A reset also opens a fresh session; nothing was archived — it was wiped.
  await store.append({
    runId: 'factory',
    type: 'session.started',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'factory', id: 'session' },
    severity: 'info',
    payload: { archivedRunIds: [] },
  });

  return { store, deletedPaths };
}
