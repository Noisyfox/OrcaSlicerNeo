import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: {
    '@slicer/client': fileURLToPath(new URL('../slicer-wasm/src/client/index.ts', import.meta.url)),
    '@slicer/testing': fileURLToPath(new URL('../slicer-wasm/src/client/testing/mock-module.ts', import.meta.url)),
  } },
});
