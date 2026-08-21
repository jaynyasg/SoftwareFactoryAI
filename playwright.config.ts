import { defineConfig } from '@playwright/test';

/**
 * Root Playwright config. Individual e2e suites live under tests/e2e.
 *
 * U8 adds the Factory Floor UI specs, which drive the real Next app over the
 * `baseURL`. The `webServer` below boots that app on 127.0.0.1:3000 (loopback).
 * The U3 operator-access and U6 local-preview specs boot their OWN ephemeral
 * servers and ignore `baseURL`, so they keep passing alongside this web server.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Port 3100 (not Next's default 3000) keeps the e2e app isolated from any
    // other dev server occupying 3000 on the developer's machine.
    baseURL: process.env.SF_BASE_URL ?? 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm --filter @software-factory/web exec next dev --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { SF_ALLOWED_ORIGINS: 'http://127.0.0.1:3100,http://localhost:3100' },
  },
});
