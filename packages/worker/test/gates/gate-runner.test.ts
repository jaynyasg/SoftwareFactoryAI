/**
 * Gate-runner orchestration: blocking order, pass/fail evidence on the ledger,
 * structured retry context, and a bounded per-gate retry budget (no infinite
 * retry). Command gates run through a real local-fallback sandbox backed by a
 * fake `CommandRunner`, so the gate -> sandbox -> runner path is exercised end
 * to end without any real process.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore, projectRun } from '@software-factory/core';
import {
  createDependencyAuditGate,
  createLintGate,
  createLocalFallbackSandbox,
  createPreviewHealthGate,
  createTypecheckGate,
  runGates,
} from '../../src/index';
import type { Gate, GateContext, GateResult, Sandbox } from '../../src/index';
import { createFakeRunner } from '../_helpers/fake-runner';
import type { FakeRunnerScript } from '../_helpers/fake-runner';

const WORKSPACE = resolve('gate-test-workspace');

function sandboxWith(script: FakeRunnerScript): Sandbox {
  return createLocalFallbackSandbox({
    policy: { workspaceDir: WORKSPACE, allowFallback: true },
    runner: createFakeRunner(script),
    hostEnv: { PATH: '/usr/bin' },
  });
}

function context(sandbox: Sandbox): GateContext {
  return { runId: 'run-gates', workspaceDir: WORKSPACE, sandbox };
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
          reason: `${name} transient failure ${calls}`,
          evidence: [{ label: `${name}:attempt`, detail: `attempt ${calls}` }],
        });
      }
      return Promise.resolve({ gate: name, passed: true, summary: 'recovered', evidence: [] });
    },
  };
}

describe('gate-runner: ordered pass with evidence', () => {
  it('emits gate.started -> gate.passed with command evidence for each gate', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({
      responses: {
        'pnpm lint': { code: 0, stdout: 'lint clean', stderr: '' },
        'pnpm typecheck': { code: 0, stdout: 'no type errors', stderr: '' },
      },
    });

    const result = await runGates(
      {
        runId: 'run-gates',
        gates: [createLintGate(), createTypecheckGate()],
        context: context(sandbox),
      },
      { store },
    );

    expect(result.passed).toBe(true);
    expect(result.ranToCompletion).toBe(true);
    expect(result.attempts).toBe(2);

    const events = await store.readRun('run-gates');
    const types = events.map((e) => e.type);
    expect(types).toEqual(['gate.started', 'gate.passed', 'gate.started', 'gate.passed']);

    // Evidence (command + output) rides on the gate.passed events and projects.
    const view = projectRun(events, 'run-gates');
    const lintPassed = view.ledger.find(
      (row) => row.type === 'gate.passed' && row.evidence?.some((e) => e.ref === 'pnpm lint'),
    );
    expect(lintPassed).toBeDefined();
    expect(lintPassed?.evidence?.[0].note).toContain('lint clean');
  });
});

describe('gate-runner: blocking failure', () => {
  it('stops the pipeline on the first failing gate and returns structured retry context', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({
      responses: {
        'pnpm lint': { code: 2, stdout: '', stderr: 'lint failed: 3 problems' },
        'pnpm typecheck': { code: 0, stdout: '', stderr: '' },
      },
    });

    const result = await runGates(
      {
        runId: 'run-blocked',
        gates: [createLintGate(), createTypecheckGate()],
        context: context(sandbox),
      },
      { store },
    );

    expect(result.passed).toBe(false);
    expect(result.ranToCompletion).toBe(false);
    expect(result.failure).toBeDefined();
    expect(result.failure?.gate).toBe('lint');
    expect(result.failure?.command).toBe('pnpm lint');
    expect(result.failure?.outputExcerpt).toContain('lint failed');
    expect(result.failure?.attempt).toBe(1);

    const events = await store.readRun('run-blocked');
    const types = events.map((e) => e.type);
    // lint started + failed; typecheck NEVER started (pipeline stopped).
    expect(types).toEqual(['gate.started', 'gate.failed']);
    const failed = events.find((e) => e.type === 'gate.failed');
    expect((failed?.payload as { gate: string }).gate).toBe('lint');
    expect(failed?.evidence?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('gate-runner: bounded retry budget', () => {
  it('retries a transient gate within budget then passes (no terminal failure)', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({});
    const result = await runGates(
      {
        runId: 'run-flaky-ok',
        gates: [flakyGate('flaky', 2)],
        context: context(sandbox),
        maxAttemptsPerGate: 3,
      },
      { store },
    );

    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(3);

    const events = await store.readRun('run-flaky-ok');
    // Three attempts => three gate.started; exactly one gate.passed; no gate.failed.
    expect(events.filter((e) => e.type === 'gate.started')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'gate.passed')).toHaveLength(1);
    expect(events.some((e) => e.type === 'gate.failed')).toBe(false);
  });

  it('stops after exhausting the retry budget (no infinite retry)', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({});
    const result = await runGates(
      {
        runId: 'run-flaky-exhausted',
        gates: [flakyGate('always', 99)],
        context: context(sandbox),
        maxAttemptsPerGate: 2,
      },
      { store },
    );

    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.failure?.attempt).toBe(2);

    const events = await store.readRun('run-flaky-exhausted');
    expect(events.filter((e) => e.type === 'gate.started')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'gate.failed')).toHaveLength(1);
  });
});

describe('gate-runner: dependency-audit gate', () => {
  it('fails (blocking) when an unapproved dependency needs review', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({});
    const gate = createDependencyAuditGate({
      policy: { allowList: ['react'] },
      dependencies: [{ name: 'react' }, { name: 'sketchy-pkg' }],
    });

    const result = await runGates(
      { runId: 'run-dep', gates: [gate], context: context(sandbox) },
      { store },
    );

    expect(result.passed).toBe(false);
    expect(result.failure?.gate).toBe('dependency-audit');
    expect(result.failure?.reason).toMatch(/review/i);
  });

  it('passes when all dependencies are allow-listed', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({});
    const gate = createDependencyAuditGate({
      policy: { allowList: ['react', 'zod'] },
      dependencies: [{ name: 'react' }, { name: 'zod' }],
    });

    const result = await runGates(
      { runId: 'run-dep-ok', gates: [gate], context: context(sandbox) },
      { store },
    );
    expect(result.passed).toBe(true);
  });
});

describe('gate-runner: preview-health gate', () => {
  it('passes only when the injected probe reports healthy', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({});
    let polls = 0;
    const gate = createPreviewHealthGate({
      url: 'http://127.0.0.1:4321',
      attempts: 5,
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
      probe: () => {
        polls += 1;
        return polls >= 3;
      },
    });

    const result = await runGates(
      { runId: 'run-preview-gate', gates: [gate], context: context(sandbox) },
      { store },
    );
    expect(result.passed).toBe(true);
    const events = await store.readRun('run-preview-gate');
    expect(events.some((e) => e.type === 'gate.passed')).toBe(true);
  });

  it('fails when the probe never reports healthy within the budget', async () => {
    const store = createInMemoryEventStore();
    const sandbox = sandboxWith({});
    const gate = createPreviewHealthGate({
      url: 'http://127.0.0.1:4321',
      attempts: 3,
      pollIntervalMs: 0,
      sleep: () => Promise.resolve(),
      probe: () => false,
    });

    const result = await runGates(
      { runId: 'run-preview-gate-fail', gates: [gate], context: context(sandbox) },
      { store },
    );
    expect(result.passed).toBe(false);
    expect(result.failure?.gate).toBe('preview-health');
  });
});
