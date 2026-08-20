/**
 * Password hashing for multi-user accounts (U1).
 *
 * scrypt (node:crypto, zero native deps) at the OWASP-recommended cost
 * (N=2^17, r=8, p=1) with an explicit `maxmem` (the Node default of 32 MiB
 * rejects N=2^17), NFKC normalization so platform-dependent Unicode
 * composition never locks a user out, and PHC-style storage that encodes the
 * parameters alongside salt+hash:
 *
 *   $scrypt$N=131072,r=8,p=1$<b64url(salt)>$<b64url(hash)>
 *
 * Verification parses the STORED parameters, so a future cost raise verifies
 * old hashes unchanged (rehash-on-login ships with that raise, not here).
 * Comparison is constant-time over the fixed-width derived keys.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt cost parameters. */
export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** Current hashing policy (OWASP floor: N=2^17, r=8, p=1). */
export const PASSWORD_SCRYPT_PARAMS: ScryptParams = { N: 131072, r: 8, p: 1 };

const SALT_BYTES = 16;
const KEY_BYTES = 64;

function maxmemFor(params: ScryptParams): number {
  // Node enforces roughly 128 * N * r <= maxmem; leave generous headroom.
  return 128 * params.N * params.r + 4 * 1024 * 1024;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const normalized = password.normalize('NFKC');
  return new Promise((resolve, reject) => {
    scrypt(
      normalized,
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params) },
      (error, key) => {
        if (error) {
          reject(error);
        } else {
          resolve(key);
        }
      },
    );
  });
}

/** Hash a password for storage. `params` override exists for tests/migrations. */
export async function hashPassword(
  password: string,
  params: ScryptParams = PASSWORD_SCRYPT_PARAMS,
): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new RangeError('Password must not be empty.');
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `$scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

const STORED_PATTERN = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/**
 * Verify a password against a stored PHC string. Malformed/truncated stored
 * values (and non-string inputs) fail closed as `false` — never a throw on
 * the login path.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || typeof stored !== 'string') {
    return false;
  }
  const match = STORED_PATTERN.exec(stored);
  if (match === null) {
    return false;
  }
  const params: ScryptParams = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!Number.isInteger(params.N) || params.N < 2 || (params.N & (params.N - 1)) !== 0) {
    return false;
  }
  if (params.r < 1 || params.p < 1 || params.N * params.r * 128 > 512 * 1024 * 1024) {
    // Refuse absurd stored params: a doctored record must not become a DoS.
    return false;
  }
  const salt = Buffer.from(match[4], 'base64url');
  const expected = Buffer.from(match[5], 'base64url');
  if (salt.length === 0 || expected.length !== KEY_BYTES) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await derive(password, salt, params);
  } catch {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
