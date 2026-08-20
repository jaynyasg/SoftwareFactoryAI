/**
 * Credential vault (U1): typed per-user credential records encrypted at rest,
 * presence-only views (values never appear), decrypt-late reads with typed
 * missing/unreadable outcomes, and in-memory + file stores with load-or-null
 * file semantics mirroring the operator-token store.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCredentialVault,
  createFileCredentialStore,
  createInMemoryCredentialStore,
  createSecretBox,
  generateMasterKey,
} from '../../src/index';

const KEY = generateMasterKey();

describe('credential vault (in-memory)', () => {
  const vault = createCredentialVault({
    box: createSecretBox({ masterKey: KEY }),
    store: createInMemoryCredentialStore(),
  });

  it('set → presence shows kind without the value; read decrypts late', async () => {
    await vault.setCredential('user-1', 'anthropic_api_key', 'sk-ant-value-123');
    const presence = await vault.getPresence('user-1');
    const row = presence.find((p) => p.kind === 'anthropic_api_key');
    expect(row?.present).toBe(true);
    expect(JSON.stringify(presence)).not.toContain('sk-ant-value-123');

    const read = await vault.readCredential('user-1', 'anthropic_api_key');
    expect(read).toEqual({ ok: true, value: 'sk-ant-value-123' });
  });

  it('missing credential reads as typed missing', async () => {
    const read = await vault.readCredential('user-1', 'vercel_token');
    expect(read).toEqual({ ok: false, reason: 'missing' });
  });

  it('remove deletes the record; per-user isolation holds', async () => {
    await vault.setCredential('user-2', 'github_token', 'ghp_two');
    await vault.removeCredential('user-1', 'anthropic_api_key');
    expect(await vault.readCredential('user-1', 'anthropic_api_key')).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(await vault.readCredential('user-2', 'github_token')).toEqual({
      ok: true,
      value: 'ghp_two',
    });
    expect(await vault.readCredential('user-1', 'github_token')).toEqual({
      ok: false,
      reason: 'missing',
    });
  });
});

describe('credential vault with an unreadable master key', () => {
  it('presence still works; reads and writes are typed master_key_unreadable', async () => {
    const store = createInMemoryCredentialStore();
    const good = createCredentialVault({ box: createSecretBox({ masterKey: KEY }), store });
    await good.setCredential('user-1', 'openai_api_key', 'sk-openai-1');

    const broken = createCredentialVault({ box: null, store });
    const presence = await broken.getPresence('user-1');
    expect(presence.find((p) => p.kind === 'openai_api_key')?.present).toBe(true);
    expect(await broken.readCredential('user-1', 'openai_api_key')).toEqual({
      ok: false,
      reason: 'master_key_unreadable',
    });
    expect(await broken.setCredential('user-1', 'github_token', 'x')).toEqual({
      ok: false,
      reason: 'master_key_unreadable',
    });
  });
});

describe('file credential store', () => {
  it('persists encrypted blobs only (never plaintext), round-trips, load-or-null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-test-'));
    const store = createFileCredentialStore(dir);
    const vault = createCredentialVault({ box: createSecretBox({ masterKey: KEY }), store });

    await vault.setCredential('user-9', 'claude_oauth_token', 'sk-ant-oat01-topsecret');
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    const raw = readFileSync(join(dir, files[0]), 'utf8');
    expect(raw).not.toContain('topsecret');

    expect(await vault.readCredential('user-9', 'claude_oauth_token')).toEqual({
      ok: true,
      value: 'sk-ant-oat01-topsecret',
    });

    // Malformed file → treated as empty, not a crash (load-or-null semantics).
    writeFileSync(join(dir, files[0]), 'not json', 'utf8');
    expect((await vault.getPresence('user-9')).every((p) => !p.present)).toBe(true);
  });
});
