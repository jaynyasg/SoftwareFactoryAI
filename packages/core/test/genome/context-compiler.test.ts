import { describe, expect, it } from 'vitest';
import {
  compileContext,
  compileExecutionNodes,
  createModuleRegistry,
  fallbackModuleContract,
  parseRunRequest,
  type ArtifactRef,
  type CompileContextInput,
  type ContextTicket,
  type ExecutableTicket,
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

/* ----------------------------------------------------------------------------
 * compileExecutionNodes (U6): projected ticket DAG -> scheduler nodes
 * ------------------------------------------------------------------------- */

function module(
  id: string,
  requiredInputs: readonly string[],
  expectedOutputs: readonly string[],
): ModuleContract {
  return {
    id,
    version: '1.0.0',
    title: `Module ${id}`,
    description: `Test module ${id}.`,
    requiredInputs: [...requiredInputs],
    expectedOutputs: [...expectedOutputs],
    allowedTools: ['fs.read', 'fs.write'],
    riskHint: {},
    artifactContracts: expectedOutputs.map((key) => ({ key, kind: 'code', required: true })),
  };
}

const EXEC_TICKETS: readonly ExecutableTicket[] = [
  {
    ticketId: 'scaffold',
    title: 'Scaffold the app',
    moduleId: 'scaffold-app',
    dependsOn: [],
    riskTier: 'low',
    state: 'completed',
  },
  {
    ticketId: 'data-model',
    title: 'Define the data model',
    moduleId: 'data-model',
    dependsOn: ['scaffold'],
    riskTier: 'medium',
    state: 'created',
  },
  {
    ticketId: 'review-acceptance',
    title: 'Implement review and acceptance',
    dependsOn: ['data-model'],
    state: 'created',
  },
];

function execRegistry(): ReturnType<typeof createModuleRegistry> {
  return createModuleRegistry([
    module('scaffold-app', [], ['app.scaffold']),
    module('data-model', ['app.scaffold'], ['data.schema']),
  ]);
}

describe('compileExecutionNodes (U6)', () => {
  const runRequest = parseRunRequest(
    'Build an AI services marketplace for customers and providers with proposals.',
  );

  function plan() {
    return compileExecutionNodes({
      runRequest,
      tickets: EXEC_TICKETS,
      modules: execRegistry(),
      workspaceDir: '/ws/run-1',
    });
  }

  it('maps every projected ticket onto a node with workspace, risk, and deps', () => {
    const { nodes } = plan();
    expect(nodes.map((node) => node.id)).toEqual(['scaffold', 'data-model', 'review-acceptance']);
    for (const node of nodes) {
      expect(node.workspaceDir).toBe('/ws/run-1');
    }
    expect(nodes[1].dependsOn).toEqual(['scaffold']);
    expect(nodes[1].riskTier).toBe('medium');
    expect(nodes[2].riskTier).toBe('low'); // default when the projection has none
  });

  it('pre-settles tickets the ledger already recorded as completed', () => {
    expect(plan().completed).toEqual(['scaffold']);
  });

  it('resolves required inputs from the producing ticket declared outputs', () => {
    const { nodes } = plan();
    const dataModel = nodes.find((node) => node.id === 'data-model');
    const prior = dataModel?.compileInput.priorArtifacts ?? {};
    expect(Object.keys(prior)).toEqual(['app.scaffold']);
    expect(prior['app.scaffold'].summary).toContain('"scaffold"');
    expect(prior['app.scaffold'].kind).toBe('code');
    // The compiled context therefore has no missing inputs.
    expect(compileContext(dataModel!.compileInput).complete).toBe(true);
  });

  it('derives write scopes from expected-output keys so shared outputs conflict', () => {
    const { nodes } = plan();
    expect(nodes.find((node) => node.id === 'data-model')?.writeScope).toEqual([
      'outputs/data.schema',
    ]);
    // Fallback tickets scope their own generic output (distinct per ticket).
    expect(nodes.find((node) => node.id === 'review-acceptance')?.writeScope).toEqual([
      'outputs/ticket.review-acceptance.output',
    ]);
  });

  it('uses the fallback module contract for tickets without a registered module', () => {
    const { nodes } = plan();
    const fallbackNode = nodes.find((node) => node.id === 'review-acceptance');
    expect(fallbackNode?.moduleId).toBe('ticket/review-acceptance');
    expect(fallbackNode?.expectedOutputs).toEqual(['ticket.review-acceptance.output']);

    const contract = fallbackModuleContract('review-acceptance', 'Implement review');
    expect(contract.allowedTools).toEqual(['fs.read', 'fs.write', 'shell.exec']);
    expect(contract.requiredInputs).toEqual([]);
  });

  it('is deterministic for identical inputs', () => {
    expect(plan()).toEqual(plan());
  });
});
