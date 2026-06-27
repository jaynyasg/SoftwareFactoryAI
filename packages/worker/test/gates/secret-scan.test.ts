/**
 * Secret-scan gate behavior over in-memory fixture file contents (no real FS).
 *
 * Asserts the gate fails with the offending file:line locations as evidence when
 * secrets are present, redacts the matched secret, and passes a clean workspace.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryWorkspaceFiles,
  createSecretScanGate,
  scanContentForSecrets,
} from '../../src/index';
import type { GateContext, Sandbox } from '../../src/index';

// The secret-scan gate never touches the sandbox; a stub satisfies the context.
const SANDBOX_STUB: Sandbox = {
  mode: 'local-fallback',
  reducedTrust: true,
  run: () =>
    Promise.resolve({
      ok: true,
      denied: false,
      reducedTrust: true,
      mode: 'local-fallback',
      stdout: '',
      stderr: '',
      violations: [],
    }),
};

function context(sandbox: Sandbox): GateContext {
  return { runId: 'run-secret', workspaceDir: '/ws', sandbox };
}

describe('scanContentForSecrets', () => {
  it('detects an OpenAI-style API key with its line number', () => {
    const findings = scanContentForSecrets(
      'src/config.ts',
      'const a = 1;\nconst key = "sk-abcdefghijklmnopqrstuvwxyz0123";\n',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('openai-api-key');
    expect(findings[0].line).toBe(2);
    // The raw secret is redacted in the excerpt.
    expect(findings[0].excerpt).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('detects a private key header', () => {
    const findings = scanContentForSecrets('id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n');
    expect(findings.some((f) => f.rule === 'private-key')).toBe(true);
  });

  it('detects a .env secret assignment', () => {
    const findings = scanContentForSecrets(
      '.env',
      'PORT=3000\nDATABASE_PASSWORD=hunter2supersecret\n',
    );
    expect(findings.some((f) => f.rule === 'env-secret')).toBe(true);
  });
});

describe('secret-scan gate', () => {
  it('fails with offending locations as evidence when a secret is present', async () => {
    const files = createInMemoryWorkspaceFiles({
      'src/app.ts': 'export const x = 1;\n',
      'src/leak.ts': 'const token = "ghp_0123456789012345678901234567890123456";\n',
    });
    const gate = createSecretScanGate({ files });
    const result = await gate.run(context(SANDBOX_STUB));

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/src\/leak\.ts:1/);
    expect(result.evidence.some((e) => e.label === 'secret:github-token')).toBe(true);
    expect(result.evidence.some((e) => e.detail === 'src/leak.ts:1')).toBe(true);
  });

  it('passes a clean workspace', async () => {
    const files = createInMemoryWorkspaceFiles({
      'src/app.ts': 'export const x = 1;\n',
      'README.md': '# Hello\n',
    });
    const gate = createSecretScanGate({ files });
    const result = await gate.run(context(SANDBOX_STUB));

    expect(result.passed).toBe(true);
    expect(result.summary).toMatch(/no secrets detected/i);
  });
});
