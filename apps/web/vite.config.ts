import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const root = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Emscripten's shared loader also contains a Node smoke-test branch. The
// browser artifact must not retain Node API imports: the branch is dead in
// a browser, but static hosts must be safe to audit and deploy as web-only.
function webOnlyWasmLoader() {
  return {
    name: 'web-only-wasm-loader',
    closeBundle: async () => {
      const wasmRoot = root('../../apps/web/dist/wasm');
      for (const variant of ['', 'threaded', 'serial']) {
        const file = `${wasmRoot}/${variant ? `${variant}/` : ''}orca_slice.js`;
        try {
          let source = await readFile(file, 'utf8');
          source = source.replace(/node:(module|worker_threads|fs|path|url|util)/g, 'web-only-disabled:$1');
          source = source.replace(/globalThis\.process/g, 'undefined');
          await writeFile(file, source);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    },
  };
}

export default defineConfig({
  // Tailwind must be compiled in every host — without a plugin the shared
  // index.css' @theme/@apply/@utility directives pass through unprocessed
  // and no utility classes are generated (2026-08-20). The desktop host
  // registers the same plugin in electron.vite.config.ts (2026-08-21).
  plugins: [react(), tailwindcss(), webOnlyWasmLoader()],
  base: './',
  // The checked-in static profile bundle is host-neutral and is reused by
  // both static hosts; WASM artifact packaging remains Step 5.
  publicDir: root('../../apps/desktop/src/renderer/public'),
  // The normal server/preview is isolated. Web E2E deliberately sets
  // ORCA_WEB_NO_ISOLATION=1 to exercise the real serial artifact.
  server: { headers: isolationHeaders() },
  preview: { headers: isolationHeaders() },
  resolve: { alias: {
    '@': root('../../packages/slicer-app/src'),
    '@orca/slicer-runtime': root('../../packages/slicer-runtime/src/index.ts'),
    '@orca/platform-contract': root('../../packages/platform-contract/src/index.ts'),
    '@slicer/client': root('../../packages/slicer-wasm/src/client/index.ts'),
    '@slicer/testing': root('../../packages/slicer-wasm/src/client/testing/mock-module.ts'),
  } },
});

function isolationHeaders(): Record<string, string> {
  return process.env.ORCA_WEB_NO_ISOLATION === '1' ? {} : {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
}
