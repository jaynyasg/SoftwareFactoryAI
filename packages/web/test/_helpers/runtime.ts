/**
 * Shared RuntimeConfig factory for web server tests.
 *
 * Several suites (command-guard, setup-routes, research-routes,
 * workspace-routes) previously each hand-built a full RuntimeConfig literal;
 * this helper keeps the common defaults in one place while every suite still
 * states ONLY the values its assertions depend on via overrides.
 */
import type { RuntimeConfig } from '../../src/server/runtime';

export interface TestRuntimeConfigOverrides {
  readonly mode?: RuntimeConfig['mode'];
  readonly host?: string;
  readonly port?: number;
  readonly factoryDir?: string;
  readonly allowedOrigins?: readonly string[];
  readonly publicBaseUrl?: string;
  readonly operatorTokenSource?: RuntimeConfig['operatorTokenSource'];
  readonly csrfToken?: string;
  readonly research?: Partial<RuntimeConfig['research']>;
  readonly workspace?: Partial<RuntimeConfig['workspace']>;
  readonly execution?: Partial<RuntimeConfig['execution']>;
}

/** Build a fully-populated RuntimeConfig with test-friendly defaults. */
export function testRuntimeConfig(overrides: TestRuntimeConfigOverrides = {}): RuntimeConfig {
  return {
    mode: overrides.mode ?? 'local',
    host: overrides.host ?? '127.0.0.1',
    port: overrides.port ?? 3000,
    factoryDir: overrides.factoryDir ?? '.factory',
    allowedOrigins: overrides.allowedOrigins ?? [],
    publicBaseUrl: overrides.publicBaseUrl,
    operatorTokenSource: overrides.operatorTokenSource ?? 'file',
    csrfToken: overrides.csrfToken,
    research: {
      allowNetwork: false,
      documentationUrls: [],
      searchCredentialsPresent: false,
      maxSources: 12,
      maxDurationMs: 120_000,
      ...overrides.research,
    },
    workspace: {
      localBoundaryRoot: '.',
      approvedFolders: [],
      checkoutRoot: '.factory/workspaces',
      checkoutCredentialsPresent: false,
      dirtyStatePolicy: 'allow_dirty',
      ...overrides.workspace,
    },
    execution: {
      leaseMs: 60_000,
      heartbeatMs: 15_000,
      reconcileIntervalMs: 30_000,
      maxAttempts: 3,
      ...overrides.execution,
    },
  };
}
