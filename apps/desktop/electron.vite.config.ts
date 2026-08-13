import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../../packages/slicer-wasm/src/client', import.meta.url));

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@slicer/client': resolve(clientRoot, 'index.ts'),
        '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
      },
    },
  },
});
