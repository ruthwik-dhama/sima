import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.output/**',
      '**/.output-e2e/**',
      '**/.wxt/**',
      '**/node_modules/**',
      'playground/**',
      'test-results/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
);
