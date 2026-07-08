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
import { executionJobId, projectExecutionQueue } from '../../src/server/execution/queue';
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
