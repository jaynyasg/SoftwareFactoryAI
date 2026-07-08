/**
 * Repo / local-folder scan adapter (full-factory U2).
 *
 * Reads evidence from an operator-approved workspace folder — and ONLY from
 * inside it. Every path (the configured folder and every per-source locator)
 * must resolve within `workspaceRoot` via the same Windows-safe containment
 * check the sandbox uses (`resolveWithinWorkspace`): absolute escapes and `..`
 * traversal are rejected, never followed.
 *
 * Discovery is deterministic: a bounded, alphabetical walk that prefers
 * well-known descriptor files (README, package.json, docs) so repeated scans of
 * the same tree produce the same sources in the same order.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWithinWorkspace } from '../sandbox/sandbox';
import type {
  DiscoverOptions,
  DiscoveredSource,
  ReadOptions,
  ResearchAdapterSetup,
  ResearchFindingDraft,
  ResearchRunContext,
  ResearchSourceAdapter,
  SourceReadResult,
} from './research-contract';

/** Options for the repo/local scan adapter. */
export interface RepoScanAdapterOptions {
  /** The approved workspace boundary. Scans may never escape this root. */
  readonly workspaceRoot: string;
  /** Folder to scan, absolute-or-relative WITHIN the root (default `.`). */
  readonly folder?: string;
  /** Source class to report (`repo_scan` for repos, `local_folder` for folders). */
  readonly kind?: 'repo_scan' | 'local_folder';
  /** Adapter id override (default derives from `kind`). */
  readonly id?: string;
  /** Max files surfaced per discovery (default 8). */
  readonly maxFiles?: number;
  /** Max bytes read per file (default 64 KiB). */
  readonly maxBytesPerFile?: number;
}

/** Files surfaced first, in priority order, when present in the scanned tree. */
const PRIORITY_FILES: readonly string[] = [
  'README.md',
  'readme.md',
  'package.json',
  'ARCHITECTURE.md',
  'PRD.md',
  'pnpm-workspace.yaml',
  'tsconfig.json',
];

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_WALK_DEPTH = 2;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.factory']);

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Flatten whitespace and clip to `max` characters. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function pathEscapeError(candidate: string, workspaceRoot: string): Error {
  return new Error(
    `Path "${candidate}" escapes the approved research workspace "${workspaceRoot}" (traversal rejected).`,
  );
}

/** Bounded, alphabetical walk collecting workspace-relative file paths. */
async function walk(dir: string, base: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await walk(
          join(dir, entry.name),
          base === '' ? entry.name : `${base}/${entry.name}`,
          depth + 1,
          out,
        );
      }
      continue;
    }
    if (entry.isFile()) {
      out.push(base === '' ? entry.name : `${base}/${entry.name}`);
    }
  }
}

