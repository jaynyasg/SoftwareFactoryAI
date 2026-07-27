/**
 * CLI review + workspace materialization verbs (connector parity).
 *
 * These wire the existing guarded routes: `review` records an approve/reject
 * decision (an approval resumes a blocked stage), and `materialize-workspace` /
 * `workspace-status` trigger and read the U4 workspace state. Mutating commands
 * resolve a fresh `expectedVersion` automatically (fetching the run) unless the
 * caller pins one, so stale-command protection stays on.
 */
import { describe, expect, it } from 'vitest';
import type {
  ApiClient,
  MaterializeWorkspaceResult,
  ReviewResult,
  WorkspaceStatusResult,
} from '../src/api-client';
import { reviewCommand } from '../src/commands/review';
import { materializeWorkspaceCommand, workspaceStatusCommand } from '../src/commands/workspace';
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

interface FakeOptions {
  readonly reviewResult?: ReviewResult;
  readonly materializeResult?: MaterializeWorkspaceResult;
  readonly workspaceResult?: WorkspaceStatusResult;
}

/** A fake client recording review/workspace calls; getRun reports lastSequence 7. */
function makeFakeClient(options: FakeOptions = {}): {
  client: ApiClient;
  calls: RecordedCall[];
} {
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
    review(runId, input) {
      calls.push({ method: 'review', runId, input });
      return Promise.resolve(
        options.reviewResult ?? {
          runId,
          run: { runId, status: 'running' } as unknown as ReviewResult['run'],
        },
      );
    },
    materializeWorkspace(runId, input) {
      calls.push({ method: 'materializeWorkspace', runId, input });
      return Promise.resolve(
        options.materializeResult ?? { runId, workspace: { status: 'ready' } },
      );
    },
    getWorkspace(runId) {
      calls.push({ method: 'getWorkspace', runId });
      return Promise.resolve(options.workspaceResult ?? { runId, workspace: { status: 'none' } });
    },
    getSetup: notUsed,
    startRun: notUsed,
    pauseRun: notUsed,
    resumeRun: notUsed,
    retryRun: notUsed,
    rerunGates: notUsed,
    getExecution: notUsed,
    getExecutionOverview: notUsed,
    resumeExecution: notUsed,
    holdExecution: notUsed,
    cancelAllRuns: notUsed,
    listInterventions: notUsed,
    resolveIntervention: notUsed,
  };
  return { client, calls };
}

describe('review command', () => {
  it('fetches a fresh expectedVersion and posts the decision', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await reviewCommand(
      { runId: 'run-1', decision: 'approved', rationale: 'looks good' },
      { client, io },
    );
    expect(calls.map((c) => c.method)).toEqual(['getRun', 'review']);
    expect(calls[1].input).toMatchObject({
      decision: 'approved',
      rationale: 'looks good',
      expectedVersion: 7,
    });
  });

  it('a pinned --expected-version skips the extra run fetch', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await reviewCommand(
      { runId: 'run-1', decision: 'rejected', expectedVersion: 3 },
      { client, io },
    );
    expect(calls.map((c) => c.method)).toEqual(['review']);
    expect(calls[0].input).toMatchObject({ decision: 'rejected', expectedVersion: 3 });
  });

  it('reports the stage-resume outcome of an approval in human output', async () => {
    const { client } = makeFakeClient({
      reviewResult: {
        runId: 'run-1',
        run: { runId: 'run-1', status: 'running' } as unknown as ReviewResult['run'],
        resumed: { stage: 'gates', resolvedInterventions: ['i-1'], queued: true },
      },
    });
    const { io, outText } = makeIo();
    await reviewCommand({ runId: 'run-1', decision: 'approved' }, { client, io });
    expect(outText()).toContain('review approved');
    expect(outText()).toContain('resumed gates stage');
  });
});

describe('workspace commands', () => {
  it('materialize-workspace resolves a fresh expectedVersion and posts the branch', async () => {
    const { client, calls } = makeFakeClient();
    const { io } = makeIo();
    await materializeWorkspaceCommand(
      { runId: 'run-1', branch: 'feature/x', json: true },
      { client, io },
    );
    expect(calls.map((c) => c.method)).toEqual(['getRun', 'materializeWorkspace']);
    expect(calls[1].input).toMatchObject({ branch: 'feature/x', expectedVersion: 7 });
  });

  it('workspace-status reads the projected state without a mutation', async () => {
    const { client, calls } = makeFakeClient({
      workspaceResult: {
        runId: 'run-1',
        workspace: {
          status: 'ready',
          workspace: { kind: 'repo_checkout', checkoutPath: '/tmp/x' },
        },
      },
    });
    const { io, outText } = makeIo();
    await workspaceStatusCommand({ runId: 'run-1' }, { client, io });
    expect(calls.map((c) => c.method)).toEqual(['getWorkspace']);
    expect(outText()).toContain('workspace ready');
    expect(outText()).toContain('/tmp/x');
  });
});

describe('review + workspace via runCli — argument validation', () => {
  it('review requires a runId', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(['review'], { io });
    expect(code).toBe(2);
    expect(errText()).toContain('runId');
  });

  it('review requires a valid --decision', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(['review', 'run-1'], { io });
    expect(code).toBe(2);
    expect(errText().toLowerCase()).toContain('decision');
  });

  it('review rejects an invalid --risk-tier', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(
      ['review', 'run-1', '--decision', 'approved', '--risk-tier', 'nuclear'],
      { io },
    );
    expect(code).toBe(2);
    expect(errText()).toContain('Invalid --risk-tier');
  });

  it('materialize-workspace requires a runId', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(['materialize-workspace'], { io });
    expect(code).toBe(2);
    expect(errText()).toContain('runId');
  });

  it('workspace-status requires a runId', async () => {
    const { io, errText } = makeIo();
    const code = await runCli(['workspace-status'], { io });
    expect(code).toBe(2);
    expect(errText()).toContain('runId');
  });
});
