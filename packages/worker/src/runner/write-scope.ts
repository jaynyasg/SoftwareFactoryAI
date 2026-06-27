/**
 * Ticket write scopes and conflict detection.
 *
 * Each ticket declares the paths/globs it will write. Two tickets CONFLICT when
 * their declared write sets overlap; conflicting tickets must be serialized even
 * when worker slots are free, so two workers never write the same file. V1 uses
 * scoped manifest/path overlap (equality, directory containment, and a minimal
 * glob match). Stronger isolation (branch-per-ticket / worktrees) is deferred to
 * TODOS — see the U5 follow-ups.
 *
 * A ticket that declares an EMPTY scope is treated as writing nothing and never
 * conflicts (it runs freely). The conflict predicate is pure and symmetric.
 */

/** A ticket's declared write scope: the paths/globs it intends to write. */
export interface WriteScope {
  readonly ticketId: string;
  /** Declared write paths/globs (POSIX-style; `**` and `*` supported). */
  readonly paths: readonly string[];
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isGlob(path: string): boolean {
  return /[*?]/.test(path);
}

/** Convert a minimal glob (`**`, `*`, `?`) to an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const norm = normalize(glob);
  let re = '^';
  let i = 0;
  while (i < norm.length) {
    const char = norm[i];
    if (char === '*') {
      if (norm[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (norm[i] === '/') {
          i += 1;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += char.replace(/[.+^${}()|[\]\\]/, '\\$&');
      i += 1;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** `true` when `child` is `dir` itself or nested under it. */
function isWithin(dir: string, child: string): boolean {
  return child === dir || child.startsWith(`${dir}/`);
}

function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

/** Whether two individual paths/globs overlap (write the same location). */
export function pathsOverlap(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const leftGlob = isGlob(left);
  const rightGlob = isGlob(right);
  if (!leftGlob && !rightGlob) {
    return isWithin(left, right) || isWithin(right, left);
  }
  if (leftGlob && matchesGlob(left, right)) {
    return true;
  }
  if (rightGlob && matchesGlob(right, left)) {
    return true;
  }
  return false;
}

/** Whether two write scopes conflict (any declared path overlaps). */
export function conflicts(a: WriteScope, b: WriteScope): boolean {
  if (a.ticketId === b.ticketId) {
    return false;
  }
  for (const left of a.paths) {
    for (const right of b.paths) {
      if (pathsOverlap(left, right)) {
        return true;
      }
    }
  }
  return false;
}

/** Tracks currently-running write scopes and gates new starts. */
export interface WriteScopeTracker {
  /** Whether `scope` may start now (no overlap with any active scope). */
  canStart(scope: WriteScope): boolean;
  /** Mark `scope` running. Returns `false` (and does nothing) if it conflicts. */
  acquire(scope: WriteScope): boolean;
  /** Release a finished ticket's scope. */
  release(ticketId: string): void;
  /** The scopes currently held. */
  active(): readonly WriteScope[];
  /** Count of active scopes (held write slots). */
  readonly size: number;
}

/** Create an in-memory write-scope tracker. */
export function createWriteScopeTracker(): WriteScopeTracker {
  const held = new Map<string, WriteScope>();

  function canStart(scope: WriteScope): boolean {
    for (const active of held.values()) {
      if (conflicts(active, scope)) {
        return false;
      }
    }
    return true;
  }

  return {
    canStart,
    acquire(scope): boolean {
      if (held.has(scope.ticketId)) {
        return true;
      }
      if (!canStart(scope)) {
        return false;
      }
      held.set(scope.ticketId, scope);
      return true;
    },
    release(ticketId): void {
      held.delete(ticketId);
    },
    active(): readonly WriteScope[] {
      return [...held.values()];
    },
    get size(): number {
      return held.size;
    },
  };
}
