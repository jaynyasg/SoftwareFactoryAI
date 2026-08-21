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
  createDefaultAdapterCatalog,
  createEventReader,
  createEventWriter,
  verifyOperatorToken,
} from '@software-factory/core';
import { resolveAdapterCatalogOptions } from './adapter-env';
import { deriveClientIp } from './auth/throttle';
import type { AuthService } from './auth/service';
import type { Identity } from './auth/records';
import type {
  AdapterCatalog,
  AppendableEvent,
  CommandGuardRequest,
  CommandRejectionReason,
  CredentialVault,
  EventReader,
  EventStore,
  EventWriter,
  OperatorTokenProvider,
} from '@software-factory/core';
import { runRoutes } from './routes/runs';
import { authRoutes } from './routes/auth';
import { credentialRoutes } from './routes/credentials';
import type { CredentialProber } from './routes/credentials';
import { createRuntimeCredentialProber } from './execution/credential-prober';
import { eventRoutes } from './routes/events';
import { reviewRoutes } from './routes/review';
import { setupRoutes } from './routes/setup';
import { executionRoutes } from './routes/execution';
import { fsRoutes } from './routes/fs';
import { researchRoutes } from './research/research-routes';
import { createRuntimePreflight } from './execution/preflight';
import type { PreflightRunResult, PreflightRunner } from './execution/preflight';
import type { ExecutionDaemon } from './execution/daemon';
import { createRuntimeResearcher } from './research/runtime-researcher';
import type { ResearchTriggerInput, RunResearcher } from './research/runtime-researcher';
import {
  createRuntimeWorkspaceMaterializer,
  createRuntimeWorkspacePublisher,
} from './workspace/runtime-materializer';
import type {
  RunWorkspaceMaterializer,
  RunWorkspacePublisher,
  WorkspacePublishOutcome,
  WorkspaceTriggerInput,
} from './workspace/runtime-materializer';
import { createGenomePlanner } from './planner';
import type { RunPlanInput, RunPlanner } from './planner';
import type { RuntimeConfig } from './runtime';
import type { ResearchRunResult, WorkspaceMaterializationResult } from '@software-factory/worker';

export type { RunPlanInput, RunPlanner } from './planner';
export type { ResearchTriggerInput, RunResearcher } from './research/runtime-researcher';
export type {
  RunWorkspaceMaterializer,
  WorkspaceTriggerInput,
} from './workspace/runtime-materializer';
export type { ExecutionDaemon } from './execution/daemon';
export type { PreflightRunner, PreflightRunResult } from './execution/preflight';

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
  /** Also allow browser requests whose Origin host matches Host/X-Forwarded-Host. */
  readonly allowSameHostOrigin?: boolean;
  /** Expected CSRF double-submit token; when set, mutating routes require it. */
  readonly csrfToken?: string;
  /** Runtime metadata surfaced by setup/readiness routes. */
  readonly runtime?: RuntimeConfig;
}

