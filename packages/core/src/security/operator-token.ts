/**
 * Local operator token / session.
 *
 * The factory binds its API and CLI to loopback and protects mutating actions
 * with a single local operator secret. This module owns:
 *  - cryptographically-random token generation (Node `crypto`),
 *  - CONSTANT-TIME verification (`crypto.timingSafeEqual` over fixed-width
 *    digests, so neither the value nor the length leaks via timing), and
 *  - a load-or-create session provider with INJECTABLE storage (in-memory by
 *    default; a caller-provided file path for persistence).
 *
 * Storage is never hardcoded to host secrets — the caller chooses where the
 * session lives. These primitives are shared by the web API (U3) and the CLI
 * (U10).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';

/** Default entropy for a generated token. 32 bytes = 256 bits. */
export const OPERATOR_TOKEN_BYTES = 32;

/** A persisted operator session: the secret plus when it was minted. */
export interface OperatorSession {
  /** The opaque bearer token. URL-safe so it survives headers/CLI args. */
  readonly token: string;
  /** Epoch ms the token was created/rotated. */
  readonly createdAt: number;
}

/** Generate a fresh, URL-safe, cryptographically-random operator token. */
export function generateOperatorToken(byteLength: number = OPERATOR_TOKEN_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new RangeError('Operator token byte length must be a positive integer.');
  }
  return randomBytes(byteLength).toString('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time string equality. Both inputs are hashed to a fixed 32-byte
 * digest first, so `timingSafeEqual` never throws on length mismatch and the
 * comparison leaks neither length nor content via timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Verify a presented token against the expected one in constant time. Empty
 * inputs always fail (an absent secret must never authenticate).
 */
export function verifyOperatorToken(expected: string, provided: string): boolean {
  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }
  if (expected.length === 0 || provided.length === 0) {
    return false;
  }
  return constantTimeEqual(expected, provided);
}

/** Pluggable persistence for the operator session. */
export interface OperatorTokenStore {
  /** Return the persisted session, or `null` if none exists yet. */
  load(): Promise<OperatorSession | null>;
  /** Persist (overwrite) the session. */
  save(session: OperatorSession): Promise<void>;
  /** Remove any persisted session (used by rotation/teardown). */
  clear(): Promise<void>;
}

/** An in-memory store. Optionally seeded with a known session (tests). */
export function createInMemoryOperatorTokenStore(initial?: OperatorSession): OperatorTokenStore {
  let current: OperatorSession | null = initial ?? null;
  return {
    load() {
      return Promise.resolve(current);
    },
    save(session) {
      current = session;
      return Promise.resolve();
    },
    clear() {
      current = null;
      return Promise.resolve();
    },
  };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isOperatorSession(value: unknown): value is OperatorSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { token?: unknown }).token === 'string' &&
    (value as { token: string }).token.length > 0 &&
    typeof (value as { createdAt?: unknown }).createdAt === 'number'
  );
}

/**
 * A file-backed store at a caller-provided path. The file is written with
 * owner-only permissions (0600) where the platform honours it.
 */
export function createFileOperatorTokenStore(filePath: string): OperatorTokenStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      return isOperatorSession(parsed) ? parsed : null;
    },
    async save(session) {
      await writeFile(filePath, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    async clear() {
      await rm(filePath, { force: true });
    },
  };
}

/** Injectable dependencies for the provider (deterministic in tests). */
export interface OperatorTokenProviderOptions {
  /** Where the session is persisted. Defaults to an in-memory store. */
  readonly store?: OperatorTokenStore;
  /** Wall-clock source (epoch ms). Defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Token source. Defaults to `generateOperatorToken`. */
  readonly generateToken?: () => string;
}

/** Load-or-create operator session abstraction reused by the API and CLI. */
export interface OperatorTokenProvider {
  /** Return the active session without creating one. */
  current(): Promise<OperatorSession | null>;
  /** Return the active session, creating + persisting one if absent. */
  getOrCreate(): Promise<OperatorSession>;
  /** Mint a new token, persist it, and return the new session. */
  rotate(): Promise<OperatorSession>;
  /** Constant-time check of a presented token against the active session. */
  verify(token: string): Promise<boolean>;
}

export function createOperatorTokenProvider(
  options: OperatorTokenProviderOptions = {},
): OperatorTokenProvider {
  const store = options.store ?? createInMemoryOperatorTokenStore();
  const clock = options.clock ?? Date.now;
  const mint = options.generateToken ?? (() => generateOperatorToken());

  return {
    current() {
      return store.load();
    },
    async getOrCreate() {
      const existing = await store.load();
      if (existing) {
        return existing;
      }
      const session: OperatorSession = { token: mint(), createdAt: clock() };
      await store.save(session);
      return session;
    },
    async rotate() {
      const session: OperatorSession = { token: mint(), createdAt: clock() };
      await store.save(session);
      return session;
    },
    async verify(token) {
      const session = await store.load();
      if (session === null) {
        return false;
      }
      return verifyOperatorToken(session.token, token);
    },
  };
}
