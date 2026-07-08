/**
 * Setup route (full-factory U4) — the workspace materialization setup surface.
 *
 * GET /api/setup must state the source rules for this runtime: local mode
 * reports the approved local-folder boundary; cloud mode reports laptop paths
 * as UNAVAILABLE (KTD5). Source checkout credentials are reported by PRESENCE
 * only — the value never appears anywhere in the response (E5).
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import { createApp, type ApiResponse, type App } from '../../src/server/app';
import { resolveRuntimeConfig } from '../../src/server/runtime';
import type { RuntimeConfig } from '../../src/server/runtime';
import { testRuntimeConfig } from '../_helpers/runtime';

const TOKEN = 'test-operator-token';

function runtimeConfig(
  mode: 'local' | 'cloud',
  workspace?: Partial<RuntimeConfig['workspace']>,
): RuntimeConfig {
  return testRuntimeConfig({
    mode,
    factoryDir: 'C:\\repo\\.factory',
    workspace: {
      localBoundaryRoot: 'C:\\repo',
      approvedFolders: ['D:\\projects\\approved'],
      checkoutRoot: 'C:\\repo\\.factory\\workspaces',
      ...workspace,
    },
  });
}

function makeApp(runtime?: RuntimeConfig): App {
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  return createApp({
    store: createInMemoryEventStore(),
    operatorToken: provider,
    config: runtime !== undefined ? { runtime } : undefined,
    planner: null,
    researcher: null,
    materializer: null,
  });
}

async function getSetup(app: App): Promise<Record<string, unknown>> {
  const res: ApiResponse = await app.handle({
    method: 'GET',
    path: '/api/setup',
    query: {},
    headers: {},
  });
  expect(res.status).toBe(200);
  return res.body as Record<string, unknown>;
}

interface MaterializationView {
  readonly checkoutRoot: string;
  readonly checkoutCredentials: { readonly present: boolean };
  readonly dirtyStatePolicy: string;
  readonly localFolders: {
    readonly status: string;
    readonly reason?: string;
    readonly boundaryRoot?: string;
    readonly approvedFolders?: readonly string[];
  };
  readonly githubRepos: { readonly status: string };
}

function materialization(body: Record<string, unknown>): MaterializationView {
  const workspace = body.workspace as { materialization: MaterializationView };
  return workspace.materialization;
}

describe('GET /api/setup — workspace materialization surface', () => {
  it('local mode reports the bounded local-folder rules and checkout root', async () => {
    const body = await getSetup(makeApp(runtimeConfig('local')));
    const view = materialization(body);

    expect(view.localFolders.status).toBe('bounded');
    expect(view.localFolders.boundaryRoot).toBe('C:\\repo');
    expect(view.localFolders.approvedFolders).toEqual(['D:\\projects\\approved']);
    expect(view.localFolders.reason).toMatch(/approved working boundary/i);
    expect(view.githubRepos.status).toBe('available');
    expect(view.checkoutRoot).toBe('C:\\repo\\.factory\\workspaces');
    expect(view.dirtyStatePolicy).toBe('allow_dirty');
  });

  it('cloud mode reports laptop paths as UNAVAILABLE (KTD5) with the alternatives', async () => {
    const body = await getSetup(makeApp(runtimeConfig('cloud')));
    const view = materialization(body);

    expect(view.localFolders.status).toBe('unavailable');
    expect(view.localFolders.reason).toMatch(/never read laptop paths/i);
    expect(view.localFolders.reason).toMatch(/GitHub repository/i);
    expect(view.localFolders.boundaryRoot).toBeUndefined();
    expect(view.githubRepos.status).toBe('available');
  });

  it('reports checkout-credential PRESENCE only — the value never appears (E5)', async () => {
    const secret = 'ghp_SetupRouteSecretValue999';
    const runtime = resolveRuntimeConfig(
      { SF_GIT_CHECKOUT_TOKEN: secret, SF_WORKSPACE_BOUNDARY: 'C:\\work' },
      'C:\\repo',
    );
    // The resolved config itself carries presence only.
    expect(runtime.workspace.checkoutCredentialsPresent).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain(secret);

    const body = await getSetup(makeApp(runtime));
    expect(materialization(body).checkoutCredentials).toEqual({ present: true });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('still reports the operator-token and runtime sections', async () => {
    const body = await getSetup(makeApp(runtimeConfig('local')));
    expect(body.operatorToken).toEqual({ present: true });
    expect((body.runtime as { mode: string }).mode).toBe('local');
  });

  it('falls back to environment-derived defaults when no runtime config is injected', async () => {
    const body = await getSetup(makeApp());
    const view = materialization(body);
    expect(view.localFolders.status).toBe('bounded');
    expect(typeof view.checkoutRoot).toBe('string');
    expect(view.checkoutRoot.length).toBeGreaterThan(0);
  });
});

describe('resolveRuntimeConfig — workspace section', () => {
  it('defaults the boundary to the workspace root and checkouts under the factory dir', () => {
    // Forward slashes keep the dirname expectation identical on win32 + posix.
    const config = resolveRuntimeConfig({ SF_FACTORY_DIR: '/var/data/.factory' }, 'C:\\repo');
    expect(config.workspace.localBoundaryRoot).toBe('/var/data');
    expect(config.workspace.checkoutRoot).toContain('.factory');
    expect(config.workspace.approvedFolders).toEqual([]);
    expect(config.workspace.checkoutCredentialsPresent).toBe(false);
    expect(config.workspace.dirtyStatePolicy).toBe('allow_dirty');
  });

  it('honors explicit boundary, approved folders, checkout root, and dirty policy', () => {
    const config = resolveRuntimeConfig(
      {
        SF_WORKSPACE_BOUNDARY: 'D:\\work',
        SF_WORKSPACE_APPROVED_FOLDERS: 'D:\\a, E:\\b',
        SF_WORKSPACE_CHECKOUT_ROOT: 'D:\\checkouts',
        SF_WORKSPACE_DIRTY_POLICY: 'reject',
      },
      'C:\\repo',
    );
    expect(config.workspace.localBoundaryRoot).toBe('D:\\work');
    expect(config.workspace.approvedFolders).toEqual(['D:\\a', 'E:\\b']);
    expect(config.workspace.checkoutRoot).toBe('D:\\checkouts');
    expect(config.workspace.dirtyStatePolicy).toBe('reject_dirty');
  });
});
