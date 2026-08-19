/**
 * Ledger-backed execution queue (full-factory U5, KTD4/E2).
 *
 * Scenario 4 (execution note): restart after an acquired-but-unfinished queue
 * lease either safely resumes the work (queued/unclaimed jobs) or marks the
 * lease abandoned for operator resolution (expired foreign leases) — never
 * double-running the same job.
 *
 * Also covers claim/lease/heartbeat/release projection semantics with
 * BullMQ-style lock/stalled-job behavior but no BullMQ dependency.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore, projectRun } from '@software-factory/core';
import type { AppendableEvent, EventStore } from '@software-factory/core';
import { createExecutionDaemon } from '../../src/server/execution/daemon';
import type { TicketExecutionResult } from '../../src/server/execution/daemon';
import {
  claimJob,
  enqueueJob,
  executionJobId,
  projectExecutionQueue,
  releaseJob,
} from '../../src/server/execution/queue';
import { projectInterventions } from '../../src/server/execution/interventions';

const T0 = 1_700_000_000_000;
const LEASE_MS = 60_000;

function noopTimers() {
  return {
    setInterval: () => null,
    clearInterval: () => undefined,
  };
}

async function seedRun(store: EventStore, runId: string): Promise<void> {
  await store.append({
    runId,
    type: 'run.created',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: 0 },
    severity: 'info',
    payload: { prompt: 'x', mode: 'research-plan-and-start' },
  });
}

async function seedQueuedJob(store: EventStore, runId: string): Promise<string> {
  const jobId = executionJobId(runId);
  await store.append({
    runId,
    type: 'queue.enqueued',
    actor: { kind: 'system', id: 'daemon-a' },
    subject: { kind: 'queue-job', id: jobId },
    severity: 'info',
    payload: { jobId, jobKind: 'run-execution', attempt: 1 },
  });
  return jobId;
}

async function seedClaim(
  store: EventStore,
  runId: string,
  jobId: string,
  leaseExpiresAt: number,
): Promise<void> {
  await store.append({
    runId,
    type: 'queue.claimed',
    actor: { kind: 'system', id: 'daemon-a' },
    subject: { kind: 'queue-job', id: jobId },
    severity: 'info',
    payload: {
      jobId,
      jobKind: 'run-execution',
      attempt: 1,
      leaseId: 'lease-old',
      ownerId: 'daemon-a',
      leaseExpiresAt,
    },
  });
}

describe('abandoned lease recovery (restart after crash)', () => {
  it('marks an expired foreign lease abandoned and escalates to the intervention queue', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-crash');
    const jobId = await seedQueuedJob(store, 'run-crash');
    await seedClaim(store, 'run-crash', jobId, T0 + LEASE_MS);

    let executed = 0;
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-b', // a NEW process incarnation after restart
      clock: () => T0 + 2 * LEASE_MS,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed' });
      },
    });

    const result = await daemon.tick();
    expect(result.abandoned).toBe(1);
    // Ambiguous in-flight work is NOT silently re-run.
    expect(executed).toBe(0);

    const events = await store.readRun('run-crash');
    expect(events.map((e) => e.type)).toContain('queue.lease_abandoned');

    const queue = projectExecutionQueue(events, 'run-crash');
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0].status).toBe('abandoned');

    const interventions = projectInterventions(events);
    expect(interventions.open).toHaveLength(1);
    expect(interventions.open[0].kind).toBe('retry_choice');
    expect(interventions.open[0].runId).toBe('run-crash');
    expect(interventions.open[0].requiredAction.length).toBeGreaterThan(0);

    // The run projects the blocked state from the ledger, not invented UI state.
    expect(projectRun(events, 'run-crash').executionState).toBe('blocked');

    // Reconciling again is idempotent: no duplicate abandon/intervention events.
    await daemon.tick();
    const after = await store.readRun('run-crash');
    expect(after.filter((e) => e.type === 'queue.lease_abandoned')).toHaveLength(1);
    expect(after.filter((e) => e.type === 'intervention.raised')).toHaveLength(1);
  });

  it('waits out an unexpired foreign lease instead of double-running the job', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-live');
    const jobId = await seedQueuedJob(store, 'run-live');
    await seedClaim(store, 'run-live', jobId, T0 + LEASE_MS);

    let executed = 0;
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-b',
      clock: () => T0 + LEASE_MS / 2, // lease still live
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed' });
      },
    });

    const result = await daemon.tick();
    expect(result.abandoned).toBe(0);
    expect(result.claimed).toBe(0);
    expect(executed).toBe(0);

    const events = await store.readRun('run-live');
    expect(events.some((e) => e.type === 'queue.lease_abandoned')).toBe(false);
    expect(projectExecutionQueue(events, 'run-live').jobs[0].status).toBe('leased');
  });

  it('safely resumes queued (never-claimed) work after a restart', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-resume');
    await seedQueuedJob(store, 'run-resume');

    let executed = 0;
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-b',
      clock: () => T0 + 5000,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'resumed after restart' });
      },
    });

    const result = await daemon.tick();
    expect(result.claimed).toBe(1);
    expect(executed).toBe(1);

    const events = await store.readRun('run-resume');
    const seen = events.map((e) => e.type);
    expect(seen).toContain('queue.claimed');
    expect(seen).toContain('run.started');
    expect(seen).toContain('execution.completed');

    const queue = projectExecutionQueue(events, 'run-resume');
    expect(queue.jobs[0].status).toBe('completed');
    expect(projectRun(events, 'run-resume').executionState).toBe('completed');
  });
});

describe('queue lease semantics', () => {
  it('heartbeats extend the lease so a live worker is not treated as stalled', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-hb');
    const jobId = await seedQueuedJob(store, 'run-hb');
    await seedClaim(store, 'run-hb', jobId, T0 + LEASE_MS);
    // The owning daemon heartbeats, extending the lease beyond the original.
    await store.append({
      runId: 'run-hb',
      type: 'queue.heartbeat',
      actor: { kind: 'system', id: 'daemon-a' },
      subject: { kind: 'queue-job', id: jobId },
      severity: 'info',
      payload: {
        jobId,
        jobKind: 'run-execution',
        attempt: 1,
        leaseId: 'lease-old',
        ownerId: 'daemon-a',
        leaseExpiresAt: T0 + 3 * LEASE_MS,
      },
    });

    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-b',
      clock: () => T0 + 2 * LEASE_MS, // past the ORIGINAL lease, inside the extension
      timers: noopTimers(),
    });

    const result = await daemon.tick();
    expect(result.abandoned).toBe(0);

    const events = await store.readRun('run-hb');
    const queue = projectExecutionQueue(events, 'run-hb');
    expect(queue.jobs[0].status).toBe('leased');
    expect(queue.jobs[0].leaseExpiresAt).toBe(T0 + 3 * LEASE_MS);
  });

  it('projects release outcomes onto job status', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-release');
    const jobId = await seedQueuedJob(store, 'run-release');
    await seedClaim(store, 'run-release', jobId, T0 + LEASE_MS);
    await store.append({
      runId: 'run-release',
      type: 'queue.released',
      actor: { kind: 'system', id: 'daemon-a' },
      subject: { kind: 'queue-job', id: jobId },
      severity: 'info',
      payload: { jobId, jobKind: 'run-execution', attempt: 1, outcome: 'failed', reason: 'boom' },
    });

    const events = await store.readRun('run-release');
    const queue = projectExecutionQueue(events, 'run-release');
    expect(queue.jobs[0].status).toBe('failed');
    expect(queue.jobs[0].reason).toBe('boom');
  });
});

/**
 * U11 — database-ready semantics. Lease, heartbeat, and abandon decisions must
 * be functions of LEDGER state only, never of process-local memory, so a
 * Postgres-backed EventStore (unique idempotency-key constraint + atomic
 * appends) can replace JSONL without changing daemon behavior. Documented
 * exception: the daemon's `inFlight` map guards only its OWN live executions;
 * foreign owners rely purely on the ledger (see daemon.ts header).
 */
