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
      const wasmUrl = '/wasm/orca_slice.js';
      const mod = (await import(/* @vite-ignore */ wasmUrl)) as {
        default: (opts?: { noInitialRun?: boolean }) => OrcaModule;
      };
      return mod.default({ noInitialRun: true });
    };

startWorker(factory);
