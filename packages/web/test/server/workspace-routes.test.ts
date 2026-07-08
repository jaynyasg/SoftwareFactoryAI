/**
 * Workspace materialization routes (full-factory U4) — exercised through the
 * framework-agnostic app with the REAL runtime materializer behind a fixture
 * checkout client (no network, no real git):
 *
 *  - cloud runs record laptop-only paths as unavailable (KTD5),
 *  - local folders bind only inside the approved boundary (security evidence
 *    on rejection),
 *  - repo materialization records branch/commit and feeds research + the
 *    build contract,
 *  - retries converge instead of duplicating evidence,
 *  - the command guard protects the trigger, and
 *  - credential values never appear in responses or serialized events (E5).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import type { EventStore, FactoryEvent } from '@software-factory/core';
import type { GitCheckoutClient } from '@software-factory/worker';
import {
  createApp,
  type ApiRequest,
  type ApiResponse,
  type App,
  type RunResearcher,
} from '../../src/server/app';
import { createRuntimeWorkspaceMaterializer } from '../../src/server/workspace/runtime-materializer';
import type { RuntimeConfig } from '../../src/server/runtime';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';
const SECRET = 'ghp_WorkspaceRouteSecret5678';

let tmpRoot: string;
let boundaryDir: string;
let checkoutRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'sf-workspace-web-'));
  boundaryDir = join(tmpRoot, 'boundary');
  checkoutRoot = join(tmpRoot, 'checkouts');
  await mkdir(join(boundaryDir, 'site'), { recursive: true });
  await mkdir(checkoutRoot, { recursive: true });
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function deterministic(): { idGenerator: () => string; clock: () => number } {
  let id = 0;
  let now = 1_700_000_000_000;
  return {
    idGenerator: () => `evt-${(id += 1)}`,
    clock: () => (now += 1000),
  };
}

function runtimeConfig(mode: 'local' | 'cloud'): RuntimeConfig {
  return {
    mode,
    host: '127.0.0.1',
    port: 3000,
    factoryDir: join(tmpRoot, '.factory'),
    allowedOrigins: [ORIGIN],
    operatorTokenSource: 'file',
    research: {
      allowNetwork: false,
      documentationUrls: [],
      searchCredentialsPresent: false,
      maxSources: 12,
      maxDurationMs: 120_000,
    },
    workspace: {
      localBoundaryRoot: boundaryDir,
      approvedFolders: [],
      checkoutRoot,
      checkoutCredentialsPresent: false,
      dirtyStatePolicy: 'allow_dirty',
    },
  };
}

/** A fixture checkout client: materializes real files into the destination. */
function fixtureGit(
  files: Readonly<Record<string, string>> = { 'README.md': '# Fixture Repo' },
): GitCheckoutClient & { readonly calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async checkout({ dest }) {
      calls.push(calls.length + 1);
      await mkdir(dest, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dest, name), content, 'utf8');
      }
      return { branch: 'main', commit: 'fixturecommit123' };
    },
  };
}

/** A checkout client that fails until "setup is fixed". */
function flakyGit(): GitCheckoutClient & { fix(): void } {
  let healthy = false;
  const inner = fixtureGit();
  return {
    fix() {
      healthy = true;
    },
    checkout(args) {
      if (!healthy) {
        return Promise.reject(
          new Error(`git clone https://x-access-token:${SECRET}@github.com failed: auth`),
        );
      }
      return inner.checkout(args);
    },
  };
}

interface MakeAppOptions {
  readonly mode?: 'local' | 'cloud';
  readonly git?: GitCheckoutClient;
  readonly researcher?: RunResearcher | null;
  /** `null` disables materialization; `undefined` wires the runtime default. */
  readonly materializer?: null;
  /** `null` disables planning (the default for these tests). */
  readonly planner?: null | undefined;
}

