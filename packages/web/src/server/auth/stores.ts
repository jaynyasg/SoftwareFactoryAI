/**
 * Shared persistence for the auth collections (U2).
 *
 * Every auth collection (accounts, sessions, invites, API tokens) is a small
 * array of records in one JSON file under `<factoryDir>/auth/`, mirroring the
 * operator-token store's semantics: 0600 writes, ENOENT → empty, malformed →
 * empty (never a crash on the login path). The generic factory keeps the
 * collections uniform and gives every collection an in-memory twin so the
 * contract suite runs against both backends.
 *
 * Writes are serialized by the AuthService's mutex (service.ts), not here —
 * the store is a dumb load/save pair by design so a future DB implementation
 * replaces it without touching call sites.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Load/save persistence for one auth collection. */
export interface CollectionStore<T> {
  load(): Promise<readonly T[]>;
  save(records: readonly T[]): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory collection (tests + contract-suite twin). */
export function createInMemoryCollectionStore<T>(initial: readonly T[] = []): CollectionStore<T> {
  let current: readonly T[] = [...initial];
  return {
    load() {
      return Promise.resolve(current);
    },
    save(records) {
      current = [...records];
      return Promise.resolve();
    },
    clear() {
      current = [];
      return Promise.resolve();
    },
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** File-backed collection at `filePath` with a per-record shape guard. */
export function createFileCollectionStore<T>(
  filePath: string,
  isRecord: (value: unknown) => value is T,
): CollectionStore<T> {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          return [];
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isRecord);
    },
    async save(records) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(records)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    async clear() {
      await rm(filePath, { force: true });
    },
  };
}
