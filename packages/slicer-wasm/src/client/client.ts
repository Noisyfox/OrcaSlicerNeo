// packages/slicer-wasm/src/client/client.ts
// ----------------------------------------------------------------
// The typed promise-based bridge client — the ONLY JS that talks to
// the WASM module (design §Bridge API). Synchronous bridge calls run
// inside the worker; every function returns a promise so the API is
// uniform when wrapped by worker messaging (Task 3).
// ----------------------------------------------------------------
import type {
  OrcaModule, OrcaModuleFactory, SlicerClient,
  InitResult, PresetList, SelectPresetResult,
  OptionMetadata, LoadModelResult,
  ModelMeshResult, SliceResultStatus, ClientSliceResult,
  ExportGcodeResult, CancelResult, ModelObjectBuffer, DeleteObjectsResult,
  DeleteVolumesResult, CloneObjectsResult, ReorderStructureResult,
  ModelStructureResult, MutationResult, SplitVolumeResult, SplitObjectResult,
  MergeObjectsResult, SeparateInstancesResult, AddInstanceResult, RemoveInstanceResult, VolumeType,
  ClientToolpath, ToolpathFeature, ModelTransform,
  ProgressMailbox, ReadLogResult,
} from './types';
import { writeBytes, callJson, readBytes } from './heap';