/** Fully-resolved config (defaults applied). */
export interface ResolvedConfig {
  readonly allowedOrigins: readonly string[];
  readonly allowSameHostOrigin: boolean;
  readonly csrfToken?: string;
  readonly runtime?: RuntimeConfig;
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
  /**
   * Researcher invoked by the research trigger route to run one bounded,
   * source-backed research pass (emitting `research.*` / `knowledge.*` events
   * into the same store). Defaults to the runtime researcher built from the
   * runtime config (`createRuntimeResearcher`). Pass `null` to disable the
   * research trigger entirely.
   */
  readonly researcher?: RunResearcher | null;
  /**
   * Workspace materializer invoked by the workspace trigger route to bind a
   * local folder or check out a repository for a run (emitting `workspace.*`
   * events into the same store). Defaults to the runtime materializer built
   * from the runtime config (`createRuntimeWorkspaceMaterializer`). Pass `null`
   * to disable the workspace trigger entirely.
   */
  readonly materializer?: RunWorkspaceMaterializer | null;
  /**
   * Workspace publisher for the completion report's "publish to GitHub"
   * action. Defaults to the runtime publisher; pass `null` to disable.
   */
  readonly publisher?: RunWorkspacePublisher | null;
  /**
   * Execution daemon (full-factory U5, hardening E1). The daemon OWNS worker
   * execution; routes only enqueue/mutate queue state and `notify()` it.
   * Unlike the researcher/materializer, the app never constructs a daemon
   * itself: its lifecycle (start/stop, exactly once per process) belongs to
   * the server entry points — `instance.ts` (Next-mounted singleton) and
   * `standalone.ts`. Omitted/`null` disables the execution command surface
   * (start/pause/resume/retry/gates fail closed with 503).
   */
  readonly execution?: ExecutionDaemon | null;
  /**
   * Preflight runner (X2 dry-run rehearsal) invoked before a start may
   * enqueue execution. Defaults to the runtime preflight built from the
   * runtime config (`createRuntimePreflight`). Pass `null` to disable — start
   * then fails closed rather than skipping the rehearsal.
   */
  readonly preflight?: PreflightRunner | null;
  /**
   * Adapter catalog for the preflight adapter readiness check (U6). Defaults
   * to the real default catalog (Codex/Claude CLIs + hosted API stub); tests
   * inject fakes. Pass `null` to run without a catalog — adapter readiness is
   * then enforced fail-closed at execution time by the scheduler setup probe.
   */
  readonly adapterCatalog?: AdapterCatalog | null;
  /**
   * Multi-user auth (U3). Present = multi-user mode ON: identities resolve
   * from session cookies and per-user `sfai_` API tokens, declared route
   * access is enforced, the shared operator token is REFUSED with a
   * migration message, and per-session CSRF replaces the process-wide token.
   * Absent/null = single-tenant: today's behavior byte-for-byte.
   */
  readonly auth?: {
    readonly service: AuthService;
    /** SF_INSECURE_COOKIES=1: plain-HTTP LAN opt-out (drops __Host-/Secure). */
    readonly insecureCookies?: boolean;
  } | null;
  /**
   * Per-user credential vault (multi-user U7+): used by the revocation
   * cascade (wipe the revoked user's credentials) and the wizard routes
   * (U10). Absent/null = no vault on this instance.
   */
  readonly credentialVault?: CredentialVault | null;
  /**
   * Live credential probe (U10). Defaults to the runtime prober (bound-
   * adapter probes + provider API pings); tests inject fakes.
   */
  readonly credentialProber?: CredentialProber;
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
  /**
   * Run one bounded research pass for a run. Resolves `null` when research is
   * disabled. Runner-level problems (budget, providers, credentials) are
   * recorded as ledger gaps/setup events by the runner itself; an unexpected
   * researcher error is appended as `research.failed` rather than thrown into
   * the request path.
   */
  runResearch(runId: string, input: ResearchTriggerInput): Promise<ResearchRunResult | null>;
  /**
   * Whether a researcher is wired on this instance. Research-enabled run modes
   * fail closed (503) at creation time when this is false, instead of minting a
   * run that can never satisfy its requested mode.
   */
  readonly researchEnabled: boolean;
  /**
   * Run one workspace materialization pass for a run (full-factory U4).
   * Resolves `null` when materialization is disabled. Source/setup/checkout
   * problems are recorded as ledger states by the materializer itself and
   * never thrown into the request path.
   */
  materializeWorkspace(
    runId: string,
    input: WorkspaceTriggerInput,
  ): Promise<WorkspaceMaterializationResult | null>;
  /** Whether a workspace materializer is wired on this instance. */
  readonly workspaceEnabled: boolean;
  /**
   * Publish a run's ready repo-checkout back to its GitHub remote (commit +
   * push, recorded as `workspace.published`). `null` when publishing is
   * disabled on this instance.
   */
  publishWorkspace(runId: string): Promise<WorkspacePublishOutcome | null>;
  /**
   * The process execution daemon (U5), or `null` when execution controls are
   * disabled on this instance. Routes use it ONLY to `notify()` after queue
   * mutations and to propagate cancellation — never to run work in-request.
   */
  readonly executionDaemon: ExecutionDaemon | null;
  /**
   * The configured adapter catalog (U6), or `null` when this instance runs
   * without one. Routes use it ONLY for read-only setup detection — selection
   * and execution keep going through preflight/executor.
   */
  readonly adapterCatalog: AdapterCatalog | null;
  /**
   * The resolved caller identity (multi-user U3). In single-tenant mode this
   * is the implicit admin; in multi-user mode it is the session/API-token
   * identity, and `null` never reaches a non-public handler (the dispatcher
   * rejects first).
   */
  readonly identity: Identity | null;
  /** The auth service in multi-user mode, `null` in single-tenant mode. */
  readonly authService: AuthService | null;
  /** The credential vault when configured on this instance (U7/U10). */
  readonly credentialVault: CredentialVault | null;
  /** Live credential probe for the wizard save routes (U10). */
  readonly credentialProber: CredentialProber;
  /** Whether multi-user auth is active on this instance. */
  readonly multiUser: boolean;
  /** Session-cookie writer for auth routes (mode-aware naming/flags). */
  sessionCookie(value: string | null): string;
  /** The caller's throttle key (proxy-aware client IP). */
  readonly clientIp: string;
  /**
   * Run one preflight rehearsal pass (X2) for a run, appending `preflight.*`
   * events and interventions for failures. Resolves `null` when preflight is
   * disabled (start then fails closed).
   */
  runPreflight(runId: string): Promise<PreflightRunResult | null>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<ApiResponse>;

/**
 * Declared access class for a route (multi-user U3). Enforcement is
 * DEFAULT-DENY: createApp refuses to register a route without a valid class,
 * so a new route can never ship unguarded by omission.
 *
 *  - `public`        — reachable anonymously in every mode (login, invite
 *                      redemption, the static liveness endpoint).
 *  - `authenticated` — any signed-in identity in multi-user mode.
 *  - `owner-scoped`  — authenticated; handlers additionally filter/authorize
 *                      by run ownership (enforced with `ownerId`, U5).
 *  - `admin`         — admin role only in multi-user mode.
 *
 * In single-tenant mode every caller resolves to the implicit admin and
 * access enforcement is skipped entirely — behavior stays byte-identical to
 * the pre-multi-user factory (reads open, mutations guarded by the operator
 * token as before).
 */
export type RouteAccess = 'public' | 'authenticated' | 'owner-scoped' | 'admin';

const ROUTE_ACCESS_VALUES: readonly RouteAccess[] = [
  'public',
  'authenticated',
  'owner-scoped',
  'admin',
];

/** A registered route. `pattern` segments may be `:params`. */
export interface RouteDef {
  readonly method: string;
  readonly pattern: string;
  readonly access: RouteAccess;
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

/**
 * DEFAULT-DENY registration: a route without a valid declared access class
 * never registers, so a future route cannot ship unguarded by omission. The
 * type system enforces this for TS callers; this runtime check catches routes
 * composed in plain JS or smuggled through a cast.
 */
export function assertRoutesClassified(routes: readonly RouteDef[]): void {
  for (const route of routes) {
    if (!ROUTE_ACCESS_VALUES.includes(route.access)) {
      throw new Error(
        `Route ${route.method} ${route.pattern} has no valid access class ` +
          `(got ${JSON.stringify((route as { access?: unknown }).access)}); ` +
          `declare one of: ${ROUTE_ACCESS_VALUES.join(', ')}.`,
      );
    }
  }
}

/** Session cookie names: prefixed+Secure by default, plain on the opt-out. */
export function sessionCookieName(insecure: boolean): string {
  return insecure ? 'sf_session' : '__Host-sf_session';
}

/** Parse one cookie value out of a Cookie header (no external deps). */
export function readCookie(
  headers: ApiRequest['headers'],
  name: string,
): string | undefined {
  const header = headers['cookie'];
  if (typeof header !== 'string' || header.length === 0) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** Serialize the session cookie (set or clear). */
export function serializeSessionCookie(value: string | null, insecure: boolean): string {
  const name = sessionCookieName(insecure);
  const flags = insecure
    ? 'Path=/; HttpOnly; SameSite=Lax'
    : 'Path=/; HttpOnly; Secure; SameSite=Lax';
  if (value === null) {
    return `${name}=; ${flags}; Max-Age=0`;
  }
  return `${name}=${encodeURIComponent(value)}; ${flags}`;
}

/** How the caller authenticated (drives CSRF + attribution semantics). */
type CredentialSource = 'session' | 'api_token' | 'legacy_token' | 'none';

interface ResolvedIdentity {
  readonly identity: Identity | null;
  readonly source: CredentialSource;
  /** Per-session CSRF secret when the caller is session-authenticated. */
  readonly sessionCsrf?: string;
}

/**
 * Strict-precedence, validate-or-reject identity resolution (multi-user).
 * Exactly one credential class is authoritative per request: a PRESENT
 * session cookie wins (an invalid one rejects — it never falls through to a
 * bearer), then an `sfai_` bearer, then the legacy operator token (which in
 * multi-user mode is always refused with migration guidance).
 */
async function resolveIdentity(
  request: ApiRequest,
  auth: { readonly service: AuthService; readonly insecureCookies?: boolean },
): Promise<ResolvedIdentity> {
  const cookie = readCookie(request.headers, sessionCookieName(auth.insecureCookies === true));
  if (cookie !== undefined) {
    const session = await auth.service.verifySession(cookie);
    if (session === null) {
      return { identity: null, source: 'session' };
    }
    const { csrfToken, ...identity } = session;
    return { identity, source: 'session', sessionCsrf: csrfToken };
  }
  const token = extractToken(request.headers);
  if (token !== undefined) {
    if (token.startsWith('sfai_')) {
      const identity = await auth.service.verifyApiToken(token);
      return { identity, source: 'api_token' };
    }
    return { identity: null, source: 'legacy_token' };
  }
  return { identity: null, source: 'none' };
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

function originFromHost(request: ApiRequest): string | undefined {
  const origin = request.headers['origin'];
  if (origin === undefined || origin.length === 0) {
    return undefined;
  }
  const host = request.headers['x-forwarded-host'] ?? request.headers['host'];
  if (host === undefined || host.length === 0) {
    return undefined;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return undefined;
  }
  const forwardedHost = host.split(',')[0]?.trim();
  if (forwardedHost === undefined || forwardedHost.length === 0) {
    return undefined;
  }
  if (originUrl.host !== forwardedHost) {
    return undefined;
  }
  return origin;
}

function allowedOriginsFor(request: ApiRequest, config: ResolvedConfig): readonly string[] {
  if (!config.allowSameHostOrigin) {
    return config.allowedOrigins;
  }
  const sameHost = originFromHost(request);
  return sameHost === undefined
    ? config.allowedOrigins
    : [...new Set([...config.allowedOrigins, sameHost])];
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
  readonly route: RouteDef;
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
      return { match: { route, handler: route.handler, params }, pathMatched: true };
    }
  }
  return { match: null, pathMatched };
}

/* ----------------------------------------------------------------------------
 * App factory
 * ------------------------------------------------------------------------- */

/**
 * Reserved ledger stream for factory-scoped (cross-run) command denials. It
 * deliberately never receives `run.created`, so `isRealRun` filters it from
 * every run list while the security events stay durable and replayable.
 */
const FACTORY_AUDIT_RUN_ID = 'factory';

export function createApp(deps: AppDeps): App {
  const { store, operatorToken } = deps;
  const clock = deps.clock ?? Date.now;
  const idGenerator = deps.idGenerator ?? defaultIdGenerator;
  const config: ResolvedConfig = {
    allowedOrigins: deps.config?.allowedOrigins ?? [],
    allowSameHostOrigin: deps.config?.allowSameHostOrigin ?? false,
    csrfToken: deps.config?.csrfToken,
    runtime: deps.config?.runtime,
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
      // request. But it MUST be observable: append a terminal `run.failed` so
      // clients (CLI `streamRunEvents`, the UI) stop waiting for a `run.planned`
      // that will never arrive — and surface it on the server too.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[software-factory] run planning failed for ${runId}: ${message}`);
      await writer.append({
        runId,
        type: 'run.failed',
        actor: { kind: 'operator', id: 'operator' },
        subject: { kind: 'run', id: runId },
        severity: 'error',
        payload: { reason: `planning failed: ${message}` },
      });
    }
  }

