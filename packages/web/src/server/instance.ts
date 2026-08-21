/**
 * Singleton local API instance for the Next.js server.
 *
 * The whole U3 API (createApp -> handle/listen) is mounted under Next by the
 * catch-all route handler, which calls THIS singleton's `handle()`. There is no
 * duplicated route logic: Next is only a transport adapter in front of the same
 * framework-agnostic app the e2e/unit tests exercise.
 *
 * Persistence is local-first by default and cloud-capable when `SF_RUNTIME=cloud`:
 *   - a FILESYSTEM event store under `<workspaceRoot>/.factory/events` or
 *     `SF_FACTORY_DIR/events`,
 *   - a file-backed local operator token, or an env-backed cloud token from
 *     `SF_OPERATOR_TOKEN`, and
 *   - a stable, per-process CSRF token.
 *
 * The operator + CSRF tokens are handed to the same-origin client by a server
 * component (see `getLocalSession`); they never leave loopback. Mutating client
 * calls echo them back as `x-operator-token` + `x-csrf-token`, and because the
 * browser sends `Origin: http://127.0.0.1:3000` (an allowed origin) the command
 * guard's origin/CSRF/token checks all pass for the local operator only.
 *
 * Next (dev especially) can load this module in separate module graphs for
 * server components vs route handlers. A naive module-level singleton would then
 * exist TWICE in one process, giving the page and the API different in-memory
 * CSRF tokens (mismatch -> 403) and divergent store caches. We therefore stash
 * the singletons on `globalThis`, which IS shared across module graphs in the
 * single Node server process — so there is exactly one store, provider, CSRF
 * token, and app for the whole process.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createDefaultAdapterCatalog, createFileSystemEventStore } from '@software-factory/core';
import type { AdapterCatalog, EventStore, OperatorTokenProvider } from '@software-factory/core';
import { resolveAdapterCatalogOptions } from './adapter-env';
import { createAiRunPlanner } from './ai-planner';
import { createApp, sessionCookieName } from './app';
import type { App } from './app';
import { createAuthService, createFileAuthStores } from './auth/service';
import type { AuthService } from './auth/service';
import { createExecutionDaemon } from './execution/daemon';
import type { ExecutionDaemon } from './execution/daemon';
import { createRuntimeCompletionStage } from './execution/completion-stage';
import { createRuntimeGateStages } from './execution/gate-stages';
import { createSchedulerTicketExecutor } from './execution/ticket-executor';
import {
  createRuntimeOperatorTokenProvider,
  resolveRuntimeConfig,
  scaleSafetyStartupLine,
} from './runtime';
import type { LocalSession } from '../lib/session';

export type { LocalSession } from '../lib/session';
export { resolveFactoryDir } from './runtime';

interface FactorySingletons {
  csrfToken?: string;
  store?: EventStore;
  provider?: OperatorTokenProvider;
  app?: App;
  daemon?: ExecutionDaemon;
  adapterCatalog?: AdapterCatalog;
  auth?: AuthService | null;
}

const globalRef = globalThis as typeof globalThis & { __softwareFactory__?: FactorySingletons };
const singletons: FactorySingletons = (globalRef.__softwareFactory__ ??= {});

/** The double-submit CSRF secret, stable for the whole server process. */
function csrfToken(): string {
  singletons.csrfToken ??= process.env.SF_CSRF_TOKEN ?? randomBytes(24).toString('base64url');
  return singletons.csrfToken;
}

function operatorTokenProvider(): OperatorTokenProvider {
  singletons.provider ??= createRuntimeOperatorTokenProvider(resolveRuntimeConfig());
  return singletons.provider;
}

/** The process-wide filesystem event store (the source of truth). */
export function getStore(): EventStore {
  singletons.store ??= createFileSystemEventStore({
    baseDir: join(resolveRuntimeConfig().factoryDir, 'events'),
  });
  return singletons.store;
}

/**
 * The process-wide execution daemon (full-factory U5, hardening E1).
 *
 * Bootstrapped EXACTLY ONCE per process: the daemon lives on the same
 * globalThis singleton record as the store/app, so Next's separate module
 * graphs (server components vs route handlers) and repeated requests all see
 * one daemon owner. `start()` runs the initial reconcile pass (resume safe
 * queued work, abandon stale leases) and the interval loop; SIGTERM/SIGINT
 * stop it gracefully so in-flight work yields and requeues.
 *
 * Bootstrap is LAZY under the Next-mounted server: `getApp()` calls this on the
 * first request, so a Next instance that restarts with pending queue work
 * resumes it when the first request arrives (in local/operator use a request is
 * effectively immediate). A `src/instrumentation.ts` eager-bootstrap hook was
 * tried but pulls this module — and its `node:child_process`-backed core
 * adapters — into Next's edge/instrumentation compilation, which webpack cannot
 * bundle; the hosted long-running daemon runs under the standalone server
 * (`standalone.ts`), which already bootstraps eagerly. So this lazy path is the
 * deliberate trade-off for the Next mount, not an oversight.
 */
/**
 * The process-wide adapter catalog shared by preflight and the executor.
 * Env knobs (`SF_CLAUDE_ALLOWED_SKILLS`, `SF_PREFERRED_SKILLS`) are resolved
 * by the shared `adapter-env` module so every entry point agrees.
 */
function getAdapterCatalog(): AdapterCatalog {
  singletons.adapterCatalog ??= createDefaultAdapterCatalog(resolveAdapterCatalogOptions());
  return singletons.adapterCatalog;
}

