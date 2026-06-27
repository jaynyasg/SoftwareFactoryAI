/**
 * Adaptive worker scheduler (up to 10 concurrent workers).
 *
 * Given a ticket DAG, a selected adapter, an event store, capacity constraints,
 * and a config (`requestedCap` 1..10), the scheduler:
 *   1. probes adapter setup ONCE and stops before any execution on
 *      setup/auth failure (emitting `adapter.setup_required` / `adapter.auth_failed`),
 *   2. repeatedly computes ready tickets (`readyTickets`) and effective capacity
 *      (`computeEffectiveCapacity`), starting real concurrent `runTicket`
 *      promises up to that capacity,
 *   3. RESPECTS write-scope conflicts — a scope-conflicting ready ticket waits
 *      even when worker slots are free, and
 *   4. emits a capacity-reduction event (`adapter.capacity_changed`) with the
 *      bounding reason whenever a SYSTEM constraint throttles below the requested cap.
 *
 * Cancellation is passed in (`cancellation`); the scheduler wraps it in a
 * run-level token and gives every worker a child token, so cancelling the run
 * propagates to every in-flight adapter. Scheduling is deterministic — ready
 * order comes from the DAG's topological order and there is no `Math.random`; a
 * clock is injected for event timestamps.
 */
import { buildTicketDag, readyTickets } from '@software-factory/core';
import type {
  AdapterFamily,
  AdapterSelector,
  AppendableEvent,
  CompileContextInput,
  DagNode,
  EventActor,
  ExecutionAdapter,
  EventStore,
  RiskTier,
  TicketDag,
} from '@software-factory/core';
import { computeEffectiveCapacity, type CapacityConstraintName, MAX_WORKER_CAP } from './capacity';
import { conflicts, createWriteScopeTracker, type WriteScope } from './write-scope';
import { createCancellation, type CancellationScope } from './cancellation';
import { runTicket } from './worker-runner';

/** A schedulable ticket: a DAG node carrying everything needed to run it. */
export interface ScheduleNode extends DagNode {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly title: string;
  readonly riskTier: RiskTier;
  /** Isolated working directory for the worker. */
  readonly workspaceDir: string;
  /** Inputs used to compile the per-ticket worker context. */
  readonly compileInput: CompileContextInput;
  /** Declared write paths/globs; conflicting scopes are serialized. */
  readonly writeScope?: readonly string[];
  /** Optional per-node caller family (else `config.callerFamily`). */
  readonly callerFamily?: AdapterFamily;
}

/** Scheduler configuration. */
export interface SchedulerConfig {
  /** Operator-requested cap; clamped to [1, 10]. */
  readonly requestedCap: number;
  /** Bounded retry budget per ticket (forwarded to `runTicket`). */
  readonly maxAttempts?: number;
  /** Soft per-task timeout (ms), forwarded to the adapter. */
  readonly timeoutMs?: number;
  /** Caller agent family, for nested-agent metadata. */
  readonly callerFamily?: AdapterFamily;
  /** Injected clock for deterministic event timestamps. */
  readonly clock?: () => number;
}

/**
 * System capacity constraints. Each defaults to a non-binding value so an
 * unset constraint never silently throttles. `adapterCapacity` defaults to the
 * adapter's detected setup capacity; `sandboxCapacity` source is U6.
 */
export interface SchedulerConstraints {
  readonly adapterCapacity?: number;
  readonly sandboxCapacity?: number;
  readonly resourceBudget?: number;
  readonly reviewPolicyLimit?: number;
  readonly writeScopeAvailable?: number;
}

/** Inputs to a scheduler run. Provide either `tickets` or a prebuilt `dag`. */
export interface RunSchedulerInput<TNode extends ScheduleNode = ScheduleNode> {
  readonly runId: string;
  readonly tickets?: readonly TNode[];
  readonly dag?: TicketDag<TNode>;
  /** The selected/primary adapter (also used for the pre-flight setup probe). */
  readonly adapter: ExecutionAdapter;
  /** Optional per-node adapter selection (pre-validated; setup probe uses `adapter`). */
  readonly selectAdapter?: AdapterSelector<TNode>;
  readonly store: EventStore;
  readonly config: SchedulerConfig;
  readonly constraints?: SchedulerConstraints;
  /** Run-level cancellation (a signal or a cancellation scope). */
  readonly cancellation?: AbortSignal | CancellationScope;
}

/** A recorded capacity reduction (one per distinct throttled capacity value). */
export interface CapacityReduction {
  readonly capacity: number;
  readonly requested: number;
  readonly boundBy: CapacityConstraintName;
  readonly reason: string;
}