  // `undefined` -> default runtime researcher; `null` -> research disabled.
  const researcher: RunResearcher | null =
    deps.researcher === undefined
      ? createRuntimeResearcher({ runtime: config.runtime, clock })
      : deps.researcher;

  async function runResearchForRun(
    runId: string,
    input: ResearchTriggerInput,
  ): Promise<ResearchRunResult | null> {
    if (researcher === null) {
      return null;
    }
    try {
      return await researcher(store, runId, input);
    } catch (error) {
      // The runner records its own failures on the ledger; this catch covers
      // researcher-construction/store errors that escaped it. Keep the failure
      // observable on the ledger AND the server log, then report it.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[software-factory] research failed for ${runId}: ${message}`);
      await writer.append({
        runId,
        type: 'research.failed',
        actor: { kind: 'researcher', id: 'research-runner' },
        subject: { kind: 'research', id: runId },
        severity: 'error',
        payload: { reason: `research runner error: ${message}` },
      });
      return {
        status: 'failed',
        failureReason: message,
        sourcesFound: 0,
        sourcesRead: 0,
        findingCount: 0,
        assumptionCount: 0,
        gapCount: 0,
        seededKnowledgeCount: 0,
        recordedKnowledgeEntryIds: [],
        budgetStops: [],
      };
    }
  }

