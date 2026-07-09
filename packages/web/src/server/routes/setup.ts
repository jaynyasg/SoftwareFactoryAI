/**
 * Setup status route (read-only).
 *
 *   GET /api/setup — feeds the UI setup checklist.
 *
 * Reports whether a local operator token exists, conservative placeholders
 * for sandbox/adapter readiness (real detection is exercised at start/exec
 * time), and REAL deploy readiness (full-factory U8): the deploy runtime
 * config (Render key presence, service id, hosted URL, git destination) is
 * inspected and the missing pieces are named. Missing deploy setup never
 * blocks local execution — the deploy stage pauses with setup-required (R30).
 *
 * The `workspace` section (full-factory U4) reports the materialization rules
 * for this runtime: in local mode, which boundary local folders must resolve
 * inside; in cloud mode, that laptop paths are UNAVAILABLE (KTD5) and a GitHub
 * repository or uploaded PRD is required.
 *
 * The `research` and `storage` sections (full-factory U10) complete the cloud
 * setup diagnostics: research provider readiness and whether the JSONL ledger
 * directory is explicitly configured (cloud instances without SF_FACTORY_DIR
 * on a persistent disk lose the ledger on redeploy).
 *
 * The THREE credential surfaces stay separate (hardening E5) — source checkout
 * (`workspace.materialization.checkoutCredentials`), deploy (`deploy`), and
 * research provider (`research.searchCredentials`) — and every credential is
 * reported by PRESENCE only, never a value.
 */
import {
  resolveDeployRuntimeConfig,
  resolveFactoryDir,
  resolveResearchRuntimeConfig,
  resolveWorkspaceRuntimeConfig,
} from '../runtime';
import type {
  DeployRuntimeConfig,
  ResearchRuntimeConfig,
  RuntimeConfig,
  WorkspaceRuntimeConfig,
} from '../runtime';
import type { ApiResponse, RouteContext, RouteDef } from '../app';

/**
 * Real deploy readiness from the deploy runtime config (U8). Reports only
 * presence/ids — never credential values (E5).
 */
function deploySetup(deploy: DeployRuntimeConfig): { status: 'ready' | 'required'; missing: string[] } {
  const missing: string[] = [];
  if (!deploy.renderApiKeyPresent) {
    missing.push('Render API key (RENDER_API_KEY or SF_RENDER_API_KEY)');
  }
  if (deploy.renderServiceId === undefined) {
    missing.push('Render service id (SF_RENDER_SERVICE_ID)');
  }
  if (deploy.hostedUrl === undefined) {
    missing.push('hosted health URL (SF_RENDER_HOSTED_URL)');
  }
  const hasDestination =
    (deploy.githubOwner !== undefined && deploy.githubRepo !== undefined) ||
    deploy.allowTemporaryRepo;
  if (!hasDestination) {
    missing.push(
      'git destination (SF_DEPLOY_GITHUB_OWNER + SF_DEPLOY_GITHUB_REPO, or SF_DEPLOY_ALLOW_TEMP_REPO)',
    );
  }
  return { status: missing.length === 0 ? 'ready' : 'required', missing };
}

function workspaceSetup(mode: 'local' | 'cloud', workspace: WorkspaceRuntimeConfig): unknown {
  const common = {
    checkoutRoot: workspace.checkoutRoot,
    // E5: presence only — the SF_GIT_CHECKOUT_TOKEN value is never surfaced.
    checkoutCredentials: { present: workspace.checkoutCredentialsPresent },
    dirtyStatePolicy: workspace.dirtyStatePolicy,
  };
  if (mode === 'cloud') {
    return {
      ...common,
      localFolders: {
        status: 'unavailable',
        reason:
          'Cloud runs never read laptop paths (KTD5). Provide a GitHub repository, upload the PRD content, or use a future upload/sync input.',
      },
      githubRepos: { status: 'available' },
    };
  }
  return {
    ...common,
    localFolders: {
      status: 'bounded',
      boundaryRoot: workspace.localBoundaryRoot,
      approvedFolders: workspace.approvedFolders,
      reason:
        'Local folders must resolve inside the approved working boundary or an explicitly approved operator folder.',
    },
    githubRepos: { status: 'available' },
  };
}

/**
 * Research provider readiness (U10). Reports the configured provider and
 * credential PRESENCE — never the `SF_RESEARCH_SEARCH_API_KEY` value (E5).
 */
function researchSetup(research: ResearchRuntimeConfig): unknown {
  return {
    allowNetwork: research.allowNetwork,
    documentationUrls: research.documentationUrls,
    provider: research.searchProviderId ?? null,
    searchCredentials: { present: research.searchCredentialsPresent },
    budgets: { maxSources: research.maxSources, maxDurationMs: research.maxDurationMs },
  };
}

/**
 * Persistent-storage diagnostics (U10). The V1.5 event store is a
 * single-instance JSONL ledger: local disks persist by default, but a cloud
 * instance must point `SF_FACTORY_DIR` at a mounted persistent disk or the
 * ledger disappears on redeploy.
 */
function storageSetup(mode: 'local' | 'cloud', runtime: RuntimeConfig | undefined): unknown {
  const factoryDir = runtime?.factoryDir ?? resolveFactoryDir();
  const persistent = mode === 'local' || runtime?.factoryDirSource === 'env';
  return {
    eventStore: 'jsonl',
    singleInstance: true,
    factoryDir,
    status: persistent ? 'ready' : 'attention',
    ...(persistent
      ? {}
      : {
          missing: [
            'persistent ledger directory (set SF_FACTORY_DIR to a mounted persistent disk, e.g. /var/data/.factory)',
          ],
        }),
  };
}

async function getSetup(ctx: RouteContext): Promise<ApiResponse> {
  const session = await ctx.operatorToken.current();
  const runtime = ctx.config.runtime;
  const mode = runtime?.mode ?? 'local';
  const workspaceConfig = runtime?.workspace ?? resolveWorkspaceRuntimeConfig();
  return {
    status: 200,
    body: {
      operatorToken: { present: session !== null },
      sandbox: { status: 'unknown' },
      adapters: { status: 'unknown', detected: [] as readonly string[] },
      deploy: deploySetup(runtime?.deploy ?? resolveDeployRuntimeConfig()),
      research: researchSetup(runtime?.research ?? resolveResearchRuntimeConfig()),
      storage: storageSetup(mode, runtime),
      workspace: {
        root: process.cwd(),
        materialization: workspaceSetup(mode, workspaceConfig),
      },
      runtime: runtime
        ? {
            mode: runtime.mode,
            publicBaseUrl: runtime.publicBaseUrl,
            factoryDir: runtime.factoryDir,
            operatorTokenSource: runtime.operatorTokenSource,
          }
        : { mode: 'local' },
    },
  };
}

export function setupRoutes(): RouteDef[] {
  return [{ method: 'GET', pattern: '/api/setup', handler: getSetup }];
}
