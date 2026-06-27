import { defineConfig } from '@playwright/test';

/**
 * Root Playwright config. Individual e2e suites live under tests/e2e and are
 * added by the units that introduce them (operator-access in U3, local-preview
 * in U6, factory-floor in U8, etc.). A `webServer` is wired in once there is a
 * bootable app to start.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.SF_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
});