describe('database-ready semantics (U11)', () => {
  it('arbitrates claims at the STORE level: the losing claim is deduplicated', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-arb');
    await seedQueuedJob(store, 'run-arb');
    const job = projectExecutionQueue(await store.readAll(), 'run-arb').jobs[0];

    // Two owners race to claim the same (jobId, attempt) — e.g. two daemons
    // that both projected the job as `queued` before either append landed.
    const first = await claimJob(store, job, {
      leaseId: 'lease-a',
      ownerId: 'daemon-a',
      leaseExpiresAt: T0 + LEASE_MS,
    });
    const second = await claimJob(store, job, {
      leaseId: 'lease-b',
      ownerId: 'daemon-b',
      leaseExpiresAt: T0 + LEASE_MS,
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    // The loser learns the ORIGINAL claim: arbitration truth is the store's
    // idempotency guarantee, not either process's memory.
    expect(second.event).toEqual(first.event);

    const view = projectExecutionQueue(await store.readAll(), 'run-arb').jobs[0];
    expect(view.status).toBe('leased');
    expect(view.ownerId).toBe('daemon-a');
    expect(view.leaseId).toBe('lease-a');
  });

  it('two daemon owners racing over the same ledger execute a job exactly once', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-two-owners');
    await seedQueuedJob(store, 'run-two-owners');

    let aRuns = 0;
    let bRuns = 0;
    const daemonA = createExecutionDaemon({
      store,
      ownerId: 'daemon-a',
      clock: () => T0,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        aRuns += 1;
        return Promise.resolve({ status: 'completed', summary: 'built by a' });
      },
    });
    const daemonB = createExecutionDaemon({
      store,
      ownerId: 'daemon-b',
      clock: () => T0,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        bRuns += 1;
        return Promise.resolve({ status: 'completed', summary: 'built by b' });
      },
    });

    // Concurrent passes: whichever interleaving occurs, the store-level claim
    // dedup (or the already-folded lease/release) must keep the loser out.
    await Promise.all([daemonA.tick(), daemonB.tick()]);

    expect(aRuns + bRuns).toBe(1);
    const events = await store.readRun('run-two-owners');
    expect(events.filter((e) => e.type === 'queue.claimed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'execution.completed')).toHaveLength(1);
    expect(projectExecutionQueue(events, 'run-two-owners').jobs[0].status).toBe('completed');
  });

  it('a daemon with fresh process memory makes identical decisions from the ledger alone', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-fresh');
    const jobId = await seedQueuedJob(store, 'run-fresh');
    await seedClaim(store, 'run-fresh', jobId, T0 + LEASE_MS);

    // Owner C never saw the claim happen — it has empty process memory. Its
    // reconcile/drain decisions must match daemon-a's own view exactly:
    // unexpired lease => wait; expired lease => abandon. No memory involved.
    const freshWaiter = createExecutionDaemon({
      store,
      ownerId: 'daemon-c',
      clock: () => T0 + LEASE_MS / 2,
      timers: noopTimers(),
    });
    const waited = await freshWaiter.tick();
    expect(waited.abandoned).toBe(0);
    expect(waited.claimed).toBe(0);

    const freshReconciler = createExecutionDaemon({
      store,
      ownerId: 'daemon-d',
      clock: () => T0 + 2 * LEASE_MS,
      timers: noopTimers(),
    });
    const reconciled = await freshReconciler.tick();
    expect(reconciled.abandoned).toBe(1);
    const events = await store.readRun('run-fresh');
    expect(projectExecutionQueue(events, 'run-fresh').jobs[0].status).toBe('abandoned');
  });
});

