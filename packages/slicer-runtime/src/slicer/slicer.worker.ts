// packages/slicer-runtime/src/slicer/slicer.worker.ts
// ----------------------------------------------------------------
// Worker entry (bundled by Vite as a module worker). The only file
// in the app that imports the WASM module. VITE_USE_MOCK=1 swaps in
// the bridge-shaped mock so UI dev needs no emsdk build.
// ----------------------------------------------------------------
import { startWorker } from '@slicer/client';
import type { OrcaModuleFactory, OrcaModule } from '@slicer/client';
import { createMockModule } from '@slicer/testing';
import { createFetchProfileSource, installProfiles, resolveDeploymentBase, resolveProfileBaseUrl } from '../profiles';
import { loadWasmArtifact, type WasmArtifactVariant } from './wasm-artifact';

const useMock = import.meta.env.VITE_USE_MOCK === '1';
const mockInstanceCount = Number(import.meta.env.VITE_MOCK_INSTANCE_COUNT ?? 1);
const mockVolumeCount = Number(import.meta.env.VITE_MOCK_VOLUME_COUNT ?? 1);
const mockPresetTransitionDelayMs = Math.max(0, Number(import.meta.env.VITE_MOCK_PRESET_TRANSITION_DELAY_MS ?? 0) || 0);
const mockPrimeTowerFixture = import.meta.env.VITE_MOCK_PRIME_TOWER === '1';
const mockPrimeTowerWarnings = import.meta.env.VITE_MOCK_PRIME_TOWER_WARNINGS === '1';

// The WASM module's boost::log severity filter is read from
// globalThis.ORCA_LOG_LEVEL at orc_init (client forwards it; default "info").
// Seed the worker-scope global from the env so a dev can set
// VITE_LOG_LEVEL=debug without touching the DevTools worker console.
// See doc/2026-08-21-wasm-boost-log.md.
const envLogLevel = import.meta.env.VITE_LOG_LEVEL as string | undefined;
if (envLogLevel) {
  (globalThis as { ORCA_LOG_LEVEL?: string }).ORCA_LOG_LEVEL = envLogLevel;
}

const factory: OrcaModuleFactory = useMock
  ? async () => createMockModule({ instanceCount: mockInstanceCount, volumeCount: mockVolumeCount, primeTowerFixture: mockPrimeTowerFixture,
    sliceWarnings: mockPrimeTowerWarnings ? [
      'Prime Tower intersects an exclusion area.', 'Prime Tower is outside the printable area.',
    ] : undefined })
  : async () => {
      // The worker chunk is emitted below assets/ while the host's static
      // artifact is served from wasm/. Resolving against the deployment base
      // derived from BASE_URL keeps root, subpath, and Vite dev layouts
      // portable: dev serves the shared package worker chunk from
      // /@fs/<package>/ outside the app root, so module-relative resolution
      // cannot reach the host's public dir — the absolute base anchors at the
      // server root instead (and stays absolute, which also lets vite's
      // import-analysis ?import rewrite pass the dynamic import through
      // untouched; see doc/2026-08-15-vite-public-module-worker-import.md).
      const workerUrl = String(import.meta.url);
      // The host deliberately publishes both real wasm64 variants. A Worker
      // inherits the page's isolation state; this keeps the selection tied to
      // the capability actually available to the module, rather than a UI
      // preference or a guessed browser string.
      const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
        && typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object';
      const artifactDir: WasmArtifactVariant = isolated ? 'threaded' : 'serial';
      const wasmBase = resolveDeploymentBase(import.meta.env.BASE_URL, workerUrl);
      const load = async (variant: WasmArtifactVariant): Promise<OrcaModule> => {
        const wasmUrl = new URL(`wasm/${variant}/orca_slice.js`, wasmBase).href;
        // Emscripten's scriptDirectory inside a worker derives from the
        // WORKER script's URL (assets/), not the imported module's — so
        // .wasm/.data fetches 404 unless locateFile points at wasm/ (the
        // harness never hits this: Node resolves from the module itself).
        const locateFile = (path: string) => new URL(`wasm/${variant}/${path}`, wasmBase).href;
        const mod = (await import(/* @vite-ignore */ wasmUrl)) as {
          default: (opts?: { noInitialRun?: boolean; locateFile?: (path: string) => string }) => OrcaModule;
        };
        return mod.default({ noInitialRun: true, locateFile });
      };
      const loaded = await loadWasmArtifact(artifactDir, load, (error) => {
        console.warn('[slicer] threaded WASM failed to start; falling back to serial', error);
      });
      return loaded.module;
    };

// Profile bytes are fetched and mounted by the Worker before the first bridge
// init. They never cross preload/IPC and remain relative to host deployment.
const profileSource = createFetchProfileSource(
  resolveProfileBaseUrl(import.meta.env.BASE_URL, String(import.meta.url)),
);
startWorker(factory, undefined, undefined, async (module) => {
  if (useMock) return;
  await installProfiles(module, profileSource);
}, useMock && mockPresetTransitionDelayMs > 0 ? async (op) => {
  // E2E-only fixture support: production builds never set this mock env var.
  // Delaying just the bridge response makes the UI's stale-picker lock
  // observable without changing any application compatibility behaviour.
  if (op === 'selectProfile') {
    await new Promise<void>((resolve) => setTimeout(resolve, mockPresetTransitionDelayMs));
  }
} : undefined);