function makeApp(options: MakeAppOptions = {}): { app: App; store: EventStore } {
  const det = deterministic();
  const store = createInMemoryEventStore(det);
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  const runtime = runtimeConfig(options.mode ?? 'local');
  let runSeq = 0;
  const app = createApp({
    store,
    operatorToken: provider,
    clock: det.clock,
    idGenerator: () => `run-${(runSeq += 1)}`,
    config: { allowedOrigins: [ORIGIN], csrfToken: CSRF, runtime },
    planner: 'planner' in options ? options.planner : null,
    researcher: options.researcher === undefined ? null : options.researcher,
    materializer:
      options.materializer === null
        ? null
        : createRuntimeWorkspaceMaterializer({
            runtime,
            clock: det.clock,
            git: options.git ?? fixtureGit(),
          }),
  });
  return { app, store };
}

function authedHeaders(): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
  body?: unknown,
): ApiRequest {
  return { method, path, query: {}, headers, body };
}

function record(res: ApiResponse): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

async function createRun(app: App, body: Record<string, unknown>): Promise<string> {
  const res = await app.handle(req('POST', '/api/runs', authedHeaders(), body));
  expect(res.status).toBe(201);
  return record(res).runId as string;
}

function types(events: readonly FactoryEvent[]): string[] {
  return events.map((event) => event.type);
}

interface WorkspaceView {
  readonly status: string;
  readonly attempts: number;
  readonly workspace?: {
    readonly kind: string;
    readonly path?: string;
    readonly repo?: string;
    readonly branch?: string;
    readonly commit?: string;
    readonly checkoutPath?: string;
  };
  readonly unavailableReason?: string;
  readonly requiredAction?: string;
  readonly failureReason?: string;
}

function workspaceOf(res: ApiResponse): WorkspaceView {
  return record(res).workspace as WorkspaceView;
}