/* ----------------------------------------------------------------------------
 * Fault tolerance: yield-crash recovery, append failures, cancel/claim races,
 * and shutdown re-entrancy (review-fix batch).
 * ------------------------------------------------------------------------- */

/** Wrap a store so ONE matching append fails (crash/disk-fault injection). */
function failingOnceStore(
  store: EventStore,
  shouldFail: (event: AppendableEvent) => boolean,
): EventStore {
  let failed = false;
  return {
    append(event) {
      if (!failed && shouldFail(event)) {
        failed = true;
        return Promise.reject(new Error('injected append failure'));
      }
      return store.append(event);
    },
    readRun: (runId) => store.readRun(runId),
    readAll: () => store.readAll(),
    listRuns: () => store.listRuns(),
    deleteRuns: (runIds) => store.deleteRuns(runIds),
  };
}

describe('yield-crash recovery (requeue must never wedge)', () => {
  it('recovers a legacy ledger that ends at released(requeued) without the follow-up enqueued', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-wedge');
    // The exact appends a pre-fix daemon wrote before crashing: enqueue,
    // claim (burning the attempt-1 claim key), release(requeued) — and then
    // the crash, BEFORE the follow-up enqueued(attempt 2).
    await enqueueJob(store, {
      runId: 'run-wedge',
      jobId: executionJobId('run-wedge'),
      jobKind: 'run-execution',
      attempt: 1,
    });
    const queued = projectExecutionQueue(await store.readAll(), 'run-wedge').jobs[0];
    await claimJob(store, queued, {
      leaseId: 'lease-old',
      ownerId: 'daemon-old',
      leaseExpiresAt: T0 + LEASE_MS,
    });
    const leased = projectExecutionQueue(await store.readAll(), 'run-wedge').jobs[0];
    await releaseJob(store, leased, 'requeued', 'safe yield before crash');

    // The job projects `queued` at attempt 1 — whose claim key is burnt.
    expect(projectExecutionQueue(await store.readAll(), 'run-wedge').jobs[0]).toMatchObject({
      status: 'queued',
      attempt: 1,
    });

    let executed = 0;
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-fresh',
      clock: () => T0 + 1000,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'recovered' });
      },
    });

    // Pass 1 detects the burnt claim + queued projection and re-enqueues the
    // next attempt idempotently instead of silently returning.
    const first = await daemon.tick();
    expect(first.requeued).toBe(1);
    expect(executed).toBe(0);
    expect(projectExecutionQueue(await store.readAll(), 'run-wedge').jobs[0]).toMatchObject({
      status: 'queued',
      attempt: 2,
    });

    // Pass 2 claims the fresh attempt and runs it: the job is NOT wedged.
    const second = await daemon.tick();
    expect(second.claimed).toBe(1);
    expect(executed).toBe(1);
    expect(projectExecutionQueue(await store.readAll(), 'run-wedge').jobs[0].status).toBe(
      'completed',
    );
  });

  it('a crash between the yield appends leaves a ledger a fresh daemon recovers (fault injection)', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-yield-crash');
    await seedQueuedJob(store, 'run-yield-crash');

    // The wrapped store dies exactly on the released(requeued) append — with
    // the fixed ordering that is the SECOND yield write, after the
    // next-attempt enqueued already landed.
    const crashing = failingOnceStore(
      store,
      (event) =>
        event.type === 'queue.released' &&
        (event.payload as { outcome?: string }).outcome === 'requeued',
    );
    const daemonA = createExecutionDaemon({
      store: crashing,
      ownerId: 'daemon-a',
      clock: () => T0,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> =>
        Promise.resolve({ status: 'yielded', reason: 'graceful shutdown' }),
    });
    await expect(daemonA.tick()).rejects.toThrow(/injected append failure/);

    // The next attempt is already enqueued, so the job is queued at attempt 2.
    const afterCrash = projectExecutionQueue(await store.readAll(), 'run-yield-crash').jobs[0];
    expect(afterCrash.status).toBe('queued');
    expect(afterCrash.attempt).toBe(2);

    let executed = 0;
    const daemonB = createExecutionDaemon({
      store,
      ownerId: 'daemon-b',
      clock: () => T0 + 1000,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed', summary: 'resumed after crash' });
      },
    });
    const tick = await daemonB.tick();
    expect(tick.claimed).toBe(1);
    expect(executed).toBe(1);

    const events = await store.readRun('run-yield-crash');
    expect(events.some((e) => e.type === 'queue.lease_abandoned')).toBe(false);
    const final = projectExecutionQueue(events, 'run-yield-crash').jobs[0];
    expect(final.status).toBe('completed');
    expect(final.attempt).toBe(2);
  });
});

