/**
 * CLI execution control verbs (full-factory U5): start-run, pause, resume,
 * retry, rerun-gates, interventions, resolve.
 *
 * The CLI enqueues/mutates execution state through the same guarded HTTP API
 * and returns projected state — it never waits for workers. Mutating commands
 * resolve a fresh `expectedVersion` automatically (fetching the run) unless
 * the caller pins one explicitly, so stale-command protection stays on.
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api-client';
import {
  cancelAllRunsCommand,
  factoryHoldCommand,
  factoryResumeCommand,
  factoryStatusCommand,
  interventionsCommand,
  pauseRunCommand,
  resolveInterventionCommand,
  resumeRunCommand,
  retryRunCommand,
  rerunGatesCommand,
  startRunCommand,
} from '../src/commands/execution';
import { runCli } from '../src/index';
import type { CliIo } from '../src/cli-io';

function makeIo(): { io: CliIo; outText: () => string; errText: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    outText: () => out.join('\n'),
    errText: () => err.join('\n'),
  };
}

interface RecordedCall {
  readonly method: string;
  readonly runId?: string;
  readonly input?: unknown;
}

/** A fake client recording execution calls; getRun reports lastSequence 7. */
function makeFakeClient(): { client: ApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const notUsed = (): Promise<never> => Promise.reject(new Error('not used'));
  const run = { runId: 'run-1', lastSequence: 7, status: 'planned' } as unknown as Awaited<
    ReturnType<ApiClient['getRun']>
  >;

  const client: ApiClient = {
    baseUrl: 'http://fake',
    eventsUrl: (runId) => `http://fake/api/runs/${runId}/events`,
    createRun: notUsed,
    getRun: (runId) => {
      calls.push({ method: 'getRun', runId });
      return Promise.resolve(run);
    },
    getEvents: notUsed,
    cancelRun: notUsed,
    review: notUsed,
    materializeWorkspace: notUsed,
    getWorkspace: notUsed,
    getSetup: notUsed,
    startRun(runId, input) {
      calls.push({ method: 'startRun', runId, input });
      return Promise.resolve({
        runId,
        queued: true,
        alreadyQueued: false,
        execution: { state: 'queued' },
        job: {
          jobId: `${runId}:execution`,
          jobKind: 'run-execution',
          attempt: 1,
          status: 'queued',
        },
      });
    },
    pauseRun(runId, input) {
      calls.push({ method: 'pauseRun', runId, input });
      return Promise.resolve({ runId, paused: true, execution: { state: 'paused' } });
    },
    resumeRun(runId, input) {
      calls.push({ method: 'resumeRun', runId, input });
      return Promise.resolve({ runId, resumed: true, execution: { state: 'started' } });
    },
    retryRun(runId, input) {
      calls.push({ method: 'retryRun', runId, input });
      return Promise.resolve({
        runId,
        queued: true,
        job: {
          jobId: `${runId}:execution`,
          jobKind: 'run-execution',
          attempt: 2,
          status: 'queued',
        },
      });
    },
    rerunGates(runId, input) {
      calls.push({ method: 'rerunGates', runId, input });
      return Promise.resolve({
        runId,
        queued: true,
        job: { jobId: `${runId}:gate-rerun`, jobKind: 'gate-rerun', attempt: 1, status: 'queued' },
      });
    },
    getExecution(runId) {
      calls.push({ method: 'getExecution', runId });
      return Promise.resolve({ runId, execution: { state: 'queued' } });
    },
    getExecutionOverview() {
      calls.push({ method: 'getExecutionOverview' });
      return Promise.resolve({
        execution: { enabled: true, held: true, running: false },
        queue: { queued: 2, leased: 1 },
      });
    },
    resumeExecution() {
      calls.push({ method: 'resumeExecution' });
      return Promise.resolve({ resumed: true, held: false });
    },
    holdExecution() {
      calls.push({ method: 'holdExecution' });
      return Promise.resolve({ held: true });
    },
    cancelAllRuns(input) {
      calls.push({ method: 'cancelAllRuns', input });
      return Promise.resolve({
        cancelled: ['run-1', 'run-2'],
        alreadyCancelled: ['run-0'],
        skippedTerminal: ['run-3'],
        cancelledCount: 2,
      });
    },
    listInterventions(query) {
      calls.push({ method: 'listInterventions', input: query });
      return Promise.resolve({
        interventions: [
          {
            interventionId: 'run-1:preflight:workspace:1',
            runId: 'run-1',
            kind: 'source_choice',
            severity: 'warn',
            blockingStage: 'preflight',
            reason: 'workspace missing',
            requiredAction: 'Materialize the workspace.',
            status: 'open',
          },
        ],
        openCount: 1,
      });
    },
    resolveIntervention(interventionId, input) {
      calls.push({ method: 'resolveIntervention', runId: interventionId, input });
      return Promise.resolve({
        alreadyResolved: false,
        intervention: {
          interventionId,
          runId: 'run-1',
          kind: 'source_choice',
          severity: 'warn',
          blockingStage: 'preflight',
          reason: 'workspace missing',
          requiredAction: 'Materialize the workspace.',
          status: 'resolved',
          resolution: input.resolution,
        },
      });
    },
  };
  return { client, calls };
}

