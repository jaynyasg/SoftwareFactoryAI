/**
 * Research source policy (full-factory U2) — allowed classes, network gating,
 * credential requirements, and secret redaction (hardening E5).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACTION_PATTERNS,
  NETWORK_SOURCE_KINDS,
  evaluateSourceClass,
  evaluateSourceSetup,
  isNetworkSourceKind,
  redactSecrets,
  resolveSourcePolicy,
} from '../../src/index';

describe('resolveSourcePolicy', () => {
  it('defaults to network CLOSED with every kind allowed and redaction on', () => {
    const policy = resolveSourcePolicy();
    expect(policy.allowNetwork).toBe(false);
    expect(policy.allowedKinds).toContain('repo_scan');
    expect(policy.allowedKinds).toContain('web_search');
    expect(policy.redactionPatterns).toEqual(DEFAULT_REDACTION_PATTERNS);
  });
});

describe('evaluateSourceClass', () => {
  it('flags network classes and gates them behind allowNetwork', () => {
    for (const kind of NETWORK_SOURCE_KINDS) {
      expect(isNetworkSourceKind(kind)).toBe(true);
      const closed = evaluateSourceClass(resolveSourcePolicy(), kind);
      expect(closed.allowed).toBe(false);
      if (!closed.allowed) {
        expect(closed.rule).toBe('network_not_allowed');
      }
      const open = evaluateSourceClass(resolveSourcePolicy({ allowNetwork: true }), kind);
      expect(open.allowed).toBe(true);
    }
  });

  it('refuses kinds outside the allow-list before the network gate', () => {
    const policy = resolveSourcePolicy({ allowedKinds: ['uploaded_prd'], allowNetwork: true });
    const decision = evaluateSourceClass(policy, 'web_search');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.rule).toBe('kind_not_allowed');
    }
  });

  it('allows non-network kinds with the default policy', () => {
    expect(evaluateSourceClass(resolveSourcePolicy(), 'repo_scan').allowed).toBe(true);
    expect(evaluateSourceClass(resolveSourcePolicy(), 'uploaded_prd').allowed).toBe(true);
  });
});

describe('evaluateSourceSetup', () => {
  it('refuses unconfigured adapters', () => {
    const decision = evaluateSourceSetup({
      configured: false,
      requiresCredentials: false,
      credentialsPresent: true,
      detail: 'nothing configured',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.rule).toBe('not_configured');
      expect(decision.reason).toBe('nothing configured');
    }
  });

  it('refuses missing required credentials (fail closed)', () => {
    const decision = evaluateSourceSetup({
      configured: true,
      requiresCredentials: true,
      credentialsPresent: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.rule).toBe('credentials_missing');
    }
  });

  it('allows configured adapters with credentials (or none required)', () => {
    expect(
      evaluateSourceSetup({ configured: true, requiresCredentials: true, credentialsPresent: true })
        .allowed,
    ).toBe(true);
    expect(
      evaluateSourceSetup({
        configured: true,
        requiresCredentials: false,
        credentialsPresent: false,
      }).allowed,
    ).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('redacts key/token/password assignments', () => {
    const input = 'set API_KEY=sk-abc123def456ghi and PASSWORD: hunter2hunter2 then run';
    const output = redactSecrets(input);
    expect(output).not.toContain('sk-abc123def456ghi');
    expect(output).not.toContain('hunter2hunter2');
    expect(output).toContain('[redacted]');
  });

  it('redacts bearer tokens and well-known credential prefixes', () => {
    const output = redactSecrets(
      'Authorization uses Bearer abcDEF123456789 while CI uses ghp_1234567890abcdef and AKIAABCDEFGH123456',
    );
    expect(output).not.toContain('abcDEF123456789');
    expect(output).not.toContain('ghp_1234567890abcdef');
    expect(output).not.toContain('AKIAABCDEFGH123456');
  });

  it('leaves ordinary text untouched and stays deterministic across calls', () => {
    const input = 'The marketplace has 12 tickets and a repo scan found 3 files.';
    expect(redactSecrets(input)).toBe(input);
    // Shared regex instances must not keep lastIndex state between calls.
    const secret = 'TOKEN=abc123abc123 TOKEN=def456def456';
    expect(redactSecrets(secret)).toBe(redactSecrets(secret));
  });
});
