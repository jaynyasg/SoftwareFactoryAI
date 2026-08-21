/**
 * Local filesystem browsing for the Run control folder picker.
 *
 *   POST /api/fs/browse (guarded) — list the child DIRECTORIES of one path on
 *                                   the operator's machine, plus parent/roots
 *                                   navigation and workspace-boundary status.
 *
 * WHY THIS EXISTS: the browser's `showDirectoryPicker()` deliberately never
 * reveals absolute paths (only the leaf name), so a web page cannot fill the
 * LOCAL FOLDER field from a native picker. This app is local-first — the
 * server runs on the operator's own machine — so the picker browses through
 * the server instead.
 *
 * Guarded like a mutation (operator token + CSRF + origin) even though it
 * writes nothing: directory listings of the operator's disk must never be
 * readable by a drive-by page the way the read-only run projections are.
 * Local mode only — cloud runs never read laptop paths (KTD5), so the route
 * answers 409 in cloud mode. Each entry carries `withinBoundary` from the
 * SAME policy the workspace materializer enforces, so the picker can show
 * which folders a run may actually bind (U4).
 */
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveLocalWorkspacePath } from '@software-factory/worker';
import type { WorkspaceLocalPolicy } from '@software-factory/worker';
import { resolveWorkspaceRuntimeConfig } from '../runtime';
import type { ApiResponse, RouteContext, RouteDef } from '../app';

interface BrowseEntry {
  readonly name: string;
  readonly path: string;
  readonly withinBoundary: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function within(policy: WorkspaceLocalPolicy, candidate: string): boolean {
  return resolveLocalWorkspacePath(policy, candidate).ok;
}

/** Existing drive roots on Windows (`C:\`, `D:\`, …); `/` elsewhere. */
async function listRoots(): Promise<readonly string[]> {
  if (process.platform !== 'win32') {
    return ['/'];
  }
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const probes = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await stat(root);
        return root;
      } catch {
        return null;
      }
    }),
  );
  return probes.filter((root): root is string => root !== null);
}

async function browse(ctx: RouteContext): Promise<ApiResponse> {
  const denial = await ctx.guardMutation({
    subject: { kind: 'factory', id: 'workspace' },
    command: 'workspace.browse',
  });
  if (denial !== null) {
    return denial;
  }

  const runtime = ctx.config.runtime;
  if ((runtime?.mode ?? 'local') === 'cloud') {
    return {
      status: 409,
      body: {
        error: 'local_folders_unavailable',
        message:
          'Cloud runs never read laptop paths (KTD5); local folder browsing is unavailable on this instance.',
      },
    };
  }

  const workspace = runtime?.workspace ?? resolveWorkspaceRuntimeConfig();
  const policy: WorkspaceLocalPolicy = {
    boundaryRoot: workspace.localBoundaryRoot,
    approvedFolders: workspace.approvedFolders,
  };

  const body = asRecord(ctx.request.body);
  const requested = typeof body.path === 'string' && body.path.trim().length > 0
    ? body.path.trim()
    : (workspace.localBoundaryRoot ?? homedir());
  const path = resolve(requested);

  let entries;
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      return {
        status: 400,
        body: { error: 'not_a_directory', message: `"${path}" is not a directory.` },
      };
    }
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 400,
      body: { error: 'browse_failed', message: `Could not browse "${path}": ${message}` },
    };
  }

  const dirs: BrowseEntry[] = [];
  for (const entry of entries) {
    // Directories only; entries that cannot be classified are skipped rather
    // than failing the whole listing (junctions, permission holes, …).
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await stat(join(path, entry.name))).isDirectory();
      } catch {
        continue;
      }
    }
    if (!isDir) {
      continue;
    }
    const childPath = join(path, entry.name);
    dirs.push({ name: entry.name, path: childPath, withinBoundary: within(policy, childPath) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = dirname(path);
  return {
    status: 200,
    body: {
      path,
      parent: parent === path ? null : parent,
      withinBoundary: within(policy, path),
      boundaryRoot: workspace.localBoundaryRoot ?? null,
      approvedFolders: workspace.approvedFolders,
      dirs,
      roots: await listRoots(),
    },
  };
}

export function fsRoutes(): RouteDef[] {
  return [{ method: 'POST', pattern: '/api/fs/browse', access: 'admin', handler: browse }];
}
