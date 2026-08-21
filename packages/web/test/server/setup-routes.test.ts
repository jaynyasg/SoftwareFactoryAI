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
  createAdapterCatalog,
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import type { AdapterCatalog, AdapterSetupState, ExecutionAdapter } from '@software-factory/core';
import { createApp, type ApiResponse, type App } from '../../src/server/app';
import { refreshAdapterSetupSnapshot } from '../../src/server/adapter-setup-snapshot';
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

function makeApp(runtime?: RuntimeConfig, adapterCatalog: AdapterCatalog | null = null): App {
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
    // Hermetic by default: the REAL catalog would background-probe the
    // machine's claude/codex CLIs from the setup route. Tests inject fakes.
    adapterCatalog,
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

describe('GET /api/setup — deploy readiness (full-factory U8)', () => {
  it('reports ready when the deploy runtime config is complete (presence only, no values)', async () => {
    const secret = 'rnd_SetupRouteRenderKey123';
    const runtime = resolveRuntimeConfig(
      {
        SF_RENDER_API_KEY: secret,
        SF_RENDER_SERVICE_ID: 'srv-42',
        SF_RENDER_HOSTED_URL: 'https://app.onrender.com',
        SF_DEPLOY_GITHUB_OWNER: 'octo',
        SF_DEPLOY_GITHUB_REPO: 'app',
      },
      'C:\\repo',
    );
    expect(runtime.deploy.renderApiKeyPresent).toBe(true);
    expect(JSON.stringify(runtime)).not.toContain(secret);

    const body = await getSetup(makeApp(runtime));
    expect(body.deploy).toEqual({ status: 'ready', missing: [] });
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('names the missing deploy setup without blocking anything locally', async () => {
    const body = await getSetup(makeApp(runtimeConfig('local')));
    const deploy = body.deploy as { status: string; missing: string[] };
    expect(deploy.status).toBe('required');
    expect(deploy.missing.join(' ')).toMatch(/Render API key/);
    expect(deploy.missing.join(' ')).toMatch(/git destination/);
  });
});

describe('GET /api/setup — research and storage surfaces (full-factory U10)', () => {
  it('reports research provider readiness by presence only (E5)', async () => {
    const secret = 'sk_SetupRouteResearchKey456';
    const runtime = resolveRuntimeConfig(
      { SF_RESEARCH_SEARCH_PROVIDER: 'tavily', SF_RESEARCH_SEARCH_API_KEY: secret },
      'C:\\repo',
    );
    const body = await getSetup(makeApp(runtime));
    const research = body.research as {
      provider: string | null;
      searchCredentials: { present: boolean };
      budgets: { maxSources: number; maxDurationMs: number };
    };
    expect(research.provider).toBe('tavily');
    expect(research.searchCredentials).toEqual({ present: true });
    expect(research.budgets.maxSources).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('flags cloud storage as attention without an explicit SF_FACTORY_DIR', async () => {
    const body = await getSetup(makeApp(runtimeConfig('cloud')));
    const storage = body.storage as { status: string; missing?: string[]; eventStore: string };
    expect(storage.eventStore).toBe('jsonl');
    expect(storage.status).toBe('attention');
    expect(String(storage.missing)).toMatch(/SF_FACTORY_DIR/);
  });

  it('reports cloud storage ready when SF_FACTORY_DIR is explicit; local is always ready', async () => {
    const cloud = resolveRuntimeConfig(
      { SF_RUNTIME: 'cloud', SF_FACTORY_DIR: '/var/data/.factory' },
      'C:\\repo',
    );
    const cloudBody = await getSetup(makeApp(cloud));
    expect((cloudBody.storage as { status: string }).status).toBe('ready');

    const localBody = await getSetup(makeApp(runtimeConfig('local')));
    expect((localBody.storage as { status: string }).status).toBe('ready');
  });
});

describe('GET /api/setup — queue/scale diagnostics (full-factory U11)', () => {
  interface QueueView {
    readonly mode: string;
    readonly storage: string;
    readonly singleInstance: boolean;
    readonly horizontalScaling: string;
    readonly warning: string;
  }

  it('reports the storage mode and queue mode', async () => {
    const body = await getSetup(makeApp(runtimeConfig('cloud')));
    const queue = body.queue as QueueView;
    expect(queue.mode).toBe('ledger');
    expect(queue.storage).toBe('jsonl');
    // The storage section stays the persistent-disk surface; both agree.
    expect((body.storage as { eventStore: string }).eventStore).toBe('jsonl');
  });

  it('carries an explicit single-instance-only warning against horizontal scaling', async () => {
    const body = await getSetup(makeApp(runtimeConfig('cloud')));
    const queue = body.queue as QueueView;
    expect(queue.singleInstance).toBe(true);
    expect(queue.horizontalScaling).toBe('unsafe');
    expect(queue.warning).toMatch(/single-instance only/i);
    expect(queue.warning).toMatch(/exactly one instance/i);
  });

  it('reports the same diagnostics in local mode (the limit is build-wide)', async () => {
    const body = await getSetup(makeApp(runtimeConfig('local')));
    const queue = body.queue as QueueView;
    expect(queue.mode).toBe('ledger');
    expect(queue.singleInstance).toBe(true);
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

/* ----------------------------------------------------------------------------
 * Adapter detection (real, non-blocking, cached)
 * ------------------------------------------------------------------------- */

function fakeAdapter(id: string, setup: Partial<AdapterSetupState>): ExecutionAdapter {
  return {
    id,
    family: 'codex',
    detectSetup: () =>
      Promise.resolve({ available: false, authenticated: false, capacity: 0, ...setup }),
    execute: () => Promise.reject(new Error('not under test')),
    reportCapacity: () => 1,
  };
}

describe('GET /api/setup — adapter detection', () => {
  it('reports unknown when this instance runs without a catalog', async () => {
    const body = await getSetup(makeApp(undefined, null));
    expect(body.adapters).toEqual({ status: 'unknown', detected: [] });
  });

  it('first read is pending (never blocks on probes); the completed detection is served after', async () => {
    const catalog: AdapterCatalog = createAdapterCatalog([
      fakeAdapter('codex-cli', { available: true, authenticated: true, capacity: 2 }),
      fakeAdapter('api', { available: false, detail: 'not configured' }),
    ]);
    const app = makeApp(undefined, catalog);

    const first = (await getSetup(app)).adapters as { status: string };
    expect(first.status).toBe('pending');

    // Deterministic completion of the detection pass, then re-read.
    await refreshAdapterSetupSnapshot(catalog);
    const second = (await getSetup(app)).adapters as {
      status: string;
      ready: readonly string[];
      detected: readonly { id: string; available: boolean; authenticated: boolean }[];
    };
    expect(second.status).toBe('ready');
    expect(second.ready).toEqual(['codex-cli']);
    expect(second.detected.map((row) => row.id)).toEqual(['codex-cli', 'api']);
  });

  it('reports attention (with per-adapter reasons) when nothing is ready', async () => {
    const catalog: AdapterCatalog = createAdapterCatalog([
      fakeAdapter('codex-cli', { available: true, authenticated: false, detail: 'not logged in' }),
    ]);
    const app = makeApp(undefined, catalog);
    await refreshAdapterSetupSnapshot(catalog);

    const adapters = (await getSetup(app)).adapters as {
      status: string;
      ready: readonly string[];
      detected: readonly { detail?: string }[];
    };
    expect(adapters.status).toBe('attention');
    expect(adapters.ready).toEqual([]);
    expect(adapters.detected[0].detail).toBe('not logged in');
  });

  it('folds a throwing probe into the adapter row instead of failing the route', async () => {
    const exploding: ExecutionAdapter = {
      ...fakeAdapter('codex-cli', {}),
      detectSetup: () => Promise.reject(new Error('probe exploded')),
    };
    const catalog = createAdapterCatalog([exploding]);
    await refreshAdapterSetupSnapshot(catalog);

    const adapters = (await getSetup(makeApp(undefined, catalog))).adapters as {
      status: string;
      detected: readonly { detail?: string }[];
    };
    expect(adapters.status).toBe('attention');
    expect(adapters.detected[0].detail).toContain('probe exploded');
  });
});
