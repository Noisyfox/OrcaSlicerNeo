import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname is undefined in ESM configs — derive the client package root
// from the config file's own URL (apps/desktop/ → ../../packages/...).
const clientRoot = fileURLToPath(new URL('../../packages/slicer-wasm/src/client', import.meta.url));
const appRoot = fileURLToPath(new URL('../../packages/slicer-app/src', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../packages/slicer-runtime/src', import.meta.url));
const platformRoot = fileURLToPath(new URL('../../packages/platform-contract/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // same aliases as electron.vite.config.ts (Task 4)
      '@': appRoot,
      '@orca/slicer-app': resolve(appRoot, 'index.ts'),
      '@orca/slicer-runtime': resolve(runtimeRoot, 'index.ts'),
      '@orca/platform-contract': resolve(platformRoot, 'index.ts'),
      '@slicer/client': resolve(clientRoot, 'index.ts'),
      '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
    },
  },
  test: {
    include: ['src/renderer/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
