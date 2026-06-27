/**
 * Build the `software-factory` CLI to a single runnable ESM bundle in `dist/`.
 *
 * Workspace packages (`@software-factory/*`) are bundled in (`noExternal`) so the
 * release artifact runs without the pnpm workspace symlinks — npm publishing is
 * deferred, so the GitHub Release attaches this self-contained `dist/`. The
 * entry's `#!/usr/bin/env node` shebang is preserved by tsup for the `bin`.
 *
 * Exported as a plain object (no `import { defineConfig } from 'tsup'`) so the
 * release can build via `pnpm dlx tsup` without `tsup` resolvable from this dir.
 */
export default {
  entry: ['src/index.ts'],
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: true,
  noExternal: [/^@software-factory\//],
};
