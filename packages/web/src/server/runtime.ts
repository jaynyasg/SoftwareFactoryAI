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
  createSecretBox,
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
  /**
   * Whether the daemon may DRAIN queued work without an operator resume.
   * Server runtimes resolve this from `SF_EXEC_AUTOSTART` and default to
   * FALSE: opening the factory never runs leftover queued work automatically —
   * the daemon boots held and the operator resumes explicitly. The static
   * default below is TRUE so directly-constructed daemons (tests, embedded
   * callers passing partial configs) keep the original drain-on-start
   * behavior.
   */
  readonly autoStart: boolean;
}

/**
 * Deploy/handoff runtime configuration (full-factory U8).
 *
 * Deploy credentials are a SEPARATE setup surface from source checkout and
 * research credentials (hardening E5). Only credential PRESENCE is resolved
 * into config — `RENDER_API_KEY`/`SF_RENDER_API_KEY` stays in the environment
 * and is read exclusively by the Render client at deploy time, never recorded
 * as evidence. Missing deploy setup NEVER blocks local execution: the deploy
 * stage pauses with `deploy.setup_required` instead (R30).
 */
export interface DeployRuntimeConfig {
  /** Whether a Render API key is PRESENT (never the value). */
  readonly renderApiKeyPresent: boolean;
  /** The target Render service id (`srv-…`), when configured. */
  readonly renderServiceId?: string;
  /** The hosted URL post-deploy health checks probe, when configured. */
  readonly hostedUrl?: string;
  /** User-provided GitHub destination for the packaged repo. */
  readonly githubOwner?: string;
  readonly githubRepo?: string;
  /** Whether a factory-owned temporary repo may back the deploy. */
  readonly allowTemporaryRepo: boolean;
  /** Local preview command for the packaged app (e.g. `pnpm dev`), when set. */
  readonly previewCommand?: string;
  /** Local preview URL health is probed at, when a preview command is set. */
  readonly previewUrl?: string;
  /** Whether a Vercel token is PRESENT (single-tenant env; never the value). */
  readonly vercelTokenPresent: boolean;
  /** Optional hosted-URL override for Vercel health checks. */
  readonly vercelHostedUrl?: string;
}

