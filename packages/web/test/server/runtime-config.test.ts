import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveMultiUserRuntimeConfig,
  resolveRuntimeConfig,
  resolveScaleDiagnostics,
  resolveTrustProxy,
  scaleSafetyStartupLine,
} from '../../src/server/runtime';

describe('resolveRuntimeConfig', () => {
  it('keeps local defaults loopback-first', () => {
    const config = resolveRuntimeConfig({}, 'C:\\repo');
    expect(config.mode).toBe('local');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.allowedOrigins).toContain('http://127.0.0.1:3000');
    expect(config.operatorTokenSource).toBe('file');
  });

  it('switches to hosted defaults and env-backed auth in cloud mode', () => {
    const config = resolveRuntimeConfig(
      {
        SF_RUNTIME: 'cloud',
        PORT: '10000',
        SF_FACTORY_DIR: '/var/data/.factory',
        SF_PUBLIC_BASE_URL: 'https://factory.example.com/',
        SF_OPERATOR_TOKEN: 'cloud-secret',
      },
      '/repo',
    );
    expect(config.mode).toBe('cloud');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(10000);
    expect(config.factoryDir).toBe('/var/data/.factory');
    expect(config.allowedOrigins).toContain('https://factory.example.com');
    expect(config.operatorTokenSource).toBe('env');
  });

  it('defaults research config to fail-closed (no network, no providers)', () => {
    const config = resolveRuntimeConfig({}, 'C:\\repo');
    expect(config.research.allowNetwork).toBe(false);
    expect(config.research.documentationUrls).toEqual([]);
    expect(config.research.searchProviderId).toBeUndefined();
    expect(config.research.searchCredentialsPresent).toBe(false);
    expect(config.research.maxSources).toBe(12);
    expect(config.research.maxDurationMs).toBe(120_000);
  });

  it('resolves research config from env, reporting credential PRESENCE only', () => {
    const config = resolveRuntimeConfig(
      {
        SF_RESEARCH_ALLOW_NETWORK: 'true',
        SF_RESEARCH_DOC_URLS: 'https://docs.a.com, https://docs.b.com',
        SF_RESEARCH_SEARCH_PROVIDER: 'example-search',
        SF_RESEARCH_SEARCH_API_KEY: 'super-secret-value',
        SF_RESEARCH_MAX_SOURCES: '5',
        SF_RESEARCH_MAX_DURATION_MS: '30000',
      },
      'C:\\repo',
    );
    expect(config.research.allowNetwork).toBe(true);
    expect(config.research.documentationUrls).toEqual(['https://docs.a.com', 'https://docs.b.com']);
    expect(config.research.searchProviderId).toBe('example-search');
    expect(config.research.searchCredentialsPresent).toBe(true);
    expect(config.research.maxSources).toBe(5);
    expect(config.research.maxDurationMs).toBe(30_000);
    // E5: the credential VALUE never appears in resolved config.
    expect(JSON.stringify(config)).not.toContain('super-secret-value');
  });

  it('defaults execution autoStart OFF: opening the factory never auto-runs queued work', () => {
    const config = resolveRuntimeConfig({}, 'C:\\repo');
    expect(config.execution.autoStart).toBe(false);
  });

  it('SF_EXEC_AUTOSTART=1 opts the daemon back into drain-on-start', () => {
    const config = resolveRuntimeConfig({ SF_EXEC_AUTOSTART: '1' }, 'C:\\repo');
    expect(config.execution.autoStart).toBe(true);
  });

  it('trustProxy is OFF by default in local mode (XFF is not trusted for throttle/audit)', () => {
    const config = resolveRuntimeConfig({}, 'C:\\repo');
    expect(config.trustProxy).toBe(false);
  });

  it('trustProxy defaults ON in cloud mode (Render terminates at a trusted proxy that overwrites XFF)', () => {
    const config = resolveRuntimeConfig(
      { SF_RUNTIME: 'cloud', SF_PUBLIC_BASE_URL: 'https://f.example.com', SF_OPERATOR_TOKEN: 't' },
      '/repo',
    );
    expect(config.trustProxy).toBe(true);
  });
});

