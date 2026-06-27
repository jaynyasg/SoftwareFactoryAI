import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lint is run as its own gate (`pnpm lint`); keep it out of `next build` so a
  // build failure always means a real build/type problem.
  eslint: { ignoreDuringBuilds: true },
  // This app is standalone (its own lockfile); pin the build-trace root to this
  // directory so Next does not walk up to the parent factory workspace.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The Playwright e2e server is reached at 127.0.0.1; allow it in dev so Next
  // 15.5+ does not warn about cross-origin /_next/* requests.
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
