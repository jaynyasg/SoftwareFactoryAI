/**
 * Genome module contract: the declared interface of one factory build module.
 *
 * A module contract states what a worker for that module may consume
 * (`requiredInputs`), must produce (`expectedOutputs` + `artifactContracts`),
 * and is allowed to use (`allowedTools`, an allow-list), plus a `riskHint` that
 * feeds risk-tier computation. Contracts are loaded from untrusted JSON, so a
 * runtime validator (`parseModuleContract`) narrows `unknown` and surfaces all
 * problems at once rather than trusting the shape.
 */
import type { RiskTier } from '../events/event-types';

/** Tiers accepted in a `riskHint.tier` field. */
const VALID_RISK_TIERS: readonly RiskTier[] = ['low', 'medium', 'high'];

/** The declared shape of one produced artifact. */
export interface ArtifactContract {
  /** Output key; must appear in the module's `expectedOutputs`. */
  readonly key: string;
  /** Coarse artifact kind, e.g. `code`, `schema`, `migration`, `report`. */
  readonly kind: string;
  /** Optional human description of the artifact. */
  readonly description?: string;
  /** Optional pointer to a schema or example for the artifact. */
  readonly schemaRef?: string;
  /** Whether the module must produce this artifact (defaults to required). */
  readonly required?: boolean;
}

/** Risk signals or an explicit tier floor hinted by a module. */
export interface ModuleRiskHint {
  /** An explicit tier floor for work in this module. */
  readonly tier?: RiskTier;
  readonly dependencyChange?: boolean;
  readonly authOrSecurity?: boolean;
  readonly deployChange?: boolean;
  readonly dataMigration?: boolean;
  readonly externalNetwork?: boolean;
  readonly destructive?: boolean;
}

/** A versioned, validated genome module contract. */
export interface ModuleContract {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  /** Context/artifact keys this module consumes (from prior modules). */
  readonly requiredInputs: readonly string[];
  /** Artifact keys this module is expected to produce. */
  readonly expectedOutputs: readonly string[];
  /** The allow-list of tools a worker may use for this module. */
  readonly allowedTools: readonly string[];
  /** Risk signals/hint that raise the risk tier of this module's work. */
  readonly riskHint: ModuleRiskHint;
  /** Declared shapes for the produced outputs. */
  readonly artifactContracts: readonly ArtifactContract[];
  /** Module ids this module depends on. */
  readonly dependsOn?: readonly string[];
}

