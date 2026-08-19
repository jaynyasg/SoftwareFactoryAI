/**
 * Model-override plumbing: an explicit `AdapterTask.model` must reach the CLI
 * as the adapter's model flag, and its absence must leave the invocation on
 * the adapter's default model. Also pins `resolveModelOverride`, the seam
 * that turns the run's `modelProfile` setting into that task field (legacy
 * sentinel profiles mean "adapter default" and must never leak into a flag).
 */
import { describe, expect, it } from 'vitest';
import {
  createClaudeCodeCliAdapter,
  createCodexCliAdapter,
  resolveModelOverride,
} from '@software-factory/core';
import type { AdapterTask, WorkerContext } from '@software-factory/core';
import { createFakeRunner } from '../_helpers/fake-runner';

function context(): WorkerContext {
  return {
    ticketId: 'tkt-1',
    title: 'Model ticket',
    moduleId: 'm',
    moduleVersion: '1.0.0',
    intent: 'ai-services-marketplace',
    prompt: 'Do the thing.',
    riskTier: 'low',
    resolvedInputs: [],
    missingInputs: [],
    allowedTools: [],
    deniedTools: [],
    expectedOutputs: ['output'],
    artifactContracts: [],
    gateFeedback: [],
    complete: true,
  };
}

function task(model?: string): AdapterTask {
  return {
    runId: 'run-1',
    ticketId: 'tkt-1',
    title: 'Model ticket',
    context: context(),
    workspaceDir: '/tmp/ws',
    model,
  };
}

const signal = new AbortController().signal;
const execOptions = { signal, onEvent: () => {} };

describe('CLI adapters pass the task model through as a model flag', () => {
  it('claude-code-cli adds --model <id> when the task carries a model', async () => {
    const runner = createFakeRunner({
      responses: { 'claude --print': { code: 0, stdout: '{"ok":true}', stderr: '' } },
    });
    const adapter = createClaudeCodeCliAdapter({ runner });

    await adapter.execute(task('claude-opus-5'), execOptions);

    const exec = runner.calls.find((call) => call.args[0] === '--print');
    expect(exec, 'claude exec invocation').toBeDefined();
    const modelIndex = exec!.args.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(exec!.args[modelIndex + 1]).toBe('claude-opus-5');
  });

  it('codex-cli adds --model <id> before the prompt when the task carries a model', async () => {
    const runner = createFakeRunner({
      responses: { 'codex exec': { code: 0, stdout: '{"ok":true}', stderr: '' } },
    });
    const adapter = createCodexCliAdapter({ runner });

    await adapter.execute(task('openai-group/gpt-5.3-codex'), execOptions);

    const exec = runner.calls.find((call) => call.args[0] === 'exec');
    expect(exec, 'codex exec invocation').toBeDefined();
    const modelIndex = exec!.args.indexOf('--model');
    expect(modelIndex).toBeGreaterThan(-1);
    expect(exec!.args[modelIndex + 1]).toBe('openai-group/gpt-5.3-codex');
    // The prompt stays the LAST positional argument.
    expect(exec!.args[exec!.args.length - 1]).toContain('Model ticket');
  });

  it('omits the model flag entirely when the task has no model', async () => {
    const claudeRunner = createFakeRunner({
      responses: { 'claude --print': { code: 0, stdout: '{"ok":true}', stderr: '' } },
    });
    await createClaudeCodeCliAdapter({ runner: claudeRunner }).execute(task(), execOptions);
    const claudeExec = claudeRunner.calls.find((call) => call.args[0] === '--print');
    expect(claudeExec!.args).not.toContain('--model');

    const codexRunner = createFakeRunner({
      responses: { 'codex exec': { code: 0, stdout: '{"ok":true}', stderr: '' } },
    });
    await createCodexCliAdapter({ runner: codexRunner }).execute(task(), execOptions);
    const codexExec = codexRunner.calls.find((call) => call.args[0] === 'exec');
    expect(codexExec!.args).not.toContain('--model');
  });
});

describe('resolveModelOverride (run.modelProfile -> task model)', () => {
  it('passes real model ids through, trimmed', () => {
    expect(resolveModelOverride('claude-opus-5')).toBe('claude-opus-5');
    expect(resolveModelOverride('  gpt-5.1-codex-max  ')).toBe('gpt-5.1-codex-max');
  });

  it('resolves sentinel/legacy "default" profiles and empty values to undefined', () => {
    expect(resolveModelOverride(undefined)).toBeUndefined();
    expect(resolveModelOverride('')).toBeUndefined();
    expect(resolveModelOverride('  ')).toBeUndefined();
    expect(resolveModelOverride('default')).toBeUndefined();
    expect(resolveModelOverride('adapter-default')).toBeUndefined();
    expect(resolveModelOverride('codex-default')).toBeUndefined();
    expect(resolveModelOverride('claude-default')).toBeUndefined();
    expect(resolveModelOverride('api-override')).toBeUndefined();
  });
});