describe('append failure after a claim (clean lease release)', () => {
  it('releases the lease cleanly when a ledger write fails mid-attempt', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-disk-fault');
    await seedQueuedJob(store, 'run-disk-fault');

    let executed = 0;
    const crashing = failingOnceStore(store, (event) => event.type === 'run.started');
    const daemon = createExecutionDaemon({
      store: crashing,
      ownerId: 'daemon-a',
      clock: () => T0,
      timers: noopTimers(),
      executor: (): Promise<TicketExecutionResult> => {
        executed += 1;
        return Promise.resolve({ status: 'completed' });
      },
    });

    await expect(daemon.tick()).rejects.toThrow(/injected append failure/);
    expect(executed).toBe(0);

    // No phantom lease: the claim was released as failed instead of sitting
    // leased until expiry (which would later raise a spurious abandonment).
    const events = await store.readRun('run-disk-fault');
    const job = projectExecutionQueue(events, 'run-disk-fault').jobs[0];
    expect(job.status).toBe('failed');
    expect(job.leaseId).toBeUndefined();
    expect(events.some((e) => e.type === 'queue.lease_abandoned')).toBe(false);

    // A follow-up pass abandons nothing and raises no intervention.
    const tick = await daemon.tick();
    expect(tick.abandoned).toBe(0);
    expect(projectInterventions(await store.readRun('run-disk-fault')).open).toHaveLength(0);
  });
});

