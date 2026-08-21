/**
 * Local workspace boundary policy (full-factory U4).
 *
 * Security-oriented path checks in the style of the sandbox tests: `..`
 * traversal and outside-boundary paths are rejected, approved-folder and
 * boundary containment admit, and Windows semantics (drive letters,
 * backslashes, case-insensitive drives) are pinned deterministically by
 * injecting `path.win32` — so these tests behave identically on any host OS.
 */
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLocalWorkspacePath } from '../../src/index';
import type { WorkspaceLocalPolicy } from '../../src/index';

const WIN_POLICY: WorkspaceLocalPolicy = { boundaryRoot: 'C:\\Users\\op\\work' };
const POSIX_POLICY: WorkspaceLocalPolicy = { boundaryRoot: '/home/op/work' };

describe('resolveLocalWorkspacePath — containment (posix semantics)', () => {
  it('admits a folder inside the working boundary', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, '/home/op/work/app', posix);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/home/op/work/app');
      expect(result.boundary).toBe('working_boundary');
      expect(result.boundaryRoot).toBe('/home/op/work');
    }
  });

  it('admits a relative folder resolved against the boundary root', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, 'app/site', posix);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('/home/op/work/app/site');
    }
  });

  it('admits the boundary root itself', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, '/home/op/work', posix);
    expect(result.ok).toBe(true);
  });

  it('rejects `..` traversal that escapes the boundary', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, '../secrets', posix);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('path_traversal');
      expect(result.reason).toMatch(/traversal/i);
    }
  });

  it('rejects traversal hidden mid-path', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, 'app/../../elsewhere', posix);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('path_traversal');
    }
  });

  it('rejects an absolute path outside the boundary', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, '/etc/passwd', posix);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('outside_boundary');
    }
  });

  it('rejects a sneaky prefix sibling (/home/op/work-evil)', () => {
    const result = resolveLocalWorkspacePath(POSIX_POLICY, '/home/op/work-evil', posix);
    expect(result.ok).toBe(false);
  });
});

describe('resolveLocalWorkspacePath — Windows semantics (win32 pinned)', () => {
  it('admits a backslash path inside the boundary', () => {
    const result = resolveLocalWorkspacePath(WIN_POLICY, 'C:\\Users\\op\\work\\app', win32);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('C:\\Users\\op\\work\\app');
      expect(result.boundary).toBe('working_boundary');
    }
  });

  it('admits mixed forward/backslash separators inside the boundary', () => {
    const result = resolveLocalWorkspacePath(WIN_POLICY, 'C:/Users/op/work/app/site', win32);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe('C:\\Users\\op\\work\\app\\site');
    }
  });

  it('admits case-insensitive drive/letter differences (win32 relative())', () => {
    const result = resolveLocalWorkspacePath(WIN_POLICY, 'c:\\users\\op\\work\\App', win32);
    expect(result.ok).toBe(true);
  });

  it('rejects a path on a DIFFERENT drive letter', () => {
    const result = resolveLocalWorkspacePath(WIN_POLICY, 'D:\\other\\folder', win32);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('outside_boundary');
    }
  });

  it('rejects backslash `..` traversal that escapes the boundary', () => {
    const result = resolveLocalWorkspacePath(WIN_POLICY, '..\\..\\Windows\\System32', win32);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('path_traversal');
    }
  });

  it('rejects an absolute path outside the boundary on the same drive', () => {
    const result = resolveLocalWorkspacePath(WIN_POLICY, 'C:\\Windows\\System32', win32);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('outside_boundary');
    }
  });
});

describe('resolveLocalWorkspacePath — approved operator folders', () => {
  const policy: WorkspaceLocalPolicy = {
    boundaryRoot: 'C:\\Users\\op\\work',
    approvedFolders: ['D:\\projects\\approved'],
  };

  it('admits an explicitly approved folder outside the working boundary', () => {
    const result = resolveLocalWorkspacePath(policy, 'D:\\projects\\approved\\site', win32);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.boundary).toBe('operator_folder');
      expect(result.boundaryRoot).toBe('D:\\projects\\approved');
    }
  });

  it('admits the approved folder itself', () => {
    const result = resolveLocalWorkspacePath(policy, 'D:\\projects\\approved', win32);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.boundary).toBe('operator_folder');
    }
  });

  it('rejects siblings of the approved folder', () => {
    const result = resolveLocalWorkspacePath(policy, 'D:\\projects\\other', win32);
    expect(result.ok).toBe(false);
  });
});

describe('resolveLocalWorkspacePath — fail closed', () => {
  it('rejects everything when no boundary or approved folder is configured', () => {
    const result = resolveLocalWorkspacePath({}, '/home/op/anything', posix);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection).toBe('no_boundary_configured');
    }
  });
});