describe('POST /api/runs/:id/workspace', () => {
  it('records a laptop-only path as unavailable on a cloud runtime (KTD5)', async () => {
    const { app, store } = makeApp({ mode: 'cloud' });
    const runId = await createRun(app, { prompt: 'x', localFolder: 'C:\\Users\\me\\laptop-only' });

    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(res.status).toBe(201);
    const view = workspaceOf(res);
    expect(view.status).toBe('unavailable');
    expect(view.unavailableReason).toMatch(/never read laptop paths/i);
    expect(view.requiredAction).toMatch(/GitHub repository/i);

    const ledger = await store.readRun(runId);
    expect(types(ledger)).toContain('workspace.unavailable');
    expect(types(ledger)).not.toContain('workspace.local_bound');
  });

  it('binds an approved local folder on a local runtime', async () => {
    const { app, store } = makeApp({ mode: 'local' });
    const folder = join(boundaryDir, 'site');
    const runId = await createRun(app, { prompt: 'x', localFolder: folder });

    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(res.status).toBe(201);
    const view = workspaceOf(res);
    expect(view.status).toBe('ready');
    expect(view.workspace?.kind).toBe('local_folder');
    expect(view.workspace?.path).toBe(folder);
    expect(types(await store.readRun(runId))).toContain('workspace.local_bound');
  });

  it('rejects an outside-boundary local folder with security evidence', async () => {
    const { app, store } = makeApp({ mode: 'local' });
    const outside = join(tmpRoot, 'outside-boundary');
    await mkdir(outside, { recursive: true });
    const runId = await createRun(app, { prompt: 'x', localFolder: outside });

    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(res.status).toBe(201);
    const view = workspaceOf(res);
    expect(view.status).toBe('unavailable');
    expect((record(res).result as { securityBlocked: boolean }).securityBlocked).toBe(true);

    const ledger = await store.readRun(runId);
    expect(types(ledger)).toContain('security.block');
    expect(types(ledger)).toContain('workspace.unavailable');
  });

  it('materializes a GitHub repo, recording branch + commit as evidence', async () => {
    const { app, store } = makeApp({ mode: 'cloud' });
    const runId = await createRun(app, { prompt: 'x', githubRepo: 'octo/fixture' });

    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(res.status).toBe(201);
    const view = workspaceOf(res);
    expect(view.status).toBe('ready');
    expect(view.workspace).toMatchObject({
      kind: 'repo_checkout',
      repo: 'octo/fixture',
      branch: 'main',
      commit: 'fixturecommit123',
    });

    const ledger = await store.readRun(runId);
    expect(types(ledger)).toEqual(
      expect.arrayContaining([
        'workspace.checkout_started',
        'workspace.ref_resolved',
        'workspace.checkout_completed',
      ]),
    );
  });

  it('converges on retry: a second trigger reuses the ready workspace (200, no new events)', async () => {
    const git = fixtureGit();
    const { app, store } = makeApp({ mode: 'cloud', git });
    const runId = await createRun(app, { prompt: 'x', githubRepo: 'octo/fixture' });

    const first = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    const before = (await store.readRun(runId)).length;
    const second = await app.handle(
      req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((record(second).result as { converged: boolean }).converged).toBe(true);
    expect(git.calls).toHaveLength(1);
    expect((await store.readRun(runId)).length).toBe(before);
  });

  it('retries a failed checkout after setup changes without duplicating prior evidence', async () => {
    const git = flakyGit();
    const { app, store } = makeApp({ mode: 'cloud', git });
    const runId = await createRun(app, { prompt: 'x', githubRepo: 'octo/fixture' });

    const failed = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(workspaceOf(failed).status).toBe('failed');
    // E5: the sanitized failure carries no credential value.
    expect(JSON.stringify(failed.body)).not.toContain(SECRET);

    git.fix();
    const fixed = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(workspaceOf(fixed).status).toBe('ready');
    expect(workspaceOf(fixed).attempts).toBe(2);

    const ledger = await store.readRun(runId);
    expect(
      types(ledger).filter((type) => type === 'workspace.checkout_failed'),
    ).toHaveLength(1);
    expect(
      types(ledger).filter((type) => type === 'workspace.checkout_completed'),
    ).toHaveLength(1);
    expect(JSON.stringify(ledger)).not.toContain(SECRET);
  });

  it('rejects unauthenticated triggers with a single security event and no workspace events', async () => {
    const { app, store } = makeApp({ mode: 'local' });
    const runId = await createRun(app, { prompt: 'x', githubRepo: 'octo/fixture' });

    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, { origin: ORIGIN }, {}));
    expect(res.status).toBe(401);
    const ledger = await store.readRun(runId);
    expect(ledger.filter((event) => event.type === 'security.block')).toHaveLength(1);
    expect(ledger.some((event) => event.type.startsWith('workspace.'))).toBe(false);
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('POST', '/api/runs/ghost/workspace', authedHeaders(), {}));
    expect(res.status).toBe(404);
  });

  it('returns 503 when materialization is disabled on the instance', async () => {
    const { app } = makeApp({ materializer: null });
    const runId = await createRun(app, { prompt: 'x' });
    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(res.status).toBe(503);
    expect(record(res).error).toBe('workspace_disabled');
  });
});

describe('GET /api/runs/:id/workspace', () => {
  it('returns the projected workspace state', async () => {
    const { app } = makeApp({ mode: 'cloud' });
    const runId = await createRun(app, { prompt: 'x', githubRepo: 'octo/fixture' });
    await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));

    const res = await app.handle(req('GET', `/api/runs/${runId}/workspace`, {}));
    expect(res.status).toBe(200);
    expect(workspaceOf(res).status).toBe('ready');
  });

  it('reports status none for a run without materialization (replay-compatible)', async () => {
    const { app } = makeApp();
    const runId = await createRun(app, { prompt: 'x' });
    const res = await app.handle(req('GET', `/api/runs/${runId}/workspace`, {}));
    expect(res.status).toBe(200);
    expect(workspaceOf(res).status).toBe('none');
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.handle(req('GET', '/api/runs/ghost/workspace', {}));
    expect(res.status).toBe(404);
  });
});

