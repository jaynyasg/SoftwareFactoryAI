import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DuplicateModuleError,
  ModuleContractError,
  createModuleRegistry,
  loadModuleRegistry,
  parseModuleContract,
  type ModuleContract,
} from '../../src/index';

// This file lives at packages/core/test/genome; the repo root is four up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const GENOME_V1_DIR = join(REPO_ROOT, 'factory-genome', 'v1');

function contract(id: string, version: string): ModuleContract {
  return {
    id,
    version,
    title: `${id} ${version}`,
    description: 'A test module contract.',
    requiredInputs: [],
    expectedOutputs: ['out'],
    allowedTools: ['fs.read'],
    riskHint: { tier: 'low' },
    artifactContracts: [{ key: 'out', kind: 'code' }],
  };
}

describe('createModuleRegistry (in-memory)', () => {
  it('looks up by id (latest) and by id+version, and lists', () => {
    const registry = createModuleRegistry([
      contract('alpha', '1.0.0'),
      contract('alpha', '1.2.0'),
      contract('beta', '1.0.0'),
    ]);

    expect(registry.ids()).toEqual(['alpha', 'beta']);
    expect(registry.has('alpha')).toBe(true);
    expect(registry.has('missing')).toBe(false);
    expect(registry.get('alpha')?.version).toBe('1.2.0');
    expect(registry.getVersion('alpha', '1.0.0')?.version).toBe('1.0.0');
    expect(registry.versions('alpha')).toEqual(['1.0.0', '1.2.0']);
    expect(registry.list()).toHaveLength(3);
  });

  it('rejects a duplicate id+version', () => {
    expect(() =>
      createModuleRegistry([contract('alpha', '1.0.0'), contract('alpha', '1.0.0')]),
    ).toThrow(DuplicateModuleError);
  });
});

describe('parseModuleContract', () => {
  it('accepts a well-formed contract', () => {
    expect(() => parseModuleContract(contract('alpha', '1.0.0'))).not.toThrow();
  });

  it('reports every problem in one error', () => {
    let caught: unknown;
    try {
      parseModuleContract({
        id: '',
        version: '1.0.0',
        title: 'x',
        description: 'y',
        requiredInputs: 'not-an-array',
        expectedOutputs: [],
        allowedTools: ['fs.read'],
        artifactContracts: [{ key: 'ghost', kind: 'code' }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ModuleContractError);
    const issues = (caught as ModuleContractError).issues;
    expect(issues.some((issue) => issue.includes('id'))).toBe(true);
    expect(issues.some((issue) => issue.includes('requiredInputs'))).toBe(true);
    expect(issues.some((issue) => issue.includes('expectedOutputs'))).toBe(true);
    // ghost key is not in (empty) expectedOutputs.
    expect(issues.some((issue) => issue.includes('not listed in expectedOutputs'))).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(() => parseModuleContract(null)).toThrow(ModuleContractError);
  });
});

describe('loadModuleRegistry (factory-genome/v1)', () => {
  it('loads and validates the seven V1 modules', async () => {
    const { manifest, registry } = await loadModuleRegistry(GENOME_V1_DIR);

    expect(manifest.version).toBe('v1');
    expect(manifest.pipeline).toHaveLength(7);
    expect(registry.ids()).toEqual([
      'ai-brief',
      'api-contract',
      'data-model',
      'marketplace-ui',
      'provider-proposals',
      'qa-gates',
      'scaffold-app',
    ]);
    expect(registry.list()).toHaveLength(7);
  });

  it('encodes the coherent module dependency graph', async () => {
    const { registry } = await loadModuleRegistry(GENOME_V1_DIR);

    expect(registry.get('scaffold-app')?.dependsOn).toEqual([]);
    expect(registry.get('data-model')?.dependsOn).toContain('scaffold-app');
    expect(registry.get('api-contract')?.dependsOn).toContain('data-model');
    for (const downstream of ['marketplace-ui', 'ai-brief', 'provider-proposals']) {
      expect(registry.get(downstream)?.dependsOn).toContain('api-contract');
    }
    expect(registry.get('qa-gates')?.dependsOn).toEqual([
      'marketplace-ui',
      'ai-brief',
      'provider-proposals',
    ]);
  });

  it('sets risk hints above low for migrations and external network', async () => {
    const { registry } = await loadModuleRegistry(GENOME_V1_DIR);
    expect(registry.get('data-model')?.riskHint.dataMigration).toBe(true);
    expect(registry.get('ai-brief')?.riskHint.externalNetwork).toBe(true);
  });

  it('keeps required inputs and expected outputs coherent across the pipeline', async () => {
    const { registry } = await loadModuleRegistry(GENOME_V1_DIR);
    // Every required input of a module is produced by some module upstream.
    const produced = new Set<string>();
    for (const contractItem of [
      'scaffold-app',
      'data-model',
      'api-contract',
      'marketplace-ui',
      'ai-brief',
      'provider-proposals',
      'qa-gates',
    ].map((id) => registry.get(id))) {
      expect(contractItem).toBeDefined();
      for (const input of contractItem?.requiredInputs ?? []) {
        expect(produced.has(input)).toBe(true);
      }
      for (const output of contractItem?.expectedOutputs ?? []) {
        produced.add(output);
      }
    }
  });
});
