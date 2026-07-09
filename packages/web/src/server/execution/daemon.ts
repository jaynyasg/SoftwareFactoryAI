/**
 * Execution daemon (full-factory U5, hardening E1/E2).
 *
 * The daemon is the ONLY component that runs queued execution work. HTTP, CLI,
 * GPT Action, and MCP commands enqueue or mutate execution state on the ledger
 * and return projected state — they never hold request lifetimes open while
 * workers run. Each server entry point (Next-mounted singleton, standalone API
 * server) bootstraps exactly ONE daemon per process.
 *
 * Every pass (`tick`) does two things, serialized so passes never overlap:
 *   1. RECONCILE — expired leases from crashed/previous owners are marked
 *      abandoned and escalated to the operator intervention queue; unexpired
 *      foreign leases are left alone (another owner may still be live).
 *   2. DRAIN — queued jobs whose runs are not paused/cancelled are claimed
 *      (lease + heartbeat) and handed to the injected `TicketExecutor`.
 *
 * U6 SEAM: the `TicketExecutor` is where ticket-to-worker execution plugs in.
 * U5 ships `deferredTicketExecutor`, which honestly BLOCKS execution (with an
 * intervention) instead of pretending to build. U6 replaces it with a
 * scheduler-backed executor; the daemon, queue, and command surface do not
 * change.
 *
 * U11 DATABASE-READY INVARIANTS: every scheduling decision in this file is a
 * function of LEDGER state (store reads + pure projections), never of process
 * memory, so a database-backed EventStore/queue can replace the JSONL store
 * without changing daemon semantics. There is no separate reconciler module —
 * reconciliation IS step 1 of `tick()` below, and the invariants live here.
 * Any replacement queue/daemon must preserve:
 *   1. QUEUE TRUTH IS A FOLD: queue state is `projectExecutionQueue` over
 *      `queue.*` ledger events — a restart replays the exact same queue.
 *   2. STORE-LEVEL CLAIM ARBITRATION: `queue.claimed` is idempotent per
 *      (jobId, attempt); a deduplicated claim means another owner already won
 *      and the loser must NOT execute. (SQL shape: unique idempotency key.)
 *   3. SINGLE ACTIVE OWNER OR LEASE-SAFE MULTI-OWNER: safety against foreign
 *      owners rests ONLY on ledger lease expiry — never on shared memory.
 *   4. HEARTBEAT FRESHNESS: heartbeats extend `leaseExpiresAt` on the ledger;
 *      an UNexpired foreign lease is never abandoned or re-claimed.
 *   5. ABANDONED-LEASE RECOVERY: expired leases are marked abandoned and
 *      escalated to the intervention queue — never silently re-run.
 *   6. RECONCILE-BEFORE-DRAIN: every pass reconciles stale leases before
 *      claiming new work, so restart recovery is never starved.
 *   7. PAUSE FOLD IMMUNITY: pause/cancel gating reads the run projection from
 *      the ledger on EVERY decision (`runIsPausedOrCancelled`), so pauses
 *      survive restarts and apply to every owner identically.
 * Documented exception (the only process-local state): `inFlight` maps THIS
 * owner's live executions to their AbortControllers. It exists to abort the
 * owner's own work on cancel/shutdown and to stop the owner's own reconciler
 * from abandoning a job its executor is still running. Foreign owners never
 * see it — for them, correctness rests purely on invariants 2-5, which the
 * U11 tests in `execution-queue.test.ts` pin.
 *
 * Timers are injectable and the clock is injectable, so tests drive `tick()`
 * deterministically with no real waits.
 */
import { projectRun } from '@software-factory/core';
import type { EventStore, InterventionKind } from '@software-factory/core';
import {
  abandonLease,
  claimJob,
  enqueueJob,
  heartbeatJob,
  projectExecutionQueue,
  releaseJob,
} from './queue';
import type { QueueJobView } from './queue';
import { raiseIntervention } from './interventions';
import { DEFAULT_EXECUTION_RUNTIME_CONFIG } from '../runtime';
import type { ExecutionRuntimeConfig } from '../runtime';