export function getExecutionDaemon(): ExecutionDaemon {
  if (singletons.daemon === undefined) {
    const runtime = resolveRuntimeConfig();
    const daemon = createExecutionDaemon({
      store: getStore(),
      config: runtime.execution,
      // U6: the real scheduler-backed executor (ticket DAG -> workers).
      // U7: gate stages wired for real — post-ticket gates + repair loop and
      // the post-run gate stage that must pass before run.completed.
      // U8: completion stage wired for real — preview, package/provenance,
      // and Render deploy run after post-run gates pass, before run.completed.
      executor: createSchedulerTicketExecutor({
        runtime,
        adapters: getAdapterCatalog(),
        gateStages: createRuntimeGateStages({ runtime }),
        completionStage: createRuntimeCompletionStage({ runtime }),
      }),
    });
    singletons.daemon = daemon;
    // U11 scale-safety: hosted logs must state the single-instance limit once
    // per process — this build's storage/queue cannot scale horizontally.
    if (runtime.mode === 'cloud') {
      console.warn(scaleSafetyStartupLine(runtime));
    }
    daemon.start().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[software-factory] execution daemon failed to start: ${message}`);
    });
    const shutdown = (): void => {
      daemon.stop().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[software-factory] execution daemon failed to stop: ${message}`);
      });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  }
  return singletons.daemon;
}

/** SF_INSECURE_COOKIES=1: plain-HTTP LAN opt-out (drops __Host-/Secure). */
function insecureCookies(): boolean {
  return process.env.SF_INSECURE_COOKIES === '1' || process.env.SF_INSECURE_COOKIES === 'true';
}

/**
 * The process-wide auth service — MULTI-USER MODE ONLY (`SF_MULTI_USER=1`).
 * File-backed stores under `<factoryDir>/auth`; the bootstrap invite arms the
 * first admin account (consume-once; SF_BOOTSTRAP_REARM=1 re-arms it for an
 * admin password reset). `null` = single-tenant, today's behavior
 * byte-for-byte. Full fail-closed env resolution hardens in U11.
 */
export function getAuthService(): AuthService | null {
  if (singletons.auth === undefined) {
    const flag = process.env.SF_MULTI_USER;
    if (flag === '1' || flag === 'true') {
      singletons.auth = createAuthService({
        stores: createFileAuthStores(join(resolveRuntimeConfig().factoryDir, 'auth')),
        bootstrapInvite: process.env.SF_BOOTSTRAP_INVITE,
        bootstrapRearm:
          process.env.SF_BOOTSTRAP_REARM === '1' || process.env.SF_BOOTSTRAP_REARM === 'true',
      });
    } else {
      singletons.auth = null;
    }
  }
  return singletons.auth;
}

/** The process-wide local API app. Built once, reused across requests. */
export function getApp(): App {
  const runtime = resolveRuntimeConfig();
  const auth = getAuthService();
  singletons.app ??= createApp({
    store: getStore(),
    operatorToken: operatorTokenProvider(),
    execution: getExecutionDaemon(),
    adapterCatalog: getAdapterCatalog(),
    auth: auth !== null ? { service: auth, insecureCookies: insecureCookies() } : null,
    // AI-backed planning: unknown intents are decomposed by the operator's
    // authenticated Claude CLI (validated fail-closed in core); the built-in
    // intent and underspecified requests keep their deterministic paths, and
    // any AI failure falls back to human triage with the reason recorded.
    planner: createAiRunPlanner(),
    config: {
      allowedOrigins: runtime.allowedOrigins,
      csrfToken: csrfToken(),
      runtime,
      allowSameHostOrigin: true,
    },
  });
  return singletons.app;
}

/**
 * Load-or-create the operator session and return it alongside the CSRF token.
 * Called by server components, which pass the result into the client provider.
 * Ensures the `.factory/` directory exists first so the file-backed token store
 * can persist the freshly minted session.
 */
export async function getLocalSession(): Promise<LocalSession> {
  await mkdir(resolveRuntimeConfig().factoryDir, { recursive: true });
  const session = await operatorTokenProvider().getOrCreate();
  return { operatorToken: session.token, csrfToken: csrfToken() };
}

/**
 * Page-level auth (multi-user U9): the session for server components plus the
 * headers loaders forward into `handle()` so SSR sees the SAME owner-scoped
 * view the API answers over the wire.
 */
export interface PageAuth {
  readonly session: LocalSession;
  /** Forward into run-data loaders (LoaderAuth). Empty single-tenant. */
  readonly loaderAuth: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve the page session. SINGLE-TENANT: today's loopback session, never
 * null. MULTI-USER: verifies the request's session cookie — `null` means the
 * caller is anonymous/expired and the page must redirect to /login (pages
 * decide; no layout-level auth per Next 15 guidance). The OPERATOR TOKEN IS
 * NEVER PART OF A MULTI-USER PAGE PAYLOAD.
 */
export async function getPageAuth(): Promise<PageAuth | null> {
  const auth = getAuthService();
  if (auth === null) {
    return { session: await getLocalSession(), loaderAuth: {} };
  }
  // next/headers is only importable inside a request scope; dynamic import
  // keeps this module loadable from the standalone (non-Next) server too.
  const { cookies } = await import('next/headers');
  const jar = await cookies();
  const cookieName = sessionCookieName(insecureCookies());
  const token = jar.get(cookieName)?.value;
  if (token === undefined) {
    return null;
  }
  const verified = await auth.verifySession(token);
  if (verified === null) {
    return null;
  }
  const { csrfToken: sessionCsrf, ...identity } = verified;
  return {
    session: { csrfToken: sessionCsrf, identity, multiUser: true },
    loaderAuth: { cookie: `${cookieName}=${encodeURIComponent(token)}` },
  };
}