  // `undefined` -> default runtime materializer; `null` -> workspace disabled.
  const materializer: RunWorkspaceMaterializer | null =
    deps.materializer === undefined
      ? createRuntimeWorkspaceMaterializer({ runtime: config.runtime, clock })
      : deps.materializer;

  // `undefined` -> default runtime publisher; `null` -> publishing disabled.
  const publisher: RunWorkspacePublisher | null =
    deps.publisher === undefined ? createRuntimeWorkspacePublisher({ clock }) : deps.publisher;

  async function publishWorkspaceForRun(runId: string): Promise<WorkspacePublishOutcome | null> {
    if (publisher === null) {
      return null;
    }
    return publisher(store, runId);
  }

  async function materializeWorkspaceForRun(
    runId: string,
    input: WorkspaceTriggerInput,
  ): Promise<WorkspaceMaterializationResult | null> {
    if (materializer === null) {
      return null;
    }
    // The materializer records its own failure modes on the ledger and never
    // throws for source/setup/checkout problems; an unexpected (store-level)
    // error propagates to the route's 500 handler and stays observable there.
    return materializer(store, runId, input);
  }

  // Execution daemon (U5): the app NEVER constructs one — lifecycle ownership
  // stays with the server entry points. Omitted/null -> execution disabled.
  const executionDaemon: ExecutionDaemon | null = deps.execution ?? null;

