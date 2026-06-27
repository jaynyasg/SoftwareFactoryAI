/**
 * Framework-agnostic local API for the Software Factory.
 *
 * `createApp(deps)` builds an app with two entry points:
 *   - `handle(req)` — a pure-ish request/response function over plain transport
 *     types, directly unit-testable with no socket, and
 *   - `listen(port, host)` — wraps Node `http` and binds to `127.0.0.1` by
 *     default (loopback-only) so the same handler can serve a real e2e.
 *
 * All collaborators are INJECTED: the event store (the source of truth from
 * `@software-factory/core`), the operator-token provider, a clock, an id
 * generator, and config (allowed origins, CSRF token). Nothing here reaches for
 * Next.js — the route handlers are plain functions registered by this factory.
 *
 * Mutating routes run through the shared command guard; read-only routes do not.
 * On guard denial the app appends exactly one security ledger event and returns
 * an error response WITHOUT any further side effects.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkCommand,
  createEventReader,
  createEventWriter,
  verifyOperatorToken,
} from '@software-factory/core';
import type {
  AppendableEvent,
  CommandGuardRequest,
  CommandRejectionReason,
  EventReader,
  EventStore,
  EventWriter,
  OperatorTokenProvider,
} from '@software-factory/core';
import { runRoutes } from './routes/runs';
import { eventRoutes } from './routes/events';
import { reviewRoutes } from './routes/review';
import { setupRoutes } from './routes/setup';
import { createGenomePlanner } from './planner';
import type { RunPlanInput, RunPlanner } from './planner';

export type { RunPlanInput, RunPlanner } from './planner';

/* ----------------------------------------------------------------------------
 * Transport types
 * ------------------------------------------------------------------------- */

/** A normalized inbound request. Header keys are lower-cased. */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body (or `undefined` for bodyless requests). */
  readonly body?: unknown;
}

/** A JSON response. `body` must be JSON-serializable. */
export interface ApiResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/* ----------------------------------------------------------------------------
 * App configuration and dependencies
 * ------------------------------------------------------------------------- */

export interface AppConfig {
  /** Exact-match allowed `Origin` values for mutating routes. */
  readonly allowedOrigins?: readonly string[];
  /** Expected CSRF double-submit token; when set, mutating routes require it. */
  readonly csrfToken?: string;
}

/** Fully-resolved config (defaults applied). */
export interface ResolvedConfig {
  readonly allowedOrigins: readonly string[];
  readonly csrfToken?: string;
}

export interface AppDeps {
  /** Append-only event store — the system of record. */
  readonly store: EventStore;
  /** Loopback operator token/session provider. */
  readonly operatorToken: OperatorTokenProvider;
  /** Wall-clock source (epoch ms). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Run-id source for new runs. Defaults to `run-<random>`. */
  readonly idGenerator?: () => string;
  /** Origin/CSRF configuration. */
  readonly config?: AppConfig;
  /**
   * Planner invoked after `run.created` to emit the supervisor decisions, ticket
   * DAG, and `run.planned` capstone into the same store. Defaults to the
   * genome-backed supervisor planner (`createGenomePlanner`). Pass `null` to
   * disable planning entirely (e.g. a unit test asserting only `run.created`).
   */
  readonly planner?: RunPlanner | null;
  /** Genome directory for the default planner. Defaults to `resolveGenomeDir()`. */
  readonly genomeDir?: string;
}

/* ----------------------------------------------------------------------------
 * Routing contracts (shared with route modules via `import type`)
 * ------------------------------------------------------------------------- */

/** Inputs a mutating route passes to the shared command guard. */
export interface GuardMutationInput {
  /** The subject the command targets (kind/id/version). */
  readonly subject: { readonly kind: string; readonly id: string; readonly version?: number };
  /** Current subject version from projected state, for the stale check. */
  readonly currentVersion?: number;
  /** Logical command name recorded on `security.command_rejected`. */
  readonly command: string;
  /** Run id the security event attaches to (defaults to a `run` subject's id). */
  readonly runId?: string;
}

