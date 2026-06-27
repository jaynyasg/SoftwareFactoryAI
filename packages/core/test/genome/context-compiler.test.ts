import { describe, expect, it } from 'vitest';
import {
  compileContext,
  parseRunRequest,
  type ArtifactRef,
  type CompileContextInput,
  type ContextTicket,
  type ModuleContract,
} from '../../src/index';

const MODULE: ModuleContract = {
  id: 'api-contract',
  version: '1.0.0',
  title: 'API Contract',
  description: 'Define the API route contracts.',
  requiredInputs: ['data.schema', 'design.tokens'],
  expectedOutputs: ['api.contract'],
  allowedTools: ['fs.read', 'fs.write'],
  riskHint: { tier: 'low' },
  artifactContracts: [{ key: 'api.contract', kind: 'code', required: true }],
  dependsOn: ['data-model'],
};

const TICKET: ContextTicket = {
  id: 'api-contract',
  title: 'Define the API contract',
  moduleId: 'api-contract',
  riskTier: 'low',
};

function artifact(key: string): ArtifactRef {
  return { key, artifactId: `artifact-${key}`, kind: 'code' };
}

function baseInput(overrides: Partial<CompileContextInput> = {}): CompileContextInput {
  return {
    runRequest: parseRunRequest('Build an AI services marketplace for customers and providers.'),
    ticket: TICKET,
    moduleContract: MODULE,
    priorArtifacts: { 'data.schema': artifact('data.schema') },
    riskTier: 'low',
    ...overrides,
  };
}

describe('compileContext', () => {
  it('resolves available required inputs and reports missing ones explicitly', () => {
    const context = compileContext(baseInput());

    expect(context.resolvedInputs.map((input) => input.key)).toEqual(['data.schema']);
    expect(context.missingInputs).toEqual(['design.tokens']);
    expect(context.complete).toBe(false);
  });

  it('marks the context complete when all required inputs are present', () => {
    const context = compileContext(
      baseInput({
        priorArtifacts: {
          'data.schema': artifact('data.schema'),
          'design.tokens': artifact('design.tokens'),
        },
      }),
    );

    expect(context.missingInputs).toEqual([]);
    expect(context.complete).toBe(true);
    expect(context.resolvedInputs).toHaveLength(2);
  });

  it('enforces the tool allow-list and excludes disallowed tools', () => {
    const context = compileContext(
      baseInput({
        availableTools: ['fs.read', 'fs.write', 'shell.exec', 'net.fetch', 'secret.read'],
      }),
    );

    expect(context.allowedTools).toEqual(['fs.read', 'fs.write']);
    expect(context.allowedTools).not.toContain('secret.read');
    expect(context.allowedTools).not.toContain('shell.exec');
    expect(context.deniedTools).toEqual(['shell.exec', 'net.fetch', 'secret.read']);
  });

  it('defaults to the module allow-list when no available tools are given', () => {
    const context = compileContext(baseInput());
    expect(context.allowedTools).toEqual(['fs.read', 'fs.write']);
    expect(context.deniedTools).toEqual([]);
  });

  it('carries risk tier, gate feedback, and module metadata through', () => {
    const context = compileContext(
      baseInput({
        riskTier: 'medium',
        gateFeedback: [{ gate: 'test', reason: 'unit test failed', attempt: 1 }],
      }),
    );

    expect(context.riskTier).toBe('medium');
    expect(context.gateFeedback).toEqual([
      { gate: 'test', reason: 'unit test failed', attempt: 1 },
    ]);
    expect(context.moduleId).toBe('api-contract');
    expect(context.moduleVersion).toBe('1.0.0');
    expect(context.expectedOutputs).toEqual(['api.contract']);
    expect(context.intent).toBe('ai-services-marketplace');
  });

  it('is deterministic for identical inputs', () => {
    expect(compileContext(baseInput())).toEqual(compileContext(baseInput()));
  });
});