/* ----------------------------------------------------------------------------
 * U6 executor seam
 * ------------------------------------------------------------------------- */

/** Context handed to the executor for one claimed queue job. */
export interface TicketExecutionContext {
  readonly runId: string;
  readonly jobId: string;
  readonly jobKind: QueueJobView['jobKind'];
  readonly attempt: number;
  readonly leaseId: string;
  /** Optional ticket focus recorded by a retry-ticket command. */
  readonly ticketId?: string;
  /** The shared ledger store — the executor emits its own worker/ticket events. */
  readonly store: EventStore;
  /** Aborted on graceful shutdown and on run cancellation. */
  readonly signal: AbortSignal;
  /** Extend the queue lease; call at least every `heartbeatMs` during work. */
  heartbeat(): Promise<void>;
  /**
   * Whether the executor may START new work: false once the run is paused or
   * cancelled. In-flight ticket handling on pause is the executor's decision.
   */
  shouldContinue(): Promise<boolean>;
}

export type TicketExecutionStatus = 'completed' | 'failed' | 'blocked' | 'yielded';

/**
 * The executor's verdict for one job attempt:
 *  - `completed` — all work for the job finished,
 *  - `failed`    — the attempt failed (operator may retry within budget),
 *  - `blocked`   — an operator action is required (raises an intervention),
 *  - `yielded`   — the executor stopped SAFELY without finishing (pause or
 *    shutdown); the job is requeued so a restart resumes it.
 */
export interface TicketExecutionResult {
  readonly status: TicketExecutionStatus;
  readonly reason?: string;
  readonly summary?: string;
  readonly requiredAction?: string;
  /**
   * Intervention-queue classification for a `blocked` result (X4). Defaults to
   * `adapter_setup`; U6 uses it to distinguish policy blocks, workspace/source
   * problems, and approval gaps from adapter setup failures.
   */
  readonly interventionKind?: InterventionKind;
  /**
   * The stage the intervention blocks (U7). Defaults to `execution` for
   * run-execution jobs and `gates` for gate-rerun jobs; the executor sets
   * `gates` explicitly when a post-run gate stage blocked a run-execution job,
   * so review approvals resume the CORRECT stage.
   */
  readonly blockingStage?: string;
}

/** The interface U6 implements: run the tickets for one claimed queue job. */
export type TicketExecutor = (ctx: TicketExecutionContext) => Promise<TicketExecutionResult>;

/**
 * U5 default executor: blocks honestly. Real ticket-to-worker execution is U6;
 * until it lands, a started run surfaces an explicit blocked state plus an
 * intervention instead of a silent no-op "success".
 */
export const deferredTicketExecutor: TicketExecutor = () =>
  Promise.resolve({
    status: 'blocked',
    reason: 'Ticket-to-worker execution integration is not available yet (planned unit U6).',
    requiredAction:
      'Wait for the ticket-to-worker execution integration (U6); the queued start request stays recorded and can be retried once it lands.',
  });

/* ----------------------------------------------------------------------------
 * Daemon
 * ------------------------------------------------------------------------- */

/** Injectable interval timers (tests pass no-op timers and call `tick()`). */
export interface DaemonTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: DaemonTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    // Never keep the process alive just for the reconciler.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle) {
    clearInterval(handle as Parameters<typeof clearInterval>[0]);
  },
};

export const DEFAULT_EXECUTION_QUEUE_CONFIG: ExecutionRuntimeConfig =
  DEFAULT_EXECUTION_RUNTIME_CONFIG;

export interface ExecutionDaemonOptions {
  readonly store: EventStore;
  /** U6 seam. Defaults to the honest `deferredTicketExecutor`. */
  readonly executor?: TicketExecutor;
  readonly config?: Partial<ExecutionRuntimeConfig>;
  readonly clock?: () => number;
  /** Lease-id source. */
  readonly idGenerator?: () => string;
  /** Stable identity for this daemon (process) instance. */
  readonly ownerId?: string;
  readonly timers?: DaemonTimers;
}

