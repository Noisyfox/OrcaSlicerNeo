import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  plugins: [react()],
  base: './',
  // The checked-in static profile bundle is host-neutral and is reused by
  // both static hosts; WASM artifact packaging remains Step 5.
  publicDir: root('../../apps/desktop/public'),
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  resolve: { alias: {
    '@': root('../../packages/slicer-app/src'),
    '@orca/slicer-app': root('../../packages/slicer-app/src/index.ts'),
    '@orca/slicer-app-css': root('../../packages/slicer-app/src/index.css'),
    '@orca/slicer-runtime': root('../../packages/slicer-runtime/src/index.ts'),
    '@orca/platform-contract': root('../../packages/platform-contract/src/index.ts'),
    '@slicer/client': root('../../packages/slicer-wasm/src/client/index.ts'),
    '@slicer/testing': root('../../packages/slicer-wasm/src/client/testing/mock-module.ts'),
  } },
});
