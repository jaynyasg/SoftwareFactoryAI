/**
 * Execution daemon lifecycle (full-factory U5, hardening E1).
 *
 * Scenario 3 (execution note): the Next-mounted singleton (instance.ts) and the
 * standalone API server (standalone.ts) each bootstrap exactly ONE daemon owner
 * per process — never one per request or per module graph/import.
 *
 * Also covers the daemon lifecycle contract: idempotent start, graceful stop,
 * and the U6 executor seam (injectable TicketExecutor).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryEventStore } from '@software-factory/core';
import type { EventStore } from '@software-factory/core';

const globalRef = globalThis as typeof globalThis & { __softwareFactory__?: unknown };

function noopTimers() {
  return {
    setInterval: () => null,
    clearInterval: () => undefined,
  };
}

async function seedPlannedStartableRun(store: EventStore, runId: string): Promise<void> {
  await store.append({
    runId,
    type: 'run.created',
    actor: { kind: 'operator', id: 'operator' },
    subject: { kind: 'run', id: runId, version: 0 },
    severity: 'info',
    payload: { prompt: 'x', mode: 'research-plan-and-start' },
  });
  await store.append({
    runId,
    type: 'queue.enqueued',
    actor: { kind: 'system', id: 'test' },
    subject: { kind: 'queue-job', id: `${runId}:execution` },
    severity: 'info',
    payload: { jobId: `${runId}:execution`, jobKind: 'run-execution', attempt: 1 },
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('daemon singleton — Next-mounted instance (instance.ts)', () => {
  it('creates and starts exactly one daemon per process across module graphs and requests', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'sf-daemon-inst-'));
    vi.stubEnv('SF_FACTORY_DIR', tmp);
    delete globalRef.__softwareFactory__;
    try {
      const first = await import('../../src/server/instance');
      const daemon = first.getExecutionDaemon();
      expect(daemon.running).toBe(true);

      // Repeated singleton access and repeated requests reuse the same owner.
      const app = first.getApp();
      await app.handle({ method: 'GET', path: '/api/runs', query: {}, headers: {} });
      await app.handle({ method: 'GET', path: '/api/runs', query: {}, headers: {} });
      expect(first.getExecutionDaemon()).toBe(daemon);

      // A separate module graph (Next dev loads server components and route
      // handlers in different graphs) must NOT create a second daemon: the
      // fresh daemon module has created none, and the instance module returns
      // the process-wide daemon from globalThis.
      vi.resetModules();
      const second = await import('../../src/server/instance');
      const freshDaemonModule = await import('../../src/server/execution/daemon');
      const again = second.getExecutionDaemon();
      expect(again).toBe(daemon);
      expect(again.ownerId).toBe(daemon.ownerId);
      expect(freshDaemonModule.executionDaemonsCreated()).toBe(0);

      await daemon.stop();
      expect(daemon.running).toBe(false);
    } finally {
      delete globalRef.__softwareFactory__;
      await rm(tmp, { recursive: true, force: true });
    }
    // Generous timeout: this test boots the real instance graph (store, app,
    // daemon) and takes ~3s alone. Under full-suite parallel load the 5s
    // default can abandon it mid-boot, and its late continuation then leaks a
    // daemon into the NEXT test's freshly-reset module counter — a cascade
    // that reads as "expected 2 to be 1" there.
  }, 30_000);
});

describe('daemon singleton — standalone API server (standalone.ts)', () => {
  it('starts one daemon per server process and requests never create more', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'sf-daemon-standalone-'));
    const daemonModule = await import('../../src/server/execution/daemon');
    const { startStandaloneServer } = await import('../../src/server/standalone');
    const before = daemonModule.executionDaemonsCreated();

    const started = await startStandaloneServer({ port: 0, factoryDir: tmp });
    try {
      expect(daemonModule.executionDaemonsCreated()).toBe(before + 1);
      expect(started.daemon.running).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${started.server.url}/api/runs`);
        expect(res.status).toBe(200);
      }
      // Serving requests created no additional daemons.
      expect(daemonModule.executionDaemonsCreated()).toBe(before + 1);
    } finally {
      await started.close();
      await rm(tmp, { recursive: true, force: true });
    }
    expect(started.daemon.running).toBe(false);
    // Same load headroom as the instance-singleton test above: a real
    // listen(0) server boot must never be abandoned mid-flight by the 5s
    // default when the suite saturates the machine.
  }, 30_000);
});

describe('daemon lifecycle + U6 executor seam', () => {
  it('start() is idempotent and stop() is graceful', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const store = createInMemoryEventStore();
    const daemon = createExecutionDaemon({ store, timers: noopTimers() });

    await daemon.start();
    await daemon.start();
    expect(daemon.running).toBe(true);
    await daemon.stop();
    await daemon.stop();
    expect(daemon.running).toBe(false);
  });

  it('claims queued work on tick and runs it through the injected executor', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-exec');

    const executedJobs: string[] = [];
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-a',
      timers: noopTimers(),
      executor: (ctx) => {
        executedJobs.push(ctx.jobId);
        return Promise.resolve({ status: 'completed', summary: 'fake build done' });
      },
    });

    const result = await daemon.tick();
    expect(result.claimed).toBe(1);
    expect(executedJobs).toEqual(['run-exec:execution']);

    const seen = (await store.readRun('run-exec')).map((e) => e.type);
    expect(seen).toContain('queue.claimed');
    expect(seen).toContain('run.started');
    expect(seen).toContain('execution.completed');
    expect(seen).toContain('queue.released');

    // A second tick re-runs nothing: the job is released.
    await daemon.tick();
    expect(executedJobs).toHaveLength(1);
  });

  it('graceful stop mid-execution yields, requeues, and a fresh daemon resumes the work', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectExecutionQueue } = await import('../../src/server/execution/queue');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-shutdown');

    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const daemonA = createExecutionDaemon({
      store,
      ownerId: 'daemon-a',
      timers: noopTimers(),
      executor: (ctx) =>
        new Promise((resolve) => {
          startedResolve?.();
          ctx.signal.addEventListener('abort', () =>
            resolve({ status: 'yielded', reason: 'shutdown requested' }),
          );
        }),
    });

    const tickPromise = daemonA.tick(); // claims and blocks in the executor
    await started;
    await daemonA.stop(); // aborts in-flight work and waits for the release
    await tickPromise;

    // The job was released as requeued and re-enqueued (attempt 2): safe resume.
    const afterStop = await store.readRun('run-shutdown');
    const queueAfterStop = projectExecutionQueue(afterStop, 'run-shutdown');
    expect(queueAfterStop.jobs[0].status).toBe('queued');
    expect(queueAfterStop.jobs[0].attempt).toBe(2);
    expect(afterStop.some((e) => e.type === 'queue.lease_abandoned')).toBe(false);

    let resumed = 0;
    const daemonB = createExecutionDaemon({
      store,
      ownerId: 'daemon-b',
      timers: noopTimers(),
      executor: () => {
        resumed += 1;
        return Promise.resolve({ status: 'completed', summary: 'finished after restart' });
      },
    });
    const result = await daemonB.tick();
    expect(result.claimed).toBe(1);
    expect(resumed).toBe(1);
    const final = await store.readRun('run-shutdown');
    expect(projectExecutionQueue(final, 'run-shutdown').jobs[0].status).toBe('completed');
  });

  it('a held daemon (autoStart off) reconciles but never claims queued work until resume()', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectExecutionQueue } = await import('../../src/server/execution/queue');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-held');

    const executed: string[] = [];
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-held',
      timers: noopTimers(),
      config: { autoStart: false },
      executor: (ctx) => {
        executed.push(ctx.jobId);
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    expect(daemon.held).toBe(true);

    // Boot + explicit passes run NOTHING while the gate is engaged: this is
    // the "opening the factory never auto-runs queued work" guarantee.
    await daemon.start();
    const whileHeld = await daemon.tick();
    expect(whileHeld.claimed).toBe(0);
    expect(executed).toEqual([]);
    const queueHeld = projectExecutionQueue(await store.readRun('run-held'), 'run-held');
    expect(queueHeld.jobs[0].status).toBe('queued');

    // The operator's resume releases the gate; the next pass drains the job.
    daemon.resume();
    expect(daemon.held).toBe(false);
    await daemon.tick();
    expect(executed).toEqual(['run-held:execution']);
    const queueAfter = projectExecutionQueue(await store.readRun('run-held'), 'run-held');
    expect(queueAfter.jobs[0].status).toBe('completed');
    await daemon.stop();
  });

  it('a held daemon still abandons expired stale leases (reconcile is not gated)', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectExecutionQueue } = await import('../../src/server/execution/queue');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-held-stale');
    // A lease from a previous (crashed) owner that has long expired.
    await store.append({
      runId: 'run-held-stale',
      type: 'queue.claimed',
      actor: { kind: 'system', id: 'daemon-dead' },
      subject: { kind: 'queue-job', id: 'run-held-stale:execution' },
      severity: 'info',
      payload: {
        jobId: 'run-held-stale:execution',
        jobKind: 'run-execution',
        attempt: 1,
        leaseId: 'lease-dead',
        ownerId: 'daemon-dead',
        leaseExpiresAt: 1,
      },
    });

    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-held-reconciler',
      timers: noopTimers(),
      config: { autoStart: false },
      executor: () => Promise.resolve({ status: 'completed' }),
    });
    const result = await daemon.tick();
    expect(result.abandoned).toBe(1);
    expect(result.claimed).toBe(0);
    const events = await store.readRun('run-held-stale');
    expect(events.some((e) => e.type === 'queue.lease_abandoned')).toBe(true);
    expect(projectExecutionQueue(events, 'run-held-stale').jobs[0].status).toBe('abandoned');
  });

  it('resume() on a daemon that was never started flips the gate but drains nothing', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectExecutionQueue } = await import('../../src/server/execution/queue');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-dead-daemon');

    const executed: string[] = [];
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-dead-resume',
      timers: noopTimers(),
      config: { autoStart: false },
      executor: (ctx) => {
        executed.push(ctx.jobId);
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });

    // The operator resumes a daemon whose loop never started: the gate opens…
    daemon.resume();
    expect(daemon.held).toBe(false);
    expect(daemon.running).toBe(false);

    // …but notify() is a no-op on a stopped loop, so nothing claims or runs.
    // This is the "operator resumes a dead daemon" trap the resume route
    // surfaces via `running: false` — the gate is open and NOTHING drains.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executed).toEqual([]);
    const events = await store.readRun('run-dead-daemon');
    expect(events.some((e) => e.type === 'queue.claimed')).toBe(false);
    expect(projectExecutionQueue(events, 'run-dead-daemon').jobs[0].status).toBe('queued');
  });

  it('resume() on a RUNNING daemon drains queued work asynchronously — no manual tick', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectExecutionQueue } = await import('../../src/server/execution/queue');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-async-resume');

    const executed: string[] = [];
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-async-resume',
      timers: noopTimers(),
      config: { autoStart: false },
      executor: (ctx) => {
        executed.push(ctx.jobId);
        return Promise.resolve({ status: 'completed', summary: 'done' });
      },
    });
    try {
      // start() boots the loop HELD: the initial pass claims nothing.
      await daemon.start();
      expect(executed).toEqual([]);

      // resume() wakes the loop itself via notify() (E1: soon, never in the
      // caller's request lifetime) — the caller never ticks manually.
      daemon.resume();
      await vi.waitFor(() => {
        expect(executed).toEqual(['run-async-resume:execution']);
      });
      const queue = projectExecutionQueue(
        await store.readRun('run-async-resume'),
        'run-async-resume',
      );
      expect(queue.jobs[0].status).toBe('completed');
    } finally {
      await daemon.stop();
    }
  });

  it('hold() re-engages the gate on an auto-start daemon: no NEW claims', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-holdable');

    let executed = 0;
    const daemon = createExecutionDaemon({
      store,
      ownerId: 'daemon-holdable',
      timers: noopTimers(),
      executor: () => {
        executed += 1;
        return Promise.resolve({ status: 'completed' });
      },
    });
    // Default (static) config auto-starts: no gate.
    expect(daemon.held).toBe(false);
    daemon.hold();
    expect(daemon.held).toBe(true);
    const result = await daemon.tick();
    expect(result.claimed).toBe(0);
    expect(executed).toBe(0);
  });

  it('the default executor blocks honestly instead of pretending to build (U6 seam)', async () => {
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectInterventions } = await import('../../src/server/execution/interventions');
    const store = createInMemoryEventStore();
    await seedPlannedStartableRun(store, 'run-noop');

    const daemon = createExecutionDaemon({ store, timers: noopTimers() });
    await daemon.tick();

    const events = await store.readRun('run-noop');
    const seen = events.map((e) => e.type);
    expect(seen).toContain('execution.blocked');
    expect(seen).not.toContain('execution.completed');
    const interventions = projectInterventions(events);
    expect(interventions.open.length).toBeGreaterThan(0);
  });
});

describe('cancelRuns as the New Session queue-clear (session lifecycle U3)', () => {
  it('releases queued jobs for targeted runs even when the run itself is NOT cancelled', async () => {
    // New Session reuses cancelRuns to clear queued work factory-wide (R8):
    // its phase-2 release must not depend on the run projecting `cancelled`,
    // or stale queued work on TERMINAL runs (e.g. a completed run's queued
    // gate re-run) would survive the session and execute after a later
    // resume — against an archived run. This pins the property the command
    // relies on.
    const { createExecutionDaemon } = await import('../../src/server/execution/daemon');
    const { projectExecutionQueue } = await import('../../src/server/execution/queue');
    const store = createInMemoryEventStore();

    // A COMPLETED run (never cancelled) with a stale queued gate re-run.
    await store.append({
      runId: 'run-done',
      type: 'run.created',
      actor: { kind: 'operator', id: 'operator' },
      subject: { kind: 'run', id: 'run-done', version: 0 },
      severity: 'info',
      payload: { prompt: 'x' },
    });
    await store.append({
      runId: 'run-done',
      type: 'run.completed',
      actor: { kind: 'system', id: 'executor' },
      subject: { kind: 'run', id: 'run-done' },
      severity: 'success',
      payload: { summary: 'done' },
    });
    await store.append({
      runId: 'run-done',
      type: 'queue.enqueued',
      actor: { kind: 'system', id: 'test' },
      subject: { kind: 'queue-job', id: 'run-done:gate-rerun' },
      severity: 'info',
      payload: { jobId: 'run-done:gate-rerun', jobKind: 'gate-rerun', attempt: 1 },
    });
    // An UNtargeted run's queued job must be left alone.
    await seedPlannedStartableRun(store, 'run-other');

    const daemon = createExecutionDaemon({ store, timers: noopTimers() });
    await daemon.cancelRuns(['run-done']);

    const queue = projectExecutionQueue(await store.readAll());
    expect(queue.byJobId['run-done:gate-rerun'].status).toBe('cancelled');
    expect(queue.byJobId['run-other:execution'].status).toBe('queued');
    const released = (await store.readRun('run-done')).find((e) => e.type === 'queue.released');
    expect((released?.payload as { outcome?: string } | undefined)?.outcome).toBe('cancelled');
    // The run's recorded outcome is untouched — only its queued work cleared.
    expect((await store.readRun('run-done')).some((e) => e.type === 'run.cancelled')).toBe(false);
  });
});