/** Everything a route handler needs; injected per request. */
export interface RouteContext {
  readonly request: ApiRequest;
  readonly params: Readonly<Record<string, string>>;
  readonly store: EventStore;
  readonly reader: EventReader;
  readonly writer: EventWriter;
  readonly operatorToken: OperatorTokenProvider;
  readonly clock: () => number;
  readonly idGenerator: () => string;
  readonly config: ResolvedConfig;
  /**
   * Run the command guard for a mutating action. On denial it appends the
   * single security ledger event and resolves to the error `ApiResponse`; when
   * allowed it resolves to `null` and the caller proceeds.
   */
  guardMutation(input: GuardMutationInput): Promise<ApiResponse | null>;
  /**
   * Plan a just-created run into the store (supervisor.decision + ticket.created
   * + run.planned). Idempotent and a no-op when planning is disabled. Never
   * throws into the request path — planning failures are logged, not fatal,
   * because `run.created` is already durable.
   */
  planRun(runId: string, input: RunPlanInput): Promise<void>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<ApiResponse>;

/** A registered route. `pattern` segments may be `:params`. */
export interface RouteDef {
  readonly method: string;
  readonly pattern: string;
  readonly handler: RouteHandler;
}

/** A running loopback server handle. */
export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface App {
  handle(request: ApiRequest): Promise<ApiResponse>;
  listen(port?: number, host?: string): Promise<RunningServer>;
}

/* ----------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/** Build a JSON `ApiResponse`. */
export function json(status: number, body: unknown, headers?: Record<string, string>): ApiResponse {
  return { status, body, headers };
}

/** Map a guard rejection reason to an HTTP status. */
export function statusForRejection(reason: CommandRejectionReason): number {
  switch (reason) {
    case 'missing_token':
    case 'invalid_token':
      return 401;
    case 'origin_not_allowed':
    case 'csrf_failed':
      return 403;
    case 'stale_subject_version':
      return 409;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** Extract the operator token from the standard headers. */
function extractToken(headers: ApiRequest['headers']): string | undefined {
  const direct = headers['x-operator-token'];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  return undefined;
}

function defaultIdGenerator(): string {
  return `run-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function normalizePath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) {
    return path.replace(/\/+$/, '');
  }
  return path;
}

interface RouteMatch {
  readonly handler: RouteHandler;
  readonly params: Record<string, string>;
}

/** Match a method+path against the route table; tracks path-only hits for 405. */
function matchRoute(
  routes: readonly RouteDef[],
  method: string,
  path: string,
): { match: RouteMatch | null; pathMatched: boolean } {
  const target = path.split('/').filter((s) => s.length > 0);
  let pathMatched = false;

  for (const route of routes) {
    const segments = route.pattern.split('/').filter((s) => s.length > 0);
    if (segments.length !== target.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const value = target[i];
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(value);
      } else if (seg !== value) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      continue;
    }
    pathMatched = true;
    if (route.method.toUpperCase() === method.toUpperCase()) {
      return { match: { handler: route.handler, params }, pathMatched: true };
    }
  }
  return { match: null, pathMatched };
}

/* ----------------------------------------------------------------------------
 * App factory
 * ------------------------------------------------------------------------- */

export function createApp(deps: AppDeps): App {
  const { store, operatorToken } = deps;
  const clock = deps.clock ?? Date.now;
  const idGenerator = deps.idGenerator ?? defaultIdGenerator;
  const config: ResolvedConfig = {
    allowedOrigins: deps.config?.allowedOrigins ?? [],
    csrfToken: deps.config?.csrfToken,
  };
  const reader = createEventReader(store);
  const writer = createEventWriter(store);

  // `undefined` -> default genome planner; `null` -> planning disabled.
  const planner: RunPlanner | null =
    deps.planner === undefined ? createGenomePlanner({ genomeDir: deps.genomeDir }) : deps.planner;

  async function planRun(runId: string, input: RunPlanInput): Promise<void> {
    if (planner === null) {
      return;
    }
    try {
      await planner(writer, runId, input);
    } catch (error) {
      // `run.created` is already durable; a planning failure must not fail the
      // request. Keep it observable on the server rather than swallowing it.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[software-factory] run planning failed for ${runId}: ${message}`);
    }
  }

  const routes: RouteDef[] = [
    ...runRoutes(),
    ...eventRoutes(),
    ...reviewRoutes(),
    ...setupRoutes(),
  ];

