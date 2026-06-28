/**
 * Runtime configuration for local and hosted Software Factory servers.
 *
 * Local mode keeps the original loopback-first behavior. Cloud mode switches
 * defaults that matter for a hosted Node service: bind to all interfaces, read
 * the public port from the platform, use explicit origins when supplied, and
 * require a stable operator token from the environment instead of minting a
 * secret into ephemeral storage.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createFileOperatorTokenStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import type { OperatorTokenProvider } from '@software-factory/core';

export type FactoryRuntimeMode = 'local' | 'cloud';
export type OperatorTokenSource = 'file' | 'env';

export interface RuntimeConfig {
  readonly mode: FactoryRuntimeMode;
  readonly host: string;
  readonly port: number;
  readonly factoryDir: string;
  readonly allowedOrigins: readonly string[];
  readonly publicBaseUrl?: string;
  readonly operatorTokenSource: OperatorTokenSource;
  readonly csrfToken?: string;
}

interface RuntimeEnv {
  readonly SF_RUNTIME?: string;
  readonly SF_HOST?: string;
  readonly HOST?: string;
  readonly SF_PORT?: string;
  readonly PORT?: string;
  readonly SF_FACTORY_DIR?: string;
  readonly SF_ALLOWED_ORIGINS?: string;
  readonly SF_PUBLIC_BASE_URL?: string;
  readonly RENDER?: string;
  readonly RENDER_EXTERNAL_URL?: string;
  readonly SF_OPERATOR_TOKEN?: string;
  readonly SF_CSRF_TOKEN?: string;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseRuntimeMode(env: RuntimeEnv): FactoryRuntimeMode {
  const explicit = clean(env.SF_RUNTIME)?.toLowerCase();
  if (explicit === 'cloud') {
    return 'cloud';
  }
  if (explicit === 'local') {
    return 'local';
  }
  return clean(env.RENDER) !== undefined || clean(env.RENDER_EXTERNAL_URL) !== undefined
    ? 'cloud'
    : 'local';
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCsv(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function findWorkspaceFactoryDir(start: string): string {
  let dir = start;
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
  return join(start, '.factory');
}

/** Resolve the shared ledger/operator-token directory. */
export function resolveFactoryDir(
  env: RuntimeEnv = process.env as RuntimeEnv,
  cwd = process.cwd(),
): string {
  const override = clean(env.SF_FACTORY_DIR);
  if (override !== undefined) {
    return override;
  }
  return findWorkspaceFactoryDir(cwd);
}

export function resolveRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
  cwd = process.cwd(),
): RuntimeConfig {
  const mode = parseRuntimeMode(env);
  const publicBaseUrl = clean(env.SF_PUBLIC_BASE_URL) ?? clean(env.RENDER_EXTERNAL_URL);
  const port = parsePort(env.PORT, parsePort(env.SF_PORT, 3000));
  const host =
    clean(env.SF_HOST) ?? clean(env.HOST) ?? (mode === 'cloud' ? '0.0.0.0' : '127.0.0.1');
  const localOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ];
  const cloudOrigins = publicBaseUrl !== undefined ? [publicBaseUrl.replace(/\/+$/, '')] : [];
  const allowedOrigins = [
    ...new Set([...localOrigins, ...cloudOrigins, ...splitCsv(env.SF_ALLOWED_ORIGINS)]),
  ];
  const operatorTokenSource = clean(env.SF_OPERATOR_TOKEN) !== undefined ? 'env' : 'file';

  return {
    mode,
    host,
    port,
    factoryDir: resolveFactoryDir(env, cwd),
    allowedOrigins,
    publicBaseUrl,
    operatorTokenSource,
    csrfToken: clean(env.SF_CSRF_TOKEN),
  };
}

/**
 * Build the operator-token provider for the runtime. Cloud mode must receive a
 * stable token via `SF_OPERATOR_TOKEN`; generating one into ephemeral storage
 * would lock remote CLI/skill callers out after every deploy.
 */
export function createRuntimeOperatorTokenProvider(
  config: RuntimeConfig,
  env: RuntimeEnv = process.env as RuntimeEnv,
): OperatorTokenProvider {
  const envToken = clean(env.SF_OPERATOR_TOKEN);
  if (envToken !== undefined) {
    return createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: envToken, createdAt: 0 }),
      generateToken: () => envToken,
    });
  }
  if (config.mode === 'cloud') {
    throw new Error('SF_OPERATOR_TOKEN is required when SF_RUNTIME=cloud.');
  }
  return createOperatorTokenProvider({
    store: createFileOperatorTokenStore(join(config.factoryDir, 'operator-token.json')),
  });
}
