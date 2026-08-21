import { mergeConfig, defineConfig } from 'vitest/config';
import shared from '../../vitest.shared';

/**
 * Web tests run in two environments from one config:
 *   - server tests (test/server/*.ts) inherit the shared `node` environment, and
 *   - component tests (test/components/*.test.tsx) opt into `jsdom` via a
 *     `// @vitest-environment jsdom` docblock at the top of each file.
 * The shared setup registers @testing-library/jest-dom matchers; it is a no-op
 * for the node-env server tests (which never use DOM matchers).
 */
export default mergeConfig(
  shared,
  defineConfig({
    // Use React's automatic JSX runtime so components/tests need no `import React`.
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    test: {
      name: 'web',
      // Enables @testing-library/react's automatic afterEach cleanup so renders
      // do not leak across component tests (server tests still import explicitly).
      globals: true,
      setupFiles: ['./test/setup.ts'],
    },
  }),
);
