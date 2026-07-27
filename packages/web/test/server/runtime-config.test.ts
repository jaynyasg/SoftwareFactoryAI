import { describe, expect, it } from 'vitest';
import {
  resolveRuntimeConfig,
  resolveScaleDiagnostics,
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
