/**
 * CLI credential resolution (multi-user U4).
 *
 * `SF_API_TOKEN` (the personal `sfai_` token minted under Settings on a
 * multi-user factory) wins over the legacy `SF_OPERATOR_TOKEN`, which wins
 * over the shared `.factory/operator-token.json` file — and both env names
 * travel through the same header slot, so single-tenant setups need no change.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOperatorToken } from '../src/operator-token';

function emptyFactoryDir(): string {
  return mkdtempSync(join(tmpdir(), 'sf-cli-token-'));
}

describe('loadOperatorToken', () => {
  it('SF_API_TOKEN (personal, multi-user) wins over SF_OPERATOR_TOKEN', async () => {
    const token = await loadOperatorToken({
      env: { SF_API_TOKEN: 'sfai_sel_secret', SF_OPERATOR_TOKEN: 'legacy-shared' },
      factoryDir: emptyFactoryDir(),
    });
    expect(token).toBe('sfai_sel_secret');
  });

  it('falls back to SF_OPERATOR_TOKEN when no personal token is set (single-tenant unchanged)', async () => {
    const token = await loadOperatorToken({
      env: { SF_OPERATOR_TOKEN: 'legacy-shared' },
      factoryDir: emptyFactoryDir(),
    });
    expect(token).toBe('legacy-shared');
  });

  it('empty-string env values are ignored, not treated as tokens', async () => {
    const token = await loadOperatorToken({
      env: { SF_API_TOKEN: '', SF_OPERATOR_TOKEN: '' },
      factoryDir: emptyFactoryDir(),
    });
    expect(token).toBeNull();
  });
});
