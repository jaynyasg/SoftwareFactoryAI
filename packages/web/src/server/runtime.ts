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

/**
 * Research-stage runtime configuration (full-factory U2).
 *
 * Research provider credentials are a SEPARATE setup surface from source
 * checkout and deploy credentials (hardening E5). Only credential PRESENCE is
 * resolved into config — the values stay in the environment and are read
 * exclusively by the provider implementation, never recorded as evidence.
 */
export interface ResearchRuntimeConfig {
  /** Whether network-backed research source classes are allowed (default off). */
  readonly allowNetwork: boolean;
  /** Operator-configured documentation URLs research may fetch. */
  readonly documentationUrls: readonly string[];
  /** Configured external web-search provider id, when any. */
  readonly searchProviderId?: string;
  /** Whether web-search provider credentials are PRESENT (never the value). */
  readonly searchCredentialsPresent: boolean;
  /** Default max sources per research pass. */
  readonly maxSources: number;
  /** Default max elapsed ms per research pass. */
  readonly maxDurationMs: number;
}

/**
 * Workspace materialization runtime configuration (full-factory U4).
 *
 * Source checkout credentials are a SEPARATE setup surface from deploy and
 * research credentials (hardening E5). Only credential PRESENCE is resolved
 * into config — `SF_GIT_CHECKOUT_TOKEN` stays in the environment and is read
 * exclusively by the checkout client at exec time, never recorded as evidence.
 */
export interface WorkspaceRuntimeConfig {
  /** Approved working boundary for local-folder workspaces (local mode). */
  readonly localBoundaryRoot: string;
  /** Explicitly approved operator folders (each admits itself + subtree). */
  readonly approvedFolders: readonly string[];
  /** Root directory repository checkouts are materialized under. */
  readonly checkoutRoot: string;
  /** Whether source checkout credentials are PRESENT (never the value). */
  readonly checkoutCredentialsPresent: boolean;
  /** Recorded dirty-state policy for bound local folders. */
  readonly dirtyStatePolicy: 'allow_dirty' | 'reject_dirty';
}

/**
 * Execution queue/daemon runtime configuration (full-factory U5).
 *
 * The plan fixes the queue INVARIANTS (claim/lease/heartbeat/reconcile with
 * abandoned-lease recovery); these numbers are deliberately configurable and
 * were chosen while writing the restart/stale-lease tests.
 */
export interface ExecutionRuntimeConfig {
  /** How long a claimed queue lease lives without a heartbeat (ms). */
  readonly leaseMs: number;
  /** Heartbeat cadence for in-flight work (ms); must be well under leaseMs. */
  readonly heartbeatMs: number;
  /** Reconciler pass interval: resume safe work, abandon stale leases (ms). */
  readonly reconcileIntervalMs: number;
  /** Max execution attempts per queue job (operator retries included). */
  readonly maxAttempts: number;
}