  async function guardMutation(
    request: ApiRequest,
    input: GuardMutationInput,
  ): Promise<ApiResponse | null> {
    const session = await operatorToken.current();
    const guardRequest: CommandGuardRequest = {
      method: request.method,
      token: extractToken(request.headers),
      origin: request.headers['origin'],
      csrfHeader: request.headers['x-csrf-token'],
      subject: input.subject,
    };
    const result = checkCommand(guardRequest, {
      verifyToken: (token) => session !== null && verifyOperatorToken(session.token, token),
      allowedOrigins: config.allowedOrigins,
      csrfToken: config.csrfToken,
      currentSubjectVersion: input.currentVersion,
    });
    if (result.allowed) {
      return null;
    }

    // Denied: append exactly one security event and perform NO other side
    // effects (no workers/adapters/deploys/repo writes). The event is attached
    // to the run subject so the blocked attempt is auditable in the ledger.
    const runId = input.runId ?? (input.subject.kind === 'run' ? input.subject.id : undefined);
    if (runId !== undefined) {
      // Build each branch separately so the discriminated union narrows the
      // payload to the matching event type.
      const securityEvent: AppendableEvent =
        result.event === 'security.command_rejected'
          ? {
              runId,
              type: 'security.command_rejected',
              actor: { kind: 'operator', id: 'operator' },
              subject: input.subject,
              severity: result.severity,
              payload: { reason: result.reason, command: input.command },
            }
          : {
              runId,
              type: 'security.block',
              actor: { kind: 'operator', id: 'operator' },
              subject: input.subject,
              severity: result.severity,
              payload: { reason: result.reason },
            };
      await store.append(securityEvent);
    }
    return json(statusForRejection(result.reason), {
      error: result.reason,
      message: result.message,
    });
  }

  function buildContext(request: ApiRequest, params: Record<string, string>): RouteContext {
    return {
      request,
      params,
      store,
      reader,
      writer,
      operatorToken,
      clock,
      idGenerator,
      config,
      guardMutation: (input) => guardMutation(request, input),
      planRun,
    };
  }

  async function handle(request: ApiRequest): Promise<ApiResponse> {
    const path = normalizePath(request.path);
    const { match, pathMatched } = matchRoute(routes, request.method, path);
    if (match === null) {
      if (pathMatched) {
        return json(405, { error: 'method_not_allowed', message: `${request.method} ${path}` });
      }
      return json(404, { error: 'not_found', message: path });
    }
    try {
      return await match.handler(buildContext(request, match.params));
    } catch (error) {
      // Keep failures observable rather than silently swallowing them.
      const message = error instanceof Error ? error.message : String(error);
      return json(500, { error: 'internal_error', message });
    }
  }

  function listen(port = 0, host = '127.0.0.1'): Promise<RunningServer> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          const apiRequest = toApiRequest(req.method ?? 'GET', req.url ?? '/', req.headers, chunks);
          let response: ApiResponse;
          if (apiRequest === null) {
            response = json(400, {
              error: 'invalid_json',
              message: 'Request body is not valid JSON.',
            });
          } else {
            response = await handle(apiRequest);
          }
          const payload = response.body === undefined ? '' : JSON.stringify(response.body);
          res.writeHead(response.status, {
            'content-type': 'application/json; charset=utf-8',
            ...response.headers,
          });
          res.end(payload);
        })().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'internal_error', message }));
        });
      });
      req.on('error', () => {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'request_error' }));
      });
    });

    return new Promise<RunningServer>((resolve, reject) => {
      server.on('error', reject);
      server.listen(port, host, () => {
        const address = server.address() as AddressInfo | null;
        const actualPort = address?.port ?? port;
        resolve({
          url: `http://${host}:${actualPort}`,
          port: actualPort,
          close: () =>
            new Promise<void>((res, rej) => {
              server.close((err) => (err ? rej(err) : res()));
            }),
        });
      });
    });
  }

  return { handle, listen };
}

/** Convert a raw Node request into the normalized transport shape. */
function toApiRequest(
  method: string,
  rawUrl: string,
  rawHeaders: Record<string, string | string[] | undefined>,
  chunks: Buffer[],
): ApiRequest | null {
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const query: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  let body: unknown;
  if (chunks.length > 0) {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }
  return { method, path: url.pathname, query, headers, body };
}
