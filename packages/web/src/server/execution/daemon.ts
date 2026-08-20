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
 * DRAIN GATE (operator autostart control): when `config.autoStart` is false
 * the daemon boots HELD — reconcile bookkeeping still runs every pass (stale
 * leases are abandoned and escalated, cancelled runs' queued jobs are
 * released), but NO queued work is claimed or executed until an operator
 * calls `resume()`. `hold()` re-engages the gate; like a run pause it stops
 * NEW claims and leaves in-flight work to finish. Server runtimes resolve
 * `autoStart` to false by default (see `resolveExecutionRuntimeConfig`), so
 * opening the factory never runs leftover queued work automatically — the
 * operator resumes explicitly. The gate is deliberately process-local state
 * (like `inFlight`): every fresh process starts held again by design.
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
import type { EventStore, InterventionKind, RunProjection } from '@software-factory/core';
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
  /**
   * Whether the drain gate is engaged: while true, passes reconcile but never
   * claim/execute queued work. Daemons created with `autoStart: false` boot
   * held; `resume()` releases the gate for the life of the process.
   */
  readonly held: boolean;
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
  /**
   * Release the drain gate and wake the loop so waiting queued work starts
   * soon (asynchronously — never in the caller's request lifetime, E1).
   * Idempotent; the operator's explicit "resume the factory" command.
   */
  resume(): void;
  /**
   * Re-engage the drain gate: stop claiming NEW queued work. Like a run pause,
   * in-flight work is left to finish (or yield) safely — never aborted. Also
   * revokes every per-run `allowRunWhileHeld` grant: an explicit hold means
   * "stop everything", including runs the operator started earlier.
   */
  hold(): void;
  /**
   * Let ONE run drain even while the gate is held. The gate exists to stop
   * UNATTENDED drain of leftover queued work after a boot/deploy — not to
   * demand a second confirmation of a start the operator just issued. Routes
   * call this on every explicit start/retry command so that run executes
   * immediately; work queued before this process booted stays held. Process-
   * local like the gate itself: a restart clears all grants by design.
   */
  allowRunWhileHeld(runId: string): void;
  /** Propagate a run cancellation to queued and in-flight work. */
  cancelRun(runId: string): Promise<void>;
  /**
   * Propagate MANY run cancellations at once (the cancel-all command). Two
   * phases: every matching in-flight AbortController is aborted FIRST (before
   * any chained pass), then ONE chained release pass covers all runs — so a
   * batch cancel never blocks behind, or keeps executing, work for runs later
   * in the batch. `cancelRun` is the single-run special case.
   */
  cancelRuns(runIds: readonly string[]): Promise<void>;
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
  const config: ExecutionRuntimeConfig = { ...DEFAULT_EXECUTION_RUNTIME_CONFIG, ...options.config };
  const clock = options.clock ?? Date.now;
  const idGenerator = options.idGenerator ?? (() => `lease-${Math.random().toString(36).slice(2)}`);
  const ownerId =
    options.ownerId ?? `daemon-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const timers = options.timers ?? defaultTimers;

  let running = false;
  let intervalHandle: unknown = null;
  let stopping = false;
  // Drain gate: held daemons reconcile but never claim queued work. Process-
  // local BY DESIGN (like inFlight): every fresh process starts held again
  // unless configured to auto-start, so opening the factory runs nothing.
  let held = !config.autoStart;
  // Per-run bypass of the gate for runs the operator EXPLICITLY started or
  // retried in this process's lifetime (see allowRunWhileHeld). Process-local
  // like `held`: a restart forgets every grant, so leftover work stays held.
  const allowedWhileHeld = new Set<string>();
  // Re-entrant stop guard: a second stop() joins the in-flight shutdown.
  let stopPromise: Promise<void> | null = null;
  // Skip-not-stack: interval ticks are skipped while one is still pending.
  let tickPending = false;
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

  async function reconcileJob(job: QueueJobView, counters: { abandoned: number }): Promise<void> {
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
      // Owner-comprehensible copy (U5): a non-admin run owner sees this in
      // THEIR queue — say what happened in plain terms, not lease mechanics.
      reason:
        `The server restarted (or crashed) while execution attempt ${job.attempt} of this run ` +
        'was in flight, so the attempt stopped early. Some of its work may already be applied.',
      requiredAction:
        'Review the run, then press Retry to continue from where it stopped ' +
        '(POST /api/runs/:id/retry) — or cancel the run. Retrying resolves this entry.',
      ticketId: job.ticketId,
    });
  }

  function pausedOrCancelledOf(run: RunProjection): 'paused' | 'cancelled' | null {
    if (run.status === 'cancelled') {
      return 'cancelled';
    }
    if (run.executionState === 'paused') {
      return 'paused';
    }
    return null;
  }

  async function runIsPausedOrCancelled(runId: string): Promise<'paused' | 'cancelled' | null> {
    return pausedOrCancelledOf(projectRun(await store.readRun(runId), runId));
  }

  async function executeJob(
    job: QueueJobView,
    counters: {
      claimed: number;
      completed: number;
      failed: number;
      blocked: number;
      requeued: number;
      cancelled: number;
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
      // EXCEPT the wedge case: a crash after `queue.released(requeued)` landed
      // but before the follow-up `queue.enqueued(attempt+1)` leaves the job
      // projected `queued` at an attempt whose claim key is already burnt —
      // no future claim can ever win, so the job would silently wedge forever.
      // The prior release was a SAFE yield, so re-enqueueing the next attempt
      // idempotently recovers the job without re-running ambiguous work.
      const current = projectExecutionQueue(await store.readRun(job.runId), job.runId).byJobId[
        job.jobId
      ];
      if (current !== undefined && current.status === 'queued' && current.attempt === job.attempt) {
        await enqueueJob(store, {
          runId: job.runId,
          jobId: job.jobId,
          jobKind: job.jobKind,
          attempt: job.attempt + 1,
          reason: 'Recovered a safely-yielded job whose follow-up re-enqueue was lost to a crash.',
          ticketId: job.ticketId,
        });
        counters.requeued += 1;
      }
      return;
    }
    counters.claimed += 1;
    const leasedJob: QueueJobView = { ...job, status: 'leased', leaseId, ownerId };

    // Fresh post-claim cancellation gate (invariant 7): the drain loop's
    // pre-claim check reads the pass SNAPSHOT, so a cancellation that landed
    // between snapshot and claim would otherwise start an executor that can
    // only be stopped by an abort nobody will send (a cancel command's abort
    // phase ran before this in-flight entry existed). Release immediately and
    // never start the work. Pause keeps its executor-mediated path
    // (`shouldContinue`) — only a cancelled run short-circuits here.
    if ((await runIsPausedOrCancelled(job.runId)) === 'cancelled') {
      await releaseJob(store, leasedJob, 'cancelled', 'Run was cancelled before execution.');
      counters.cancelled += 1;
      return;
    }

    try {
      await runClaimedJob(job, leasedJob, leaseId, counters);
    } catch (error) {
      // A ledger append failed mid-attempt (e.g. EBUSY/ENOSPC): release the
      // lease cleanly so the job never sits leased until expiry (a phantom
      // lease that would later be abandoned with a spurious intervention),
      // then rethrow so the pass surfaces the failure.
      inFlight.delete(job.jobId);
      const message = error instanceof Error ? error.message : String(error);
      try {
        await releaseJob(
          store,
          leasedJob,
          'failed',
          `A ledger write failed during the attempt: ${message}`,
        );
      } catch {
        // The store is still failing; the reconciler recovers via lease expiry.
      }
      throw error;
    }
  }

  async function runClaimedJob(
    job: QueueJobView,
    leasedJob: QueueJobView,
    leaseId: string,
    counters: {
      claimed: number;
      completed: number;
      failed: number;
      blocked: number;
      requeued: number;
    },
  ): Promise<void> {
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
        // Safe stop (pause/shutdown): requeue + release so a later pass or a
        // restarted daemon resumes the SAME work without operator involvement.
        // ORDER MATTERS: the next-attempt `queue.enqueued` lands FIRST. The
        // queue fold ignores a `queue.released` whose payload.attempt no
        // longer matches the job's (bumped) attempt, so a crash between the
        // two appends leaves the job queued at attempt+1 (recoverable by any
        // fresh daemon) instead of queued at an attempt whose claim key is
        // already burnt (permanently wedged).
        await enqueueJob(store, {
          runId: job.runId,
          jobId: job.jobId,
          jobKind: job.jobKind,
          attempt: job.attempt + 1,
          reason: result.reason ?? 'Requeued after a safe yield.',
          ticketId: job.ticketId,
        });
        await releaseJob(store, leasedJob, 'requeued', result.reason ?? 'Execution yielded.');
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

      // Pause/cancel gating for the drain loop is computed ONCE per run from
      // the SAME snapshot the queue was projected from (perf: no readRun per
      // queued job). Post-claim decisions (`shouldContinue`, the post-executor
      // cancellation check) still re-read the ledger for freshness.
      const runStates = new Map<string, 'paused' | 'cancelled' | null>();
      const snapshotRunState = (runId: string): 'paused' | 'cancelled' | null => {
        let state = runStates.get(runId);
        if (state === undefined) {
          state = pausedOrCancelledOf(projectRun(events, runId));
          runStates.set(runId, state);
        }
        return state;
      };

      // 1. Reconcile stale leases first so restart recovery is never starved.
      for (const job of queue.jobs) {
        await reconcileJob(job, counters);
      }

      // 2. Drain queued work (sequential: single-instance V1.5 semantics).
      for (const job of queue.jobs) {
        if (job.status !== 'queued' || inFlight.has(job.jobId) || stopping) {
          continue;
        }
        const state = snapshotRunState(job.runId);
        if (state === 'cancelled') {
          await releaseJob(store, job, 'cancelled', 'Run was cancelled before execution.');
          counters.cancelled += 1;
          continue;
        }
        if (state === 'paused' || (held && !allowedWhileHeld.has(job.runId))) {
          // A run pause and the factory drain gate both stop NEW worker
          // starts; the job stays queued for the matching resume. Cancelled
          // cleanup above still runs while held — it releases work, never
          // starts any. Runs the operator explicitly started in THIS process
          // (allowRunWhileHeld) bypass the gate: the gate guards against
          // unattended boot-time drain, not against attended start commands.
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
    tickPending = false;
    intervalHandle = timers.setInterval(() => {
      // Skip-not-stack: while a previous interval tick is still pending, do
      // not enqueue another pass behind it (a slow pass would otherwise stack
      // an unbounded backlog of redundant passes).
      if (tickPending) {
        return;
      }
      tickPending = true;
      void tick()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[software-factory] execution daemon tick failed: ${message}`);
        })
        .finally(() => {
          tickPending = false;
        });
    }, config.reconcileIntervalMs);
    // Initial pass: resume safe queued work, abandon stale leases (E2/E6).
    await tick();
  }

  function stop(): Promise<void> {
    // Re-entrant guard: a second stop() during shutdown (double SIGTERM/SIGINT,
    // double close()) joins the in-flight stop instead of re-running it.
    if (stopPromise !== null) {
      return stopPromise;
    }
    stopPromise = (async () => {
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
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
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

  function resume(): void {
    if (!held) {
      return;
    }
    held = false;
    // Drain soon, NEVER in the caller's request lifetime (E1): notify() runs
    // the pass asynchronously with errors logged, so waiting queued work
    // starts on the operator's resume without blocking the resume command.
    notify();
  }

  function hold(): void {
    held = true;
    // An explicit hold stops EVERYTHING: revoke earlier per-run grants so a
    // previously-started run cannot re-claim new work behind the operator.
    allowedWhileHeld.clear();
  }

  function allowRunWhileHeld(runId: string): void {
    allowedWhileHeld.add(runId);
  }

  async function cancelRuns(runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) {
      return;
    }
    const targets = new Set(runIds);
    // Phase 1 — abort THIS owner's in-flight work for EVERY targeted run
    // immediately; the executor's post-run path releases each job as
    // cancelled because the run projection is now cancelled. The aborts must
    // NOT wait behind the pass chain: an in-flight executor is awaited by the
    // current pass, so a chained abort would deadlock behind the very work it
    // cancels — and a batch cancel that aborted one run per chained pass
    // would keep executing work for runs later in the batch meanwhile.
    const snapshot = projectExecutionQueue(await store.readAll());
    for (const job of snapshot.jobs) {
      if (targets.has(job.runId)) {
        inFlight.get(job.jobId)?.abort();
      }
    }
    // Phase 2 — release queued/abandoned jobs for ALL targeted runs INSIDE
    // one pass-chain slot, re-projecting the queue there, so the cancelled
    // release can never interleave with a drain pass's claim of the same
    // attempt (a pre-claim `released(cancelled)` would burn the outcome's
    // idempotency scope and leave the claimed job leased forever, later
    // abandoned with a spurious retry intervention).
    await enqueuePass(async () => {
      const queue = projectExecutionQueue(await store.readAll());
      for (const job of queue.jobs) {
        if (!targets.has(job.runId) || inFlight.has(job.jobId)) {
          continue;
        }
        if (job.status === 'queued' || job.status === 'abandoned') {
          await releaseJob(store, job, 'cancelled', 'Run was cancelled.');
        }
      }
    });
  }

  function cancelRun(runId: string): Promise<void> {
    return cancelRuns([runId]);
  }

  return {
    ownerId,
    config,
    get running() {
      return running;
    },
    get held() {
      return held;
    },
    start,
    stop,
    tick,
    notify,
    resume,
    hold,
    allowRunWhileHeld,
    cancelRun,
    cancelRuns,
  };
}
