import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/eval/**/*.eval.ts'], testTimeout: 1_800_000 },
});
