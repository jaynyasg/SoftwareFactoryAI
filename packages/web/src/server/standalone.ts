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
import { createFileSystemEventStore } from '@software-factory/core';
import { createApp } from './app';
import type { RunningServer } from './app';
import { createRuntimeOperatorTokenProvider, resolveRuntimeConfig } from './runtime';

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
}

/**
 * Build and start the standalone API server. The returned handle exposes the
 * bound URL plus the operator-token location so callers can report it.
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

  // No CSRF token here: the CLI is a non-browser caller authenticated by the
  // operator token. The default genome planner plans every created run.
  const app = createApp({
    store,
    operatorToken: provider,
    config: { allowedOrigins: runtime.allowedOrigins, runtime, allowSameHostOrigin: true },
  });

  const port = options.port ?? runtime.port;
  const host = options.host ?? runtime.host;
  const server = await app.listen(port, host);
  return { server, factoryDir, operatorTokenPath, operatorToken: session.token };
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

  const shutdown = (): void => {
    void started.server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
