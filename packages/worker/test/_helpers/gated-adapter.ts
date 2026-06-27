/**
 * A fully controllable `ExecutionAdapter` for concurrency tests.
 *
 * Each `execute` call blocks on a per-ticket gate that the test resolves on
 * command, so concurrency is asserted PRECISELY (no timers): start the
 * scheduler, `await adapter.whenStarted(10)`, assert 10 are in flight before any
 * completes, then `release`/`releaseAll`. The adapter also honors the abort
 * signal (settling with a normalized `cancelled` failure) and records start
 * order, in-flight count, and the high-water concurrency mark.
 */
import { AdapterError } from '@software-factory/core';
import type {
  AdapterExecuteOptions,
  AdapterFamily,
  AdapterResult,
  AdapterSetupState,
  AdapterTask,
  DetectSetupOptions,
  ExecutionAdapter,
} from '@software-factory/core';
import { createDeferred, type Deferred } from './deferred';

export interface GatedAdapterOptions {
  readonly id?: string;
  readonly family?: AdapterFamily;
  readonly capacity?: number;
  /** Overrides for the setup probe (defaults to available + authenticated). */
  readonly setup?: Partial<AdapterSetupState>;
}

export interface GatedAdapter extends ExecutionAdapter {
  /** Resolves once at least `n` executions have started. */
  whenStarted(n: number): Promise<void>;
  /** Resolve one in-flight ticket (default: success). */
  release(ticketId: string, result?: AdapterResult): void;
  /** Fail one in-flight ticket with a normalized error. */
  fail(ticketId: string, error: AdapterError): void;
  /** Resolve every currently in-flight ticket (default: success). */
  releaseAll(result?: AdapterResult): void;
  /** Ticket ids in the order their executions started. */
  readonly started: readonly string[];
  /** Number of executions currently in flight. */
  readonly inFlight: number;
  /** High-water mark of simultaneous in-flight executions. */
  readonly maxConcurrent: number;
  /** Number of executions that have completed (any outcome). */
  readonly settledCount: number;
}

function successResult(ticketId: string): AdapterResult {
  return { ok: true, output: `done:${ticketId}`, artifacts: [], summary: `Completed ${ticketId}.` };
}

export function createGatedAdapter(options: GatedAdapterOptions = {}): GatedAdapter {
  const capacity = options.capacity ?? 10;
  const gates = new Map<string, Deferred<AdapterResult>>();
  const started: string[] = [];
  const startWaiters: { readonly n: number; readonly deferred: Deferred<void> }[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  let settledCount = 0;

  const checkStartWaiters = (): void => {
    for (let i = startWaiters.length - 1; i >= 0; i -= 1) {
      if (started.length >= startWaiters[i].n) {
        startWaiters[i].deferred.resolve();
        startWaiters.splice(i, 1);
      }
    }
  };

  const detectSetup = (_options?: DetectSetupOptions): Promise<AdapterSetupState> =>
    Promise.resolve({
      available: options.setup?.available ?? true,
      authenticated: options.setup?.authenticated ?? true,
      capacity: options.setup?.capacity ?? capacity,
      setupActions: options.setup?.setupActions,
      detail: options.setup?.detail,
      version: options.setup?.version,
    });

  const execute = async (
    task: AdapterTask,
    opts: AdapterExecuteOptions,
  ): Promise<AdapterResult> => {
    if (opts.signal.aborted) {
      return { ok: false, error: AdapterError.cancelled() };
    }
    const gate = createDeferred<AdapterResult>();
    gates.set(task.ticketId, gate);
    started.push(task.ticketId);
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    opts.onEvent({ kind: 'progress', message: `gated:${task.ticketId}` });
    checkStartWaiters();

    const onAbort = (): void => {
      gate.resolve({ ok: false, error: AdapterError.cancelled() });
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await gate.promise;
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      gates.delete(task.ticketId);
      inFlight -= 1;
      settledCount += 1;
    }
  };

  return {
    id: options.id ?? 'gated',
    family: options.family ?? 'codex',
    detectSetup,
    execute,
    reportCapacity: () => capacity,
    whenStarted(n: number): Promise<void> {
      if (started.length >= n) {
        return Promise.resolve();
      }
      const deferred = createDeferred<void>();
      startWaiters.push({ n, deferred });
      return deferred.promise;
    },
    release(ticketId: string, result?: AdapterResult): void {
      gates.get(ticketId)?.resolve(result ?? successResult(ticketId));
    },
    fail(ticketId: string, error: AdapterError): void {
      gates.get(ticketId)?.resolve({ ok: false, error });
    },
    releaseAll(result?: AdapterResult): void {
      for (const [ticketId, gate] of gates) {
        gate.resolve(result ?? successResult(ticketId));
      }
    },
    get started(): readonly string[] {
      return started;
    },
    get inFlight(): number {
      return inFlight;
    },
    get maxConcurrent(): number {
      return maxConcurrent;
    },
    get settledCount(): number {
      return settledCount;
    },
  };
}
