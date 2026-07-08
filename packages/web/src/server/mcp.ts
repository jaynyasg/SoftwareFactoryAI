/**
 * Minimal remote MCP bridge for web-hosted model clients.
 *
 * ChatGPT Apps and Claude custom connectors talk to internet-hosted tools from
 * their own cloud. This bridge exposes the factory's existing API as MCP tools
 * while keeping the ledger, planner, and command guard in one place.
 */
import { verifyOperatorToken } from '@software-factory/core';
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
        kind: {
          type: 'string',
          enum: [
            'approval',
            'missing_credentials',
            'source_choice',
            'unsafe_path',
            'adapter_setup',
            'deploy_setup',
            'retry_choice',
            'policy_block',
          ],
        },
        severity: { type: 'string', enum: ['info', 'success', 'warn', 'error', 'critical'] },
        blockingStage: { type: 'string' },
        open: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'software_factory_resolve_intervention',
    description: 'Resolve one operator intervention with a resolution note.',
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
      case 'software_factory_get_run': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return toolResult({ error: 'runId is required.' }, true);
        }
        response = await deps.app.handle(
          internalRequest('GET', `/api/runs/${encodeURIComponent(runId)}`, session),
        );
        break;
      }
      case 'software_factory_get_events': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return toolResult({ error: 'runId is required.' }, true);
        }
        response = await deps.app.handle(
          internalRequest('GET', `/api/runs/${encodeURIComponent(runId)}/events`, session),
        );
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
          return toolResult({ error: 'runId is required.' }, true);
        }
        response = await deps.app.handle(
          internalRequest('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, session, {
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
          return toolResult({ error: 'runId is required.' }, true);
        }
        const subpath = {
          software_factory_start_run: 'start',
          software_factory_pause_run: 'pause',
          software_factory_resume_run: 'resume',
          software_factory_retry_run: 'retry',
          software_factory_rerun_gates: 'gates/rerun',
        }[name];
        response = await deps.app.handle(
          internalRequest('POST', `/api/runs/${encodeURIComponent(runId)}/${subpath}`, session, {
            expectedVersion: num(args.expectedVersion),
            reason: str(args.reason),
            ...(name === 'software_factory_retry_run' ? { ticketId: str(args.ticketId) } : {}),
          }),
        );
        break;
      }
      case 'software_factory_get_execution': {
        const runId = str(args.runId);
        if (runId === undefined) {
          return toolResult({ error: 'runId is required.' }, true);
        }
        response = await deps.app.handle(
          internalRequest('GET', `/api/runs/${encodeURIComponent(runId)}/execution`, session),
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
      default:
        return toolResult({ error: `Unknown tool: ${name}` }, true);
    }
    return toolResult(response.body ?? {}, response.status >= 400);
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
