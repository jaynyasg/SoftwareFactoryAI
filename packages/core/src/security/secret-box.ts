/**
 * Authenticated secret encryption for the credential vault (U1).
 *
 * AES-256-GCM via node:crypto with:
 *  - a boot-validated 32-byte master key (hex or base64url) from the platform
 *    secret store — NEVER a file under the factory dir,
 *  - an HKDF-SHA256 purpose subkey (domain separation from the raw env key),
 *  - a fresh random 96-bit IV per encryption (IV reuse under GCM is
 *    catastrophic — never a counter),
 *  - AAD binding every blob to `v1:<userId>:<credentialName>` so records
 *    cannot be swapped between users or credential slots, and
 *  - a versioned blob format `v1.<b64url(iv)>.<b64url(ct)>.<b64url(tag)>`
 *    so rotation/migration can be layered on later without re-encrypting
 *    blind.
 *
 * Decryption NEVER throws for data problems: tamper, wrong key, malformed
 * blob, and AAD mismatch all return a typed `{ ok: false, reason }` with no
 * partial plaintext (authenticity is only established at final()).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Result of a decrypt: value on success, a typed reason on failure. */
export type SecretOpenResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: 'unreadable' };

/** Context every blob is cryptographically bound to (via GCM AAD). */
export interface SecretAad {
  readonly userId: string;
  readonly credentialName: string;
}

export interface SecretBox {
  encrypt(plaintext: string, aad: SecretAad): string;
  decrypt(blob: string, aad: SecretAad): SecretOpenResult;
}

export interface SecretBoxOptions {
  /** 32-byte master key as 64-char hex or base64url. Validated here. */
  readonly masterKey: string;
}

const VERSION = 'v1';
const IV_BYTES = 12;
const HKDF_SALT = 'asapwaire-credential-vault';
const HKDF_INFO = 'credential-encryption:v1';

/** Generate a fresh master key in the accepted format (setup helper/tests). */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64url');
}

function parseMasterKey(raw: string): Buffer {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new RangeError(
      'Master key must be 32 bytes, provided as 64-char hex or base64url (generate one with 32 random bytes).',
    );
  }
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
    const parsed = Buffer.from(value, 'base64url');
    if (parsed.length === 32) {
      return parsed;
    }
  }
  if (value.length === 64) {
    throw new RangeError('Master key is 64 chars but not valid hex or base64url.');
  }
  throw new RangeError(
    'Master key must be 32 bytes, provided as 64-char hex or 43-char base64url.',
  );
}

function aadBuffer(aad: SecretAad): Buffer {
  return Buffer.from(`${VERSION}:${aad.userId}:${aad.credentialName}`, 'utf8');
}

/**
 * Construct the box. Throws on a malformed master key — this is the
 * boot-time fail-closed validation; runtime data problems never throw.
 */
export function createSecretBox(options: SecretBoxOptions): SecretBox {
  const master = parseMasterKey(options.masterKey);
  const key = Buffer.from(hkdfSync('sha256', master, HKDF_SALT, HKDF_INFO, 32));

  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aadBuffer(aad));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${VERSION}.${iv.toString('base64url')}.${ct.toString('base64url')}.${tag.toString('base64url')}`;
    },
    decrypt(blob, aad) {
      try {
        if (typeof blob !== 'string') {
          return { ok: false, reason: 'unreadable' };
        }
        const parts = blob.split('.');
        if (parts.length !== 4 || parts[0] !== VERSION) {
          return { ok: false, reason: 'unreadable' };
        }
        const iv = Buffer.from(parts[1], 'base64url');
        const ct = Buffer.from(parts[2], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');
        if (iv.length !== IV_BYTES || tag.length !== 16) {
          return { ok: false, reason: 'unreadable' };
        }
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(aadBuffer(aad));
        decipher.setAuthTag(tag);
        // No partial plaintext: update() output is only surfaced after
        // final() authenticates the whole record.
        const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
        return { ok: true, value: plain.toString('utf8') };
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
    },
  };
}
