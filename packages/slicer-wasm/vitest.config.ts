import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'harness/**/*.test.mjs'],
    environment: 'node',
  },
});