  // Multi-user auth (U3): present = enforce identities + declared access.
  const auth = deps.auth ?? null;
  const credentialVault = deps.credentialVault ?? null;
  const credentialProber = deps.credentialProber ?? createRuntimeCredentialProber();

  // Adapter catalog (U6): `undefined` -> the real default catalog (with the
  // shared env-derived skill options); `null` -> no catalog (readiness
  // enforced fail-closed at execution time instead).
  const adapterCatalog: AdapterCatalog | null =
    deps.adapterCatalog === undefined
      ? createDefaultAdapterCatalog(resolveAdapterCatalogOptions())
      : deps.adapterCatalog;

  // `undefined` -> default runtime preflight; `null` -> preflight disabled
  // (start fails closed rather than skipping the rehearsal).
  const preflight: PreflightRunner | null =
    deps.preflight === undefined
      ? createRuntimePreflight({
          runtime: config.runtime,
          clock,
          adapters: adapterCatalog ?? undefined,
        })
      : deps.preflight;

  async function runPreflightForRun(runId: string): Promise<PreflightRunResult | null> {
    if (preflight === null) {
      return null;
    }
    return preflight(store, runId);
  }

  const routes: RouteDef[] = [
    ...runRoutes(),
    ...eventRoutes(),
    ...reviewRoutes(),
    ...setupRoutes(),
    ...researchRoutes(),
    ...executionRoutes(),
    ...fsRoutes(),
    ...authRoutes(),
    ...credentialRoutes(),
  ];

  assertRoutesClassified(routes);

