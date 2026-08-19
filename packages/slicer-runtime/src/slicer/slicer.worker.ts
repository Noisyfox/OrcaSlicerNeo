// apps/desktop/src/renderer/src/slicer/slicer.worker.ts
// ----------------------------------------------------------------
// Worker entry (bundled by Vite as a module worker). The only file
// in the app that imports the WASM module. VITE_USE_MOCK=1 swaps in
// the bridge-shaped mock so UI dev needs no emsdk build.
// ----------------------------------------------------------------
import { startWorker } from '@slicer/client';
import type { OrcaModuleFactory, OrcaModule } from '@slicer/client';
import { createMockModule } from '@slicer/testing';
import { createFetchProfileSource, installProfiles, resolveModuleAssetUrl, resolveProfileBaseUrl } from '../profiles';

const useMock = import.meta.env.VITE_USE_MOCK === '1';
const mockInstanceCount = Number(import.meta.env.VITE_MOCK_INSTANCE_COUNT ?? 1);
const mockVolumeCount = Number(import.meta.env.VITE_MOCK_VOLUME_COUNT ?? 1);

const factory: OrcaModuleFactory = useMock
  ? async () => createMockModule({ instanceCount: mockInstanceCount, volumeCount: mockVolumeCount })
  : async () => {
      // The worker chunk is emitted below assets/ while the host's static
      // artifact is served from wasm/. Resolving from the module URL keeps
      // both root and subpath deployments portable, including Vite dev.
      const workerUrl = String(import.meta.url);
      // The host deliberately publishes both real wasm64 variants. A Worker
      // inherits the page's isolation state; this keeps the selection tied to
      // the capability actually available to the module, rather than a UI
      // preference or a guessed browser string.
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const artifactDir = isolated ? 'threaded' : 'serial';
      const wasmUrl = resolveModuleAssetUrl(`../wasm/${artifactDir}/orca_slice.js`, workerUrl);
      // Emscripten's scriptDirectory inside a worker derives from the
      // WORKER script's URL (assets/), not the imported module's — so
      // .wasm/.data fetches 404 unless locateFile points at wasm/ (the
      // harness never hits this: Node resolves from the module itself).
      const locateFile = (path: string) => resolveModuleAssetUrl(`../wasm/${artifactDir}/${path}`, workerUrl);
      const mod = (await import(/* @vite-ignore */ wasmUrl)) as {
        default: (opts?: { noInitialRun?: boolean; locateFile?: (path: string) => string }) => OrcaModule;
      };
      return mod.default({ noInitialRun: true, locateFile });
    };

// Profile bytes are fetched and mounted by the Worker before the first bridge
// init. They never cross preload/IPC and remain relative to host deployment.
const profileSource = createFetchProfileSource(
  resolveProfileBaseUrl(import.meta.env.BASE_URL, String(import.meta.url)),
);
startWorker(factory, undefined, undefined, async (module) => {
  if (useMock) return;
  await installProfiles(module, profileSource);
});
