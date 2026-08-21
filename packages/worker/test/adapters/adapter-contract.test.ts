/**
 * Shared adapter-contract suite.
 *
 * The SAME assertions run against the Codex CLI, Claude Code CLI, and API
 * adapters (CLI adapters driven by a fake `CommandRunner`; the API adapter by an
 * injected stub). Every adapter must: expose id/family, report a well-formed
 * setup state, honor an already-aborted signal, return a normalized failure
 * (never throw) on errors, surface setup actions when unavailable, and produce a
 * well-shaped success result.
 */
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  createApiAdapter,
  createClaudeCodeCliAdapter,
  createCodexCliAdapter,
  isAdapterError,
} from '@software-factory/core';
import type {
  AdapterExecuteOptions,
  AdapterTask,
  ExecutionAdapter,
  WorkerContext,
} from '@software-factory/core';
import { createFakeRunner, createMissingRunner } from '../_helpers/fake-runner';

function context(): WorkerContext {
  return {
    ticketId: 'tkt-1',
    title: 'Contract ticket',
    moduleId: 'm',
    moduleVersion: '1.0.0',
    intent: 'ai-services-marketplace',
    prompt: 'Do the thing.',
    riskTier: 'low',
    resolvedInputs: [],
    missingInputs: [],
    allowedTools: ['fs.read'],
    deniedTools: [],
    expectedOutputs: ['output'],
    artifactContracts: [],
    gateFeedback: [],
    complete: true,
  };
}

function task(): AdapterTask {
  return {
    runId: 'run-1',
    ticketId: 'tkt-1',
    title: 'Contract ticket',
    context: context(),
    workspaceDir: '/tmp/ws',
  };
}

function execOptions(signal: AbortSignal): AdapterExecuteOptions {
  return { signal, onEvent: () => {} };
}

interface AdapterCase {
  readonly name: string;
  /** detectSetup -> available + authenticated; execute -> success. */
  readonly ready: () => ExecutionAdapter;
  /** detectSetup -> NOT available; surfaces setup actions; execute -> failure. */
  readonly unavailable: () => ExecutionAdapter;
  /** detectSetup -> ready; execute -> a normalized failure. */
  readonly failing: () => ExecutionAdapter;
}

const cases: readonly AdapterCase[] = [
  {
    name: 'codex-cli',
    ready: () =>
      createCodexCliAdapter({
        runner: createFakeRunner({
          responses: {
            'codex --version': { code: 0, stdout: 'codex 1.2.3', stderr: '' },
            'codex login': { code: 0, stdout: 'logged in', stderr: '' },
            'codex exec': { code: 0, stdout: '{"ok":true}', stderr: '' },
          },
        }),
      }),
    unavailable: () => createCodexCliAdapter({ runner: createMissingRunner('codex') }),
    failing: () =>
      createCodexCliAdapter({
        runner: createFakeRunner({
          responses: {
            'codex --version': { code: 0, stdout: 'codex 1.2.3', stderr: '' },
            'codex login': { code: 0, stdout: 'logged in', stderr: '' },
            'codex exec': { code: 1, stdout: '', stderr: 'rate limit exceeded, try again' },
          },
        }),
      }),
  },
  {
    name: 'claude-code-cli',
    ready: () =>
      createClaudeCodeCliAdapter({
        runner: createFakeRunner({
          responses: {
            'claude --version': { code: 0, stdout: 'claude 1.0.0', stderr: '' },
            'claude auth': { code: 0, stdout: 'authenticated', stderr: '' },
            'claude --print': { code: 0, stdout: '{"ok":true}', stderr: '' },
          },
        }),
      }),
    unavailable: () => createClaudeCodeCliAdapter({ runner: createMissingRunner('claude') }),
    failing: () =>
      createClaudeCodeCliAdapter({
        runner: createFakeRunner({
          responses: {
            'claude --version': { code: 0, stdout: 'claude 1.0.0', stderr: '' },
            'claude auth': { code: 0, stdout: 'authenticated', stderr: '' },
            'claude --print': { code: 1, stdout: '', stderr: 'usage limit reached' },
          },
        }),
      }),
  },
  {
    name: 'api',
    ready: () =>
      createApiAdapter({
        endpoint: 'https://example.test',
        apiKey: 'k',
        stubExecute: () => Promise.resolve({ ok: true, output: 'hosted ok', artifacts: [] }),
      }),
    unavailable: () => createApiAdapter(),
    failing: () =>
      createApiAdapter({
        endpoint: 'https://example.test',
        apiKey: 'k',
        stubExecute: () =>
          Promise.resolve({ ok: false, error: AdapterError.rateLimited('hosted rate limited') }),
      }),
  },
];

describe.each(cases)('ExecutionAdapter contract: $name', (testCase) => {
  it('exposes a non-empty id and family', () => {
    const adapter = testCase.ready();
    expect(adapter.id.length).toBeGreaterThan(0);
    expect(String(adapter.family).length).toBeGreaterThan(0);
    expect(adapter.reportCapacity()).toBeGreaterThanOrEqual(0);
  });

  it('reports a well-formed setup state when ready', async () => {
    const setup = await testCase.ready().detectSetup();
    expect(typeof setup.available).toBe('boolean');
    expect(typeof setup.authenticated).toBe('boolean');
    expect(setup.available).toBe(true);
    expect(setup.authenticated).toBe(true);
    expect(setup.capacity).toBeGreaterThan(0);
  });

  it('reports unavailable + surfaces setup actions when not set up', async () => {
    const setup = await testCase.unavailable().detectSetup();
    expect(setup.available && setup.authenticated).toBe(false);
    expect(setup.capacity).toBe(0);
    expect(setup.setupActions?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns a normalized success result', async () => {
    const controller = new AbortController();
    const result = await testCase.ready().execute(task(), execOptions(controller.signal));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.artifacts)).toBe(true);
      expect(typeof result.output).toBe('string');
    }
  });

  it('honors an already-aborted signal (returns a cancelled failure, never throws)', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await testCase.ready().execute(task(), execOptions(controller.signal));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('cancelled');
    }
  });

  it('normalizes execution failures to an AdapterError (never throws)', async () => {
    const controller = new AbortController();
    const result = await testCase.failing().execute(task(), execOptions(controller.signal));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isAdapterError(result.error)).toBe(true);
      expect(result.error.kind.length).toBeGreaterThan(0);
    }
  });

  it('returns a normalized failure from an unavailable adapter (never throws)', async () => {
    const controller = new AbortController();
    const result = await testCase.unavailable().execute(task(), execOptions(controller.signal));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isAdapterError(result.error)).toBe(true);
    }
  });
});