/** A minimal completed stub research pass (research-enabled run modes). */
function stubResearcher(): RunResearcher {
  return async (store, runId) => {
    const base = {
      runId,
      actor: { kind: 'researcher' as const, id: 'stub' },
      subject: { kind: 'research', id: runId },
      severity: 'info' as const,
    };
    await store.append({
      ...base,
      type: 'research.requested',
      payload: { objective: 'stub objective' },
    });
    await store.append({
      ...base,
      type: 'research.brief_completed',
      payload: { summary: 'Stub research brief.' },
    });
    return {
      status: 'completed' as const,
      briefSummary: 'Stub research brief.',
      sourcesFound: 0,
      sourcesRead: 0,
      findingCount: 0,
      assumptionCount: 0,
      gapCount: 0,
      seededKnowledgeCount: 0,
      recordedKnowledgeEntryIds: [],
      budgetStops: [],
    };
  };
}

describe('materialization feeds the build contract and research (U3/U2 seams)', () => {
  it('refreshes the build contract with checkout evidence after materialization', async () => {
    // Real (default) planner + stub researcher: research-and-plan generates a
    // contract whose workspace is "pending materialization" — until U4 runs.
    const { app } = makeApp({ mode: 'cloud', researcher: stubResearcher(), planner: undefined });
    const created = await app.handle(
      req('POST', '/api/runs', authedHeaders(), {
        prompt: 'Build the fixture app',
        githubRepo: 'octo/fixture',
        mode: 'research-and-plan',
      }),
    );
    expect(created.status).toBe(201);
    const runId = record(created).runId as string;
    const beforeContract = (record(created).run as { buildContract?: { workspace: string } })
      .buildContract;
    expect(beforeContract?.workspace).toMatch(/pending workspace materialization/i);

    const res = await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    expect(res.status).toBe(201);
    const afterContract = (record(res).run as { buildContract?: { workspace: string } })
      .buildContract;
    expect(afterContract?.workspace).toContain('octo/fixture');
    expect(afterContract?.workspace).toContain('fixturecommit123');
    expect(afterContract?.workspace).toMatch(/checked out at/i);
  });

  it('research scans the materialized checkout instead of reporting it unavailable', async () => {
    // `researcher: undefined` wires the REAL runtime researcher.
    const det = deterministic();
    const store = createInMemoryEventStore(det);
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
    });
    const runtime = runtimeConfig('cloud');
    const app = createApp({
      store,
      operatorToken: provider,
      clock: det.clock,
      idGenerator: () => 'run-research',
      config: { allowedOrigins: [ORIGIN], csrfToken: CSRF, runtime },
      planner: null,
      materializer: createRuntimeWorkspaceMaterializer({
        runtime,
        clock: det.clock,
        git: fixtureGit({ 'README.md': '# Materialized Fixture' }),
      }),
    });
    const runId = await createRun(app, { prompt: 'x', githubRepo: 'octo/fixture' });

    await app.handle(req('POST', `/api/runs/${runId}/workspace`, authedHeaders(), {}));
    const research = await app.handle(
      req('POST', `/api/runs/${runId}/research`, authedHeaders(), {}),
    );
    expect(research.status).toBe(201);

    const ledger = await store.readRun(runId);
    const reads = ledger.filter((event) => event.type === 'research.source_read');
    expect(reads.length).toBeGreaterThan(0);
    expect(JSON.stringify(reads)).toContain('README.md');
    // No "not materialized" gap remains once the checkout exists.
    const gaps = ledger.filter((event) => event.type === 'research.gap_recorded');
    expect(JSON.stringify(gaps)).not.toMatch(/not materialized/i);
  });
});