/** The outcome of a scheduler run. */
export interface SchedulerResult {
  readonly runId: string;
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly cancelled: readonly string[];
  /** Tickets neither completed/failed/cancelled (e.g. blocked by a failed dep). */
  readonly unfinished: readonly string[];
  /** `true` when the pre-flight adapter setup/auth probe failed (no work ran). */
  readonly setupFailed: boolean;
  /** `true` when the run was cancelled. */
  readonly cancelledRun: boolean;
  /** `true` when ready work could not progress (defensive anti-hang exit). */
  readonly stalled: boolean;
  readonly capacityReductions: readonly CapacityReduction[];
}

/**
 * Run the adaptive scheduler to completion (or cancellation). Resolves with a
 * summary; only unexpected infrastructure errors propagate.
 */
export async function runScheduler<TNode extends ScheduleNode = ScheduleNode>(
  input: RunSchedulerInput<TNode>,
): Promise<SchedulerResult> {
  const { runId, store, adapter, config } = input;
  const clock = config.clock;
  const adapterActor: EventActor = { kind: 'adapter', id: adapter.id, display: adapter.family };
  const schedulerActor: EventActor = { kind: 'worker', id: 'scheduler', display: 'scheduler' };

  const append = (event: Omit<AppendableEvent, 'runId' | 'timestamp'>): Promise<unknown> =>
    store.append({ ...event, runId, timestamp: clock?.() } as AppendableEvent);

  const runToken = createCancellation(input.cancellation);

  // Pre-flight: probe setup ONCE. Stop before any execution on failure.
  const setup = await adapter.detectSetup({ signal: runToken.signal });
  if (!setup.available || !setup.authenticated) {
    if (setup.available && !setup.authenticated) {
      await append({
        type: 'adapter.auth_failed',
        actor: adapterActor,
        subject: { kind: 'adapter', id: adapter.id },
        severity: 'error',
        payload: { reason: setup.detail ?? `${adapter.family} adapter is not authenticated.` },
      });
    }
    const actions =
      setup.setupActions !== undefined && setup.setupActions.length > 0
        ? setup.setupActions
        : [{ id: 'adapter.configure', title: 'Configure the execution adapter' } as const];
    for (const action of actions) {
      await append({
        type: 'adapter.setup_required',
        actor: adapterActor,
        subject: { kind: 'adapter', id: adapter.id },
        severity: 'warn',
        payload: { action: action.title, reason: action.description ?? setup.detail },
      });
    }
    runToken.dispose();
    const all = (input.dag ?? buildDag(input.tickets)).nodes.map((n) => n.id);
    return {
      runId,
      completed: [],
      failed: [],
      cancelled: [],
      unfinished: all,
      setupFailed: true,
      cancelledRun: runToken.aborted,
      stalled: false,
      capacityReductions: [],
    };
  }

  const dag = input.dag ?? buildDag(input.tickets);

  const adapterCapacity = input.constraints?.adapterCapacity ?? setup.capacity;
  const sandboxCapacity = input.constraints?.sandboxCapacity ?? MAX_WORKER_CAP;
  const resourceBudget = input.constraints?.resourceBudget ?? MAX_WORKER_CAP;
  const reviewPolicyLimit = input.constraints?.reviewPolicyLimit ?? MAX_WORKER_CAP;
  const writeScopeAvailable = input.constraints?.writeScopeAvailable ?? MAX_WORKER_CAP;

  const completed = new Set<string>();
  const failed = new Set<string>();
  const cancelled = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const ticketTokens = new Map<string, CancellationScope>();
  const queuedEmitted = new Set<string>();
  const tracker = createWriteScopeTracker();
  const reductions: CapacityReduction[] = [];
  let lastEmittedCapacity: number | undefined;
  let stalled = false;
  let infraError: unknown;

  const isSettled = (id: string): boolean =>
    completed.has(id) || failed.has(id) || cancelled.has(id);

  const emitQueuedOnce = async (id: string): Promise<void> => {
    if (queuedEmitted.has(id)) {
      return;
    }
    queuedEmitted.add(id);
    await append({
      type: 'ticket.queued',
      ticketId: id,
      actor: schedulerActor,
      subject: { kind: 'ticket', id },
      severity: 'info',
      payload: {},
    });
  };

  const emitCapacityChanged = async (
    capacity: number,
    requested: number,
    boundBy: CapacityConstraintName,
    reason: string,
  ): Promise<void> => {
    if (capacity === lastEmittedCapacity) {
      return;
    }
    lastEmittedCapacity = capacity;
    reductions.push({ capacity, requested, boundBy, reason });
    await append({
      type: 'adapter.capacity_changed',
      actor: adapterActor,
      subject: { kind: 'run', id: runId },
      severity: 'warn',
      payload: { capacity, previousCapacity: requested, reason },
    });
  };

  const startTicket = (node: TNode): void => {
    const adapterForNode = input.selectAdapter ? input.selectAdapter(node) : adapter;
    const token = runToken.child();
    ticketTokens.set(node.id, token);
    const promise = runTicket(
      {
        runId,
        compileInput: node.compileInput,
        workspaceDir: node.workspaceDir,
        signal: token.signal,
        callerFamily: node.callerFamily ?? config.callerFamily,
        maxAttempts: config.maxAttempts,
        timeoutMs: config.timeoutMs,
      },
      { store, adapter: adapterForNode, clock },
    )
      .then(
        (result) => {
          if (result.outcome === 'completed') {
            completed.add(node.id);
          } else if (result.outcome === 'cancelled') {
            cancelled.add(node.id);
          } else {
            failed.add(node.id);
          }
        },
        (error: unknown) => {
          // runTicket normalizes adapter failures; a throw here is infrastructure.
          failed.add(node.id);
          infraError = infraError ?? error;
        },
      )
      .finally(() => {
        running.delete(node.id);
        tracker.release(node.id);
        token.dispose();
        ticketTokens.delete(node.id);
      });
    running.set(node.id, promise);
  };

  const fillSlots = async (): Promise<void> => {
    if (runToken.aborted) {
      return;
    }
    const ready = readyTickets(dag, completed).filter(
      (node) => !running.has(node.id) && !isSettled(node.id),
    );
    const demand = running.size + ready.length;
    const effective = computeEffectiveCapacity({
      readyTickets: demand,
      requestedCap: config.requestedCap,
      adapterCapacity,
      sandboxCapacity,
      resourceBudget,
      writeScopeAvailable,
      reviewPolicyLimit,
    });
    if (effective.systemThrottled && effective.reason !== undefined) {
      await emitCapacityChanged(
        effective.capacity,
        effective.requested,
        effective.boundBy,
        effective.reason,
      );
    }

    let slots = Math.max(0, effective.capacity - running.size);
    const pickedScopes: WriteScope[] = [];
    for (const node of ready) {
      const scope: WriteScope = { ticketId: node.id, paths: node.writeScope ?? [] };
      if (slots <= 0) {
        await emitQueuedOnce(node.id);
        continue;
      }
      const scopeConflict =
        !tracker.canStart(scope) || pickedScopes.some((picked) => conflicts(picked, scope));
      if (scopeConflict) {
        await emitQueuedOnce(node.id);
        continue;
      }
      tracker.acquire(scope);
      pickedScopes.push(scope);
      slots -= 1;
      startTicket(node);
    }
  };

  const allSettled = (): boolean => dag.nodes.every((node) => isSettled(node.id));

  while (true) {
    if (runToken.aborted) {
      break;
    }
    await fillSlots();
    if (running.size === 0) {
      if (allSettled()) {
        break;
      }
      const anyReady = readyTickets(dag, completed).some((node) => !isSettled(node.id));
      if (!anyReady) {
        // Remaining tickets are blocked by failed/cancelled dependencies.
        break;
      }
      // Ready work exists but nothing could start and nothing is running:
      // a zero/over-tight system constraint. Exit instead of busy-looping.
      stalled = true;
      break;
    }
    await Promise.race([...running.values()]);
  }

  // Drain any in-flight workers (they cancel themselves when the run is aborted).
  await Promise.allSettled([...running.values()]);
  for (const token of ticketTokens.values()) {
    token.dispose();
  }
  runToken.dispose();

  if (infraError !== undefined) {
    throw infraError instanceof Error ? infraError : new Error(String(infraError));
  }

  const unfinished = dag.nodes.map((node) => node.id).filter((id) => !isSettled(id));
  return {
    runId,
    completed: [...completed],
    failed: [...failed],
    cancelled: [...cancelled],
    unfinished,
    setupFailed: false,
    cancelledRun: runToken.aborted,
    stalled,
    capacityReductions: reductions,
  };
}

function buildDag<TNode extends ScheduleNode>(tickets?: readonly TNode[]): TicketDag<TNode> {
  return buildTicketDag<TNode>(tickets ?? []);
}