describe('resolveTrustProxy (residual review #7 — un-forgeable client IP)', () => {
  it('defaults to the runtime mode: false for local/direct, true for cloud', () => {
    expect(resolveTrustProxy({}, 'local')).toBe(false);
    expect(resolveTrustProxy({}, 'cloud')).toBe(true);
  });

  it('SF_TRUST_PROXY is an explicit override in BOTH directions', () => {
    // Force ON even in local mode (operator runs behind their own trusted proxy).
    expect(resolveTrustProxy({ SF_TRUST_PROXY: '1' }, 'local')).toBe(true);
    expect(resolveTrustProxy({ SF_TRUST_PROXY: 'true' }, 'local')).toBe(true);
    // Force OFF even in cloud mode (operator fronts the app directly).
    expect(resolveTrustProxy({ SF_TRUST_PROXY: '0' }, 'cloud')).toBe(false);
    expect(resolveTrustProxy({ SF_TRUST_PROXY: 'false' }, 'cloud')).toBe(false);
  });

  it('ignores a non-boolean SF_TRUST_PROXY and falls back to the mode default', () => {
    expect(resolveTrustProxy({ SF_TRUST_PROXY: 'yes-please' }, 'local')).toBe(false);
    expect(resolveTrustProxy({ SF_TRUST_PROXY: '  ' }, 'cloud')).toBe(true);
  });
});

describe('scale diagnostics (full-factory U11)', () => {
  it('reports single-instance JSONL storage and the ledger queue mode', () => {
    const diagnostics = resolveScaleDiagnostics();
    expect(diagnostics.storageMode).toBe('jsonl');
    expect(diagnostics.queueMode).toBe('ledger');
    expect(diagnostics.singleInstanceOnly).toBe(true);
    expect(diagnostics.horizontalScaling).toBe('unsafe');
  });

  it('warns explicitly that horizontal scaling is unsafe and names the seam', () => {
    const diagnostics = resolveScaleDiagnostics();
    expect(diagnostics.warning).toMatch(/single-instance only/i);
    expect(diagnostics.warning).toMatch(/exactly one instance/i);
    expect(diagnostics.warning).toMatch(/horizontal/i);
    // The warning points at the documented migration seam, not a dead end.
    expect(diagnostics.warning).toMatch(/Hosted Scale Migration Seam/);
  });

  it('formats a startup log line naming mode, storage, and queue', () => {
    const config = resolveRuntimeConfig(
      {
        SF_RUNTIME: 'cloud',
        SF_FACTORY_DIR: '/var/data/.factory',
        SF_OPERATOR_TOKEN: 'cloud-secret',
      },
      '/repo',
    );
    const line = scaleSafetyStartupLine(config);
    expect(line).toContain('[software-factory] scale-safety:');
    expect(line).toContain('mode=cloud');
    expect(line).toContain('storage=jsonl');
    expect(line).toContain('queue=ledger');
    expect(line).toContain('horizontal-scaling=unsafe');
    expect(line).toMatch(/single-instance only/i);
  });
});

/* ----------------------------------------------------------------------------
 * Multi-user activation (U11): fail-closed in BOTH directions.
 * ------------------------------------------------------------------------- */

