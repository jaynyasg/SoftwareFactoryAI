/**
 * Gated ticket runner (U7): post-ticket gates + the bounded repair loop.
 *
 * All gates are deterministic fakes (no lint/test subprocesses) and the
 * adapter records the compiled context each execution receives, so the tests
 * assert the REAL contract: gate feedback reaches the repaired worker run,
 * repair budgets are bounded and ledger-derived (a "restarted" runner resumes
 * the consumed budget instead of resetting it), and exhaustion escalates with
 * `repair.failed` instead of looping.
 */
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore, projectTickets } from '@software-factory/core';
import type { AdapterTask, EventStore, ExecutionAdapter } from '@software-factory/core';
import { createGatedTicketRunner } from '../../src/index';
import type { Gate, GateContext, GateResult, Sandbox, TicketRunner } from '../../src/index';
import { makeCompileInput } from '../_helpers/nodes';

const RUN = 'run-gated';
const WORKSPACE = '/virtual/ws';

/** A sandbox stub — the fake gates never execute commands through it. */
const SANDBOX_STUB: Sandbox = {
  mode: 'local-fallback',
  reducedTrust: true,
  run: () =>
    Promise.resolve({
      ok: true,
      denied: false,
      reducedTrust: true,
      mode: 'local-fallback',
      stdout: '',
      stderr: '',
      violations: [],
    }),
};

function gateContext(): GateContext {
  return { runId: RUN, workspaceDir: WORKSPACE, sandbox: SANDBOX_STUB };
}

/** Records every adapter execution and the context it received. */
function recordingAdapter(): ExecutionAdapter & { readonly tasks: readonly AdapterTask[] } {
  const tasks: AdapterTask[] = [];
  return {
    id: 'fake-exec',
    family: 'codex',
    detectSetup: () => Promise.resolve({ available: true, authenticated: true, capacity: 4 }),
    execute: (task) => {
      tasks.push(task);
      return Promise.resolve({ ok: true, output: `done:${task.ticketId}`, artifacts: [] });
    },
    reportCapacity: () => 4,
    tasks,
  };
}

/** A gate that fails its first `failures` runs, then passes. */
function flakyGate(name: string, failures: number): Gate {
  let calls = 0;
  return {
    name,
    run(): Promise<GateResult> {
      calls += 1;
      if (calls <= failures) {
        return Promise.resolve({
          gate: name,
          passed: false,
          reason: `${name} failure ${calls}`,
          evidence: [{ label: `${name}:attempt`, detail: `attempt ${calls}` }],
        });
      }
      return Promise.resolve({ gate: name, passed: true, summary: 'clean', evidence: [] });
    },
  };
}

function makeRunner(gates: readonly Gate[], maxRepairAttempts: number): TicketRunner {
  return createGatedTicketRunner({
    gates: () => gates,
    gateContext: () => gateContext(),
    maxRepairAttempts,
  });
}

async function runOnce(
  runner: TicketRunner,
  store: EventStore,
  adapter: ExecutionAdapter,
  ticketId = 'data-model',
) {
  return runner(
    {
      runId: RUN,
      compileInput: makeCompileInput(ticketId),
      workspaceDir: WORKSPACE,
      signal: new AbortController().signal,
    },
    { store, adapter },
  );
}

async function types(store: EventStore): Promise<string[]> {
  return (await store.readRun(RUN)).map((event) => event.type);
}

describe('gated ticket runner: passing gates advance the ticket', () => {
  it('completes the ticket and records post_ticket gate evidence, no repair events', async () => {
    const store = createInMemoryEventStore();
    const adapter = recordingAdapter();
    const result = await runOnce(makeRunner([flakyGate('lint', 0)], 2), store, adapter);

    expect(result.outcome).toBe('completed');
    expect(adapter.tasks).toHaveLength(1);
    const events = await store.readRun(RUN);
    const gateStarted = events.find((event) => event.type === 'gate.started');
    expect(gateStarted?.ticketId).toBe('data-model');
    expect((gateStarted?.payload as { stage?: string }).stage).toBe('post_ticket');
    expect(await types(store)).toContain('gate.passed');
    expect(await types(store)).not.toContain('repair.started');
    expect(projectTickets(events, RUN).byId['data-model']?.state).toBe('completed');
  });
});

