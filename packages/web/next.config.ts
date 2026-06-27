import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Resolve and transpile the factory's internal source-only packages.
  transpilePackages: ['@software-factory/core'],
};

export default nextConfig;
