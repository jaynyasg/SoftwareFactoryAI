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
import { createApp } from './app';
import type { App } from './app';
import { createExecutionDaemon } from './execution/daemon';
import type { ExecutionDaemon } from './execution/daemon';
import { createRuntimeCompletionStage } from './execution/completion-stage';
import { createRuntimeGateStages } from './execution/gate-stages';
import { createSchedulerTicketExecutor } from './execution/ticket-executor';
import type { FactoryResetRuntime } from './factory-reset';
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
/** The process-wide adapter catalog shared by preflight and the executor. */
function getAdapterCatalog(): AdapterCatalog {
  singletons.adapterCatalog ??= createDefaultAdapterCatalog();
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

/**
 * The Factory Reset dispose/rebuild capability (session lifecycle U4) over
 * THESE globalThis singletons. `rebuild()` is called by the reset route AFTER
 * the daemon was stopped and the allowlisted factory paths were deleted; it
 * drops every factory-STATE singleton so nothing cached survives the wipe:
 *   - `store` — its in-memory event cache, idempotency map, and sequence
 *     high-water marks would otherwise resurrect the deleted ledger;
 *   - `provider` — the file-backed operator token it served was just deleted;
 *     the next `getLocalSession()` mints a fresh one;
 *   - `app` — bound to the old store/daemon; the next request's `getApp()`
 *     rebuilds it over the fresh singletons (the Next catch-all calls
 *     `getApp()` per request, so the swap is picked up immediately);
 *   - `daemon` — stopped by the route; the rebuilt daemon boots HELD again
 *     (server runtimes resolve `autoStart` to false).
 * The CSRF token and adapter catalog deliberately SURVIVE: they are process
 * capabilities, not factory state (the CSRF secret is documented as stable
 * for the whole server process — open tabs re-auth via the reset-generation
 * reload banner, R15).
 */
function factoryResetRuntime(): FactoryResetRuntime {
  return {
    factoryDir: resolveRuntimeConfig().factoryDir,
    rebuild: (): Promise<EventStore> => {
      delete singletons.store;
      delete singletons.provider;
      delete singletons.app;
      delete singletons.daemon;
      return Promise.resolve(getStore());
    },
  };
}

/** The process-wide local API app. Built once, reused across requests. */
export function getApp(): App {
  const runtime = resolveRuntimeConfig();
  singletons.app ??= createApp({
    store: getStore(),
    operatorToken: operatorTokenProvider(),
    execution: getExecutionDaemon(),
    adapterCatalog: getAdapterCatalog(),
    factoryReset: factoryResetRuntime(),
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
