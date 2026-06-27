/**
 * Singleton local API instance for the Next.js server.
 *
 * The whole U3 API (createApp -> handle/listen) is mounted under Next by the
 * catch-all route handler, which calls THIS singleton's `handle()`. There is no
 * duplicated route logic: Next is only a transport adapter in front of the same
 * framework-agnostic app the e2e/unit tests exercise.
 *
 * Persistence is local-first and loopback-only:
 *   - a FILESYSTEM event store under `<workspaceRoot>/.factory/events` (gitignored),
 *   - a file-backed operator token at `<workspaceRoot>/.factory/operator-token.json`
 *     (0600 where the platform honours it), and
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
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createFileOperatorTokenStore,
  createFileSystemEventStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import type { EventStore, OperatorTokenProvider } from '@software-factory/core';
import { createApp } from './app';
import type { App } from './app';
import type { LocalSession } from '../lib/session';

export type { LocalSession } from '../lib/session';

interface FactorySingletons {
  csrfToken?: string;
  store?: EventStore;
  provider?: OperatorTokenProvider;
  app?: App;
}

const globalRef = globalThis as typeof globalThis & { __softwareFactory__?: FactorySingletons };
const singletons: FactorySingletons = (globalRef.__softwareFactory__ ??= {});

/**
 * Origins the browser presents on same-origin fetches. The default is the
 * documented dev port (3000); `SF_ALLOWED_ORIGINS` (comma-separated) appends
 * extras so e2e can serve the app on an alternate loopback port when 3000 is
 * occupied. Only loopback origins are ever added.
 */
function allowedOrigins(): readonly string[] {
  const defaults = ['http://127.0.0.1:3000', 'http://localhost:3000'];
  const extra = (process.env.SF_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set([...defaults, ...extra])];
}

/**
 * Walk up from the current working directory to the pnpm workspace root so the
 * runtime `.factory/` directory always lands at the repo root (where the
 * `/.factory/` gitignore rule covers it), regardless of which package directory
 * `next dev`/`next start` is launched from.
 */
function resolveFactoryDir(): string {
  const override = process.env.SF_FACTORY_DIR;
  if (override !== undefined && override.length > 0) {
    return override;
  }
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return join(dir, '.factory');
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return join(process.cwd(), '.factory');
}

/** The double-submit CSRF secret, stable for the whole server process. */
function csrfToken(): string {
  singletons.csrfToken ??= process.env.SF_CSRF_TOKEN ?? randomBytes(24).toString('base64url');
  return singletons.csrfToken;
}

function operatorTokenProvider(): OperatorTokenProvider {
  singletons.provider ??= createOperatorTokenProvider({
    store: createFileOperatorTokenStore(join(resolveFactoryDir(), 'operator-token.json')),
  });
  return singletons.provider;
}

/** The process-wide filesystem event store (the source of truth). */
export function getStore(): EventStore {
  singletons.store ??= createFileSystemEventStore({ baseDir: join(resolveFactoryDir(), 'events') });
  return singletons.store;
}

/** The process-wide local API app. Built once, reused across requests. */
export function getApp(): App {
  singletons.app ??= createApp({
    store: getStore(),
    operatorToken: operatorTokenProvider(),
    config: { allowedOrigins: allowedOrigins(), csrfToken: csrfToken() },
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
  await mkdir(resolveFactoryDir(), { recursive: true });
  const session = await operatorTokenProvider().getOrCreate();
  return { operatorToken: session.token, csrfToken: csrfToken() };
}