describe('gated ticket runner: failing gates create repair work with feedback', () => {
  it('re-runs the ticket with the gate failure compiled into its context, then succeeds', async () => {
    const store = createInMemoryEventStore();
    const adapter = recordingAdapter();
    const result = await runOnce(makeRunner([flakyGate('unit-test', 1)], 2), store, adapter);

    expect(result.outcome).toBe('completed');
    // Two worker runs: the original, then ONE repair with structured feedback.
    expect(adapter.tasks).toHaveLength(2);
    expect(adapter.tasks[0].context.gateFeedback).toEqual([]);
    expect(adapter.tasks[1].context.gateFeedback).toEqual([
      { gate: 'unit-test', reason: 'unit-test failure 1', attempt: 1 },
    ]);

    const seen = await types(store);
    expect(seen).toContain('gate.failed');
    expect(seen).toContain('repair.started');
    expect(seen).toContain('repair.succeeded');
    expect(seen).not.toContain('repair.failed');
    const events = await store.readRun(RUN);
    expect(projectTickets(events, RUN).byId['data-model']?.state).toBe('completed');
    // repair.succeeded records the gate whose failure the repair fixed.
    const succeeded = events.find((event) => event.type === 'repair.succeeded');
    expect((succeeded?.payload as { gate: string }).gate).toBe('unit-test');
  });

  it('repair.succeeded records the LAST FAILED gate, not a positional entry of the merged feedback', async () => {
    const store = createInMemoryEventStore();
    const adapter = recordingAdapter();
    // Compiled feedback already carries entries for BOTH gates, with the gate
    // that will fail this invocation ("unit-test") FIRST: merging by Map
    // insertion order keeps "unit-test" at position 0, so the last array
    // entry is "lint" — the wrong gate for positional derivation.
    const compiledFeedback = [
      { gate: 'unit-test', reason: 'stale unit-test failure', attempt: 1 },
      { gate: 'lint', reason: 'stale lint failure', attempt: 1 },
    ];
    const runner = makeRunner([flakyGate('unit-test', 1)], 2);
    const result = await runner(
      {
        runId: RUN,
        compileInput: { ...makeCompileInput('data-model'), gateFeedback: compiledFeedback },
        workspaceDir: WORKSPACE,
        signal: new AbortController().signal,
      },
      { store, adapter },
    );

    expect(result.outcome).toBe('completed');
    const events = await store.readRun(RUN);
    const succeeded = events.find((event) => event.type === 'repair.succeeded');
    expect(succeeded).toBeDefined();
    expect((succeeded?.payload as { gate: string }).gate).toBe('unit-test');
  });
});

describe('gated ticket runner: retry budget exhaustion escalates instead of looping', () => {
  it('stops after the repair budget with repair.failed and a failed ticket', async () => {
    const store = createInMemoryEventStore();
    const adapter = recordingAdapter();
    const result = await runOnce(makeRunner([flakyGate('lint', 99)], 1), store, adapter);

    expect(result.outcome).toBe('failed');
    // Bounded: original run + exactly ONE repair run — never an infinite loop.
    expect(adapter.tasks).toHaveLength(2);
    const events = await store.readRun(RUN);
    const repairStarted = events.filter((event) => event.type === 'repair.started');
    expect(repairStarted).toHaveLength(1);
    const repairFailed = events.find((event) => event.type === 'repair.failed');
    expect(repairFailed).toBeDefined();
    expect((repairFailed?.payload as { attempt: number }).attempt).toBe(1);
    const ticket = projectTickets(events, RUN).byId['data-model'];
    expect(ticket?.state).toBe('failed');
    expect(ticket?.failureReason).toContain('lint');
    expect(ticket?.failureReason).toContain('repair attempt');
  });
});

describe('gated ticket runner: restart does not lose the repair budget', () => {
  it('a fresh runner (new process) resumes the ledger-derived budget and feedback', async () => {
    const store = createInMemoryEventStore();

    // Before the "restart": a prior process recorded one gate failure and one
    // consumed repair attempt, then died mid-loop. Seed the ledger with
    // exactly what that partial attempt wrote (no terminal event).
    const alwaysFailing = flakyGate('unit-test', 99);
    await store.append({
      runId: RUN,
      ticketId: 'data-model',
      type: 'gate.failed',
      actor: { kind: 'gate', id: 'gate-runner' },
      subject: { kind: 'gate', id: 'unit-test' },
      severity: 'error',
      payload: { gate: 'unit-test', reason: 'unit-test failure 1', stage: 'post_ticket' },
    });
    await store.append({
      runId: RUN,
      ticketId: 'data-model',
      type: 'repair.started',
      actor: { kind: 'gate', id: 'repair-loop' },
      subject: { kind: 'ticket', id: 'data-model' },
      severity: 'warn',
      payload: { attempt: 1, gate: 'unit-test', reason: 'unit-test failure 1' },
    });

    // The "restarted" runner: budget 2 TOTAL. It must see 1 attempt already
    // consumed (ledger), feed the recorded failure into the next worker run,
    // and exhaust after ONE more repair — attempts numbered 2, not restarting
    // at 1.
    const adapter = recordingAdapter();
    const result = await runOnce(makeRunner([alwaysFailing], 2), store, adapter);

    expect(result.outcome).toBe('failed');
    expect(adapter.tasks).toHaveLength(2); // resume run + one final repair
    // The resumed run already carries the pre-restart gate feedback.
    expect(adapter.tasks[0].context.gateFeedback).toEqual([
      { gate: 'unit-test', reason: 'unit-test failure 1' },
    ]);

    const events = await store.readRun(RUN);
    const attempts = events
      .filter((event) => event.type === 'repair.started')
      .map((event) => (event.payload as { attempt: number }).attempt);
    expect(attempts).toEqual([1, 2]); // monotonic across the restart
    const repairFailed = events.find((event) => event.type === 'repair.failed');
    expect((repairFailed?.payload as { attempt: number }).attempt).toBe(2);
  });
});
