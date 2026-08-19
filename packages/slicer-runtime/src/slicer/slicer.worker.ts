// apps/desktop/src/renderer/src/slicer/slicer.worker.ts
// ----------------------------------------------------------------
// Worker entry (bundled by Vite as a module worker). The only file
// in the app that imports the WASM module. VITE_USE_MOCK=1 swaps in
// the bridge-shaped mock so UI dev needs no emsdk build.
// ----------------------------------------------------------------
import { startWorker } from '@slicer/client';
import type { OrcaModuleFactory, OrcaModule } from '@slicer/client';
import { createMockModule } from '@slicer/testing';
import { createFetchProfileSource, installProfiles } from '../profiles';

const useMock = import.meta.env.VITE_USE_MOCK === '1';
const mockInstanceCount = Number(import.meta.env.VITE_MOCK_INSTANCE_COUNT ?? 1);
const mockVolumeCount = Number(import.meta.env.VITE_MOCK_VOLUME_COUNT ?? 1);

const factory: OrcaModuleFactory = useMock
  ? async () => createMockModule({ instanceCount: mockInstanceCount, volumeCount: mockVolumeCount })
  : async () => {
      // dev: Vite serves the renderer public/ dir at '/' — the staged module
      // lives at public/wasm/orca_slice.js. prod: main serves out/renderer
      // over http://127.0.0.1:<port> (doc/2026-08-14-http-origin-for-workers
      // .md — the app:// scheme died with out-of-process workers), and the
      // worker chunk sits in out/renderer/assets/, so the relative specifier
      // '../wasm/orca_slice.js' resolves against the chunk URL →
      // /wasm/orca_slice.js.
      //
      // The dev specifier MUST be absolute (new URL + import.meta.url):
      // vite's import-analysis rewrites every variable dynamic import into
      // __vite__injectQuery(url, 'import') — the /* @vite-ignore */ comment
      // only silences the "cannot be analyzed" warning, it does not prevent
      // the rewrite. On a relative URL that appends ?import at runtime, and
      // the public middleware forwards ?import requests to the transform
      // pipeline, which refuses files in /public (500 ERR_LOAD_PUBLIC_URL:
      // "should not be imported from source code"). injectQuery passes
      // absolute URLs through untouched, so the worker imports the public
      // file as a plain module (static 200). A literal '/wasm/...' specifier
      // is dead too — import-analysis throws on literal imports of public
      // JS outright.
      const wasmUrl = import.meta.env.PROD
        ? '../wasm/orca_slice.js'
        : new URL('/wasm/orca_slice.js', import.meta.url).href;
      // Emscripten's scriptDirectory inside a worker derives from the
      // WORKER script's URL (assets/), not the imported module's — so
      // .wasm/.data fetches 404 unless locateFile points at wasm/ (the
      // harness never hits this: Node resolves from the module itself).
      const locateFile = import.meta.env.PROD
        ? (path: string) => `../wasm/${path}`
        : (path: string) => `/wasm/${path}`;
      const mod = (await import(/* @vite-ignore */ wasmUrl)) as {
        default: (opts?: { noInitialRun?: boolean; locateFile?: (path: string) => string }) => OrcaModule;
      };
      return mod.default({ noInitialRun: true, locateFile });
    };

// Profile bytes are fetched and mounted by the Worker before the first bridge
// init. They never cross preload/IPC and remain relative to host deployment.
const profileSource = createFetchProfileSource(
  import.meta.env.PROD ? new URL('../profiles/', import.meta.url) : new URL('/profiles/', import.meta.url),
);
startWorker(factory, undefined, undefined, async (module) => {
  if (useMock) return;
  await installProfiles(module, profileSource);
});
