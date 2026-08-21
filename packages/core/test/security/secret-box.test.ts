/**
 * Secret box (U1): AES-256-GCM with per-record random IVs, AAD binding, HKDF
 * subkeys from a validated env master key, and a versioned blob format. Wrong
 * key / tampered blob / swapped AAD fail closed with NO partial plaintext.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createSecretBox, generateMasterKey } from '../../src/index';

const KEY = generateMasterKey();

describe('createSecretBox', () => {
  it('rejects a malformed or short master key with an actionable message', () => {
    expect(() => createSecretBox({ masterKey: 'too-short' })).toThrow(/32 bytes/);
    expect(() => createSecretBox({ masterKey: '' })).toThrow(/32 bytes/);
    expect(() => createSecretBox({ masterKey: 'zz'.repeat(32) })).toThrow(/hex|base64/i);
  });

  it('accepts a 64-char hex or 43-char base64url key', () => {
    expect(() => createSecretBox({ masterKey: randomBytes(32).toString('hex') })).not.toThrow();
    expect(() =>
      createSecretBox({ masterKey: randomBytes(32).toString('base64url') }),
    ).not.toThrow();
  });
});

describe('encrypt / decrypt', () => {
  const box = createSecretBox({ masterKey: KEY });
  const aad = { userId: 'user-1', credentialName: 'anthropic_api_key' };

  it('round-trips a secret; blob is versioned and contains no plaintext', () => {
    const blob = box.encrypt('sk-ant-super-secret-value', aad);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('sk-ant');
    const out = box.decrypt(blob, aad);
    expect(out).toEqual({ ok: true, value: 'sk-ant-super-secret-value' });
  });

  it('uses a fresh IV per encryption (same input, different blobs)', () => {
    const a = box.encrypt('same secret', aad);
    const b = box.encrypt('same secret', aad);
    expect(a).not.toBe(b);
  });

  it('fails closed on tampered ciphertext with no partial plaintext', () => {
    const blob = box.encrypt('secret', aad);
    const parts = blob.split('.');
    const ct = Buffer.from(parts[2], 'base64url');
    ct[0] ^= 0xff;
    parts[2] = ct.toString('base64url');
    const out = box.decrypt(parts.join('.'), aad);
    expect(out.ok).toBe(false);
    expect(out).not.toHaveProperty('value');
  });

  it('fails closed when the blob is swapped between users (AAD mismatch)', () => {
    const blob = box.encrypt('user1 secret', aad);
    const out = box.decrypt(blob, { userId: 'user-2', credentialName: 'anthropic_api_key' });
    expect(out.ok).toBe(false);
  });

  it('fails closed with the WRONG master key — typed, not thrown', () => {
    const blob = box.encrypt('secret', aad);
    const other = createSecretBox({ masterKey: generateMasterKey() });
    const out = other.decrypt(blob, aad);
    expect(out).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('fails closed on malformed blobs', () => {
    for (const bad of ['', 'v1.', 'nope', 'v9.aaaa.bbbb.cccc']) {
      expect(box.decrypt(bad, aad).ok).toBe(false);
    }
  });
});