describe('resolveMultiUserRuntimeConfig', () => {
  const VALID_KEY = randomBytes(32).toString('base64url');
  const TEMP_FACTORY = mkdtempSync(join(tmpdir(), 'sfai-runtime-'));

  it('single-tenant regression pin: local AND cloud resolve identically with the new vars unset', () => {
    const local = resolveRuntimeConfig({}, 'C:\repo');
    expect(local.multiUser).toEqual({
      enabled: false,
      bootstrapRearm: false,
      insecureCookies: false,
      warnings: [],
    });
    const cloud = resolveRuntimeConfig(
      { SF_RUNTIME: 'cloud', SF_OPERATOR_TOKEN: 'cloud-secret', SF_FACTORY_DIR: TEMP_FACTORY },
      '/repo',
    );
    expect(cloud.multiUser.enabled).toBe(false);
  });

  it('multi-user on + valid key + configured origin → boots with the mode exposed', () => {
    const config = resolveRuntimeConfig(
      {
        SF_MULTI_USER: '1',
        SF_MASTER_KEY: VALID_KEY,
        SF_PUBLIC_BASE_URL: 'https://factory.example.com',
        SF_BOOTSTRAP_INVITE: 'a-high-entropy-bootstrap-invite',
        SF_FACTORY_DIR: TEMP_FACTORY,
      },
      '/repo',
    );
    expect(config.multiUser.enabled).toBe(true);
    expect(config.multiUser.source).toBe('env');
    expect(config.multiUser.masterKey).toBe(VALID_KEY);
    expect(config.multiUser.bootstrapInvite).toBe('a-high-entropy-bootstrap-invite');
  });

  it('SF_MULTI_USER=1 without a valid SF_MASTER_KEY → boot FAILS with the remediation', () => {
    expect(() =>
      resolveMultiUserRuntimeConfig(
        { SF_MULTI_USER: '1', SF_PUBLIC_BASE_URL: 'https://x.example' },
        { factoryDir: TEMP_FACTORY },
      ),
    ).toThrow(/SF_MASTER_KEY/);
    expect(() =>
      resolveMultiUserRuntimeConfig(
        {
          SF_MULTI_USER: '1',
          SF_MASTER_KEY: 'not-a-key',
          SF_PUBLIC_BASE_URL: 'https://x.example',
        },
        { factoryDir: TEMP_FACTORY },
      ),
    ).toThrow(/randomBytes\(32\)/);
  });

  it('low-entropy SF_BOOTSTRAP_INVITE rejected; missing origin rejected', () => {
    expect(() =>
      resolveMultiUserRuntimeConfig(
        {
          SF_MULTI_USER: '1',
          SF_MASTER_KEY: VALID_KEY,
          SF_PUBLIC_BASE_URL: 'https://x.example',
          SF_BOOTSTRAP_INVITE: 'short',
        },
        { factoryDir: TEMP_FACTORY },
      ),
    ).toThrow(/too short/);
    expect(() =>
      resolveMultiUserRuntimeConfig(
        { SF_MULTI_USER: '1', SF_MASTER_KEY: VALID_KEY },
        { factoryDir: TEMP_FACTORY },
      ),
    ).toThrow(/SF_PUBLIC_BASE_URL/);
  });

  it('downgrade fail-closed: initialized auth stores + flag UNSET keeps multi-user ON', () => {
    const factoryDir = mkdtempSync(join(tmpdir(), 'sfai-runtime-init-'));
    mkdirSync(join(factoryDir, 'auth'), { recursive: true });
    writeFileSync(join(factoryDir, 'auth', 'accounts.json'), '[]\n', 'utf8');

    const config = resolveMultiUserRuntimeConfig({}, { factoryDir });
    expect(config.enabled).toBe(true);
    expect(config.source).toBe('disk_state');
    // No boot crash without the key — but the operator hears about it.
    expect(config.masterKey).toBeUndefined();
    expect(config.warnings.join('\n')).toMatch(/staying in multi-user mode/i);
    expect(config.warnings.join('\n')).toMatch(/UNREADABLE/);
  });

  it('a master-key FILE on the factory disk triggers the hygiene warning', () => {
    const factoryDir = mkdtempSync(join(tmpdir(), 'sfai-runtime-keyfile-'));
    writeFileSync(join(factoryDir, 'master-key'), 'oops\n', 'utf8');
    const config = resolveMultiUserRuntimeConfig(
      {
        SF_MULTI_USER: '1',
        SF_MASTER_KEY: VALID_KEY,
        SF_PUBLIC_BASE_URL: 'https://x.example',
      },
      { factoryDir },
    );
    expect(config.warnings.join('\n')).toMatch(/platform secret store/i);
  });
});
