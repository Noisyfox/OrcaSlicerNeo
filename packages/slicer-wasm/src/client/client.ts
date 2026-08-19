// packages/slicer-wasm/src/client/client.ts
// ----------------------------------------------------------------
// The typed promise-based bridge client — the ONLY JS that talks to
// the WASM module (design §Bridge API). Synchronous bridge calls run
// inside the worker; every function returns a promise so the API is
// uniform when wrapped by worker messaging (Task 3).
// ----------------------------------------------------------------
import type {
  OrcaModule, OrcaModuleFactory, SlicerClient,
  InitResult, PresetList, AppConfig, SelectPresetResult,
  OptionMetadata, LoadModelResult,
  ModelMeshResult, SliceResultStatus, ClientSliceResult,
  ExportGcodeResult, CancelResult, ModelObjectBuffer,
  ClientToolpath, ToolpathFeature, ModelTransform,
  ProgressMailbox,
} from './types';
import { writeBytes, callJson, readBytes } from './heap';

export function createClient(
  moduleFactory: OrcaModuleFactory,
  onBridgeProgress?: (percent: number, text: string) => void,
  onProgressMailbox?: (mailbox: ProgressMailbox) => void,
  beforeInit?: (module: OrcaModule) => Promise<void>,
): SlicerClient {
  let modulePromise: Promise<OrcaModule> | null = null;
  const progressListeners = new Set<(percent: number, text: string) => void>();

  async function module(): Promise<OrcaModule> {
    if (!modulePromise) {
      modulePromise = moduleFactory({ noInitialRun: true }).then((m) => {
        // Use the regular JSON bridge decoder instead of ccall('string') so
        // wasm64 and the mock module share the same pointer contract.
        const threading = callJson(m, 'orc_get_threading_info', [], []) as {
          threaded?: boolean;
        };
        if (threading.threaded) {
          const mailbox = callJson(m, 'orc_get_progress_mailbox', [], []) as {
            ok?: boolean; byte_offset?: number; text_capacity?: number;
          };
          const buffer = m.HEAPU8.buffer;
          if (mailbox.ok && buffer instanceof SharedArrayBuffer &&
              Number.isSafeInteger(mailbox.byte_offset) &&
              Number.isSafeInteger(mailbox.text_capacity)) {
            onProgressMailbox?.({
              buffer,
              byteOffset: Number(mailbox.byte_offset),
              textCapacity: Number(mailbox.text_capacity),
            });
          }
          return m;
        }

        // Register the serial progress callback ONCE and never remove it:
        // the bridge's g_progress is a raw fn ptr with no clear path.
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
    async init(appConfig?: AppConfig | null): Promise<InitResult> {
      const m = await module();
      await beforeInit?.(m);
      // M4: the app config (installed-state + selections) is the bridge's
      // source of truth; omitted = fresh config (bridge installs everything).
      // wasm64: every C param must receive a value — passing an empty string
      // for the nullable app_config_json arg, never no args (undefined → BigInt
      // conversion TypeError in the wasm64 wrapper).
      if (appConfig !== undefined && appConfig !== null) {
        return callJson(m, 'orc_init', ['string'], [JSON.stringify(appConfig)]) as InitResult;
      }
      return callJson(m, 'orc_init', ['string'], ['']) as InitResult;
    },

    async setAppConfig(appConfig: AppConfig): Promise<InitResult> {
      const m = await module();
      return callJson(m, 'orc_set_app_config', ['string'], [JSON.stringify(appConfig)]) as InitResult;
    },

    async getAppConfig(): Promise<AppConfig & { ok: boolean; error?: string }> {
      const m = await module();
      return callJson(m, 'orc_get_app_config', [], []) as AppConfig & { ok: boolean; error?: string };
    },

    async getPresets(kind: 'printer' | 'print' | 'filament'): Promise<PresetList> {
      const m = await module();
      return callJson(m, 'orc_get_presets', ['string'], [kind]) as PresetList;
    },

    async selectPreset(kind: 'printer' | 'print' | 'filament', name: string): Promise<SelectPresetResult> {
      const m = await module();
      return callJson(m, 'orc_select_preset', ['string', 'string'], [kind, name]) as SelectPresetResult;
    },

    async getOptionMetadata(): Promise<OptionMetadata> {
      const m = await module();
      return callJson(m, 'orc_get_option_metadata', [], []) as OptionMetadata;
    },

    async addModel(bytes: Uint8Array, ext: string): Promise<LoadModelResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        return callJson(m, 'orc_add_model', ['pointer', 'number', 'string'],
                        [ptr, bytes.length, ext]) as LoadModelResult;
      } finally {
        m._free(ptr);
      }
    },

    async clearModel(): Promise<{ ok: boolean; error?: string }> {
      const m = await module();
      return callJson(m, 'orc_clear_model', [], []) as { ok: boolean; error?: string };
    },

    async setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number) {
      const m = await module();
      return callJson(m, 'orc_set_instance_offset',
                      ['number', 'number', 'number', 'number', 'number'],
                      [objIdx, instIdx, x, y, z]) as { ok: boolean; error?: string };
    },

    async setModelTransform(objIdx, volumeIdx, instIdx, instanceTransform, volumeTransform) {
      const m = await module();
      return callJson(m, 'orc_set_model_transform',
        ['number', 'number', 'number', 'string', 'string'],
        [objIdx, volumeIdx, instIdx, JSON.stringify(instanceTransform), JSON.stringify(volumeTransform)],
      ) as { ok: boolean; error?: string };
    },

    async getModelMesh(): Promise<ModelMeshResult> {
      const m = await module();
      const r = callJson(m, 'orc_get_model_mesh', [], []) as {
        ok: boolean; error?: string; objects?: Array<{
          object_idx: number; volume_idx: number; instance_idx: number;
          vertex_ptr: number; vertex_count: number;
          index_ptr: number; index_count: number; offset: number[];
          instance_transform: ModelTransform; volume_transform: ModelTransform;
        }>;
      };
      if (!r.ok || !r.objects) return r as unknown as ModelMeshResult;
      const objects: ModelObjectBuffer[] = r.objects.map((o) => {
        const positions = new Float32Array(readBytes(m, Number(o.vertex_ptr), o.vertex_count * 3 * 4).buffer);
        const indices = new Uint32Array(readBytes(m, Number(o.index_ptr), o.index_count * 4).buffer);
        return {
          objectIdx: o.object_idx,
          volumeIdx: o.volume_idx,
          instanceIdx: o.instance_idx,
          positions, vertexCount: o.vertex_count,
          indices, indexCount: o.index_count,
          offset: [o.offset[0], o.offset[1], o.offset[2]] as [number, number, number],
          instanceTransform: o.instance_transform,
          volumeTransform: o.volume_transform,
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
      };
      if (!r.ok || !r.toolpath) return r as unknown as ClientSliceResult;

      const t = r.toolpath;
      const toolpath: ClientToolpath = {
        vertexCount: t.vertex_count,
        positions: new Float32Array(readBytes(m, Number(t.vertex_ptr), t.vertex_count * 3 * 4).buffer),
        layers: new Uint32Array(readBytes(m, Number(t.layer_ptr), t.layer_count * 4).buffer),
        features: new Uint32Array(readBytes(m, Number(t.feature_ptr), t.feature_count * 4).buffer),
        palette: t.features,
      };

      return { ok: true, objects: r.objects ?? 0, layers: r.layers ?? 0, toolpath };
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
