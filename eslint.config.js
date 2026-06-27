import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'packages/web/next-env.d.ts',
      'generated-app-template/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // TypeScript's own checker handles undefined identifiers; the core rule
      // false-positives on globals like `process` in .ts files.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.config.{js,ts,mjs,cts}', 'vitest.shared.ts', 'playwright.config.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // Trusted plain JS/MJS Node scripts (config, fixtures, generators) use Node
    // globals (console, process, Buffer, ...). TS files already disable no-undef
    // (tsc handles undefined refs); apply the same here to avoid false positives.
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      'no-undef': 'off',
    },
  },
);
