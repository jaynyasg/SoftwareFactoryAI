import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright boots the real app via `webServer` before the smoke test runs:
 * it resets a dedicated SQLite database (prisma/e2e.db), seeds it, then starts
 * `next dev` on port 3100. No external services are required.
 */
const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm run e2e:server',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL: 'file:./e2e.db',
    },
  },
});
