// packages/slicer-wasm/src/client/client.ts
// ----------------------------------------------------------------
// The typed promise-based bridge client — the ONLY JS that talks to
// the WASM module (design §Bridge API). Synchronous bridge calls run
// inside the worker; every function returns a promise so the API is
// uniform when wrapped by worker messaging (Task 3).
// ----------------------------------------------------------------
import type {
  OrcaModule, OrcaModuleFactory, SlicerClient,
  InitResult, PresetList, OptionMetadata, LoadModelResult,
  ModelMeshResult, SliceResultStatus, ClientSliceResult,
  ExportGcodeResult, CancelResult, ModelObjectBuffer,
  ClientToolpath, ClientSlicedMesh, ToolpathFeature,
} from './types';
import { writeBytes, callJson, readBytes } from './heap';

export function createClient(
  moduleFactory: OrcaModuleFactory,
  onBridgeProgress?: (percent: number, text: string) => void,
): SlicerClient {
  let modulePromise: Promise<OrcaModule> | null = null;
  const progressListeners = new Set<(percent: number, text: string) => void>();

  async function module(): Promise<OrcaModule> {
    if (!modulePromise) {
      modulePromise = moduleFactory({ noInitialRun: true }).then((m) => {
        // Register the progress callback ONCE at module init and NEVER
        // removeFunction it (stale-slot trap discipline, bridge-smoke Fix
        // round 1): the bridge's g_progress is a raw fn ptr with no orc_*
        // clear path; a removed slot re-used by a later slice traps the
        // whole module. The bridge calls it only while slicing; the sink
        // (the worker's progress-message post) lets the bridge-level stream
        // escape this module.
        const cb = m.addFunction((pct: unknown, text: unknown) => {
          const msg = m.UTF8ToString(Number(text));
          for (const l of progressListeners) l(Number(pct), msg);
          onBridgeProgress?.(Number(pct), msg);
        }, 'vij');
        m.ccall('orc_set_progress_callback', 'void', ['pointer'], [cb]);
        return m;
      });
    }
    return modulePromise;
  }

  return {
    async init(): Promise<InitResult> {
      const m = await module();
      return callJson(m, 'orc_init', [], []) as InitResult;
    },

    async getPresets(kind: 'printer' | 'print' | 'filament'): Promise<PresetList> {
      const m = await module();
      return callJson(m, 'orc_get_presets', ['string'], [kind]) as PresetList;
    },

    async getOptionMetadata(): Promise<OptionMetadata> {
      const m = await module();
      return callJson(m, 'orc_get_option_metadata', [], []) as OptionMetadata;
    },

    async loadModel(bytes: Uint8Array, ext: string): Promise<LoadModelResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        return callJson(m, 'orc_load_model', ['pointer', 'number', 'string'],
                        [ptr, bytes.length, ext]) as LoadModelResult;
      } finally {
        m._free(ptr);
      }
    },

    async setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number) {
      const m = await module();
      return callJson(m, 'orc_set_instance_offset',
                      ['number', 'number', 'number', 'number', 'number'],
                      [objIdx, instIdx, x, y, z]) as { ok: boolean; error?: string };
    },

    async getModelMesh(): Promise<ModelMeshResult> {
      const m = await module();
      const r = callJson(m, 'orc_get_model_mesh', [], []) as {
        ok: boolean; error?: string; objects?: Array<{
          object_idx: number; vertex_ptr: number; vertex_count: number;
          index_ptr: number; index_count: number; offset: number[];
        }>;
      };
      if (!r.ok || !r.objects) return r as unknown as ModelMeshResult;
      const objects: ModelObjectBuffer[] = r.objects.map((o) => {
        const positions = new Float32Array(readBytes(m, Number(o.vertex_ptr), o.vertex_count * 3 * 4).buffer);
        const indices = new Uint32Array(readBytes(m, Number(o.index_ptr), o.index_count * 4).buffer);
        return {
          objectIdx: o.object_idx,
          positions, vertexCount: o.vertex_count,
          indices, indexCount: o.index_count,
          offset: [o.offset[0], o.offset[1], o.offset[2]] as [number, number, number],
        };
      });
      return { ok: true, objects };
    },

    async slice(config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus> {
      const m = await module();
      // The bridge callback was registered at module init (module()) — the
      // bridge's g_progress persists across calls, so every slice reports
      // progress even with no listener attached; here we just subscribe.
      if (onProgress) progressListeners.add(onProgress);
      try {
        return callJson(m, 'orc_slice', ['string'], [JSON.stringify(config)]) as SliceResultStatus;
      } finally {
        if (onProgress) progressListeners.delete(onProgress);
      }
    },

    async getSliceResult(): Promise<ClientSliceResult> {
      const m = await module();
      const r = callJson(m, 'orc_get_slice_result', [], []) as {
        ok: boolean; error?: string; objects?: number; layers?: number;
        toolpath?: {
          vertex_ptr: number; vertex_count: number;
          layer_ptr: number; layer_count: number;
          feature_ptr: number; feature_count: number;
          features: ToolpathFeature[];
        };
        mesh?: {
          vertex_ptr: number; vertex_count: number;
          index_ptr: number; index_count: number;
          layer_ptr: number; layer_count: number;
        };
      };
      if (!r.ok || !r.toolpath || !r.mesh) return r as unknown as ClientSliceResult;

      const t = r.toolpath;
      const toolpath: ClientToolpath = {
        vertexCount: t.vertex_count,
        positions: new Float32Array(readBytes(m, Number(t.vertex_ptr), t.vertex_count * 3 * 4).buffer),
        layers: new Uint32Array(readBytes(m, Number(t.layer_ptr), t.layer_count * 4).buffer),
        features: new Uint32Array(readBytes(m, Number(t.feature_ptr), t.feature_count * 4).buffer),
        palette: t.features,
      };

      const s = r.mesh;
      const mesh: ClientSlicedMesh = {
        vertexCount: s.vertex_count,
        positions: new Float32Array(readBytes(m, Number(s.vertex_ptr), s.vertex_count * 3 * 4).buffer),
        indices: new Uint32Array(readBytes(m, Number(s.index_ptr), s.index_count * 4).buffer),
        indexCount: s.index_count,
        layerRanges: new Uint32Array(readBytes(m, Number(s.layer_ptr), s.layer_count * 4).buffer),
      };

      return { ok: true, objects: r.objects ?? 0, layers: r.layers ?? 0, toolpath, mesh };
    },

    async exportGcode(): Promise<ExportGcodeResult> {
      const m = await module();
      const r = callJson(m, 'orc_export_gcode', [], []) as { ok: boolean; path?: string; error?: string };
      if (!r.ok) return r as ExportGcodeResult;
      const bytes = m.FS.readFile('/out.gcode');
      return { ok: true, path: r.path ?? '/out.gcode', bytes };
    },

    async cancel(): Promise<CancelResult> {
      const m = await module();
      return callJson(m, 'orc_cancel', [], []) as CancelResult;
    },
  };
}