export interface RuntimeConfig {
  readonly mode: FactoryRuntimeMode;
  readonly host: string;
  readonly port: number;
  readonly factoryDir: string;
  readonly allowedOrigins: readonly string[];
  readonly publicBaseUrl?: string;
  readonly operatorTokenSource: OperatorTokenSource;
  readonly csrfToken?: string;
  readonly research: ResearchRuntimeConfig;
  readonly workspace: WorkspaceRuntimeConfig;
  readonly execution: ExecutionRuntimeConfig;
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
  readonly SF_RESEARCH_ALLOW_NETWORK?: string;
  readonly SF_RESEARCH_DOC_URLS?: string;
  readonly SF_RESEARCH_SEARCH_PROVIDER?: string;
  readonly SF_RESEARCH_SEARCH_API_KEY?: string;
  readonly SF_RESEARCH_MAX_SOURCES?: string;
  readonly SF_RESEARCH_MAX_DURATION_MS?: string;
  readonly SF_WORKSPACE_BOUNDARY?: string;
  readonly SF_WORKSPACE_APPROVED_FOLDERS?: string;
  readonly SF_WORKSPACE_CHECKOUT_ROOT?: string;
  readonly SF_WORKSPACE_DIRTY_POLICY?: string;
  readonly SF_GIT_CHECKOUT_TOKEN?: string;
  readonly SF_EXEC_LEASE_MS?: string;
  readonly SF_EXEC_HEARTBEAT_MS?: string;
  readonly SF_EXEC_RECONCILE_INTERVAL_MS?: string;
  readonly SF_EXEC_MAX_ATTEMPTS?: string;
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

const DEFAULT_RESEARCH_MAX_SOURCES = 12;
const DEFAULT_RESEARCH_MAX_DURATION_MS = 120_000;

const DEFAULT_EXEC_LEASE_MS = 60_000;
const DEFAULT_EXEC_HEARTBEAT_MS = 15_000;
const DEFAULT_EXEC_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_EXEC_MAX_ATTEMPTS = 3;

/** Resolve the execution queue/daemon config from the environment. */
export function resolveExecutionRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
): ExecutionRuntimeConfig {
  return {
    leaseMs: parsePort(env.SF_EXEC_LEASE_MS, DEFAULT_EXEC_LEASE_MS),
    heartbeatMs: parsePort(env.SF_EXEC_HEARTBEAT_MS, DEFAULT_EXEC_HEARTBEAT_MS),
    reconcileIntervalMs: parsePort(
      env.SF_EXEC_RECONCILE_INTERVAL_MS,
      DEFAULT_EXEC_RECONCILE_INTERVAL_MS,
    ),
    maxAttempts: parsePort(env.SF_EXEC_MAX_ATTEMPTS, DEFAULT_EXEC_MAX_ATTEMPTS),
  };
}

function parseBool(value: string | undefined): boolean {
  const cleaned = clean(value)?.toLowerCase();
  return cleaned === '1' || cleaned === 'true' || cleaned === 'yes';
}

/**
 * Resolve the research runtime config from the environment. Reads only the
 * PRESENCE of `SF_RESEARCH_SEARCH_API_KEY` — never its value (hardening E5).
 */
export function resolveResearchRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
): ResearchRuntimeConfig {
  return {
    allowNetwork: parseBool(env.SF_RESEARCH_ALLOW_NETWORK),
    documentationUrls: splitCsv(env.SF_RESEARCH_DOC_URLS),
    searchProviderId: clean(env.SF_RESEARCH_SEARCH_PROVIDER),
    searchCredentialsPresent: clean(env.SF_RESEARCH_SEARCH_API_KEY) !== undefined,
    maxSources: parsePort(env.SF_RESEARCH_MAX_SOURCES, DEFAULT_RESEARCH_MAX_SOURCES),
    maxDurationMs: parsePort(env.SF_RESEARCH_MAX_DURATION_MS, DEFAULT_RESEARCH_MAX_DURATION_MS),
  };
}

/**
 * Resolve the workspace materialization config from the environment. Reads only
 * the PRESENCE of `SF_GIT_CHECKOUT_TOKEN` — never its value (hardening E5).
 * Defaults: the approved local boundary is the workspace root that owns the
 * factory dir, and checkouts land under `<factoryDir>/workspaces`.
 */
export function resolveWorkspaceRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
  factoryDir: string = resolveFactoryDir(env),
): WorkspaceRuntimeConfig {
  return {
    localBoundaryRoot: clean(env.SF_WORKSPACE_BOUNDARY) ?? dirname(factoryDir),
    approvedFolders: splitCsv(env.SF_WORKSPACE_APPROVED_FOLDERS),
    checkoutRoot: clean(env.SF_WORKSPACE_CHECKOUT_ROOT) ?? join(factoryDir, 'workspaces'),
    checkoutCredentialsPresent: clean(env.SF_GIT_CHECKOUT_TOKEN) !== undefined,
    dirtyStatePolicy:
      clean(env.SF_WORKSPACE_DIRTY_POLICY)?.toLowerCase() === 'reject'
        ? 'reject_dirty'
        : 'allow_dirty',
  };
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
  const factoryDir = resolveFactoryDir(env, cwd);

  return {
    mode,
    host,
    port,
    factoryDir,
    allowedOrigins,
    publicBaseUrl,
    operatorTokenSource,
    csrfToken: clean(env.SF_CSRF_TOKEN),
    research: resolveResearchRuntimeConfig(env),
    workspace: resolveWorkspaceRuntimeConfig(env, factoryDir),
    execution: resolveExecutionRuntimeConfig(env),
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