export interface DaemonTickResult {
  readonly claimed: number;
  readonly abandoned: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly requeued: number;
  readonly cancelled: number;
}

export interface ExecutionDaemon {
  readonly ownerId: string;
  readonly running: boolean;
  /** Resolved queue tuning (lease/heartbeat/reconcile/retry budget). */
  readonly config: ExecutionRuntimeConfig;
  /** Idempotent bootstrap: initial reconcile pass + the interval loop. */
  start(): Promise<void>;
  /** Graceful shutdown: stops the loop and aborts in-flight work (yield/requeue). */
  stop(): Promise<void>;
  /** One reconcile+drain pass. Serialized; safe to call directly in tests. */
  tick(): Promise<DaemonTickResult>;
  /** Wake the loop soon (called by routes after enqueue). No-op when stopped. */
  notify(): void;
  /** Propagate a run cancellation to queued and in-flight work. */
  cancelRun(runId: string): Promise<void>;
}

let daemonsCreated = 0;

/** Diagnostics for singleton tests: daemons created via this module instance. */
export function executionDaemonsCreated(): number {
  return daemonsCreated;
}

export function createExecutionDaemon(options: ExecutionDaemonOptions): ExecutionDaemon {
  daemonsCreated += 1;
  const store = options.store;
  const executor = options.executor ?? deferredTicketExecutor;
  const config: ExecutionRuntimeConfig = { ...DEFAULT_EXECUTION_QUEUE_CONFIG, ...options.config };
  const clock = options.clock ?? Date.now;
  const idGenerator =
    options.idGenerator ?? (() => `lease-${Math.random().toString(36).slice(2)}`);
  const ownerId =
    options.ownerId ?? `daemon-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const timers = options.timers ?? defaultTimers;

  let running = false;
  let intervalHandle: unknown = null;
  let stopping = false;
  // Serialize passes: reconcile/drain must never overlap (E2).
  let chain: Promise<unknown> = Promise.resolve();
  const inFlight = new Map<string, AbortController>();

  function enqueuePass<T>(task: () => Promise<T>): Promise<T> {
    const result = chain.then(task, task);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function reconcileJob(
    job: QueueJobView,
    counters: { abandoned: number },
  ): Promise<void> {
    if (job.status !== 'leased' || inFlight.has(job.jobId)) {
      return;
    }
    const expiresAt = job.leaseExpiresAt ?? 0;
    if (expiresAt > clock()) {
      // An unexpired foreign lease may belong to a live owner — wait it out.
      return;
    }
    const result = await abandonLease(
      store,
      job,
      `Queue lease ${job.leaseId ?? 'unknown'} (owner ${job.ownerId ?? 'unknown'}) expired without release; the owning process likely crashed or restarted mid-execution.`,
    );
    if (!result.deduplicated) {
      counters.abandoned += 1;
    }
    await raiseIntervention(store, {
      runId: job.runId,
      interventionId: `${job.jobId}:abandoned:${job.attempt}`,
      kind: 'retry_choice',
      blockingStage: 'execution',
      severity: 'warn',
      reason: `Execution attempt ${job.attempt} was abandoned mid-flight (stale queue lease after a crash or restart). The work may be partially applied.`,
      requiredAction:
        'Inspect the run, then retry execution (POST /api/runs/:id/retry) or cancel the run. Retrying resolves this entry.',
      ticketId: job.ticketId,
    });
  }

  async function runIsPausedOrCancelled(runId: string): Promise<'paused' | 'cancelled' | null> {
    const run = projectRun(await store.readRun(runId), runId);
    if (run.status === 'cancelled') {
      return 'cancelled';
    }
    if (run.executionState === 'paused') {
      return 'paused';
    }
    return null;
  }

  async function executeJob(
    job: QueueJobView,
    counters: {
      claimed: number;
      completed: number;
      failed: number;
      blocked: number;
      requeued: number;
    },
  ): Promise<void> {
    const leaseId = idGenerator();
    const claimed = await claimJob(store, job, {
      leaseId,
      ownerId,
      leaseExpiresAt: clock() + config.leaseMs,
    });
    if (claimed.deduplicated) {
      // This attempt was already claimed by a previous incarnation; the
      // reconciler owns its fate (lease expiry -> abandoned). Never run twice.
      return;
    }
    counters.claimed += 1;

    if (job.jobKind === 'run-execution') {
      await store.append({
        runId: job.runId,
        type: 'run.started',
        actor: { kind: 'system', id: ownerId },
        subject: { kind: 'run', id: job.runId },
        severity: 'info',
        idempotencyKey: `${job.runId}:run.started`,
        payload: {},
      });
    }

    const abort = new AbortController();
    inFlight.set(job.jobId, abort);
    const leasedJob: QueueJobView = { ...job, status: 'leased', leaseId, ownerId };
    const ctx: TicketExecutionContext = {
      runId: job.runId,
      jobId: job.jobId,
      jobKind: job.jobKind,
      attempt: job.attempt,
      leaseId,
      ticketId: job.ticketId,
      store,
      signal: abort.signal,
      heartbeat: async () => {
        await heartbeatJob(store, leasedJob, {
          leaseId,
          ownerId,
          leaseExpiresAt: clock() + config.leaseMs,
        });
      },
      shouldContinue: async () => (await runIsPausedOrCancelled(job.runId)) === null,
    };

    let result: TicketExecutionResult;
    try {
      result = await executor(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = abort.signal.aborted
        ? { status: 'yielded', reason: `aborted: ${message}` }
        : { status: 'failed', reason: message };
    } finally {
      inFlight.delete(job.jobId);
    }

    // A cancellation that raced the executor wins over its reported result.
    const state = await runIsPausedOrCancelled(job.runId);
    if (state === 'cancelled') {
      await releaseJob(store, leasedJob, 'cancelled', 'Run was cancelled during execution.');
      return;
    }

    switch (result.status) {
      case 'completed': {
        if (job.jobKind === 'run-execution') {
          await store.append({
            runId: job.runId,
            type: 'execution.completed',
            actor: { kind: 'system', id: ownerId },
            subject: { kind: 'run', id: job.runId },
            severity: 'success',
            idempotencyKey: `${job.jobId}:execution.completed:${job.attempt}`,
            payload: { summary: result.summary },
          });
        }
        await releaseJob(store, leasedJob, 'completed', result.summary);
        counters.completed += 1;
        break;
      }
      case 'failed': {
        const reason = result.reason ?? 'Execution attempt failed.';
        if (job.jobKind === 'run-execution') {
          await store.append({
            runId: job.runId,
            type: 'execution.failed',
            actor: { kind: 'system', id: ownerId },
            subject: { kind: 'run', id: job.runId },
            severity: 'error',
            idempotencyKey: `${job.jobId}:execution.failed:${job.attempt}`,
            payload: { reason },
          });
        }
        await releaseJob(store, leasedJob, 'failed', reason);
        counters.failed += 1;
        break;
      }
      case 'blocked': {
        const reason = result.reason ?? 'Execution is blocked pending an operator action.';
        const requiredAction =
          result.requiredAction ?? 'Resolve the open intervention, then retry execution.';
        if (job.jobKind === 'run-execution') {
          await store.append({
            runId: job.runId,
            type: 'execution.blocked',
            actor: { kind: 'system', id: ownerId },
            subject: { kind: 'run', id: job.runId },
            severity: 'warn',
            idempotencyKey: `${job.jobId}:execution.blocked:${job.attempt}`,
            payload: { reason, requiredAction },
          });
        }
        await raiseIntervention(store, {
          runId: job.runId,
          interventionId: `${job.jobId}:blocked:${job.attempt}`,
          kind: result.interventionKind ?? 'adapter_setup',
          blockingStage:
            result.blockingStage ?? (job.jobKind === 'gate-rerun' ? 'gates' : 'execution'),
          reason,
          requiredAction,
          ticketId: job.ticketId,
        });
        await releaseJob(store, leasedJob, 'blocked', reason);
        counters.blocked += 1;
        break;
      }
      case 'yielded': {
        // Safe stop (pause/shutdown): release + requeue so a later pass or a
        // restarted daemon resumes the SAME work without operator involvement.
        await releaseJob(store, leasedJob, 'requeued', result.reason ?? 'Execution yielded.');
        await enqueueJob(store, {
          runId: job.runId,
          jobId: job.jobId,
          jobKind: job.jobKind,
          attempt: job.attempt + 1,
          reason: result.reason ?? 'Requeued after a safe yield.',
          ticketId: job.ticketId,
        });
        counters.requeued += 1;
        break;
      }
      default: {
        const exhaustive: never = result.status;
        throw new Error(`Unknown executor status: ${String(exhaustive)}`);
      }
    }
  }

  function tick(): Promise<DaemonTickResult> {
    return enqueuePass(async () => {
      const counters = {
        claimed: 0,
        abandoned: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
        requeued: 0,
        cancelled: 0,
      };
      const events = await store.readAll();
      const queue = projectExecutionQueue(events);

      // 1. Reconcile stale leases first so restart recovery is never starved.
      for (const job of queue.jobs) {
        await reconcileJob(job, counters);
      }

      // 2. Drain queued work (sequential: single-instance V1.5 semantics).
      for (const job of queue.jobs) {
        if (job.status !== 'queued' || inFlight.has(job.jobId) || stopping) {
          continue;
        }
        const state = await runIsPausedOrCancelled(job.runId);
        if (state === 'cancelled') {
          await releaseJob(store, job, 'cancelled', 'Run was cancelled before execution.');
          counters.cancelled += 1;
          continue;
        }
        if (state === 'paused') {
          // Pause stops NEW worker starts; the job stays queued for resume.
          continue;
        }
        await executeJob(job, counters);
      }

      return counters;
    });
  }

  async function start(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    stopping = false;
    intervalHandle = timers.setInterval(() => {
      void tick().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[software-factory] execution daemon tick failed: ${message}`);
      });
    }, config.reconcileIntervalMs);
    // Initial pass: resume safe queued work, abandon stale leases (E2/E6).
    await tick();
  }

  async function stop(): Promise<void> {
    // Always abort in-flight work, even when the interval loop never started
    // (e.g. a test-driven tick): graceful shutdown must never strand a lease.
    stopping = true;
    if (intervalHandle !== null) {
      timers.clearInterval(intervalHandle);
      intervalHandle = null;
    }
    for (const controller of inFlight.values()) {
      controller.abort();
    }
    // Wait for the in-flight pass (and its release/requeue writes) to settle.
    await chain;
    running = false;
    stopping = false;
  }

  function notify(): void {
    if (!running || stopping) {
      return;
    }
    void tick().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[software-factory] execution daemon notify-tick failed: ${message}`);
    });
  }

  async function cancelRun(runId: string): Promise<void> {
    // Abort in-flight work for the run; the executor's finally-path releases
    // the job as cancelled because the run projection is now cancelled.
    const events = await store.readAll();
    const queue = projectExecutionQueue(events);
    for (const job of queue.jobs) {
      if (job.runId !== runId) {
        continue;
      }
      const controller = inFlight.get(job.jobId);
      if (controller !== undefined) {
        controller.abort();
        continue;
      }
      if (job.status === 'queued' || job.status === 'abandoned') {
        await releaseJob(store, job, 'cancelled', 'Run was cancelled.');
      }
    }
  }

  return {
    ownerId,
    config,
    get running() {
      return running;
    },
    start,
    stop,
    tick,
    notify,
    cancelRun,
  };
}