describe('cancelRun racing a drain-tick claim', () => {
  it('a post-claim cancelled release lands even after a lease-less cancelled release (fold)', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-race');
    await seedQueuedJob(store, 'run-race');
    const queuedView = projectExecutionQueue(await store.readAll(), 'run-race').jobs[0];

    // Interleaving under the OLD key scheme: cancelRun released the QUEUED
    // (lease-less) job as cancelled, then the racing tick's claim landed —
    // leaving the job leased with the (jobId, attempt, cancelled) idempotency
    // scope burnt, so the executor's own cancelled release deduplicated away
    // and the job stayed leased forever.
    await releaseJob(store, queuedView, 'cancelled', 'Run was cancelled.');
    await claimJob(store, queuedView, {
      leaseId: 'lease-tick',
      ownerId: 'daemon-a',
      leaseExpiresAt: T0 + LEASE_MS,
    });
    expect(projectExecutionQueue(await store.readAll(), 'run-race').jobs[0].status).toBe('leased');

    // The post-claim release is scoped by leaseId, so it is NOT deduplicated.
    const leasedView = projectExecutionQueue(await store.readAll(), 'run-race').jobs[0];
    const release = await releaseJob(store, leasedView, 'cancelled', 'cancelled during execution');
    expect(release.deduplicated).toBe(false);
    expect(projectExecutionQueue(await store.readAll(), 'run-race').jobs[0].status).toBe(
      'cancelled',
    );
  });

  it('cancelRun during an in-flight claim converges to cancelled without abandonment', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-cancel-live');
    await seedQueuedJob(store, 'run-cancel-live');

    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-a',
      clock: () => T0,
      timers: noopTimers(),
      executor: (ctx): Promise<TicketExecutionResult> =>
        new Promise((resolve) => {
          startedResolve?.();
          ctx.signal.addEventListener('abort', () =>
            resolve({ status: 'yielded', reason: 'aborted by cancel' }),
          );
        }),
    });

    const tickPromise = daemon.tick(); // claims and blocks inside the executor
    await started;
    // The cancel route appends run.cancelled BEFORE propagating to the daemon.
    await store.append({
      runId: 'run-cancel-live',
      type: 'run.cancelled',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-cancel-live' },
      severity: 'warn',
      payload: { reason: 'operator stop' },
    });
    await daemon.cancelRun('run-cancel-live');
    await tickPromise;

    const events = await store.readRun('run-cancel-live');
    const job = projectExecutionQueue(events, 'run-cancel-live').jobs[0];
    expect(job.status).toBe('cancelled');

    // A later pass (same or fresh owner) abandons nothing and raises nothing.
    const later = createExecutionDaemon({
      store,
      ownerId: 'daemon-later',
      clock: () => T0 + 10 * LEASE_MS,
      timers: noopTimers(),
    });
    const tick = await later.tick();
    expect(tick.abandoned).toBe(0);
    expect(tick.claimed).toBe(0);
    const after = await store.readRun('run-cancel-live');
    expect(after.some((e) => e.type === 'queue.lease_abandoned')).toBe(false);
    expect(projectInterventions(after).open).toHaveLength(0);
  });
});