export interface RuntimeConfig {
  readonly mode: FactoryRuntimeMode;
  readonly host: string;
  readonly port: number;
  readonly factoryDir: string;
  /**
   * How the factory dir was chosen: `env` (explicit `SF_FACTORY_DIR`, e.g. a
   * mounted persistent disk in cloud mode) or `derived` (walked up from the
   * working directory). Cloud setup diagnostics use this to flag ledgers that
   * would land on an ephemeral filesystem (U10).
   */
  readonly factoryDirSource?: 'env' | 'derived';
  readonly allowedOrigins: readonly string[];
  readonly publicBaseUrl?: string;
  readonly operatorTokenSource: OperatorTokenSource;
  readonly csrfToken?: string;
  readonly research: ResearchRuntimeConfig;
  readonly workspace: WorkspaceRuntimeConfig;
  readonly execution: ExecutionRuntimeConfig;
  readonly deploy: DeployRuntimeConfig;
  /** Multi-user activation + validated secrets config (U11). */
  readonly multiUser: MultiUserRuntimeConfig;
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
  readonly SF_MULTI_USER?: string;
  readonly SF_MASTER_KEY?: string;
  readonly SF_BOOTSTRAP_INVITE?: string;
  readonly SF_BOOTSTRAP_REARM?: string;
  readonly SF_INSECURE_COOKIES?: string;
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
  readonly SF_EXEC_AUTOSTART?: string;
  readonly RENDER_API_KEY?: string;
  readonly SF_RENDER_API_KEY?: string;
  readonly SF_VERCEL_TOKEN?: string;
  readonly SF_VERCEL_HOSTED_URL?: string;
  readonly SF_RENDER_SERVICE_ID?: string;
  readonly SF_RENDER_HOSTED_URL?: string;
  readonly SF_DEPLOY_GITHUB_OWNER?: string;
  readonly SF_DEPLOY_GITHUB_REPO?: string;
  readonly SF_DEPLOY_ALLOW_TEMP_REPO?: string;
  readonly SF_PREVIEW_COMMAND?: string;
  readonly SF_PREVIEW_URL?: string;
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

/**
 * Static execution queue/daemon defaults — the single source of truth for the
 * lease/heartbeat/reconcile/retry-budget numbers (the daemon and ticket
 * executor reuse it rather than re-declaring the values).
 */
export const DEFAULT_EXECUTION_RUNTIME_CONFIG: ExecutionRuntimeConfig = {
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  reconcileIntervalMs: 30_000,
  maxAttempts: 3,
  autoStart: true,
};

/**
 * Resolve the execution queue/daemon config from the environment. `autoStart`
 * deliberately does NOT inherit the static default: server runtimes boot the
 * daemon HELD unless `SF_EXEC_AUTOSTART` explicitly opts back in, so opening
 * the factory never runs queued work until the operator resumes.
 */
export function resolveExecutionRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
): ExecutionRuntimeConfig {
  return {
    leaseMs: parsePort(env.SF_EXEC_LEASE_MS, DEFAULT_EXECUTION_RUNTIME_CONFIG.leaseMs),
    heartbeatMs: parsePort(env.SF_EXEC_HEARTBEAT_MS, DEFAULT_EXECUTION_RUNTIME_CONFIG.heartbeatMs),
    reconcileIntervalMs: parsePort(
      env.SF_EXEC_RECONCILE_INTERVAL_MS,
      DEFAULT_EXECUTION_RUNTIME_CONFIG.reconcileIntervalMs,
    ),
    maxAttempts: parsePort(env.SF_EXEC_MAX_ATTEMPTS, DEFAULT_EXECUTION_RUNTIME_CONFIG.maxAttempts),
    autoStart: parseBool(env.SF_EXEC_AUTOSTART),
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

/**
 * Resolve the deploy/handoff runtime config from the environment. Reads only
 * the PRESENCE of the Render API key — never its value (hardening E5).
 */
export function resolveDeployRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
): DeployRuntimeConfig {
  return {
    renderApiKeyPresent:
      clean(env.SF_RENDER_API_KEY) !== undefined || clean(env.RENDER_API_KEY) !== undefined,
    renderServiceId: clean(env.SF_RENDER_SERVICE_ID),
    hostedUrl: clean(env.SF_RENDER_HOSTED_URL),
    githubOwner: clean(env.SF_DEPLOY_GITHUB_OWNER),
    githubRepo: clean(env.SF_DEPLOY_GITHUB_REPO),
    allowTemporaryRepo: parseBool(env.SF_DEPLOY_ALLOW_TEMP_REPO),
    previewCommand: clean(env.SF_PREVIEW_COMMAND),
    previewUrl: clean(env.SF_PREVIEW_URL),
    vercelTokenPresent: clean(env.SF_VERCEL_TOKEN) !== undefined,
    vercelHostedUrl: clean(env.SF_VERCEL_HOSTED_URL),
  };
}

/**
 * Scale-safety diagnostics (full-factory U11).
 *
 * This build persists events in a single-instance JSONL ledger and runs the
 * execution queue as a fold over `queue.*` ledger events owned by ONE daemon
 * process. Horizontal scaling — more than one instance (or daemon) against the
 * same ledger — is UNSAFE until the database-backed EventStore and durable
 * queue replacement lands: JSONL appends and per-run sequence allocation are
 * serialized per process, not across processes. These diagnostics feed
 * `GET /api/setup` (the `queue` section) and the cloud startup log line so a
 * hosted operator sees the limit instead of discovering it.
 */
export interface ScaleDiagnostics {
  /** Event persistence backend in this build. */
  readonly storageMode: 'jsonl';
  /** Execution queue backend: a fold over `queue.*` ledger events. */
  readonly queueMode: 'ledger';
  /** This build supports exactly one instance per ledger. */
  readonly singleInstanceOnly: true;
  readonly horizontalScaling: 'unsafe';
  /** Operator-facing warning naming the limit and the migration seam. */
  readonly warning: string;
}

/**
 * Resolve the scale-safety diagnostics. Constant for this build (there is one
 * storage and one queue implementation); a database-backed store/queue keys
 * this off runtime config when it lands (the U11 seam).
 */
export function resolveScaleDiagnostics(): ScaleDiagnostics {
  return {
    storageMode: 'jsonl',
    queueMode: 'ledger',
    singleInstanceOnly: true,
    horizontalScaling: 'unsafe',
    warning:
      'Single-instance only: run exactly one instance (and one execution daemon) against this ' +
      'ledger. JSONL event storage and the ledger-backed queue do not support horizontal ' +
      'scaling; scaling out requires the database-backed event store and durable queue ' +
      'described in ARCHITECTURE.md ("Hosted Scale Migration Seam").',
  };
}

/**
 * The scale-safety startup log line (U11). Server entry points emit this once
 * per process in cloud mode so hosted logs state the single-instance limit.
 */
export function scaleSafetyStartupLine(config: Pick<RuntimeConfig, 'mode'>): string {
  const diagnostics = resolveScaleDiagnostics();
  return (
    `[software-factory] scale-safety: mode=${config.mode} ` +
    `storage=${diagnostics.storageMode} queue=${diagnostics.queueMode} ` +
    `horizontal-scaling=${diagnostics.horizontalScaling} — ${diagnostics.warning}`
  );
}

/* ----------------------------------------------------------------------------
 * Multi-user activation (U11)
 * ------------------------------------------------------------------------- */

/** Resolved multi-user mode + validated secret config. */
export interface MultiUserRuntimeConfig {
  readonly enabled: boolean;
  /**
   * Why multi-user is active: the explicit env flag, or initialized auth
   * stores found on disk with the flag UNSET (`disk_state`) — the downgrade
   * fail-closed path: unsetting SF_MULTI_USER can never silently re-enable
   * the shared operator token on a deployment that already has accounts.
   */
  readonly source?: 'env' | 'disk_state';
  /** The validated master key value (present only when it parsed). */
  readonly masterKey?: string;
  readonly bootstrapInvite?: string;
  readonly bootstrapRearm: boolean;
  /** SF_INSECURE_COOKIES=1: plain-HTTP LAN opt-out (drops __Host-/Secure). */
  readonly insecureCookies: boolean;
  /** Operator-facing warnings the entry points log once at boot. */
  readonly warnings: readonly string[];
}

/** Minimum bootstrap-invite length (mirrors the auth service's floor). */
const MIN_BOOTSTRAP_ENTROPY_CHARS = 16;

function flagOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Whether this factory dir already holds initialized auth stores. */
export function authStoresInitialized(factoryDir: string): boolean {
  return existsSync(join(factoryDir, 'auth', 'accounts.json'));
}

/**
 * Resolve (and FAIL-CLOSED validate) the multi-user configuration.
 *
 * With `SF_MULTI_USER=1` the boot REQUIRES, with exact remediation messages:
 *  - a valid `SF_MASTER_KEY` (32 bytes, hex or base64url) — the credential
 *    vault cannot exist without it;
 *  - a high-entropy `SF_BOOTSTRAP_INVITE` when one is set at all;
 *  - a configured browser origin (`SF_PUBLIC_BASE_URL`/`RENDER_EXTERNAL_URL`
 *    or `SF_ALLOWED_ORIGINS`) — the pre-session CSRF defense on the two
 *    public POSTs depends on the origin check.
 *
 * With the flag UNSET but initialized auth stores on disk, multi-user STAYS
 * ON (`source: 'disk_state'`, warning logged) so the legacy shared token is
 * still refused — a config slip never downgrades a live multi-user deploy.
 * Fresh single-tenant deployments (no flag, no stores) resolve identically to
 * before this unit existed.
 */
export function resolveMultiUserRuntimeConfig(
  env: RuntimeEnv = process.env as RuntimeEnv,
  options: { readonly factoryDir: string },
): MultiUserRuntimeConfig {
  const flagged = flagOn(env.SF_MULTI_USER);
  const initialized = authStoresInitialized(options.factoryDir);
  const warnings: string[] = [];

  if (!flagged && !initialized) {
    return { enabled: false, bootstrapRearm: false, insecureCookies: false, warnings };
  }
  if (!flagged && initialized) {
    warnings.push(
      '[software-factory] multi-user: SF_MULTI_USER is unset but initialized auth stores exist ' +
        `under ${join(options.factoryDir, 'auth')} — staying in multi-user mode (fail closed). ` +
        'The legacy shared operator token remains refused. Set SF_MULTI_USER=1 to silence this, ' +
        'or delete the auth stores to genuinely return to single-tenant.',
    );
  }

  // Master key: REQUIRED when the flag explicitly claims multi-user; the
  // disk-state path degrades to an unreadable vault instead of refusing boot
  // (logins keep working; runs block with the admin-directed intervention).
  const rawKey = clean(env.SF_MASTER_KEY);
  let masterKey: string | undefined;
  if (rawKey !== undefined) {
    try {
      createSecretBox({ masterKey: rawKey });
      masterKey = rawKey;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (flagged) {
        throw new Error(
          `SF_MULTI_USER=1 requires a valid SF_MASTER_KEY, but the provided value did not parse ` +
            `(${message}). Generate one with:\n` +
            `  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"\n` +
            `and set it in your platform's SECRET store (never a file under the factory dir), then redeploy.`,
        );
      }
      warnings.push(
        `[software-factory] multi-user: SF_MASTER_KEY did not parse (${message}) — the credential ` +
          'vault is UNREADABLE until an admin fixes it. Logins keep working; runs stay blocked.',
      );
    }
  } else if (flagged) {
    throw new Error(
      'SF_MULTI_USER=1 requires SF_MASTER_KEY (the credential vault cannot exist without it). ' +
        'Generate one with:\n' +
        '  node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64url\'))"\n' +
        "and set it in your platform's SECRET store (never a file under the factory dir), then redeploy.",
    );
  } else {
    warnings.push(
      '[software-factory] multi-user (disk_state): SF_MASTER_KEY is unset — the credential vault ' +
        'is UNREADABLE until an admin restores it. Logins keep working; runs stay blocked.',
    );
  }

  // Key-file-on-disk hygiene: the master key belongs in the platform secret
  // store; a copy on the (backed-up, persistent) factory disk defeats
  // encryption-at-rest.
  for (const name of ['master-key', 'master-key.txt', '.master-key', 'sf-master-key']) {
    if (existsSync(join(options.factoryDir, name))) {
      warnings.push(
        `[software-factory] multi-user: found "${name}" under the factory dir — the master key ` +
          'must live ONLY in the platform secret store. A key file next to the encrypted vault ' +
          'defeats encryption at rest; delete it.',
      );
    }
  }

  const bootstrapInvite = clean(env.SF_BOOTSTRAP_INVITE);
  if (flagged && bootstrapInvite !== undefined && bootstrapInvite.length < MIN_BOOTSTRAP_ENTROPY_CHARS) {
    throw new Error(
      `SF_BOOTSTRAP_INVITE is too short (${bootstrapInvite.length} chars; minimum ` +
        `${MIN_BOOTSTRAP_ENTROPY_CHARS}). It guards first-admin creation on a public URL — use a ` +
        'high-entropy value, e.g.:\n  openssl rand -base64 24',
    );
  }

  // The pre-session CSRF defense on login/redeem depends on the origin check:
  // multi-user boots must pin the browser origin explicitly.
  if (flagged) {
    const publicBaseUrl = clean(env.SF_PUBLIC_BASE_URL) ?? clean(env.RENDER_EXTERNAL_URL);
    const explicitOrigins = splitCsv(env.SF_ALLOWED_ORIGINS);
    if (publicBaseUrl === undefined && explicitOrigins.length === 0) {
      throw new Error(
        'SF_MULTI_USER=1 requires a configured browser origin: set SF_PUBLIC_BASE_URL ' +
          '(Render sets RENDER_EXTERNAL_URL automatically) or SF_ALLOWED_ORIGINS. The login and ' +
          'invite pages verify the request Origin against it — without it the pre-session CSRF ' +
          'defense cannot hold.',
      );
    }
  }

  return {
    enabled: true,
    source: flagged ? 'env' : 'disk_state',
    masterKey,
    bootstrapInvite,
    bootstrapRearm: flagOn(env.SF_BOOTSTRAP_REARM),
    insecureCookies: flagOn(env.SF_INSECURE_COOKIES),
    warnings,
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
  const multiUser = resolveMultiUserRuntimeConfig(env, { factoryDir });

  return {
    mode,
    host,
    port,
    factoryDir,
    factoryDirSource: clean(env.SF_FACTORY_DIR) !== undefined ? 'env' : 'derived',
    allowedOrigins,
    publicBaseUrl,
    operatorTokenSource,
    csrfToken: clean(env.SF_CSRF_TOKEN),
    research: resolveResearchRuntimeConfig(env),
    workspace: resolveWorkspaceRuntimeConfig(env, factoryDir),
    execution: resolveExecutionRuntimeConfig(env),
    deploy: resolveDeployRuntimeConfig(env),
    multiUser,
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
