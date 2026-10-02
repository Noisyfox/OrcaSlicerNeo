import { mountNativeTemporaryDirectory, startWorker } from '@slicer/client';
import type { OrcaModuleFactory, OrcaModule } from '@slicer/client';
import { createMockModule } from '@slicer/testing';
import { installProfiles, type ProfileSource } from '../profiles';
import type { WorkerMessage } from '@slicer/client';
import { loadWasmArtifact, type WasmArtifactVariant } from './wasm-artifact';

const useMock = import.meta.env.VITE_USE_MOCK === '1';
const mockInstanceCount = Number(import.meta.env.VITE_MOCK_INSTANCE_COUNT ?? 1);
const mockVolumeCount = Number(import.meta.env.VITE_MOCK_VOLUME_COUNT ?? 1);
const mockPresetTransitionDelayMs = Math.max(0, Number(import.meta.env.VITE_MOCK_PRESET_TRANSITION_DELAY_MS ?? 0) || 0);
const mockPrimeTowerFixture = import.meta.env.VITE_MOCK_PRIME_TOWER === '1';
const mockPaintedFacetFixture = import.meta.env.VITE_MOCK_PAINTED_FACET_FIXTURE === '1';
const mockPrimeTowerWarnings = import.meta.env.VITE_MOCK_PRIME_TOWER_WARNINGS === '1';
const realProjectProfileBuild = import.meta.env.VITE_REAL_PROJECT_PROFILE === '1';

// The WASM module's boost::log severity filter is read from
// globalThis.ORCA_LOG_LEVEL at orc_init (client forwards it; default "info").
// Seed the worker-scope global from the env so a dev can set
// VITE_LOG_LEVEL=debug without touching the DevTools worker console.
// See doc/2026-08-21-wasm-boost-log.md.
const envLogLevel = import.meta.env.VITE_LOG_LEVEL as string | undefined;
if (envLogLevel) {
  (globalThis as { ORCA_LOG_LEVEL?: string }).ORCA_LOG_LEVEL = envLogLevel;
}

export interface SlicerWorkerHost {
  threaded: boolean;
  /** Trusted host setup; never supplied by renderer requests. Serial uses MEMFS. */
  nativeTemporaryDirectory?: string;
  load(variant: WasmArtifactVariant | 'profile-threaded'): Promise<OrcaModule>;
  profiles: ProfileSource;
  post(message: WorkerMessage, transfer?: Transferable[]): void;
  onMessage(listener: (message: WorkerMessage) => void): void;
}

export function startSlicerHost(host: SlicerWorkerHost): void {
  const prepareModule = (module: OrcaModule, variant: WasmArtifactVariant | 'profile-threaded') => {
    if (variant !== 'serial' && host.nativeTemporaryDirectory) {
      mountNativeTemporaryDirectory(module, host.nativeTemporaryDirectory);
    }
    return module;
  };
  const factory: OrcaModuleFactory = useMock
    ? async () => createMockModule({ instanceCount: mockInstanceCount, volumeCount: mockVolumeCount, primeTowerFixture: mockPrimeTowerFixture,
      paintedFacetFixture: mockPaintedFacetFixture,
      sliceWarnings: mockPrimeTowerWarnings ? [
        'Prime Tower intersects an exclusion area.', 'Prime Tower is outside the printable area.',
      ] : undefined })
    : async () => {
        const threaded = host.threaded;
        const load = host.load;
        if (realProjectProfileBuild) {
          if (!threaded) throw new Error('the real-project profile requires the visible threaded Electron runtime');
          return prepareModule(await load('profile-threaded'), 'profile-threaded');
        }
        const gateVariant = import.meta.env.VITE_SCOPED_CONFIGURATION_GATE === '1'
          ? import.meta.env.VITE_SCOPED_CONFIGURATION_GATE_VARIANT : undefined;
        if (gateVariant === 'threaded' && !threaded) throw new Error('threaded release gate requires threading support');
        const loaded = await loadWasmArtifact(gateVariant === 'serial' ? 'serial' : threaded ? 'threaded' : 'serial', load, (error) => {
          if (gateVariant === 'threaded') throw error;
          console.warn('[slicer] threaded WASM failed to start; falling back to serial', error);
        });
        return prepareModule(loaded.module, loaded.variant);
      };

  startWorker(factory, host.post, host.onMessage, async (module) => {
    if (useMock) return;
    await installProfiles(module, host.profiles, undefined, ({ index, total }) => {
      host.post({ type: 'startup-progress', text: `Downloading profiles (${index + 1}/${total})...` });
    });
  }, useMock && mockPresetTransitionDelayMs > 0 ? async (op) => {
    // E2E-only fixture support: production builds never set this mock env var.
    // Delaying just the bridge response makes the UI's stale-picker lock
    // observable without changing any application compatibility behaviour.
    if (op === 'selectProfile' || op === 'selectPrinterWithRememberedRack') {
      await new Promise<void>((resolve) => setTimeout(resolve, mockPresetTransitionDelayMs));
    }
  } : undefined);
}