  async function guardMutation(
    request: ApiRequest,
    input: GuardMutationInput,
    resolved?: ResolvedIdentity,
  ): Promise<ApiResponse | null> {
    const session = await operatorToken.current();
    const headerToken = extractToken(request.headers);
    // Multi-user: the dispatcher already resolved+authorized the identity, so
    // the guard's token layer verifies "this request carries the identity the
    // dispatcher accepted". Session callers present their PER-SESSION CSRF;
    // header-token callers (sfai_ bearers — and legacy tokens in
    // single-tenant) are CSRF-exempt because browsers cannot set those
    // headers cross-site. Origin and stale-version checks are unchanged.
    const multiUserIdentity = auth != null ? (resolved?.identity ?? null) : null;
    const token =
      auth != null
        ? multiUserIdentity !== null
          ? (headerToken ?? 'session-authenticated')
          : headerToken
        : headerToken;
    const csrfToken =
      auth != null
        ? resolved?.source === 'session'
          ? resolved.sessionCsrf
          : undefined
        : headerToken !== undefined
          ? undefined
          : config.csrfToken;
    const guardRequest: CommandGuardRequest = {
      method: request.method,
      token,
      origin: request.headers['origin'],
      csrfHeader: request.headers['x-csrf-token'],
      subject: input.subject,
    };
    const result = checkCommand(guardRequest, {
      verifyToken: (presented) =>
        auth != null
          ? multiUserIdentity !== null
          : session !== null && verifyOperatorToken(session.token, presented),
      allowedOrigins: allowedOriginsFor(request, config),
      csrfToken,
      currentSubjectVersion: input.currentVersion,
    });
    if (result.allowed) {
      return null;
    }

    // Denied: append exactly one security event and perform NO other side
    // effects (no workers/adapters/deploys/repo writes). The event is attached
    // to the run subject so the blocked attempt is auditable in the ledger.
    // Factory-scoped commands (cancel-all, resume/hold) have no run of their
    // own: their denials land on the reserved 'factory' stream — a runId that
    // never sees `run.created`, so `isRealRun` keeps it out of every run list
    // (the same phantom-run filtering that already covers lone security
    // events) — AND on the server log so the denial is never invisible.
    if (input.subject.kind === 'factory') {
      console.error(
        `[software-factory] factory command denied: ${input.command} (${result.reason}) on ` +
          `${input.subject.kind}/${input.subject.id}`,
      );
    }
    const runId =
      input.runId ??
      (input.subject.kind === 'run'
        ? input.subject.id
        : input.subject.kind === 'factory'
          ? FACTORY_AUDIT_RUN_ID
          : undefined);
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

  function buildContext(
    request: ApiRequest,
    params: Record<string, string>,
    resolved: ResolvedIdentity | undefined,
  ): RouteContext {
    const insecureCookies = auth?.insecureCookies === true;
    // Single-tenant callers act as the implicit admin (today's model).
    const identity: Identity | null =
      auth != null
        ? (resolved?.identity ?? null)
        : { userId: 'operator', username: 'operator', role: 'admin' };
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
      guardMutation: (input) => guardMutation(request, input, resolved),
      planRun,
      runResearch: runResearchForRun,
      researchEnabled: researcher !== null,
      materializeWorkspace: materializeWorkspaceForRun,
      workspaceEnabled: materializer !== null,
      publishWorkspace: publishWorkspaceForRun,
      executionDaemon,
      adapterCatalog,
      identity,
      authService: auth?.service ?? null,
      credentialVault,
      credentialProber,
      multiUser: auth != null,
      sessionCookie: (value) => serializeSessionCookie(value, insecureCookies),
      clientIp: deriveClientIp(request.headers, undefined, true),
      runPreflight: runPreflightForRun,
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
      let resolved: ResolvedIdentity | undefined;
      if (auth != null) {
        resolved = await resolveIdentity(request, auth);
        // Declared-access enforcement (multi-user only; single-tenant stays
        // byte-identical). Strict precedence already applied in resolution:
        // an invalid presented credential never falls through to a weaker one.
        if (match.route.access !== 'public' && resolved.identity === null) {
          if (resolved.source === 'legacy_token') {
            return json(401, {
              error: 'multi_user_enabled',
              message:
                'Multi-user mode is enabled on this factory: the shared operator token has been ' +
                'retired. Sign in with your account, or use your personal API token ' +
                '(mint one under Settings) in the same header.',
            });
          }
          return json(401, {
            error: 'unauthenticated',
            message: 'Sign in (or present a personal API token) to access this factory.',
            returnTo: `${request.path}`,
          });
        }
        if (match.route.access === 'admin' && resolved.identity?.role !== 'admin') {
          return json(403, { error: 'forbidden', message: 'This action requires the admin.' });
        }
      }
      return await match.handler(buildContext(request, match.params, resolved));
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
