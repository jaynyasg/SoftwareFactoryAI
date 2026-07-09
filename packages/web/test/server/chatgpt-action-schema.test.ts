/**
 * ChatGPT Action schema contract tests (full-factory U10).
 *
 * The Action schema at `integrations/chatgpt/actions.openai.yaml` is a CONTRACT
 * for hosted web-model callers: this suite validates it as a REAL OpenAPI 3.1
 * document (structure valid, every $ref resolves) and then asserts the
 * lifecycle operations exist with the shapes remote callers rely on. It
 * replaces the earlier string-level `toContain` assertions that lived in
 * execution-routes.test.ts.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';

const SCHEMA_FILE = fileURLToPath(
  new URL('../../../../integrations/chatgpt/actions.openai.yaml', import.meta.url),
);

/** Every operation the Action schema must declare: id -> [METHOD, path]. */
const REQUIRED_OPERATIONS: Readonly<Record<string, readonly [string, string]>> = {
  getSetup: ['get', '/api/setup'],
  listRuns: ['get', '/api/runs'],
  createRun: ['post', '/api/runs'],
  getRun: ['get', '/api/runs/{runId}'],
  getRunEvents: ['get', '/api/runs/{runId}/events'],
  cancelRun: ['post', '/api/runs/{runId}/cancel'],
  startRun: ['post', '/api/runs/{runId}/start'],
  pauseRun: ['post', '/api/runs/{runId}/pause'],
  resumeRun: ['post', '/api/runs/{runId}/resume'],
  retryRun: ['post', '/api/runs/{runId}/retry'],
  rerunGates: ['post', '/api/runs/{runId}/gates/rerun'],
  getExecution: ['get', '/api/runs/{runId}/execution'],
  listInterventions: ['get', '/api/interventions'],
  resolveIntervention: ['post', '/api/interventions/{interventionId}/resolve'],
  triggerResearch: ['post', '/api/runs/{runId}/research'],
  getResearch: ['get', '/api/runs/{runId}/research'],
  getRunOutputs: ['get', '/api/runs/{runId}/outputs'],
};

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  expect(typeof value, 'expected an object').toBe('object');
  expect(value).not.toBeNull();
  return value as Rec;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** Collect operationId -> [method, path] from a (resolved) specification. */
function collectOperations(spec: Rec): Map<string, readonly [string, string]> {
  const operations = new Map<string, readonly [string, string]>();
  const paths = rec(spec.paths);
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(rec(pathItem))) {
      if (!HTTP_METHODS.includes(method)) {
        continue;
      }
      const id = rec(operation).operationId;
      expect(typeof id, `operation ${method.toUpperCase()} ${path} has no operationId`).toBe(
        'string',
      );
      expect(operations.has(id as string), `duplicate operationId ${id as string}`).toBe(false);
      operations.set(id as string, [method, path]);
    }
  }
  return operations;
}

