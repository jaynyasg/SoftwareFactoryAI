/**
 * Per-user credential vault (U1).
 *
 * Typed credential records encrypted at rest through the secret box, with
 * PRESENCE-ONLY views (E5: values never reach config, setup surfaces,
 * evidence, or the ledger) and decrypt-late reads. The vault degrades
 * honestly when the master key is unreadable: presence still works (it needs
 * no decryption), while reads/writes return a typed
 * `master_key_unreadable` — login and non-credential surfaces stay alive and
 * runs block with an admin-directed intervention instead of a crash.
 *
 * Stores mirror the operator-token store's file semantics: one JSON file per
 * user under a caller-provided directory, 0600, ENOENT/malformed → empty.
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { SecretBox } from './secret-box';

/** The closed set of per-user credential slots. */
export const CREDENTIAL_KINDS = [
  'claude_oauth_token',
  'anthropic_api_key',
  'openai_api_key',
  'codex_auth_json',
  'github_token',
  'render_api_key',
  'vercel_token',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Type guard for a credential kind value. */
export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === 'string' && (CREDENTIAL_KINDS as readonly string[]).includes(value);
}

/** One stored record: the encrypted blob plus presence metadata. */
export interface CredentialRecord {
  readonly kind: CredentialKind;
  readonly blob: string;
  readonly updatedAt: number;
  readonly validatedAt?: number;
}

/** Presence-only view of one slot (never the value; E5). */
export interface CredentialPresence {
  readonly kind: CredentialKind;
  readonly present: boolean;
  readonly updatedAt?: number;
  readonly validatedAt?: number;
}

/** Result of a decrypt-late read. */
export type CredentialReadResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'missing' | 'unreadable' | 'master_key_unreadable' };

/** Result of a write (typed so an unreadable key never throws into routes). */
export type CredentialWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'master_key_unreadable' };

/** Pluggable persistence: per-user record maps. */
export interface CredentialStore {
  load(userId: string): Promise<readonly CredentialRecord[]>;
  save(userId: string, records: readonly CredentialRecord[]): Promise<void>;
  clear(userId: string): Promise<void>;
}

/** In-memory store (tests + fallback). */
export function createInMemoryCredentialStore(): CredentialStore {
  const byUser = new Map<string, readonly CredentialRecord[]>();
  return {
    load(userId) {
      return Promise.resolve(byUser.get(userId) ?? []);
    },
    save(userId, records) {
      byUser.set(userId, [...records]);
      return Promise.resolve();
    },
    clear(userId) {
      byUser.delete(userId);
      return Promise.resolve();
    },
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isCredentialRecord(value: unknown): value is CredentialRecord {
  const record = value as {
    kind?: unknown;
    blob?: unknown;
    updatedAt?: unknown;
  };
  return (
    typeof value === 'object' &&
    value !== null &&
    isCredentialKind(record.kind) &&
    typeof record.blob === 'string' &&
    typeof record.updatedAt === 'number'
  );
}

/** Filename derived from a hash of the user id (ids never become paths). */
function userFileName(userId: string): string {
  return `${createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 32)}.json`;
}

/**
 * File-backed store: one 0600 JSON file per user under `baseDir`. Missing or
 * malformed files load as empty — mirroring the operator-token store.
 */
export function createFileCredentialStore(baseDir: string): CredentialStore {
  const pathFor = (userId: string): string => join(baseDir, userFileName(userId));
  return {
    async load(userId) {
      let raw: string;
      try {
        raw = await readFile(pathFor(userId), 'utf8');
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
      return parsed.filter(isCredentialRecord);
    },
    async save(userId, records) {
      await mkdir(baseDir, { recursive: true });
      await writeFile(pathFor(userId), `${JSON.stringify(records)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    },
    async clear(userId) {
      await rm(pathFor(userId), { force: true });
    },
  };
}

export interface CredentialVaultOptions {
  /** The secret box, or `null` when the master key failed boot validation. */
  readonly box: SecretBox | null;
  readonly store: CredentialStore;
  /** Clock for presence metadata. Defaults to Date.now. */
  readonly clock?: () => number;
}

export interface CredentialVault {
  /** Presence-only rows for every kind (E5: no values, ever). */
  getPresence(userId: string): Promise<readonly CredentialPresence[]>;
  /** Encrypt and store one credential; marks it validated when flagged. */
  setCredential(
    userId: string,
    kind: CredentialKind,
    value: string,
    options?: { readonly validated?: boolean },
  ): Promise<CredentialWriteResult>;
  /** Remove one credential slot. */
  removeCredential(userId: string, kind: CredentialKind): Promise<void>;
  /** Remove EVERY credential for a user (revocation cascade). */
  removeAll(userId: string): Promise<void>;
  /** Decrypt-late read. Never throws for data/key problems. */
  readCredential(userId: string, kind: CredentialKind): Promise<CredentialReadResult>;
  /** Whether the vault can decrypt at all (master key readable). */
  readonly readable: boolean;
}

export function createCredentialVault(options: CredentialVaultOptions): CredentialVault {
  const { box, store } = options;
  const clock = options.clock ?? Date.now;

  return {
    readable: box !== null,
    async getPresence(userId) {
      const records = await store.load(userId);
      return CREDENTIAL_KINDS.map((kind) => {
        const record = records.find((r) => r.kind === kind);
        return record === undefined
          ? { kind, present: false }
          : {
              kind,
              present: true,
              updatedAt: record.updatedAt,
              ...(record.validatedAt !== undefined ? { validatedAt: record.validatedAt } : {}),
            };
      });
    },
    async setCredential(userId, kind, value, opts = {}) {
      if (box === null) {
        return { ok: false, reason: 'master_key_unreadable' };
      }
      const blob = box.encrypt(value, { userId, credentialName: kind });
      const now = clock();
      const records = (await store.load(userId)).filter((r) => r.kind !== kind);
      records.push({
        kind,
        blob,
        updatedAt: now,
        ...(opts.validated === true ? { validatedAt: now } : {}),
      });
      await store.save(userId, records);
      return { ok: true };
    },
    async removeCredential(userId, kind) {
      const records = (await store.load(userId)).filter((r) => r.kind !== kind);
      await store.save(userId, records);
    },
    async removeAll(userId) {
      await store.clear(userId);
    },
    async readCredential(userId, kind) {
      if (box === null) {
        return { ok: false, reason: 'master_key_unreadable' };
      }
      const record = (await store.load(userId)).find((r) => r.kind === kind);
      if (record === undefined) {
        return { ok: false, reason: 'missing' };
      }
      const opened = box.decrypt(record.blob, { userId, credentialName: kind });
      if (!opened.ok) {
        return { ok: false, reason: 'unreadable' };
      }
      return { ok: true, value: opened.value };
    },
  };
}
