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
import type { EventStore } from '@software-factory/core';
import { createExecutionDaemon } from '../../src/server/execution/daemon';
import type { TicketExecutionResult } from '../../src/server/execution/daemon';
import { claimJob, executionJobId, projectExecutionQueue } from '../../src/server/execution/queue';
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
