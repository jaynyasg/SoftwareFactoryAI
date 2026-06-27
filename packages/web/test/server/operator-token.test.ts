import { describe, expect, it } from 'vitest';
import {
  createInMemoryOperatorTokenStore,
  createOperatorTokenProvider,
  generateOperatorToken,
  verifyOperatorToken,
} from '@software-factory/core';

describe('generateOperatorToken', () => {
  it('produces non-empty, unique tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 256; i += 1) {
      const token = generateOperatorToken();
      expect(token.length).toBeGreaterThan(0);
      tokens.add(token);
    }
    expect(tokens.size).toBe(256);
  });

  it('honours a custom byte length and rejects invalid lengths', () => {
    expect(generateOperatorToken(8).length).toBeGreaterThan(0);
    expect(() => generateOperatorToken(0)).toThrow(RangeError);
    expect(() => generateOperatorToken(-4)).toThrow(RangeError);
  });
});

describe('verifyOperatorToken', () => {
  it('accepts the matching token and rejects mismatches', () => {
    const token = generateOperatorToken();
    expect(verifyOperatorToken(token, token)).toBe(true);
    expect(verifyOperatorToken(token, `${token}x`)).toBe(false);
    expect(verifyOperatorToken(token, generateOperatorToken())).toBe(false);
  });

  it('rejects empty inputs so an absent secret never authenticates', () => {
    const token = generateOperatorToken();
    expect(verifyOperatorToken('', token)).toBe(false);
    expect(verifyOperatorToken(token, '')).toBe(false);
    expect(verifyOperatorToken('', '')).toBe(false);
  });

  it('handles different-length inputs without throwing', () => {
    expect(verifyOperatorToken('short', 'a-much-longer-presented-value')).toBe(false);
  });
});

describe('createOperatorTokenProvider', () => {
  it('creates once and returns the same session on subsequent load-or-create', async () => {
    let minted = 0;
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore(),
      clock: () => 1000,
      generateToken: () => `token-${(minted += 1)}`,
    });

    expect(await provider.current()).toBeNull();
    const first = await provider.getOrCreate();
    const second = await provider.getOrCreate();
    expect(first.token).toBe('token-1');
    expect(second.token).toBe('token-1');
    expect(minted).toBe(1);
    expect((await provider.current())?.token).toBe('token-1');
  });

  it('verifies the active token in constant time', async () => {
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore({ token: 'known-token', createdAt: 0 }),
    });
    expect(await provider.verify('known-token')).toBe(true);
    expect(await provider.verify('other-token')).toBe(false);
  });

  it('rotates the token and invalidates the previous one', async () => {
    let minted = 0;
    const provider = createOperatorTokenProvider({
      store: createInMemoryOperatorTokenStore(),
      generateToken: () => `token-${(minted += 1)}`,
    });
    const original = await provider.getOrCreate();
    const rotated = await provider.rotate();

    expect(rotated.token).not.toBe(original.token);
    expect(await provider.verify(original.token)).toBe(false);
    expect(await provider.verify(rotated.token)).toBe(true);
  });

  it('returns false from verify when no session exists', async () => {
    const provider = createOperatorTokenProvider({ store: createInMemoryOperatorTokenStore() });
    expect(await provider.verify('anything')).toBe(false);
  });
});
