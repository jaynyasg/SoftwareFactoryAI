import { describe, expect, it } from 'vitest';
import { CORE_CONTRACT_VERSION, CORE_PACKAGE_NAME } from '../src/index';

describe('core package contract', () => {
  it('exposes a semantic contract version', () => {
    expect(CORE_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exposes its stable package identifier', () => {
    expect(CORE_PACKAGE_NAME).toBe('@software-factory/core');
  });
});
