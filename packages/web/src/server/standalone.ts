/**
 * Standalone loopback API server for the Software Factory.
 *
 * This is the backend the CLI (`software-factory start`) boots when no server is
 * already reachable. It mounts the SAME framework-agnostic `createApp` the Next
 * web app mounts, backed by the SAME on-disk `.factory/` store and file-backed
 * operator token — so the CLI and the web UI share one ledger and one operator
 * session.
 *
 * Unlike the Next-mounted instance, this server is configured for NON-browser
 * callers: it allows requests with no `Origin` and does NOT require a CSRF token
 * (the command guard treats a no-Origin + valid-token request as the trusted
 * local operator). That is exactly the CLI's calling convention, so the CLI
 * authenticates with the operator token alone — no CSRF handshake required.
 *
 * Factory Reset (session lifecycle U4/U7) is wired: the HTTP listener
 * dispatches through a mutable app reference, and the injected
 * `FactoryResetRuntime.rebuild()` swaps in a fresh store/daemon/app after the
 * allowlisted wipe — the standalone equivalent of `instance.ts` dropping its
 * globalThis singletons. The rebuilt daemon boots HELD and a fresh operator
 * token is minted (existing CLI sessions re-auth, R15).
 *
 * Run directly with tsx:
 *   tsx packages/web/src/server/standalone.ts [--port <n>]
 * or via env: SF_RUNTIME, PORT/SF_PORT, SF_HOST, SF_FACTORY_DIR,
 * SF_ALLOWED_ORIGINS, SF_OPERATOR_TOKEN.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDefaultAdapterCatalog, createFileSystemEventStore } from '@software-factory/core';
import type { EventStore } from '@software-factory/core';
import { createApp, serveApp } from './app';
import type { App, RunningServer } from './app';
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

export interface StandaloneOptions {
  /** Port to bind (0 = ephemeral). Defaults to `SF_PORT` or 3000. */
  readonly port?: number;
  /** Host to bind. Defaults to loopback. */
  readonly host?: string;
  /** Override the `.factory` directory. Defaults to `resolveFactoryDir()`. */
  readonly factoryDir?: string;
}

export interface StandaloneServer {
  readonly server: RunningServer;
  readonly factoryDir: string;
  readonly operatorTokenPath: string;
  /** The operator token minted/loaded for this server (loopback only). */
  readonly operatorToken: string;
  /** The single execution daemon owned by this server process (E1). */
  readonly daemon: ExecutionDaemon;
  /** Graceful shutdown: stop the daemon (yield/requeue), then the server. */
  close(): Promise<void>;
}

/**
 * Build and start the standalone API server. The returned handle exposes the
 * bound URL plus the operator-token location so callers can report it.
 *
 * Exactly ONE execution daemon is bootstrapped per server (U5/E1): requests
 * enqueue work and `notify()` it; the daemon owns the queue loop and leases.
 */
