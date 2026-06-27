import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
      'next-env.d.ts',
      'src/generated/**',
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
      // false-positives on globals like `process`/`fetch` in .ts/.tsx files.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.config.{js,ts,mjs,cts}', 'playwright.config.ts', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
