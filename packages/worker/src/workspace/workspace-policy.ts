/**
 * Local workspace boundary policy (full-factory U4).
 *
 * In local mode an operator-supplied folder may back a run workspace ONLY when
 * it resolves inside an approved working boundary or inside (or exactly at) an
 * explicitly chosen operator folder. Everything else — `..` traversal, absolute
 * escapes, other drive letters — is rejected, never followed.
 *
 * The checks are pure and Windows-safe: containment is decided via
 * `resolve`/`relative`/`isAbsolute` exactly like the sandbox's
 * `resolveWithinWorkspace`, which handles drive letters (`relative` across
 * drives yields an absolute path) and backslash/forward-slash mixing. The path
 * primitives are injectable (`PathKit`) so tests can pin `path.win32` or
 * `path.posix` semantics deterministically on any host platform.
 */
import * as nodePath from 'node:path';
import type { WorkspaceLocalBoundary } from '@software-factory/core';

/** The path primitives the policy depends on (injectable for tests). */
export interface PathKit {
  resolve(...segments: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(candidate: string): boolean;
}

/** The default kit: the host platform's `node:path`. */
export const DEFAULT_PATH_KIT: PathKit = nodePath;

/** Local-boundary policy: the approved root plus explicit operator folders. */
export interface WorkspaceLocalPolicy {
  /** The approved working boundary; folders inside it are admissible. */
  readonly boundaryRoot?: string;
  /** Explicitly chosen operator folders (each admits itself + its subtree). */
  readonly approvedFolders?: readonly string[];
}

/** Why a local path was rejected. */
export type LocalPathRejection = 'no_boundary_configured' | 'outside_boundary' | 'path_traversal';

/** The outcome of resolving a local folder against the policy. */
export type LocalWorkspaceResolution =
  | {
      readonly ok: true;
      /** The resolved absolute path to bind. */
      readonly resolved: string;
      /** Which rule admitted the folder. */
      readonly boundary: WorkspaceLocalBoundary;
      /** The approving boundary root. */
      readonly boundaryRoot: string;
    }
  | {
      readonly ok: false;
      readonly rejection: LocalPathRejection;
      readonly reason: string;
    };

/** Containment: `candidate` resolves inside (or exactly at) `root`. */
function isContained(kit: PathKit, root: string, candidate: string): boolean {
  const base = kit.resolve(root);
  const resolved = kit.resolve(base, candidate);
  const rel = kit.relative(base, resolved);
  return rel === '' || (!rel.startsWith('..') && !kit.isAbsolute(rel));
}

/** Whether the raw request contains a `..` traversal segment. */
function hasTraversalSegment(requested: string): boolean {
  return requested.split(/[\\/]/).some((segment) => segment === '..');
}

/**
 * Resolve an operator-supplied local folder against the policy. Pure. Order:
 * explicitly approved operator folders win (they are the operator's strongest
 * signal), then the approved working boundary; a relative path is resolved
 * against the boundary root. Fail closed when nothing is configured.
 */
export function resolveLocalWorkspacePath(
  policy: WorkspaceLocalPolicy,
  requestedPath: string,
  kit: PathKit = DEFAULT_PATH_KIT,
): LocalWorkspaceResolution {
  const approvedFolders = policy.approvedFolders ?? [];
  const boundaryRoot = policy.boundaryRoot;

  if (boundaryRoot === undefined && approvedFolders.length === 0) {
    return {
      ok: false,
      rejection: 'no_boundary_configured',
      reason:
        'No approved working boundary or operator folder is configured; local folders cannot be bound.',
    };
  }

  // 1. Explicitly chosen operator folders (absolute requests only — a relative
  //    request is interpreted against the working boundary below).
  if (kit.isAbsolute(requestedPath)) {
    for (const folder of approvedFolders) {
      if (isContained(kit, folder, requestedPath)) {
        return {
          ok: true,
          resolved: kit.resolve(requestedPath),
          boundary: 'operator_folder',
          boundaryRoot: kit.resolve(folder),
        };
      }
    }
  }

  // 2. The approved working boundary (admits absolute-inside and relative-
  //    inside paths; traversal that escapes is rejected by containment).
  if (boundaryRoot !== undefined && isContained(kit, boundaryRoot, requestedPath)) {
    return {
      ok: true,
      resolved: kit.resolve(kit.resolve(boundaryRoot), requestedPath),
      boundary: 'working_boundary',
      boundaryRoot: kit.resolve(boundaryRoot),
    };
  }

  const rejection: LocalPathRejection = hasTraversalSegment(requestedPath)
    ? 'path_traversal'
    : 'outside_boundary';
  return {
    ok: false,
    rejection,
    reason:
      rejection === 'path_traversal'
        ? `Local folder "${requestedPath}" uses path traversal that escapes the approved working boundary; traversal is rejected, never followed.`
        : `Local folder "${requestedPath}" resolves outside the approved working boundary${
            approvedFolders.length > 0 ? ' and every approved operator folder' : ''
          }.`,
  };
}