export function createClient(
  moduleFactory: OrcaModuleFactory,
  onBridgeProgress?: (percent: number, text: string) => void,
  onProgressMailbox?: (mailbox: ProgressMailbox) => void,
  beforeInit?: (module: OrcaModule) => Promise<void>,
): SlicerClient {
  let modulePromise: Promise<OrcaModule> | null = null;
  // beforeInit (profile installation in the worker) runs once per client:
  // React StrictMode double-mounts the boot effect in dev, sending init
  // twice — the second call must not re-fetch/re-install profiles. A rejected
  // install clears the memo so a later init can retry.
  let beforeInitPromise: Promise<void> | null = null;
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
    async init(): Promise<InitResult> {
      const m = await module();
      if (!beforeInitPromise) {
        if (beforeInit) {
          beforeInitPromise = beforeInit(m);
          try {
            await beforeInitPromise;
          } catch (error) {
            beforeInitPromise = null;
            throw error;
          }
        } else {
          beforeInitPromise = Promise.resolve();
        }
      }
      await beforeInitPromise;
      // The orc_init JSON is the options payload: the bridge reads "log_level"
      // from it to set the boost::log severity filter (default info when
      // unset). The value comes from the global JS variable in the module's
      // worker scope — see doc/2026-08-21-wasm-boost-log.md. wasm64: every C
      // param must receive a value; the string always exists (possibly "{}").
      const opts = {
        log_level: (globalThis as { ORCA_LOG_LEVEL?: unknown }).ORCA_LOG_LEVEL,
      };
      return callJson(m, 'orc_init', ['string'], [JSON.stringify(opts)]) as InitResult;
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

    async addShape(type: string, name?: string): Promise<LoadModelResult> {
      const m = await module();
      return callJson(m, 'orc_add_shape', ['string', 'string'],
                      [type, name ?? '']) as LoadModelResult;
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

    async getModelStructure(): Promise<ModelStructureResult> {
      const m = await module();
      return callJson(m, 'orc_get_model_structure', [], []) as ModelStructureResult;
    },

    async deleteObjects(objectIds: number[]): Promise<DeleteObjectsResult> {
      const m = await module();
      return callJson(m, 'orc_delete_objects', ['string'],
                      [JSON.stringify(objectIds)]) as DeleteObjectsResult;
    },

    async deleteVolumes(volumeIds: number[]): Promise<DeleteVolumesResult> {
      const m = await module();
      return callJson(m, 'orc_delete_volumes', ['string'],
                      [JSON.stringify(volumeIds)]) as DeleteVolumesResult;
    },

    async cloneObjects(objectIds: number[]): Promise<CloneObjectsResult> {
      const m = await module();
      return callJson(m, 'orc_clone_objects', ['string'],
                      [JSON.stringify(objectIds)]) as CloneObjectsResult;
    },

    async reorderObjects(fromObjectId: number, toIndex: number): Promise<ReorderStructureResult> {
      const m = await module();
      return callJson(m, 'orc_reorder_objects', ['number', 'number'],
                      [fromObjectId, toIndex]) as ReorderStructureResult;
    },

    async reorderVolumes(objectId: number, fromVolumeId: number, toIndex: number): Promise<ReorderStructureResult> {
      const m = await module();
      return callJson(m, 'orc_reorder_volumes', ['number', 'number', 'number'],
                      [objectId, fromVolumeId, toIndex]) as ReorderStructureResult;
    },

    async splitVolumeToParts(volumeId: number, maxExtruders = 1, remapPaint = false): Promise<SplitVolumeResult> {
      const m = await module();
      return callJson(m, 'orc_split_volume_to_parts', ['number', 'number', 'number'],
                      [volumeId, maxExtruders, remapPaint ? 1 : 0]) as SplitVolumeResult;
    },

    async splitObjectToObjects(objectId: number, autoDrop = false): Promise<SplitObjectResult> {
      const m = await module();
      return callJson(m, 'orc_split_object_to_objects', ['number', 'number'],
                      [objectId, autoDrop ? 1 : 0]) as SplitObjectResult;
    },

    async mergeObjectsToMultipart(objectIds: number[], name: string): Promise<MergeObjectsResult> {
      const m = await module();
      return callJson(m, 'orc_merge_objects_to_multipart', ['string', 'string'],
                      [JSON.stringify(objectIds), name]) as MergeObjectsResult;
    },

    async separateInstances(objectId: number, instanceIds: number[]): Promise<SeparateInstancesResult> {
      const m = await module();
      return callJson(m, 'orc_instances_to_separate_objects', ['number', 'string'],
                      [objectId, JSON.stringify(instanceIds)]) as SeparateInstancesResult;
    },

    async addInstance(objectId: number): Promise<AddInstanceResult> {
      const m = await module();
      return callJson(m, 'orc_add_instance', ['number'], [objectId]) as AddInstanceResult;
    },

    async removeInstance(objectId: number, instanceId: number): Promise<RemoveInstanceResult> {
      const m = await module();
      return callJson(m, 'orc_remove_instance', ['number', 'number'],
                      [objectId, instanceId]) as RemoveInstanceResult;
    },

    async renameObject(objectId: number, name: string): Promise<MutationResult> {
      const m = await module();
      return callJson(m, 'orc_rename_object', ['number', 'string'],
                      [objectId, name]) as MutationResult;
    },

    async renameVolume(volumeId: number, name: string): Promise<MutationResult> {
      const m = await module();
      return callJson(m, 'orc_rename_volume', ['number', 'string'],
                      [volumeId, name]) as MutationResult;
    },

    async setVolumeType(volumeId: number, type: VolumeType): Promise<MutationResult> {
      const m = await module();
      return callJson(m, 'orc_set_volume_type', ['number', 'string'],
                      [volumeId, type]) as MutationResult;
    },

    async setObjectPrintable(objectId: number, printable: boolean): Promise<MutationResult> {
      const m = await module();
      return callJson(m, 'orc_set_object_printable', ['number', 'number'],
                      [objectId, printable ? 1 : 0]) as MutationResult;
    },

    async setInstancePrintable(instanceId: number, printable: boolean): Promise<MutationResult> {
      const m = await module();
      return callJson(m, 'orc_set_instance_printable', ['number', 'number'],
                      [instanceId, printable ? 1 : 0]) as MutationResult;
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

    async readLog(): Promise<ReadLogResult> {
      const m = await module();
      try {
        const bytes = m.FS.readFile('/tmp/orca.log');
        return { ok: true, path: '/tmp/orca.log', bytes };
      } catch (error) {
        // No log file yet (nothing was logged at or above the filter level,
        // or init never ran) — report it, not throw.
        return { ok: false, path: '/tmp/orca.log', bytes: new Uint8Array(0), error: String(error) };
      }
    },

    async cancel(): Promise<CancelResult> {
      const m = await module();
      return callJson(m, 'orc_cancel', [], []) as CancelResult;
    },
  };
}
