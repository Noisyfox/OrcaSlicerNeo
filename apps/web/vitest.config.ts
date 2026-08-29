import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const appRoot = fileURLToPath(new URL('../../packages/slicer-app/src', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../packages/slicer-runtime/src', import.meta.url));
const platformRoot = fileURLToPath(new URL('../../packages/platform-contract/src', import.meta.url));
const printerRoot = fileURLToPath(new URL('../../packages/printer-control/src', import.meta.url));
const clientRoot = fileURLToPath(new URL('../../packages/slicer-wasm/src/client', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    '@': appRoot,
    '@orca/slicer-runtime': resolve(runtimeRoot, 'index.ts'),
    '@orca/platform-contract': resolve(platformRoot, 'index.ts'),
    '@orca/printer-control': resolve(printerRoot, 'index.ts'),
    '@slicer/client': resolve(clientRoot, 'index.ts'),
    '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
  } },
  test: { environment: 'jsdom', passWithNoTests: true },
});
