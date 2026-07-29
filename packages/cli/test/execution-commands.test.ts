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
import { ApiError } from '../src/api-client';
import type { ApiClient } from '../src/api-client';
import {
  FACTORY_RESET_PHRASE,
  archiveRunCommand,
  cancelAllRunsCommand,
  cancelRunCommand,
  factoryHoldCommand,
  factoryResetCommand,
  factoryResumeCommand,
  factoryStatusCommand,
  interventionsCommand,
  newSessionCommand,
  pauseRunCommand,
  resolveInterventionCommand,
  resumeRunCommand,
  retryRunCommand,
  rerunGatesCommand,
  startRunCommand,
  unarchiveRunCommand,
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
    cancelRun(runId, input) {
      calls.push({ method: 'cancelRun', runId, input });
      return Promise.resolve({
        runId,
        run,
        ...(input.archive === true ? { archived: true } : {}),
      });
    },
    archiveRun(runId, input) {
      calls.push({ method: 'archiveRun', runId, input });
      return Promise.resolve({ runId, cancelled: true, run });
    },
    unarchiveRun(runId, input) {
      calls.push({ method: 'unarchiveRun', runId, input });
      return Promise.resolve({ runId, run });
    },
    startNewSession(input) {
      calls.push({ method: 'startNewSession', input });
      return Promise.resolve({
        archived: ['run-1', 'run-2'],
        cancelled: ['run-1'],
        held: true,
      });
    },
    factoryReset(input) {
      calls.push({ method: 'factoryReset', input });
      return Promise.resolve({
        reset: true,
        resetGeneration: 3,
        held: true,
        destroyed: { runCount: 2, archivedRunCount: 1 },
      });
    },
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

  it('cancel and archive require a runId', async () => {
    for (const command of ['cancel', 'archive', 'unarchive']) {
      const { io, errText } = makeIo();
      const code = await runCli([command], { io });
      expect(code, command).toBe(2);
      expect(errText(), command).toContain('runId');
    }
  });
});

/* ----------------------------------------------------------------------------
 * Session lifecycle commands (U7 connector parity): thin wrappers over the
 * guarded U2/U3/U4 routes — the only client-side rule is factory-reset's
 * local phrase check, which must abort WITHOUT sending any request.
 * ------------------------------------------------------------------------- */

describe('session lifecycle commands', () => {
  it('archive resolves a fresh expectedVersion and posts the archive command', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await archiveRunCommand({ runId: 'run-1' }, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['getRun', 'archiveRun']);
    expect(calls[1].input).toMatchObject({ expectedVersion: 7 });
    expect(result.cancelled).toBe(true);
    // The human summary names the reversible contract, not a fake deletion.
    expect(outText()).toContain('archived');
    expect(outText()).toContain('replayable');
  });

  it('unarchive posts the unarchive command with a fresh expectedVersion', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    await unarchiveRunCommand({ runId: 'run-1' }, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['getRun', 'unarchiveRun']);
    expect(calls[1].input).toMatchObject({ expectedVersion: 7 });
    expect(outText()).toContain('visible again');
  });

  it('cancel --archive performs cancel-then-archive in ONE client command', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await cancelRunCommand(
      { runId: 'run-1', archive: true, reason: 'done here' },
      { client, io },
    );

    // Exactly one mutation: the archive rides on the cancel body (R10), never
    // a second round-trip.
    expect(calls.map((c) => c.method)).toEqual(['getRun', 'cancelRun']);
    expect(calls[1].input).toMatchObject({
      expectedVersion: 7,
      archive: true,
      reason: 'done here',
    });
    expect(result.archived).toBe(true);
    expect(outText()).toContain('cancelled and archived');
  });

  it('new-session forwards --confirm-active and reports the held gate', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await newSessionCommand({ confirmActive: true }, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['startNewSession']);
    expect(calls[0].input).toMatchObject({ confirmActive: true });
    expect(result.held).toBe(true);
    expect(outText()).toContain('archived 2 run(s)');
    expect(outText()).toContain('HELD');
  });

  it('new-session surfaces the ask-once refusal with a --confirm-active hint', async () => {
    const { client } = makeFakeClient();
    const refusing: ApiClient = {
      ...client,
      startNewSession: () =>
        Promise.reject(
          new ApiError(409, 'active_runs_present', '1 run(s) are still active.', {
            error: 'active_runs_present',
            activeRuns: [{ runId: 'run-9', title: 'Live build', executionState: 'started' }],
          }),
        ),
    };
    const { io, errText } = makeIo();

    await expect(newSessionCommand({}, { client: refusing, io })).rejects.toMatchObject({
      code: 'active_runs_present',
    });
    // The refusal is actionable: it lists the actives and names the CLI flag.
    expect(errText()).toContain('run-9');
    expect(errText()).toContain('--confirm-active');
  });
});

describe('factory-reset command — typed phrase contract', () => {
  it('pins the CLI mirror of the server phrase (drift fails the build)', () => {
    expect(FACTORY_RESET_PHRASE).toBe('reset the factory');
  });

  it('sends the request when --confirm carries the exact phrase', async () => {
    const { client, calls } = makeFakeClient();
    const { io, outText } = makeIo();
    const result = await factoryResetCommand({ confirm: FACTORY_RESET_PHRASE }, { client, io });

    expect(calls.map((c) => c.method)).toEqual(['factoryReset']);
    expect(calls[0].input).toMatchObject({ confirm: FACTORY_RESET_PHRASE });
    expect(result).not.toBeNull();
    expect(outText()).toContain('generation 3');
    expect(outText()).toContain('HELD');
  });

  it('aborts locally on a wrong --confirm phrase — NO request is sent', async () => {
    const { client, calls } = makeFakeClient();
    const { io, errText } = makeIo();
    const result = await factoryResetCommand({ confirm: 'reset everything' }, { client, io });

    expect(result).toBeNull();
    expect(calls).toEqual([]);
    expect(errText()).toContain('Nothing was sent');
  });

  it('prompts for the phrase when --confirm is absent; a mismatch aborts locally', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    const asked: string[] = [];
    const result = await factoryResetCommand(
      {},
      {
        client,
        io,
        promptLine: (question) => {
          asked.push(question);
          return Promise.resolve('nope');
        },
      },
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(FACTORY_RESET_PHRASE);
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  it('prompted exact phrase proceeds to the request', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    const result = await factoryResetCommand(
      {},
      { client, io, promptLine: () => Promise.resolve(FACTORY_RESET_PHRASE) },
    );

    expect(result).not.toBeNull();
    expect(calls.map((c) => c.method)).toEqual(['factoryReset']);
  });

  it('runCli factory-reset exits 2 on a mismatched interactive phrase without HTTP', async () => {
    const { io, errText } = makeIo();
    // A guaranteed-unreachable base URL plus an env token: an accidental HTTP
    // attempt would throw a connection error instead of exiting cleanly.
    const code = await runCli(['factory-reset'], {
      io,
      env: { SF_BASE_URL: 'http://127.0.0.1:9', SF_OPERATOR_TOKEN: 'test-token' },
      promptLine: () => Promise.resolve('not the phrase'),
    });
    expect(code).toBe(2);
    expect(errText()).toContain('Nothing was sent');
  });
});