describe('ChatGPT Action schema (integrations/chatgpt/actions.openai.yaml)', () => {
  let validator: Validator;
  let valid: boolean;
  let errors: unknown;
  /** The specification with every $ref resolved in place. */
  let resolved: Rec;

  beforeAll(async () => {
    validator = new Validator();
    const result = await validator.validate(SCHEMA_FILE);
    valid = result.valid;
    errors = result.errors;
    if (result.valid) {
      resolved = validator.resolveRefs() as Rec;
    }
  });

  it('is a structurally valid OpenAPI 3.1 document', () => {
    expect(valid, JSON.stringify(errors, null, 2)).toBe(true);
    expect(validator.version).toBe('3.1');
  });

  it('every $ref resolves (paths/operations/schemas)', () => {
    // `resolveRefs` throws on any dangling reference; reaching here with a
    // resolved document proves the parameter/schema refs all land.
    expect(resolved).toBeDefined();
    expect(rec(resolved.paths)).toBeTruthy();
  });

  it('declares every lifecycle operation on the expected method and path', () => {
    const operations = collectOperations(resolved);
    for (const [operationId, [method, path]] of Object.entries(REQUIRED_OPERATIONS)) {
      expect(operations.get(operationId), `missing operationId ${operationId}`).toEqual([
        method,
        path,
      ]);
    }
  });

  it('requires the runId path parameter on every run-scoped operation', () => {
    const paths = rec(resolved.paths);
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!path.includes('{runId}')) {
        continue;
      }
      for (const [method, operation] of Object.entries(rec(pathItem))) {
        if (!HTTP_METHODS.includes(method)) {
          continue;
        }
        const parameters = (rec(operation).parameters ?? []) as readonly unknown[];
        const runId = parameters
          .map((parameter) => rec(parameter))
          .find((parameter) => parameter.name === 'runId');
        expect(runId, `${method.toUpperCase()} ${path} lacks a runId parameter`).toBeDefined();
        expect(rec(runId).in).toBe('path');
        expect(rec(runId).required).toBe(true);
      }
    }
  });

  it('authenticates with the x-operator-token API key header', () => {
    const schemes = rec(rec(resolved.components).securitySchemes);
    const operator = rec(schemes.OperatorToken);
    expect(operator.type).toBe('apiKey');
    expect(operator.in).toBe('header');
    expect(operator.name).toBe('x-operator-token');
    expect(resolved.security).toEqual([{ OperatorToken: [] }]);
  });

  it('exposes the three run modes on run creation', () => {
    const schemas = rec(rec(resolved.components).schemas);
    const createRun = rec(schemas.CreateRunRequest);
    const mode = rec(rec(rec(createRun.properties)).mode);
    expect(mode.enum).toEqual(['plan-only', 'research-and-plan', 'research-plan-and-start']);
  });

  it('execution commands accept the optional expectedVersion stale check', () => {
    const schemas = rec(rec(resolved.components).schemas);
    const command = rec(schemas.ExecutionCommandRequest);
    const expectedVersion = rec(rec(rec(command.properties)).expectedVersion);
    expect(expectedVersion.type).toBe('integer');
    expect(expectedVersion.minimum).toBe(0);
  });

  it('projects run mode and executionState on the run projection', () => {
    const schemas = rec(rec(resolved.components).schemas);
    const run = rec(rec(schemas.RunProjection).properties);
    expect(rec(run.mode).type).toBe('string');
    expect(rec(run.executionState).type).toBe('string');
  });

  it('research trigger is idempotent-by-contract and budgeted', () => {
    const paths = rec(resolved.paths);
    const trigger = rec(rec(rec(paths['/api/runs/{runId}/research'])).post);
    const responses = rec(trigger.responses);
    // 200 = already researched (idempotent repeat), 201 = research ran.
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '201']));
    const schemas = rec(rec(resolved.components).schemas);
    const request = rec(rec(schemas.ResearchTriggerRequest).properties);
    expect(rec(request.budget)).toBeDefined();
    expect(rec(request.force)).toBeDefined();
  });

  it('run outputs contract keeps the hosted URL strict and links the event log', () => {
    const schemas = rec(rec(resolved.components).schemas);
    const outputs = rec(rec(schemas.RunOutputs).properties);
    for (const field of [
      'runId',
      'status',
      'tickets',
      'hostedUrl',
      'repoPath',
      'handoffRef',
      'provenanceRef',
      'deploy',
      'tests',
      'artifacts',
      'eventsUrl',
    ]) {
      expect(outputs[field], `RunOutputs is missing ${field}`).toBeDefined();
    }
    // Hosted URL only exists after hosted health passes (R29/R30).
    expect(String(rec(outputs.hostedUrl).description)).toMatch(/health/i);
    const deploy = rec(rec(rec(outputs.deploy)).properties);
    expect(rec(deploy.status).enum).toEqual(
      expect.arrayContaining(['setup_required', 'health_failed', 'hosted_ready']),
    );
    expect(rec(deploy.retryable).type).toBe('boolean');
  });
});
