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
 * Run directly with tsx:
 *   tsx packages/web/src/server/standalone.ts [--port <n>]
 * or via env: SF_RUNTIME, PORT/SF_PORT, SF_HOST, SF_FACTORY_DIR,
 * SF_ALLOWED_ORIGINS, SF_OPERATOR_TOKEN.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCredentialVault,
  createDefaultAdapterCatalog,
  createFileCredentialStore,
  createFileSystemEventStore,
  createSecretBox,
} from '@software-factory/core';
import type { CredentialVault } from '@software-factory/core';
import { resolveAdapterCatalogOptions } from './adapter-env';
import { createApp } from './app';
import type { RunningServer } from './app';
import { createAuthService, createFileAuthStores } from './auth/service';
import { createExecutionDaemon } from './execution/daemon';
import type { ExecutionDaemon } from './execution/daemon';
import { createRuntimeCompletionStage } from './execution/completion-stage';
import {
  createRunCredentialResolver,
  sweepOrphanCodexHomes,
} from './execution/credential-bundles';
import { createRuntimeGateStages } from './execution/gate-stages';
import { createSchedulerTicketExecutor } from './execution/ticket-executor';
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
  // check so both resolve the same adapter set (U6). Skill env knobs resolve
  // through the SAME shared module as the Next mount — this entry point used
  // to drop SF_CLAUDE_ALLOWED_SKILLS silently.
  const adapterCatalog = createDefaultAdapterCatalog(resolveAdapterCatalogOptions());

  // Multi-user (U11): same activation as the Next mount — env flag or
  // initialized auth stores on disk (downgrade fail-closed). Warnings and the
  // mode line print once at boot so a misconfigured deploy self-explains.
  const multiUser = runtime.multiUser;
  for (const warning of multiUser.warnings) {
    console.warn(warning);
  }
  const authService = multiUser.enabled
    ? createAuthService({
        stores: createFileAuthStores(join(factoryDir, 'auth')),
        bootstrapInvite: multiUser.bootstrapInvite,
        bootstrapRearm: multiUser.bootstrapRearm,
      })
    : null;
  const credentialVault: CredentialVault | null = multiUser.enabled
    ? createCredentialVault({
        box: multiUser.masterKey !== undefined ? createSecretBox({ masterKey: multiUser.masterKey }) : null,
        store: createFileCredentialStore(join(factoryDir, 'credentials')),
      })
    : null;
  if (multiUser.enabled) {
    console.warn(
      `[software-factory] multi-user: ON (source=${multiUser.source ?? 'env'}, ` +
        `vault=${multiUser.masterKey !== undefined ? 'readable' : 'UNREADABLE'}, ` +
        `bootstrap=${multiUser.bootstrapInvite !== undefined ? 'armed' : 'absent'}). ` +
        'The legacy shared operator token is refused; personal API tokens and sessions authenticate.',
    );
    // U7: remove ephemeral codex homes left by a crashed previous process.
    const swept = await sweepOrphanCodexHomes();
    if (swept.length > 0) {
      console.warn(`[software-factory] swept ${swept.length} orphaned codex home(s).`);
    }
  }

  const daemon = createExecutionDaemon({
    store,
    config: runtime.execution,
    // U7: gate stages wired for real (post-ticket repair loop + post-run gate).
    // U8: completion stage wired for real (preview, package/provenance, deploy).
    executor: createSchedulerTicketExecutor({
      runtime,
      adapters: adapterCatalog,
      gateStages: createRuntimeGateStages({ runtime }),
      completionStage: createRuntimeCompletionStage({ runtime }),
      // U7/U11: multi-user runs bind the OWNER's decrypted credentials.
      credentials:
        credentialVault !== null
          ? createRunCredentialResolver({
              vault: credentialVault,
              catalog: (spawnEnv) =>
                createDefaultAdapterCatalog({ ...resolveAdapterCatalogOptions(), spawnEnv }),
            })
          : undefined,
    }),
  });
  await daemon.start();

  // U11 scale-safety: hosted logs must state the single-instance limit once
  // per process. stderr, so the machine-readable stdout line stays first.
  if (runtime.mode === 'cloud') {
    console.warn(scaleSafetyStartupLine(runtime));
  }

  // No CSRF token here: the CLI is a non-browser caller authenticated by the
  // operator token. The default genome planner plans every created run.
  const app = createApp({
    store,
    operatorToken: provider,
    execution: daemon,
    adapterCatalog,
    auth:
      authService !== null
        ? { service: authService, insecureCookies: multiUser.insecureCookies }
        : null,
    credentialVault,
    config: { allowedOrigins: runtime.allowedOrigins, runtime, allowSameHostOrigin: true },
  });

  const port = options.port ?? runtime.port;
  const host = options.host ?? runtime.host;
  const server = await app.listen(port, host);
  return {
    server,
    factoryDir,
    operatorTokenPath,
    operatorToken: session.token,
    daemon,
    close: async () => {
      await daemon.stop();
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
