import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests run against a throwaway SQLite database (prisma/test.db) — no
 * external services required. `tests/setup/global-setup.ts` pushes the schema
 * once; `tests/setup/test-setup.ts` truncates tables before each test so cases
 * stay independent and deterministic. `fileParallelism: false` keeps the single
 * SQLite file free of cross-file write contention.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/test-setup.ts'],
    fileParallelism: false,
    env: {
      DATABASE_URL: 'file:./test.db',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
