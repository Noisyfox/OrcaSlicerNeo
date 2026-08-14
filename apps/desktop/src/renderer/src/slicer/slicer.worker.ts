// apps/desktop/src/renderer/src/slicer/slicer.worker.ts
// ----------------------------------------------------------------
// Worker entry (bundled by Vite as a module worker). The only file
// in the app that imports the WASM module. VITE_USE_MOCK=1 swaps in
// the bridge-shaped mock so UI dev needs no emsdk build.
// ----------------------------------------------------------------
import { startWorker } from '@slicer/client';
import type { OrcaModuleFactory, OrcaModule } from '@slicer/client';
import { createMockModule } from '@slicer/testing';

const useMock = import.meta.env.VITE_USE_MOCK === '1';

const factory: OrcaModuleFactory = useMock
  ? async () => createMockModule()
  : async () => {
      // dev: Vite serves the renderer public/ dir at '/' — the staged module
      // lives at public/wasm/orca_slice.js. prod: main serves out/renderer
      // over http://127.0.0.1:<port> (doc/2026-08-14-http-origin-for-workers
      // .md — the app:// scheme died with out-of-process workers), and the
      // worker chunk sits in out/renderer/assets/, so the relative specifier
      // '../wasm/orca_slice.js' resolves against the chunk URL →
      // /wasm/orca_slice.js. (Emscripten loads orca_slice.wasm/.data relative
      // to the module script, which is that same dir — no locateFile
      // override needed.)
      const wasmUrl = import.meta.env.PROD
        ? '../wasm/orca_slice.js'
        : '/wasm/orca_slice.js';
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

startWorker(factory);
