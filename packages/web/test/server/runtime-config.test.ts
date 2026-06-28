import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig } from '../../src/server/runtime';

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
});
