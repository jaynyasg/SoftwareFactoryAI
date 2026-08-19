/**
 * Connector parity meta-test.
 *
 * The MCP bridge tool list and the ChatGPT Action operation list are both
 * hand-maintained — history shows a new web route can ship without either
 * connector noticing (the factory-wide drain gate + cancel-all did exactly
 * that). This suite derives the REAL route surface from the same route
 * factories `createApp` composes and asserts every route is either:
 *
 *   - mapped to a ChatGPT Action operationId (validated against the actual
 *     `integrations/chatgpt/actions.openai.yaml` on the matching method+path)
 *     AND an MCP tool name (validated against the actual `tools/list`), or
 *   - listed in the explicit EXCLUSIONS below with a written reason.
 *
 * Adding a route without updating `CONNECTOR_SURFACE` fails this suite, so
 * the next connector gap is a deliberate, reviewed decision — never a drift.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { Validator } from '@seriousme/openapi-schema-validator';
import type { App, RouteDef } from '../../src/server/app';
import { runRoutes } from '../../src/server/routes/runs';
import { eventRoutes } from '../../src/server/routes/events';
import { reviewRoutes } from '../../src/server/routes/review';
import { setupRoutes } from '../../src/server/routes/setup';
import { researchRoutes } from '../../src/server/research/research-routes';
import { executionRoutes } from '../../src/server/routes/execution';
import { handleMcpRequest } from '../../src/server/mcp';

const SCHEMA_FILE = fileURLToPath(
  new URL('../../../../integrations/chatgpt/actions.openai.yaml', import.meta.url),
);

/** One route's connector coverage: mapped to both surfaces OR excluded. */
interface ConnectorMapping {
  /** ChatGPT Action operationId that fronts this route. */
  readonly action?: string;
  /** MCP tool name that dispatches (or reads) through this route. */
  readonly mcp?: string;
  /** Deliberate web-only routes MUST say why (reviewed exclusion, not drift). */
  readonly excluded?: string;
}

/**
 * The single source of truth mapping `METHOD /pattern` -> connector coverage.
 * Keys must match the route factories exactly — a new route with no entry (or
 * a stale entry with no route) fails the surface test below.
 */
const CONNECTOR_SURFACE: Readonly<Record<string, ConnectorMapping>> = {
  // Run lifecycle.
  'POST /api/runs': { action: 'createRun', mcp: 'software_factory_create_run' },
  'GET /api/runs': { action: 'listRuns', mcp: 'software_factory_list_runs' },
  'POST /api/runs/cancel-all': {
    action: 'cancelAllRuns',
    mcp: 'software_factory_cancel_all_runs',
  },
  'POST /api/runs/clear-all': {
    action: 'clearAllRuns',
    mcp: 'software_factory_clear_all_runs',
  },
  'POST /api/runs/:id/cancel': { action: 'cancelRun', mcp: 'software_factory_cancel_run' },
  'GET /api/runs/:id': { action: 'getRun', mcp: 'software_factory_get_run' },
  'GET /api/runs/:id/events': { action: 'getRunEvents', mcp: 'software_factory_get_events' },
  'GET /api/runs/:id/outputs': { action: 'getRunOutputs', mcp: 'software_factory_get_outputs' },
  // Review.
  'POST /api/runs/:id/review': { action: 'reviewRun', mcp: 'software_factory_review_decide' },
  // Workspace materialization.
  'POST /api/runs/:id/workspace': {
    action: 'materializeWorkspace',
    mcp: 'software_factory_materialize_workspace',
  },
  'GET /api/runs/:id/workspace': { action: 'getWorkspace', mcp: 'software_factory_get_workspace' },
  // Research + knowledge.
  'POST /api/runs/:id/research': {
    action: 'triggerResearch',
    mcp: 'software_factory_trigger_research',
  },
  'GET /api/runs/:id/research': { action: 'getResearch', mcp: 'software_factory_get_research' },
  'GET /api/knowledge': {
    excluded:
      'Read-only knowledge-index query with E4 opt-in filters (includeStale/includeSensitive); ' +
      'web-only for now — remote agents consume knowledge through the run-scoped research, ' +
      'contract, and outputs reads instead of the raw index.',
  },
  // Execution controls (run-scoped).
  'POST /api/runs/:id/start': { action: 'startRun', mcp: 'software_factory_start_run' },
  'POST /api/runs/:id/pause': { action: 'pauseRun', mcp: 'software_factory_pause_run' },
  'POST /api/runs/:id/resume': { action: 'resumeRun', mcp: 'software_factory_resume_run' },
  'POST /api/runs/:id/retry': { action: 'retryRun', mcp: 'software_factory_retry_run' },
  'POST /api/runs/:id/gates/rerun': { action: 'rerunGates', mcp: 'software_factory_rerun_gates' },
  'GET /api/runs/:id/execution': { action: 'getExecution', mcp: 'software_factory_get_execution' },
  // Factory-wide drain gate (the daemon boots HELD by default).
  'GET /api/execution': {
    action: 'getExecutionOverview',
    mcp: 'software_factory_get_execution_overview',
  },
  'POST /api/execution/resume': {
    action: 'resumeExecution',
    mcp: 'software_factory_resume_execution',
  },
  'POST /api/execution/hold': { action: 'holdExecution', mcp: 'software_factory_hold_execution' },
  // Operator intervention queue.
  'GET /api/interventions': {
    action: 'listInterventions',
    mcp: 'software_factory_list_interventions',
  },
  'POST /api/interventions/:id/resolve': {
    action: 'resolveIntervention',
    mcp: 'software_factory_resolve_intervention',
  },
  // Setup diagnostics.
  'GET /api/setup': { action: 'getSetup', mcp: 'software_factory_get_setup' },
};

