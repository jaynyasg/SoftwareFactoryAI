/**
 * Setup status route (read-only).
 *
 *   GET /api/setup — feeds the UI setup checklist.
 *
 * Reports whether a local operator token exists and returns conservative
 * placeholders for sandbox/adapter/deploy readiness. Real sandbox/adapter
 * detection lands in U5/U6 and deploy config in U9; until then these are
 * intentionally "unknown"/"required" so the checklist shows work remaining.
 *
 * The `workspace` section (full-factory U4) reports the materialization rules
 * for this runtime: in local mode, which boundary local folders must resolve
 * inside; in cloud mode, that laptop paths are UNAVAILABLE (KTD5) and a GitHub
 * repository or uploaded PRD is required. Source checkout credentials are a
 * separate setup surface from deploy and research credentials (E5) — only
 * their PRESENCE is reported, never a value.
 */
import { resolveWorkspaceRuntimeConfig } from '../runtime';
import type { WorkspaceRuntimeConfig } from '../runtime';
import type { ApiResponse, RouteContext, RouteDef } from '../app';

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
      deploy: { status: 'required' },
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
