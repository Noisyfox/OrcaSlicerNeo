import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../../packages/slicer-wasm/src/client', import.meta.url));
const appRoot = fileURLToPath(new URL('../../packages/slicer-app/src', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../packages/slicer-runtime/src', import.meta.url));
const platformRoot = fileURLToPath(new URL('../../packages/platform-contract/src', import.meta.url));
const printerControlRoot = fileURLToPath(new URL('../../packages/printer-control/src', import.meta.url));

export default defineConfig({
  main: { resolve: { alias: { '@orca/printer-control': resolve(printerControlRoot, 'index.ts') } } },
  preload: { resolve: { alias: { '@orca/printer-control': resolve(printerControlRoot, 'index.ts') } } },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: {
      headers: {
        // Dev counterpart of the prod CSP (main/index.ts): same directives,
        // plus 'unsafe-inline' in script-src for @vitejs/plugin-react-swc's
        // inline react-refresh preamble (no other inline scripts exist). Silences
        // Electron's Insecure-CSP devtools warning in `dev` mode.
        'content-security-policy':
          "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
          // Vite emits the package worker as a data URL in the e2e/mock bundle;
          // keep the allowance scoped to worker-src (never script-src).
          "font-src 'self' data:; connect-src 'self'; worker-src 'self' data:; child-src 'self' data:",
      },
    },
    resolve: {
      alias: {
        '@renderer': appRoot,
        '@': appRoot,
        '@orca/slicer-runtime': resolve(runtimeRoot, 'index.ts'),
        '@orca/platform-contract': resolve(platformRoot, 'index.ts'),
        '@orca/printer-control': resolve(printerControlRoot, 'index.ts'),
        '@slicer/client': resolve(clientRoot, 'index.ts'),
        '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
      },
    },
  },
});