describe('shutdown re-entrancy and interval tick stacking', () => {
  it('double stop() joins the in-flight shutdown and resolves once cleanly', async () => {
    const store = createInMemoryEventStore();
    await seedRun(store, 'run-double-stop');
    await seedQueuedJob(store, 'run-double-stop');

    let aborts = 0;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-a',
      clock: () => T0,
      timers: noopTimers(),
      executor: (ctx): Promise<TicketExecutionResult> =>
        new Promise((resolve) => {
          startedResolve?.();
          ctx.signal.addEventListener('abort', () => {
            aborts += 1;
            resolve({ status: 'yielded', reason: 'shutdown' });
          });
        }),
    });

    const tickPromise = daemon.tick();
    await started;
    const first = daemon.stop();
    const second = daemon.stop();
    // Re-entry returns the SAME in-flight promise instead of re-stopping.
    expect(second).toBe(first);
    await first;
    await second;
    await tickPromise;
    expect(daemon.running).toBe(false);
    expect(aborts).toBe(1);
  });

  it('interval ticks are skipped while one is already pending (skip-not-stack)', async () => {
    const raw = createInMemoryEventStore();
    await seedRun(raw, 'run-interval');
    await seedQueuedJob(raw, 'run-interval');
    let readAllCalls = 0;
    const store: EventStore = {
      append: (event) => raw.append(event),
      readRun: (runId) => raw.readRun(runId),
      readAll: () => {
        readAllCalls += 1;
        return raw.readAll();
      },
      listRuns: () => raw.listRuns(),
      deleteRuns: (runIds) => raw.deleteRuns(runIds),
    };

    let intervalCallback: (() => void) | undefined;
    let releaseExecutor: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    let executorStarted: (() => void) | undefined;
    const executorRunning = new Promise<void>((resolve) => {
      executorStarted = resolve;
    });
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-a',
      clock: () => T0,
      timers: {
        setInterval: (callback: () => void) => {
          intervalCallback = callback;
          return 1;
        },
        clearInterval: () => undefined,
      },
      executor: async (): Promise<TicketExecutionResult> => {
        executorStarted?.();
        await released;
        return { status: 'completed', summary: 'released' };
      },
    });

    const startPromise = daemon.start(); // initial pass blocks in the executor
    await executorRunning;
    expect(readAllCalls).toBe(1);

    // Two interval fires while the pass is still running: the first enqueues
    // ONE follow-up pass, the second is skipped instead of stacking a third.
    intervalCallback?.();
    intervalCallback?.();

    releaseExecutor?.();
    await startPromise;
    await daemon.stop(); // waits for the queued follow-up pass to settle
    expect(readAllCalls).toBe(2);
  });
});