describe('execution commands — request shape + auto expectedVersion', () => {
  it('start-run fetches the run for a fresh expectedVersion and posts start', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await startRunCommand({ runId: 'run-1', json: true }, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['getRun', 'startRun']);
    expect(calls[1].input).toMatchObject({ expectedVersion: 7 });
    expect(result.queued).toBe(true);
    expect(JSON.parse(outText())).toMatchObject({ queued: true });
  });

  it('a pinned --expected-version skips the extra run fetch (stale checks stay possible)', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await startRunCommand({ runId: 'run-1', expectedVersion: 3, json: true }, { client, io });
    expect(calls.map((c) => c.method)).toEqual(['startRun']);
    expect(calls[0].input).toMatchObject({ expectedVersion: 3 });
  });

  it('pause/resume post the matching commands', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await pauseRunCommand({ runId: 'run-1', reason: 'lunch', json: true }, { client, io });
    await resumeRunCommand({ runId: 'run-1', json: true }, { client, io });
    expect(calls.filter((c) => c.method === 'pauseRun')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'pauseRun')?.input).toMatchObject({ reason: 'lunch' });
    expect(calls.filter((c) => c.method === 'resumeRun')).toHaveLength(1);
  });

  it('retry forwards the optional --ticket focus', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await retryRunCommand({ runId: 'run-1', ticketId: 'data-model', json: true }, { client, io });
    expect(calls.find((c) => c.method === 'retryRun')?.input).toMatchObject({
      ticketId: 'data-model',
      expectedVersion: 7,
    });
  });

  it('rerun-gates posts the gate re-run command', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await rerunGatesCommand({ runId: 'run-1', json: true }, { client, io });
    expect(calls.filter((c) => c.method === 'rerunGates')).toHaveLength(1);
  });

  it('interventions lists the operator queue with filters', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    await interventionsCommand({ runId: 'run-1', open: true, json: true }, { client, io });
    expect(calls.find((c) => c.method === 'listInterventions')?.input).toMatchObject({
      runId: 'run-1',
      open: true,
    });
    const parsed = JSON.parse(outText()) as { interventions: { kind: string }[] };
    expect(parsed.interventions[0].kind).toBe('source_choice');
  });

  it('resolve posts the resolution for one intervention', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await resolveInterventionCommand(
      {
        interventionId: 'run-1:preflight:workspace:1',
        resolution: 'approved',
        note: 'done',
        json: true,
      },
      { client, io },
    );
    expect(calls.find((c) => c.method === 'resolveIntervention')?.input).toMatchObject({
      resolution: 'approved',
      note: 'done',
    });
  });

  it('human (non-json) output summarizes the projected state instead of dumping JSON', async () => {
    const { client } = makeFakeClient();
    const { io, outText } = makeIo();
    await startRunCommand({ runId: 'run-1' }, { client, io });
    expect(outText()).toContain('run-1');
    expect(outText().toLowerCase()).toContain('queued');
  });
});

describe('factory-wide drain gate + cancel-all commands', () => {
  it('factory-status reports the gate, daemon, and cross-run queue counts', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await factoryStatusCommand({}, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['getExecutionOverview']);
    expect(result.execution.held).toBe(true);
    // The human summary must surface the drain gate — a held factory queues
    // started runs without executing them until factory-resume.
    expect(outText()).toContain('HELD');
    expect(outText()).toContain('factory-resume');
    expect(outText()).toContain('2 queued');
  });

  it('factory-resume releases the gate (no runId, no expectedVersion fetch)', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await factoryResumeCommand({ json: true }, { client, io });

    // Factory scope: no getRun version fetch precedes the gate command.
    expect(calls.map((c) => c.method)).toEqual(['resumeExecution']);
    expect(result.resumed).toBe(true);
    expect(JSON.parse(outText())).toMatchObject({ resumed: true, held: false });
  });

  it('factory-hold re-engages the gate', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await factoryHoldCommand({}, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['holdExecution']);
    expect(result.held).toBe(true);
    expect(outText().toLowerCase()).toContain('held');
  });

  it('cancel-all forwards --reason and summarizes the batch outcome', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await cancelAllRunsCommand({ reason: 'shutdown' }, { client, io });

    expect(calls.find((c) => c.method === 'cancelAllRuns')?.input).toMatchObject({
      reason: 'shutdown',
    });
    expect(result.cancelledCount).toBe(2);
    expect(outText()).toContain('Cancelled 2 run(s)');
    expect(outText()).toContain('1 already cancelled');
    expect(outText()).toContain('1 terminal');
    expect(outText()).toContain('cancelled run-1');
  });
});

describe('execution commands via runCli — argument validation', () => {
  it('start-run requires a runId', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(['start-run'], { io });
    expect(code).toBe(2);
    expect(errText()).toContain('runId');
  });

  it('resolve requires an interventionId and a --resolution', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(['resolve'], { io });
    expect(code).toBe(2);
    expect(errText().toLowerCase()).toContain('intervention');
  });
});
