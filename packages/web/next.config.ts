import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin file tracing to THIS monorepo. Without it, a stray lockfile above the
  // repo (e.g. ~/pnpm-lock.yaml) makes Next infer the HOME directory as the
  // workspace root and glob-walk everything under it — including locked
  // AppData/Temp folders on Windows, which fails the build with EPERM.
  outputFileTracingRoot: join(__dirname, '..', '..'),
  // Resolve and transpile the factory's internal source-only packages.
  transpilePackages: [
    '@software-factory/core',
    '@software-factory/worker',
    '@software-factory/cli',
  ],
};

export default nextConfig;
