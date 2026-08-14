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
    server: {
      headers: {
        // Dev counterpart of the prod CSP (main/index.ts): same directives,
        // plus 'unsafe-inline' in script-src for @vitejs/plugin-react's inline
        // react-refresh preamble (no other inline scripts exist). Silences
        // Electron's Insecure-CSP devtools warning in `dev` mode.
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          "font-src 'self' data:; connect-src 'self'; worker-src 'self'",
      },
    },
    resolve: {
      alias: {
        '@slicer/client': resolve(clientRoot, 'index.ts'),
        '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
      },
    },
  },
});
