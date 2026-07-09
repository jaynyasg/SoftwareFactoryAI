/**
 * Minimal remote MCP bridge for web-hosted model clients.
 *
 * ChatGPT Apps and Claude custom connectors talk to internet-hosted tools from
 * their own cloud. This bridge exposes the factory's existing API as MCP tools
 * while keeping the ledger, planner, and command guard in one place.
 */
import { INTERVENTION_KINDS, verifyOperatorToken } from '@software-factory/core';
import type { ApiRequest, ApiResponse, App } from './app';
import type { LocalSession } from '../lib/session';

export interface McpHttpRequest {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface McpHandlerDeps {
  readonly app: App;
  readonly getSession: () => Promise<LocalSession>;
}

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TEXT_JSON = 'application/json; charset=utf-8';

const TOOLS: readonly McpTool[] = [
  {
    name: 'software_factory_create_run',
    description:
      'Create a Software Factory run from a prompt, PRD text, PRD reference, or any combination of them.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        prdRef: { type: 'string' },
        prdText: { type: 'string' },
        title: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['plan-only', 'research-and-plan', 'research-plan-and-start'],
          description:
            'plan-only (default) creates the blueprint; research-and-plan runs bounded research first; research-plan-and-start also records a start request that is preflighted and enqueued for the execution daemon.',
        },
        reviewMode: { type: 'string', enum: ['human', 'autonomous'] },
        requestedWorkerCap: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        localFolder: { type: 'string' },
        githubRepo: { type: 'string' },
        selectedAdapter: { type: 'string' },
        modelProfile: { type: 'string' },
        reasoningEffort: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_list_runs',
    description: 'List projected Software Factory runs, most recent first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'software_factory_get_run',
    description: 'Read the projected state for one Software Factory run.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_events',
    description: 'Read the ordered ledger events for one run, optionally after a sequence cursor.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        sinceSequence: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_cancel_run',
    description:
      'Cancel a run with an expected ledger version for stale-command protection. Cancellation propagates to queued and active execution work.',
    inputSchema: {
      type: 'object',
      required: ['runId', 'expectedVersion'],
      properties: {
        runId: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_start_run',
    description:
      'Start execution for a planned run. Runs the dry-run preflight rehearsal first and enqueues the run-execution job for the execution daemon; duplicate starts return the existing queue state.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_pause_run',
    description: 'Pause execution for a run: no new worker starts until resumed.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_resume_run',
    description: 'Resume a paused execution.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_retry_run',
    description:
      'Retry a failed, blocked, or abandoned execution (optionally focused on one ticket) within the bounded retry budget.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        ticketId: { type: 'string' },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_rerun_gates',
    description: 'Enqueue a quality-gate re-run job for a run.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_execution',
    description:
      'Read the projected execution state for a run: queue job, lease, preflight outcome, and open interventions.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_list_interventions',
    description:
      'List the operator intervention queue across runs, filterable by run, kind, severity, blocking stage, and open-only.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        kind: { type: 'string', enum: [...INTERVENTION_KINDS] },
        severity: { type: 'string', enum: ['info', 'success', 'warn', 'error', 'critical'] },
        blockingStage: { type: 'string' },
        open: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_resolve_intervention',
    description:
      'Resolve one operator intervention with a resolution note. Resolving an already-resolved intervention returns its existing state.',
    inputSchema: {
      type: 'object',
      required: ['interventionId', 'resolution'],
      properties: {
        interventionId: { type: 'string' },
        resolution: { type: 'string' },
        note: { type: 'string' },
        expectedVersion: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_trigger_research',
    description:
      'Trigger one bounded, source-backed research pass for a run. Idempotent: when research already ran, the existing projected state is returned instead of re-running (unless force is true).',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: {
        runId: { type: 'string' },
        objective: { type: 'string' },
        force: { type: 'boolean' },
        budget: {
          type: 'object',
          properties: {
            maxSources: { type: 'integer', minimum: 1 },
            maxDurationMs: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
        expectedVersion: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_research',
    description:
      'Read the projected research state for a run: status, sources, findings, assumptions, unresolved gaps, and the enriched brief summary.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_contract',
    description:
      'Read the build contract for a run (scope, workspace, write boundaries, risks, gates, deploy target, completion criteria). Null when no contract has been generated yet.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_preflight',
    description:
      'Read the latest dry-run preflight rehearsal outcome for a run, including the open preflight interventions blocking a start.',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_outputs',
    description:
      'Read the run artifact contract: package path, handoff and provenance references, gate evidence, deploy state, and the hosted URL (present ONLY after hosted health passed).',
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_get_setup',
    description:
      'Read cloud/local setup diagnostics: operator token, deploy readiness, research provider readiness, source checkout credentials, workspace source rules, and persistent-storage state. Credentials are reported by presence only; secret values are never emitted.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function asRequest(value: unknown): JsonRpcRequest | null {
  return typeof value === 'object' && value !== null ? (value as JsonRpcRequest) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bearer(headers: McpHttpRequest['headers']): string | undefined {
  const direct = headers['x-operator-token'];
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  const auth = headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  return undefined;
}

function json(status: number, body: unknown): ApiResponse {
  return { status, headers: { 'content-type': TEXT_JSON }, body };
}

function rpc(id: JsonRpcRequest['id'], result: unknown): ApiResponse {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): ApiResponse {
  return json(200, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  });
}

function toolResult(body: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    isError,
  };
}

/* ----------------------------------------------------------------------------
 * Concise summaries (U10): remote tools return run summaries plus links/ids,
 * never the full event ledger — `software_factory_get_events` stays the
 * explicit detail read.
 * ------------------------------------------------------------------------- */

/** Summarize a projected run: ledger rows become a count, PRD text a length. */
function summarizeRunValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const run = value as Record<string, unknown>;
  if (!Array.isArray(run.ledger)) {
    return value;
  }
  const { ledger, prdText, ...rest } = run;
  return {
    ...rest,
    ledgerEventCount: ledger.length,
    ...(typeof prdText === 'string' ? { prdTextChars: prdText.length } : {}),
  };
}

/** Relative detail links for a run (fetchable via the matching tools/routes). */
function runLinks(runId: string): Record<string, string> {
  const id = encodeURIComponent(runId);
  return {
    events: `/api/runs/${id}/events`,
    execution: `/api/runs/${id}/execution`,
    research: `/api/runs/${id}/research`,
    outputs: `/api/runs/${id}/outputs`,
  };
}

/** Tools that intentionally return event-level detail, exempt from trimming. */
const DETAIL_TOOLS: ReadonlySet<string> = new Set(['software_factory_get_events']);

/**
 * Trim a route response body for remote consumption: embedded run projections
 * are summarized and, when the target run is known, detail links are attached.
 */
function conciseBody(name: string, args: Record<string, unknown>, body: unknown): unknown {
  if (DETAIL_TOOLS.has(name) || typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const record: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (record.run !== undefined) {
    record.run = summarizeRunValue(record.run);
  }
  if (Array.isArray(record.runs)) {
    record.runs = record.runs.map(summarizeRunValue);
  }
  const runId = str(record.runId) ?? str(args.runId);
  if (runId !== undefined) {
    record.links = runLinks(runId);
  }
  return record;
}

async function requireSession(
  request: McpHttpRequest,
  deps: McpHandlerDeps,
): Promise<LocalSession | ApiResponse> {
  const token = bearer(request.headers);
  if (token === undefined) {
    return rpcError(null, -32001, 'Operator token is required.');
  }
  const session = await deps.getSession();
  if (!verifyOperatorToken(session.operatorToken, token)) {
    return rpcError(null, -32002, 'Operator token is invalid.');
  }
  return session;
}

function internalRequest(
  method: string,
  path: string,
  session: LocalSession,
  body?: unknown,
): ApiRequest {
  return {
    method,
    path,
    query: {},
    headers: {
      'x-operator-token': session.operatorToken,
      'x-csrf-token': session.csrfToken,
    },
    body,
  };
}

/** `/api/runs/:id` (plus an optional subpath), with the run id URL-encoded. */
function runPath(runId: string, subpath?: string): string {
  return `/api/runs/${encodeURIComponent(runId)}${subpath !== undefined ? `/${subpath}` : ''}`;
}

/** The standard error result for a run-scoped tool invoked without a runId. */
function missingRunId(): Record<string, unknown> {
  return toolResult({ error: 'runId is required.' }, true);
}

/** Run-scoped read tools that are plain GETs over the matching route. */
const RUN_READ_SUBPATH: Readonly<Record<string, string | undefined>> = {
  software_factory_get_run: undefined,
  software_factory_get_execution: 'execution',
  software_factory_get_research: 'research',
  software_factory_get_outputs: 'outputs',
};

async function callFactoryTool(
  name: string,
  args: Record<string, unknown>,
  request: McpHttpRequest,
  deps: McpHandlerDeps,
): Promise<Record<string, unknown>> {
  const sessionOrError = await requireSession(request, deps);
  if ('operatorToken' in sessionOrError) {
    const session = sessionOrError;
    let response: ApiResponse;
    switch (name) {
      case 'software_factory_create_run':
        response = await deps.app.handle(
          internalRequest('POST', '/api/runs', session, { ...args, callerFamily: 'api' }),
        );
        break;
      case 'software_factory_list_runs':
        response = await deps.app.handle(internalRequest('GET', '/api/runs', session));
        break;
      case 'software_factory_get_run':
      case 'software_factory_get_execution':
      case 'software_factory_get_research':
      case 'software_factory_get_outputs': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        response = await deps.app.handle(
          internalRequest('GET', runPath(runId, RUN_READ_SUBPATH[name]), session),
        );
        break;
      }
      case 'software_factory_get_events': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        response = await deps.app.handle(internalRequest('GET', runPath(runId, 'events'), session));
        const since = num(args.sinceSequence) ?? 0;
        if (response.status === 200 && since > 0) {
          const body = asRecord(response.body);
          const events = Array.isArray(body.events)
            ? body.events.filter(
                (event) =>
                  typeof event === 'object' &&
                  event !== null &&
                  Number((event as { sequence?: unknown }).sequence) > since,
              )
            : [];
          response = { ...response, body: { ...body, events } };
        }
        break;
      }
      case 'software_factory_cancel_run': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        response = await deps.app.handle(
          internalRequest('POST', runPath(runId, 'cancel'), session, {
            expectedVersion: num(args.expectedVersion),
            reason: str(args.reason),
          }),
        );
        break;
      }
      case 'software_factory_start_run':
      case 'software_factory_pause_run':
      case 'software_factory_resume_run':
      case 'software_factory_retry_run':
      case 'software_factory_rerun_gates': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        const subpath = {
          software_factory_start_run: 'start',
          software_factory_pause_run: 'pause',
          software_factory_resume_run: 'resume',
          software_factory_retry_run: 'retry',
          software_factory_rerun_gates: 'gates/rerun',
        }[name];
        response = await deps.app.handle(
          internalRequest('POST', runPath(runId, subpath), session, {
            expectedVersion: num(args.expectedVersion),
            reason: str(args.reason),
            ...(name === 'software_factory_retry_run' ? { ticketId: str(args.ticketId) } : {}),
          }),
        );
        break;
      }
      case 'software_factory_list_interventions': {
        const request = internalRequest('GET', '/api/interventions', session);
        const query: Record<string, string | undefined> = {
          runId: str(args.runId),
          kind: str(args.kind),
          severity: str(args.severity),
          blockingStage: str(args.blockingStage),
          open: args.open === true ? '1' : undefined,
        };
        response = await deps.app.handle({ ...request, query });
        break;
      }
      case 'software_factory_resolve_intervention': {
        const interventionId = str(args.interventionId);
        const resolution = str(args.resolution);
        if (interventionId === undefined || resolution === undefined) {
          return toolResult({ error: 'interventionId and resolution are required.' }, true);
        }
        response = await deps.app.handle(
          internalRequest(
            'POST',
            `/api/interventions/${encodeURIComponent(interventionId)}/resolve`,
            session,
            {
              resolution,
              note: str(args.note),
              expectedVersion: num(args.expectedVersion),
            },
          ),
        );
        break;
      }
      case 'software_factory_trigger_research': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        const budget = asRecord(args.budget);
        response = await deps.app.handle(
          internalRequest('POST', runPath(runId, 'research'), session, {
            objective: str(args.objective),
            force: args.force === true,
            budget: {
              maxSources: num(budget.maxSources),
              maxDurationMs: num(budget.maxDurationMs),
            },
            expectedVersion: num(args.expectedVersion),
          }),
        );
        break;
      }
      case 'software_factory_get_contract': {
        // Thin read over the run projection: the contract is replayed from
        // `contract.generated` ledger events, never invented here.
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        const runResponse = await deps.app.handle(internalRequest('GET', runPath(runId), session));
        if (runResponse.status !== 200) {
          response = runResponse;
          break;
        }
        const run = asRecord(asRecord(runResponse.body).run);
        const contract = run.buildContract ?? null;
        response = {
          status: 200,
          body: {
            runId,
            contract,
            ...(contract === null
              ? {
                  message:
                    'No build contract has been generated for this run yet. Research-enabled ' +
                    'run modes generate one after research and planning; starting execution ' +
                    'refreshes it.',
                }
              : {}),
          },
        };
        break;
      }
      case 'software_factory_get_preflight': {
        // Thin read over the execution projection, narrowed to the dry-run
        // rehearsal outcome plus the interventions blocking the start.
        const runId = str(args.runId);
        if (runId === undefined) {
          return missingRunId();
        }
        const executionResponse = await deps.app.handle(
          internalRequest('GET', runPath(runId, 'execution'), session),
        );
        if (executionResponse.status !== 200) {
          response = executionResponse;
          break;
        }
        const body = asRecord(executionResponse.body);
        const interventions = Array.isArray(body.interventions)
          ? body.interventions.filter((entry) => asRecord(entry).blockingStage === 'preflight')
          : [];
        response = {
          status: 200,
          body: { runId, preflight: body.preflight, execution: body.execution, interventions },
        };
        break;
      }
      case 'software_factory_get_setup':
        response = await deps.app.handle(internalRequest('GET', '/api/setup', session));
        break;
      default:
        return toolResult({ error: `Unknown tool: ${name}` }, true);
    }
    return toolResult(conciseBody(name, args, response.body ?? {}), response.status >= 400);
  }
  return toolResult(sessionOrError.body, true);
}

export async function handleMcpRequest(
  httpRequest: McpHttpRequest,
  deps: McpHandlerDeps,
): Promise<ApiResponse> {
  const request = asRequest(httpRequest.body);
  if (request === null || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(null, -32600, 'Invalid JSON-RPC request.');
  }

  switch (request.method) {
    case 'initialize': {
      const params = asRecord(request.params);
      return rpc(request.id, {
        protocolVersion: str(params.protocolVersion) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'software-factory', version: '0.1.0' },
      });
    }
    case 'notifications/initialized':
      return json(202, null);
    case 'tools/list':
      return rpc(request.id, { tools: TOOLS });
    case 'tools/call': {
      const params = asRecord(request.params);
      const name = str(params.name);
      if (name === undefined) {
        return rpcError(request.id, -32602, 'Tool name is required.');
      }
      const result = await callFactoryTool(name, asRecord(params.arguments), httpRequest, deps);
      return rpc(request.id, result);
    }
    case 'ping':
      return rpc(request.id, {});
    default:
      return rpcError(request.id, -32601, `Method not found: ${request.method}`);
  }
}
