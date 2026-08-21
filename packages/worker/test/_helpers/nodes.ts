/**
 * Builders for minimal, valid scheduler inputs: a `CompileContextInput` and a
 * `ScheduleNode`. These keep the concurrency/scheduler tests focused on
 * scheduling behavior rather than on assembling genome/run plumbing.
 */
import { parseRunRequest } from '@software-factory/core';
import type { CompileContextInput, ModuleContract } from '@software-factory/core';
import type { ScheduleNode } from '../../src/index';

const MODULE: ModuleContract = {
  id: 'test-module',
  version: '1.0.0',
  title: 'Test Module',
  description: 'A minimal module contract for scheduler tests.',
  requiredInputs: [],
  expectedOutputs: ['output'],
  allowedTools: ['fs.read', 'fs.write'],
  riskHint: { tier: 'low' },
  artifactContracts: [{ key: 'output', kind: 'code', required: true }],
};

const RUN_REQUEST = parseRunRequest(
  'Build an AI services marketplace for customers and providers with proposals.',
);

export function makeCompileInput(ticketId: string): CompileContextInput {
  return {
    runRequest: RUN_REQUEST,
    ticket: { id: ticketId, title: `Ticket ${ticketId}`, moduleId: MODULE.id, riskTier: 'low' },
    moduleContract: MODULE,
    priorArtifacts: {},
    riskTier: 'low',
  };
}

export interface MakeNodeOptions {
  readonly dependsOn?: readonly string[];
  readonly writeScope?: readonly string[];
  readonly callerFamily?: string;
  readonly workspaceDir?: string;
}

export function makeNode(id: string, options: MakeNodeOptions = {}): ScheduleNode {
  return {
    id,
    dependsOn: options.dependsOn ?? [],
    title: `Ticket ${id}`,
    riskTier: 'low',
    workspaceDir: options.workspaceDir ?? `/tmp/ws/${id}`,
    compileInput: makeCompileInput(id),
    writeScope: options.writeScope,
    callerFamily: options.callerFamily,
  };
}

/** Build `count` independent nodes with distinct, non-conflicting write scopes. */
export function makeIndependentNodes(count: number, prefix = 't'): ScheduleNode[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeNode(`${prefix}${index + 1}`, { writeScope: [`src/${prefix}${index + 1}.ts`] }),
  );
}