/** Rank: priority files first (by priority order), then markdown, then rest. */
function rankFiles(files: readonly string[]): string[] {
  const score = (file: string): number => {
    const name = file.split('/').pop() ?? file;
    const priority = PRIORITY_FILES.indexOf(name);
    if (priority >= 0 && !file.includes('/')) {
      return priority;
    }
    if (name.toLowerCase().endsWith('.md')) {
      return PRIORITY_FILES.length + 1;
    }
    return PRIORITY_FILES.length + 2;
  };
  return [...files].sort((a, b) => {
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Deterministic findings for well-known file shapes (no fabrication). */
function findingsForFile(relPath: string, content: string): ResearchFindingDraft[] {
  const name = relPath.split('/').pop() ?? relPath;
  if (name === 'package.json') {
    try {
      const parsed = JSON.parse(content) as {
        name?: unknown;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const pkgName = typeof parsed.name === 'string' ? parsed.name : '(unnamed)';
      const depCount =
        Object.keys(parsed.dependencies ?? {}).length +
        Object.keys(parsed.devDependencies ?? {}).length;
      return [
        {
          statement: `Workspace declares package "${pkgName}" with ${depCount} dependencies (${relPath}).`,
          classification: 'verified_fact',
          confidence: 0.95,
          reusable: true,
          knowledgeKind: 'repo_fact',
          tags: ['repo', 'package'],
        },
      ];
    } catch {
      return [
        {
          statement: `Workspace file ${relPath} exists but is not valid JSON.`,
          classification: 'verified_fact',
          confidence: 0.9,
        },
      ];
    }
  }
  if (name.toLowerCase().endsWith('.md')) {
    const heading = content
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return [
      {
        statement: `Workspace document ${relPath} starts with: ${clip(heading ?? '(empty)', 160)}`,
        classification: 'verified_fact',
        confidence: 0.9,
        reusable: true,
        knowledgeKind: 'repo_fact',
        tags: ['repo', 'docs'],
      },
    ];
  }
  return [
    {
      statement: `Workspace file ${relPath} is present (${content.length} bytes read).`,
      classification: 'verified_fact',
      confidence: 0.9,
    },
  ];
}

/**
 * Create the repo/local scan adapter. Fail closed: a folder that escapes the
 * workspace boundary reports `configured: false` from `detectSetup`, and any
 * direct `discover`/`read` against an escaping path rejects with an error.
 */
export function createRepoScanAdapter(options: RepoScanAdapterOptions): ResearchSourceAdapter {
  const kind = options.kind ?? 'repo_scan';
  const id = options.id ?? (kind === 'repo_scan' ? 'repo-scan' : 'local-folder');
  const folder = options.folder ?? '.';
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES;

  const containment = resolveWithinWorkspace(options.workspaceRoot, folder);

  const detectSetup = async (): Promise<ResearchAdapterSetup> => {
    if (!containment.ok) {
      return {
        configured: false,
        requiresCredentials: false,
        credentialsPresent: true,
        detail: `Scan folder "${folder}" escapes the approved workspace boundary "${options.workspaceRoot}".`,
        setupAction: {
          id: `${id}.folder`,
          title: 'Choose a folder inside the approved workspace',
          description:
            'Research may only scan folders inside the operator-approved workspace root.',
        },
      };
    }
    try {
      const info = await stat(containment.resolved);
      if (!info.isDirectory()) {
        return {
          configured: false,
          requiresCredentials: false,
          credentialsPresent: true,
          detail: `Scan target "${folder}" is not a directory.`,
        };
      }
    } catch {
      return {
        configured: false,
        requiresCredentials: false,
        credentialsPresent: true,
        detail: `Scan folder "${folder}" does not exist under the approved workspace.`,
      };
    }
    return { configured: true, requiresCredentials: false, credentialsPresent: true };
  };

  const discover = async (
    _context: ResearchRunContext,
    discoverOptions: DiscoverOptions,
  ): Promise<readonly DiscoveredSource[]> => {
    if (!containment.ok) {
      throw pathEscapeError(folder, options.workspaceRoot);
    }
    const files: string[] = [];
    await walk(containment.resolved, '', 0, files);
    const limit = Math.min(discoverOptions.limit, maxFiles);
    return rankFiles(files)
      .slice(0, Math.max(limit, 0))
      .map((relPath) => ({
        sourceId: `${id}:${relPath}`,
        kind,
        title: relPath,
        locator: relPath,
        summary: `Workspace file ${relPath}`,
      }));
  };

  const read = async (
    source: DiscoveredSource,
    _options: ReadOptions,
  ): Promise<SourceReadResult> => {
    const locator = source.locator ?? '';
    if (!containment.ok) {
      throw pathEscapeError(folder, options.workspaceRoot);
    }
    // The locator must resolve inside the scanned folder (itself contained in
    // the workspace root) — `..` traversal and absolute escapes are rejected,
    // never followed.
    const contained = resolveWithinWorkspace(containment.resolved, locator);
    if (!contained.ok) {
      throw pathEscapeError(locator, options.workspaceRoot);
    }
    const raw = await readFile(contained.resolved, 'utf8');
    const content = raw.slice(0, maxBytes);
    return {
      summary: `Read workspace file ${locator} (${content.length} bytes): ${clip(content, 160)}`,
      contentDigest: sha256(content),
      findings: findingsForFile(locator, content),
    };
  };

  return { id, kind, detectSetup, discover, read };
}
