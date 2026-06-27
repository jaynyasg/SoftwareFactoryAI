import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest base config. Each package extends this via `mergeConfig` so test
 * wiring (environment, include globs, no-tests tolerance) stays consistent.
 *
 * Cross-package imports like `@software-factory/core` resolve through pnpm
 * workspace symlinks + the package `exports` field (which points at TS source),
 * so no path-alias plugin is required here.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    clearMocks: true,
  },
});
