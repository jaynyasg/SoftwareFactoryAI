/**
 * POST /api/fs/browse — the server-backed folder picker.
 *
 * The browser's directory picker never reveals absolute paths, so the Run
 * control picker browses through the local-first server. These tests pin:
 * guarded access (token + CSRF), directory listing with parent navigation,
 * workspace-boundary status per entry, error shapes for bad paths, and the
 * cloud-mode 409 (KTD5: cloud runs never read laptop paths).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInMemoryEventStore,
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
} from '@software-factory/core';
import { createApp, type ApiRequest, type ApiResponse, type App } from '../../src/server/app';
import { testRuntimeConfig } from '../_helpers/runtime';

const TOKEN = 'test-operator-token';
const CSRF = 'test-csrf-token';
const ORIGIN = 'http://127.0.0.1:5173';

let boundaryDir: string;

beforeEach(async () => {
  boundaryDir = await mkdtemp(join(tmpdir(), 'sf-fs-browse-'));
  await mkdir(join(boundaryDir, 'project-a'));
  await mkdir(join(boundaryDir, 'project-b', 'nested'), { recursive: true });
  await writeFile(join(boundaryDir, 'notes.txt'), 'not a directory', 'utf8');
});

afterEach(async () => {
  await rm(boundaryDir, { recursive: true, force: true });
});

function makeApp(mode: 'local' | 'cloud' = 'local'): App {
  const provider = createOperatorTokenProvider({
    store: createInMemoryOperatorTokenStore({ token: TOKEN, createdAt: 0 }),
  });
  return createApp({
    store: createInMemoryEventStore(),
    operatorToken: provider,
    config: {
      allowedOrigins: [ORIGIN],
      csrfToken: CSRF,
      runtime: testRuntimeConfig({ mode, workspace: { localBoundaryRoot: boundaryDir } }),
    },
    planner: null,
  });
}

function authedHeaders(): Record<string, string | undefined> {
  return { 'x-operator-token': TOKEN, 'x-csrf-token': CSRF, origin: ORIGIN };
}

function req(headers: Record<string, string | undefined>, body?: unknown): ApiRequest {
  return { method: 'POST', path: '/api/fs/browse', query: {}, headers, body };
}

function record(res: ApiResponse): Record<string, unknown> {
  return res.body as Record<string, unknown>;
}

describe('POST /api/fs/browse', () => {
  it('lists child directories (never files) with boundary status and parent', async () => {
    const app = makeApp();
    const res = await app.handle(req(authedHeaders(), { path: boundaryDir }));
    expect(res.status).toBe(200);
    const body = record(res) as {
      path: string;
      parent: string | null;
      withinBoundary: boolean;
      dirs: { name: string; path: string; withinBoundary: boolean }[];
      roots: string[];
    };
    expect(body.withinBoundary).toBe(true);
    expect(body.parent).not.toBeNull();
    expect(body.dirs.map((d) => d.name)).toEqual(['project-a', 'project-b']);
    expect(body.dirs.every((d) => d.withinBoundary)).toBe(true);
    expect(body.roots.length).toBeGreaterThan(0);
  });

  it('defaults to the workspace boundary root when no path is given', async () => {
    const app = makeApp();
    const res = await app.handle(req(authedHeaders(), {}));
    expect(res.status).toBe(200);
    expect(record(res).path).toBe(boundaryDir);
  });

  it('navigates into subdirectories and reports outside-boundary parents honestly', async () => {
    const app = makeApp();
    const inside = await app.handle(
      req(authedHeaders(), { path: join(boundaryDir, 'project-b') }),
    );
    expect(inside.status).toBe(200);
    expect((record(inside).dirs as { name: string }[]).map((d) => d.name)).toEqual(['nested']);

    // The boundary root's PARENT is outside the boundary — status says so.
    const parent = record(inside).parent as string;
    void parent;
    const outside = await app.handle(req(authedHeaders(), { path: tmpdir() }));
    expect(outside.status).toBe(200);
    expect(record(outside).withinBoundary).toBe(false);
  });

  it('rejects file paths and unreadable paths with explainable errors', async () => {
    const app = makeApp();
    const file = await app.handle(
      req(authedHeaders(), { path: join(boundaryDir, 'notes.txt') }),
    );
    expect(file.status).toBe(400);
    expect(record(file).error).toBe('not_a_directory');

    const missing = await app.handle(
      req(authedHeaders(), { path: join(boundaryDir, 'does-not-exist') }),
    );
    expect(missing.status).toBe(400);
    expect(record(missing).error).toBe('browse_failed');
  });

  it('requires the command guard before touching the filesystem', async () => {
    const app = makeApp();
    const denied = await app.handle(
      req({ origin: ORIGIN, 'x-csrf-token': CSRF }, { path: boundaryDir }),
    );
    expect(denied.status).toBe(401);
  });

  it('answers 409 in cloud mode (cloud runs never read laptop paths)', async () => {
    const app = makeApp('cloud');
    const res = await app.handle(req(authedHeaders(), { path: boundaryDir }));
    expect(res.status).toBe(409);
    expect(record(res).error).toBe('local_folders_unavailable');
  });
});