/** Raised by `parseModuleContract` with every validation issue found. */
export class ModuleContractError extends Error {
  readonly code = 'invalid_module_contract';
  constructor(
    readonly issues: readonly string[],
    readonly source?: string,
  ) {
    super(
      `Invalid module contract${source !== undefined ? ` (${source})` : ''}: ${issues.join('; ')}`,
    );
    this.name = 'ModuleContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(
  value: unknown,
  field: string,
  issues: string[],
  { allowEmpty = true }: { allowEmpty?: boolean } = {},
): readonly string[] {
  if (value === undefined) {
    issues.push(`${field} is required and must be an array of strings.`);
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array of strings.`);
    return [];
  }
  const out: string[] = [];
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      issues.push(`${field}[${index}] must be a non-empty string.`);
      return;
    }
    out.push(entry);
  });
  if (!allowEmpty && out.length === 0) {
    issues.push(`${field} must contain at least one entry.`);
  }
  return out;
}

function validateRiskHint(value: unknown, issues: string[]): ModuleRiskHint {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    issues.push('riskHint must be an object.');
    return {};
  }
  const hint: {
    tier?: RiskTier;
    dependencyChange?: boolean;
    authOrSecurity?: boolean;
    deployChange?: boolean;
    dataMigration?: boolean;
    externalNetwork?: boolean;
    destructive?: boolean;
  } = {};
  if (value.tier !== undefined) {
    if (typeof value.tier === 'string' && (VALID_RISK_TIERS as string[]).includes(value.tier)) {
      hint.tier = value.tier as RiskTier;
    } else {
      issues.push(`riskHint.tier must be one of ${VALID_RISK_TIERS.join(', ')}.`);
    }
  }
  const booleanFields = [
    'dependencyChange',
    'authOrSecurity',
    'deployChange',
    'dataMigration',
    'externalNetwork',
    'destructive',
  ] as const;
  for (const field of booleanFields) {
    const fieldValue = value[field];
    if (fieldValue === undefined) {
      continue;
    }
    if (typeof fieldValue !== 'boolean') {
      issues.push(`riskHint.${field} must be a boolean.`);
      continue;
    }
    hint[field] = fieldValue;
  }
  return hint;
}

function validateArtifactContracts(
  value: unknown,
  expectedOutputs: readonly string[],
  issues: string[],
): readonly ArtifactContract[] {
  if (value === undefined) {
    issues.push('artifactContracts is required and must be an array.');
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push('artifactContracts must be an array.');
    return [];
  }
  const expected = new Set(expectedOutputs);
  const out: ArtifactContract[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push(`artifactContracts[${index}] must be an object.`);
      return;
    }
    if (!isNonEmptyString(entry.key)) {
      issues.push(`artifactContracts[${index}].key must be a non-empty string.`);
      return;
    }
    if (!isNonEmptyString(entry.kind)) {
      issues.push(`artifactContracts[${index}].kind must be a non-empty string.`);
      return;
    }
    if (!expected.has(entry.key)) {
      issues.push(
        `artifactContracts[${index}].key "${entry.key}" is not listed in expectedOutputs.`,
      );
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      issues.push(`artifactContracts[${index}].description must be a string.`);
    }
    if (entry.schemaRef !== undefined && typeof entry.schemaRef !== 'string') {
      issues.push(`artifactContracts[${index}].schemaRef must be a string.`);
    }
    if (entry.required !== undefined && typeof entry.required !== 'boolean') {
      issues.push(`artifactContracts[${index}].required must be a boolean.`);
    }
    out.push({
      key: entry.key,
      kind: entry.kind,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      schemaRef: typeof entry.schemaRef === 'string' ? entry.schemaRef : undefined,
      required: typeof entry.required === 'boolean' ? entry.required : undefined,
    });
  });
  return out;
}

/**
 * Validate `value` as a `ModuleContract`. Throws `ModuleContractError` listing
 * every problem found. `source` (e.g. a file path) is included in the message.
 */
export function parseModuleContract(value: unknown, source?: string): ModuleContract {
  const issues: string[] = [];

  if (!isRecord(value)) {
    throw new ModuleContractError(['module contract must be a JSON object.'], source);
  }

  if (!isNonEmptyString(value.id)) {
    issues.push('id must be a non-empty string.');
  }
  if (!isNonEmptyString(value.version)) {
    issues.push('version must be a non-empty string.');
  }
  if (!isNonEmptyString(value.title)) {
    issues.push('title must be a non-empty string.');
  }
  if (!isNonEmptyString(value.description)) {
    issues.push('description must be a non-empty string.');
  }

  const requiredInputs = validateStringArray(value.requiredInputs, 'requiredInputs', issues);
  const expectedOutputs = validateStringArray(value.expectedOutputs, 'expectedOutputs', issues, {
    allowEmpty: false,
  });
  const allowedTools = validateStringArray(value.allowedTools, 'allowedTools', issues);
  const riskHint = validateRiskHint(value.riskHint, issues);
  const artifactContracts = validateArtifactContracts(
    value.artifactContracts,
    expectedOutputs,
    issues,
  );
  const dependsOn =
    value.dependsOn === undefined
      ? undefined
      : validateStringArray(value.dependsOn, 'dependsOn', issues);

  if (issues.length > 0) {
    throw new ModuleContractError(issues, source);
  }

  return {
    id: value.id as string,
    version: value.version as string,
    title: value.title as string,
    description: value.description as string,
    requiredInputs,
    expectedOutputs,
    allowedTools,
    riskHint,
    artifactContracts,
    dependsOn,
  };
}

/** Type guard: `true` when `value` is a valid module contract. */
export function isModuleContract(value: unknown): value is ModuleContract {
  try {
    parseModuleContract(value);
    return true;
  } catch {
    return false;
  }
}