/** The same composition `createApp` uses — new factories must be added HERE. */
function allRoutes(): readonly RouteDef[] {
  return [
    ...runRoutes(),
    ...eventRoutes(),
    ...reviewRoutes(),
    ...setupRoutes(),
    ...researchRoutes(),
    ...executionRoutes(),
  ];
}

function routeKey(route: RouteDef): string {
  return `${route.method} ${route.pattern}`;
}

/**
 * Convert a route pattern to the Action schema's path template. Route
 * patterns use a positional `:id`; the Action names its path parameters by
 * subject (`{runId}`, `{interventionId}`).
 */
function actionPath(pattern: string): string {
  return pattern.startsWith('/api/interventions/')
    ? pattern.replace(':id', '{interventionId}')
    : pattern.replace(':id', '{runId}');
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec {
  expect(typeof value, 'expected an object').toBe('object');
  expect(value).not.toBeNull();
  return value as Rec;
}

/** operationId -> `METHOD /path` from the resolved Action specification. */
function collectActionOperations(spec: Rec): Map<string, string> {
  const operations = new Map<string, string>();
  for (const [path, pathItem] of Object.entries(rec(spec.paths))) {
    for (const [method, operation] of Object.entries(rec(pathItem))) {
      if (HTTP_METHODS.includes(method)) {
        operations.set(String(rec(operation).operationId), `${method.toUpperCase()} ${path}`);
      }
    }
  }
  return operations;
}

/**
 * The MCP tool names from the REAL `tools/list`. Listing tools requires no
 * auth and dispatches nothing, so the deps deliberately reject any use.
 */
async function listMcpToolNames(): Promise<readonly string[]> {
  const rejectingApp: App = {
    handle: () => Promise.reject(new Error('tools/list must not dispatch a route')),
    listen: () => Promise.reject(new Error('tools/list must not start a server')),
  };
  const response = await handleMcpRequest(
    { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: {} },
    { app: rejectingApp, getSession: () => Promise.reject(new Error('no session needed')) },
  );
  const body = response.body as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

describe('connector parity (routes <-> ChatGPT Action + MCP tools)', () => {
  let actionOperations: Map<string, string>;
  let mcpToolNames: readonly string[];

  beforeAll(async () => {
    const validator = new Validator();
    const result = await validator.validate(SCHEMA_FILE);
    expect(result.valid, JSON.stringify(result.errors, null, 2)).toBe(true);
    actionOperations = collectActionOperations(validator.resolveRefs() as Rec);
    mcpToolNames = await listMcpToolNames();
  });

  it('every registered route is mapped or explicitly excluded (and nothing is stale)', () => {
    const routeKeys = allRoutes().map(routeKey);
    // Route factories never register the same METHOD+pattern twice.
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    // Exact set equality both ways: a NEW route without a mapping fails here
    // (add it to CONNECTOR_SURFACE — or exclude it with a reason); a REMOVED
    // route leaves a stale mapping behind and fails here too.
    expect([...routeKeys].sort()).toEqual(Object.keys(CONNECTOR_SURFACE).sort());
  });

  it('mappings are well-formed: covered on BOTH surfaces or excluded with a reason', () => {
    for (const [key, mapping] of Object.entries(CONNECTOR_SURFACE)) {
      if (mapping.excluded !== undefined) {
        expect(mapping.excluded.length, `${key} exclusion needs a real reason`).toBeGreaterThan(10);
        expect(mapping.action, `${key} cannot be both excluded and Action-mapped`).toBeUndefined();
        expect(mapping.mcp, `${key} cannot be both excluded and MCP-mapped`).toBeUndefined();
        continue;
      }
      // Parity means BOTH connectors: a route reachable from ChatGPT but not
      // from Claude connectors (or vice versa) is exactly the drift this
      // suite exists to stop.
      expect(mapping.action, `${key} lacks a ChatGPT Action operationId`).toBeDefined();
      expect(mapping.mcp, `${key} lacks an MCP tool`).toBeDefined();
    }
  });

  it('every mapped Action operationId exists on the matching method and path', () => {
    for (const [key, mapping] of Object.entries(CONNECTOR_SURFACE)) {
      if (mapping.action === undefined) {
        continue;
      }
      const [method, pattern] = key.split(' ');
      expect(
        actionOperations.get(mapping.action),
        `Action operation ${mapping.action} (for ${key}) is missing or on the wrong method/path`,
      ).toBe(`${method} ${actionPath(pattern)}`);
    }
  });

  it('every mapped MCP tool exists in tools/list', () => {
    for (const [key, mapping] of Object.entries(CONNECTOR_SURFACE)) {
      if (mapping.mcp === undefined) {
        continue;
      }
      expect(mcpToolNames, `MCP tool ${mapping.mcp} (for ${key}) is not exposed`).toContain(
        mapping.mcp,
      );
    }
  });
});
