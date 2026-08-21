/**
 * Auth record shapes + pure helpers (U2).
 *
 * Secrets NEVER persist in the clear: passwords are PHC scrypt strings,
 * session tokens / invite tokens / API-token secrets are stored as SHA-256
 * hashes and compared via the constant-time helper. Full token values exist
 * exactly once — in the response that minted them.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type Role = 'admin' | 'user';

/** The resolved caller identity every guarded surface consumes. */
export interface Identity {
  readonly userId: string;
  readonly username: string;
  readonly role: Role;
}

export interface UserAccount {
  readonly userId: string;
  /** Original casing preserved for display; uniqueness is case-insensitive. */
  readonly username: string;
  readonly passwordHash: string;
  readonly role: Role;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

export interface SessionRecord {
  readonly tokenHash: string;
  readonly userId: string;
  /** Per-session CSRF secret (survives restarts with the session). */
  readonly csrfToken: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface InviteRecord {
  readonly inviteId: string;
  readonly tokenHash: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Present on re-invites: redeeming resets THIS user instead of creating. */
  readonly forUserId?: string;
  readonly redeemedAt?: number;
  readonly revokedAt?: number;
}

export interface ApiTokenRecord {
  readonly selector: string;
  readonly secretHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
}

/** Consume-once bootstrap + other singleton auth metadata. */
export interface AuthMeta {
  readonly key: 'meta';
  /** SHA-256 of the consumed bootstrap value — the same value never replays. */
  readonly bootstrapConsumedHash?: string;
}

/** Session policy: sliding idle window plus an absolute cap (server-side). */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
/** Persist lastSeenAt at most this often (write-amplification guard). */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

/** Invite lifetime (G12). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum password length (NIST/OWASP floor). */
export const MIN_PASSWORD_LENGTH = 12;

/** Minimum length for the env bootstrap value (entropy floor). */
export const MIN_BOOTSTRAP_LENGTH = 16;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time hex-digest comparison (fixed width, no length leak). */
export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== 32 || b.length !== 32) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * API token format: sfai_<selector>_<secret> (selector = O(1) lookup). The
 * selector is HEX (never base64url) so it can't contain the `_` delimiter.
 */
export function mintApiTokenValue(): { token: string; selector: string; secret: string } {
  const selector = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { token: `sfai_${selector}_${secret}`, selector, secret };
}

export function parseApiTokenValue(
  value: string,
): { selector: string; secret: string } | null {
  if (typeof value !== 'string' || !value.startsWith('sfai_')) {
    return null;
  }
  const rest = value.slice('sfai_'.length);
  const split = rest.indexOf('_');
  if (split <= 0 || split === rest.length - 1) {
    return null;
  }
  return { selector: rest.slice(0, split), secret: rest.slice(split + 1) };
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** Username rules: 3-32 chars, letters/digits/dash/underscore/dot. */
export function isValidUsername(username: string): boolean {
  return typeof username === 'string' && /^[A-Za-z0-9._-]{3,32}$/.test(username.trim());
}

function has<K extends string>(value: object, key: K, type: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === type;
}

export function isUserAccount(value: unknown): value is UserAccount {
  return (
    typeof value === 'object' &&
    value !== null &&
    has(value, 'userId', 'string') &&
    has(value, 'username', 'string') &&
    has(value, 'passwordHash', 'string') &&
    has(value, 'role', 'string') &&
    has(value, 'createdAt', 'number')
  );
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    has(value, 'tokenHash', 'string') &&
    has(value, 'userId', 'string') &&
    has(value, 'csrfToken', 'string') &&
    has(value, 'createdAt', 'number') &&
    has(value, 'lastSeenAt', 'number')
  );
}

export function isInviteRecord(value: unknown): value is InviteRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    has(value, 'inviteId', 'string') &&
    has(value, 'tokenHash', 'string') &&
    has(value, 'createdBy', 'string') &&
    has(value, 'createdAt', 'number') &&
    has(value, 'expiresAt', 'number')
  );
}

export function isApiTokenRecord(value: unknown): value is ApiTokenRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    has(value, 'selector', 'string') &&
    has(value, 'secretHash', 'string') &&
    has(value, 'userId', 'string') &&
    has(value, 'createdAt', 'number')
  );
}

export function isAuthMeta(value: unknown): value is AuthMeta {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { key?: unknown }).key === 'meta'
  );
}
