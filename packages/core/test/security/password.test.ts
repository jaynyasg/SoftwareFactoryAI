/**
 * Password hashing (U1): scrypt with OWASP parameters, PHC-format storage,
 * NFKC normalization, and forward-compatible verification against stored
 * parameter strings (a future param raise verifies old hashes unchanged).
 */
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword, PASSWORD_SCRYPT_PARAMS } from '../../src/index';

describe('hashPassword / verifyPassword', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('$scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
  });

  it('normalizes unicode (NFKC) so composed and decomposed forms match', async () => {
    const composed = 'café-secret-123456'; // é as one code point
    const decomposed = 'café-secret-123456'; // e + combining acute
    const stored = await hashPassword(composed);
    expect(await verifyPassword(decomposed, stored)).toBe(true);
  });

  it('salts every hash: same password, different stored strings', async () => {
    const a = await hashPassword('same password 12345');
    const b = await hashPassword('same password 12345');
    expect(a).not.toBe(b);
  });

  it('verifies against a stored string with OLDER (weaker) params — forward compat', async () => {
    // Simulate a legacy hash minted at lower cost by hashing with explicit
    // low params, then verifying with the CURRENT verifier.
    const stored = await hashPassword('legacy password 999', { N: 16384, r: 8, p: 1 });
    expect(stored).toContain('N=16384');
    expect(await verifyPassword('legacy password 999', stored)).toBe(true);
  });

  it('current params meet the OWASP floor', () => {
    expect(PASSWORD_SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(131072);
    expect(PASSWORD_SCRYPT_PARAMS.r).toBe(8);
    expect(PASSWORD_SCRYPT_PARAMS.p).toBeGreaterThanOrEqual(1);
  });

  it('rejects malformed or truncated stored strings without throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-phc-string')).toBe(false);
    expect(await verifyPassword('anything', '$scrypt$N=1024,r=8,p=1$AAAA')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('rejects empty passwords at hash time', async () => {
    await expect(hashPassword('')).rejects.toThrow(/empty/i);
  });
});