export async function startStandaloneServer(
  options: StandaloneOptions = {},
): Promise<StandaloneServer> {
  const runtime = resolveRuntimeConfig();
  const factoryDir = options.factoryDir ?? runtime.factoryDir;
  await mkdir(factoryDir, { recursive: true });

  const operatorTokenPath = join(factoryDir, 'operator-token.json');
  const provider = createRuntimeOperatorTokenProvider({ ...runtime, factoryDir });
  const session = await provider.getOrCreate();
  const store = createFileSystemEventStore({ baseDir: join(factoryDir, 'events') });

  // One daemon per process: bootstrapped BEFORE the listener so the initial
  // reconcile pass (resume safe queued work, abandon stale leases) runs first.
  // The adapter catalog is shared by the executor and the preflight readiness
  // check so both resolve the same adapter set (U6). The executor holds no
  // store reference, so the Factory Reset rebuild below reuses it as-is.
  const adapterCatalog = createDefaultAdapterCatalog();
  const executor = createSchedulerTicketExecutor({
    runtime,
    adapters: adapterCatalog,
    // U7: gate stages wired for real (post-ticket repair loop + post-run gate).
    // U8: completion stage wired for real (preview, package/provenance, deploy).
    gateStages: createRuntimeGateStages({ runtime }),
    completionStage: createRuntimeCompletionStage({ runtime }),
  });
  const daemon = createExecutionDaemon({ store, config: runtime.execution, executor });
  await daemon.start();

  // U11 scale-safety: hosted logs must state the single-instance limit once
  // per process. stderr, so the machine-readable stdout line stays first.
  if (runtime.mode === 'cloud') {
    console.warn(scaleSafetyStartupLine(runtime));
  }

  const appConfig = {
    allowedOrigins: runtime.allowedOrigins,
    runtime,
    allowSameHostOrigin: true,
  } as const;

  /**
   * Mutable factory-state triple (session lifecycle U4/U7): the HTTP listener
   * dispatches through `current.app`, so the Factory Reset dispose/rebuild
   * sequence can swap in a fresh store/daemon/app after the wipe — mirroring
   * how `instance.ts` drops its globalThis singletons. Requests never reach a
   * disposed store: the swap happens before the reset route responds. Assigned
   * below (after `createApp`); the closures here only read it lazily.
   */
  let current: { store: EventStore; daemon: ExecutionDaemon; app: App };

  const factoryResetRuntime: FactoryResetRuntime = {
    factoryDir,
    // Called AFTER the allowlisted paths were deleted (executeFactoryReset):
    // a fresh store hydrates the EMPTY events dir, a fresh provider mints a
    // new operator token (the old file was wiped; callers re-auth, R15), and
    // the fresh daemon boots HELD again (server runtimes never auto-start).
    rebuild: async () => {
      const freshStore = createFileSystemEventStore({ baseDir: join(factoryDir, 'events') });
      const freshProvider = createRuntimeOperatorTokenProvider({ ...runtime, factoryDir });
      await freshProvider.getOrCreate();
      const freshDaemon = createExecutionDaemon({
        store: freshStore,
        config: runtime.execution,
        executor,
      });
      await freshDaemon.start();
      const freshApp = createApp({
        store: freshStore,
        operatorToken: freshProvider,
        execution: freshDaemon,
        adapterCatalog,
        factoryReset: factoryResetRuntime,
        config: appConfig,
      });
      current = { store: freshStore, daemon: freshDaemon, app: freshApp };
      return freshStore;
    },
  };

  // No CSRF token here: the CLI is a non-browser caller authenticated by the
  // operator token. The default genome planner plans every created run.
  current = {
    store,
    daemon,
    app: createApp({
      store,
      operatorToken: provider,
      execution: daemon,
      adapterCatalog,
      factoryReset: factoryResetRuntime,
      config: appConfig,
    }),
  };

  const port = options.port ?? runtime.port;
  const host = options.host ?? runtime.host;
  // Serve through the mutable reference so a reset's rebuilt app takes over
  // without rebinding the socket.
  const server = await serveApp((request) => current.app.handle(request), port, host);
  return {
    server,
    factoryDir,
    operatorTokenPath,
    operatorToken: session.token,
    get daemon(): ExecutionDaemon {
      return current.daemon;
    },
    close: async () => {
      await current.daemon.stop();
      await server.close();
    },
  };
}

function parsePortArg(argv: readonly string[]): number | undefined {
  const index = argv.indexOf('--port');
  if (index >= 0 && index + 1 < argv.length) {
    const value = Number(argv[index + 1]);
    if (Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

/** CLI entry: start the server and keep it running until interrupted. */
async function main(): Promise<void> {
  const port = parsePortArg(process.argv.slice(2));
  const started = await startStandaloneServer(port !== undefined ? { port } : {});
  // A single machine-readable line first (the CLI parses this), then a human note.
  process.stdout.write(
    `${JSON.stringify({
      ready: true,
      url: started.server.url,
      port: started.server.port,
      factoryDir: started.factoryDir,
      operatorTokenPath: started.operatorTokenPath,
    })}\n`,
  );
  process.stdout.write(
    `[software-factory] standalone API listening on ${started.server.url} (.factory: ${started.factoryDir})\n`,
  );

  // Signal handlers are registered ONCE per signal and the shutdown itself is
  // guarded, so a double signal (or SIGINT followed by SIGTERM) never runs a
  // second close over a shutdown already in flight.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void started.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// Run only when executed directly (tsx/node), not when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[software-factory] standalone server failed: ${message}\n`);
    process.exit(1);
  });
}
