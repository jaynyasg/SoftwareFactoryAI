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
  });
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
  });
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
