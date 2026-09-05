// packages/slicer-wasm/src/client/client.ts
// ----------------------------------------------------------------
// The typed promise-based bridge client — the ONLY JS that talks to
// the WASM module (design §Bridge API). Synchronous bridge calls run
// inside the worker; every function returns a promise so the API is
// uniform when wrapped by worker messaging (Task 3).
// ----------------------------------------------------------------
import type {
  OrcaModule, OrcaModuleFactory, SlicerClient,
  InitResult, PresetSnapshotResult,
  PlateSessionPlate, PlateSessionSnapshotResult,
  OptionMetadata, LoadModelResult, ProjectLoadMode, ProjectLoadResult,
  ModelMeshResult, SliceResultStatus, ClientSliceResult,
  ExportGcodeResult, ExportProjectResult, CancelResult, ModelObjectBuffer, DeleteObjectsResult,
  DeleteVolumesResult, CloneObjectsResult, ReorderStructureResult,
  ModelStructureResult, MutationResult, SplitVolumeResult, SplitObjectResult,
  MergeObjectsResult, SeparateInstancesResult, AddInstanceResult, RemoveInstanceResult, VolumeType,
  ClientToolpath, ToolpathFeature, ModelTransform,
  ProgressMailbox, ReadLogResult, PreviewMetadata, PreviewToolpathMetrics,
  PreviewAnalysis, PreviewMetricKey,
  PreviewTextChunk, PreviewTextChunkRequest,
  PreviewTextLines, PreviewTextLinesRequest,
} from './types';
import { PREVIEW_TEXT_CHUNK_MAX_BYTES, PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES, PREVIEW_TEXT_LINES_MAX } from './types';
import { writeBytes, callJson, readBytes } from './heap';

function normalizePlateSessionResult(raw: unknown): PlateSessionSnapshotResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid plate session response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) return { ok: false, error: typeof value.error === 'string' ? value.error : 'plate session request failed' };
  if (value.version !== 1 || typeof value.current_plate_id !== 'string' || !Array.isArray(value.plates)) {
    return { ok: false, error: 'invalid plate session response' };
  }
  const plates = value.plates.map((entry): PlateSessionPlate | null => {
    if (!entry || typeof entry !== 'object') return null;
    const plate = entry as Record<string, unknown>;
    const origin = plate.origin;
    if (typeof plate.plate_id !== 'string' || typeof plate.name !== 'string' ||
        !Number.isInteger(plate.display_index) || !Array.isArray(origin) || origin.length !== 3 ||
        !origin.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) return null;
    const coordinates = origin as [number, number, number];
    return {
      plateId: plate.plate_id,
      displayIndex: plate.display_index as number,
      origin: [coordinates[0], coordinates[1], coordinates[2]],
      name: plate.name,
    };
  });
  if (plates.some((plate): plate is null => plate === null) || plates.length === 0) {
    return { ok: false, error: 'invalid plate session response' };
  }
  if (!plates.some((plate) => plate!.plateId === value.current_plate_id)) {
    return { ok: false, error: 'invalid plate session current identity' };
  }
  return {
    ok: true,
    version: 1,
    currentPlateId: value.current_plate_id,
    plates: plates as PlateSessionPlate[],
  };
}

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

    async getPlateSessionSnapshot(): Promise<PlateSessionSnapshotResult> {
      const m = await module();
      return normalizePlateSessionResult(callJson(m, 'orc_get_plate_session_snapshot', [], []));
    },

    async resetPlateSession(): Promise<PlateSessionSnapshotResult> {
      const m = await module();
      return normalizePlateSessionResult(callJson(m, 'orc_reset_plate_session', [], []));
    },

    async selectPlate(plateId: string): Promise<PlateSessionSnapshotResult> {
      const m = await module();
      return normalizePlateSessionResult(callJson(m, 'orc_select_plate', ['string'], [plateId]));
    },

    async getPresetSnapshot(): Promise<PresetSnapshotResult> {
      const m = await module();
      return callJson(m, 'orc_get_preset_snapshot', [], []) as PresetSnapshotResult;
    },

    async selectPreset(kind: 'printer' | 'print' | 'filament', name: string): Promise<PresetSnapshotResult> {
      const m = await module();
      return callJson(m, 'orc_select_preset', ['string', 'string'], [kind, name]) as PresetSnapshotResult;
    },

    async getOptionMetadata(): Promise<OptionMetadata> {
      const m = await module();
      return callJson(m, 'orc_get_option_metadata', [], []) as OptionMetadata;
    },

    async addModel(bytes: Uint8Array, ext: string, displayName?: string): Promise<LoadModelResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        return callJson(m, 'orc_add_model', ['pointer', 'number', 'string', 'string'],
                        [ptr, bytes.length, ext, displayName ?? '']) as LoadModelResult;
      } finally {
        m._free(ptr);
      }
    },

    async loadProject(bytes: Uint8Array, mode: ProjectLoadMode = 'project', displayName?: string): Promise<ProjectLoadResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        const r = callJson(m, 'orc_load_project', ['pointer', 'number', 'number', 'string'],
          [ptr, bytes.length, mode === 'geometry-only' ? 1 : 0, displayName ?? '']) as Record<string, unknown>;
        if (!r.ok) return r as unknown as ProjectLoadResult;
        const warnings = r.embedded_preset_warnings as Record<string, unknown> | undefined;
        return {
          ok: true,
          objects: Number(r.objects ?? 0),
          instances: Number(r.instances ?? 0),
          mode: r.mode as ProjectLoadMode | undefined,
          displayName: typeof r.display_name === 'string' ? r.display_name : undefined,
          compatibility: r.compatibility as ProjectLoadResult['compatibility'],
          projectSettingsAvailable: r.project_settings_available === true,
          isBbl3mf: r.is_bbl_3mf === true,
          isOrca3mf: r.is_orca_3mf === true,
          fileVersion: typeof r.file_version === 'string' ? r.file_version : undefined,
          multiPlate: r.multi_plate === true,
          plateCount: Number(r.plate_count ?? 0),
          embeddedPresetWarnings: warnings ? {
            present: warnings.present === true,
            count: Number(warnings.count ?? 0),
            printerCount: Number(warnings.printer_count ?? 0),
            processCount: Number(warnings.process_count ?? 0),
            filamentCount: Number(warnings.filament_count ?? 0),
            modifiedPrinterGcode: warnings.modified_printer_gcode === true,
            modifiedFilamentGcode: warnings.modified_filament_gcode === true,
            missingSystemPreset: warnings.missing_system_preset === true,
            requiresConfirmation: warnings.requires_confirmation === true,
            modifiedGcodeKeys: Array.isArray(warnings.modified_gcode_keys)
              ? warnings.modified_gcode_keys.filter((key): key is string => typeof key === 'string') : undefined,
            missingSystemPresetTypes: Array.isArray(warnings.missing_system_preset_types)
              ? warnings.missing_system_preset_types.filter((type): type is 'printer' | 'filament' =>
                type === 'printer' || type === 'filament') : undefined,
            presetEvidence: Array.isArray(warnings.preset_evidence) ? warnings.preset_evidence.flatMap((evidence) => {
              if (!evidence || typeof evidence !== 'object') return [];
              const item = evidence as Record<string, unknown>;
              const type = item.type === 'printer' || item.type === 'filament' ? item.type : undefined;
              if (!type || typeof item.name !== 'string' || typeof item.inherits !== 'string') return [];
              return [{
                type, name: item.name, inherits: item.inherits,
                hasMatchingSystemPreset: item.has_matching_system_preset === true,
                modifiedGcodeKeys: Array.isArray(item.modified_gcode_keys)
                  ? item.modified_gcode_keys.filter((key): key is string => typeof key === 'string') : [],
              }];
            }) : undefined,
          } : undefined,
          presetSnapshot: r.preset_snapshot && typeof r.preset_snapshot === 'object'
            && (r.preset_snapshot as Record<string, unknown>).ok === true
            ? r.preset_snapshot as unknown as import('./types').PresetSnapshot : undefined,
        };
      } finally {
        m._free(ptr);
      }
    },

    async importProjectGeometry(bytes: Uint8Array, displayName?: string): Promise<ProjectLoadResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        const r = callJson(m, 'orc_import_project_geometry', ['pointer', 'number', 'string'],
          [ptr, bytes.length, displayName ?? '']) as Record<string, unknown>;
        if (!r.ok) return r as unknown as ProjectLoadResult;
        // Keep the public result shape identical to loadProject's geometry
        // mode without making the worker or callers know a second bridge op.
        return {
          ok: true,
          objects: Number(r.objects ?? 0),
          instances: Number(r.instances ?? 0),
          mode: 'geometry-only',
          displayName: typeof r.display_name === 'string' ? r.display_name : undefined,
          compatibility: r.compatibility as ProjectLoadResult['compatibility'],
          projectSettingsAvailable: r.project_settings_available === true,
          isBbl3mf: r.is_bbl_3mf === true,
          isOrca3mf: r.is_orca_3mf === true,
          fileVersion: typeof r.file_version === 'string' ? r.file_version : undefined,
          multiPlate: r.multi_plate === true,
          plateCount: Number(r.plate_count ?? 0),
          embeddedPresetWarnings: r.embedded_preset_warnings ? {
            present: (r.embedded_preset_warnings as Record<string, unknown>).present === true,
            count: Number((r.embedded_preset_warnings as Record<string, unknown>).count ?? 0),
            printerCount: Number((r.embedded_preset_warnings as Record<string, unknown>).printer_count ?? 0),
            processCount: Number((r.embedded_preset_warnings as Record<string, unknown>).process_count ?? 0),
            filamentCount: Number((r.embedded_preset_warnings as Record<string, unknown>).filament_count ?? 0),
            modifiedPrinterGcode: (r.embedded_preset_warnings as Record<string, unknown>).modified_printer_gcode === true,
            modifiedFilamentGcode: (r.embedded_preset_warnings as Record<string, unknown>).modified_filament_gcode === true,
            missingSystemPreset: (r.embedded_preset_warnings as Record<string, unknown>).missing_system_preset === true,
            requiresConfirmation: (r.embedded_preset_warnings as Record<string, unknown>).requires_confirmation === true,
          } : undefined,
        };
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
        ok: boolean; error?: string; objects?: number; layers?: number; preview_version?: number;
        metadata?: {
          result_id?: number; source_filename?: string;
          layer_ranges?: Array<{ id: number; z: number; first_segment: number; segment_count: number }>;
          feature_palette?: ToolpathFeature[];
          extruder_palette?: Array<ToolpathFeature & { tool?: number }>;
          source_line_mapping?: { available: boolean; line_count: number };
          source_text?: { available: boolean; byte_length?: number };
          analysis?: {
            summary?: {
              estimated_time_seconds?: number;
              filament_length_meters?: number;
              filament_weight_grams?: number;
              filament_cost?: number;
            };
            feature_statistics?: Array<{
              feature_id: number;
              time_seconds?: number;
              filament_length_meters?: number;
              filament_weight_grams?: number;
            }>;
          };
        };
        toolpath?: {
          segment_count?: number;
          starts_ptr?: number; ends_ptr?: number;
          layer_id_ptr?: number; move_order_ptr?: number; gcode_id_ptr?: number;
          move_type_ptr?: number; extrusion_role_ptr?: number;
          extruder_id_ptr?: number; color_print_id_ptr?: number;
          width_ptr?: number; height_ptr?: number;
          metrics?: Record<string, { ptr: number; count: number }>;
          vertex_ptr: number; vertex_count: number;
          layer_ptr: number; layer_count: number;
          feature_ptr: number; feature_count: number;
          features: ToolpathFeature[];
        };
      };
      if (!r.ok || !r.toolpath) return r as unknown as ClientSliceResult;

      const t = r.toolpath;
      const segmentCount = Number(t.segment_count ?? t.vertex_count ?? 0);
      const readF32 = (ptr: number | undefined, count: number): Float32Array =>
        ptr && count > 0 ? new Float32Array(readBytes(m, Number(ptr), count * 4).buffer) : new Float32Array(count);
      const readU32 = (ptr: number | undefined, count: number): Uint32Array =>
        ptr && count > 0 ? new Uint32Array(readBytes(m, Number(ptr), count * 4).buffer) : new Uint32Array(count);
      const readU16 = (ptr: number | undefined, count: number): Uint16Array =>
        ptr && count > 0 ? new Uint16Array(readBytes(m, Number(ptr), count * 2).buffer) : new Uint16Array(count);
      const readU8 = (ptr: number | undefined, count: number): Uint8Array =>
        ptr && count > 0 ? readBytes(m, Number(ptr), count) : new Uint8Array(count);
      const starts = readF32(t.starts_ptr, segmentCount * 3);
      const ends = readF32(t.ends_ptr, segmentCount * 3);
      // v1 result fallback: old bridges only had endpoint positions. Keep the
      // aliases usable while making the v2 arrays total and typed.
      // The bridge keeps vertex_ptr as a v1 compatibility allocation. Read it
      // even for v2 responses so its heap ownership is released exactly once;
      // v2 rendering uses ends instead.
      const legacyPositions = t.ends_ptr && t.vertex_ptr === t.ends_ptr
        ? new Float32Array(0)
        : t.ends_ptr
        ? (readF32(t.vertex_ptr, (t.vertex_count ?? segmentCount) * 3), new Float32Array(0))
        : readF32(t.vertex_ptr, (t.vertex_count ?? segmentCount) * 3);
      const resolvedEnds = t.ends_ptr ? ends : legacyPositions;
      const resolvedStarts = t.starts_ptr ? starts : resolvedEnds.slice();
      const layerIds = readU32(t.layer_id_ptr ?? t.layer_ptr, segmentCount);
      const features = readU32(t.feature_ptr, segmentCount);
      const metricKeyMap: Record<string, keyof PreviewToolpathMetrics> = {
        feedrate: 'feedrate', actual_feedrate: 'actualFeedrate',
        volumetric_flow: 'volumetricFlow', actual_volumetric_flow: 'actualVolumetricFlow',
        fan_speed: 'fanSpeed', temperature: 'temperature', pressure_advance: 'pressureAdvance',
        acceleration: 'acceleration', jerk: 'jerk', time: 'time', layer_duration: 'layerDuration',
      };
      const metrics: PreviewToolpathMetrics = {};
      for (const [wireName, field] of Object.entries(metricKeyMap)) {
        const descriptor = t.metrics?.[wireName];
        if (descriptor && descriptor.ptr && descriptor.count === segmentCount)
          metrics[field] = readF32(descriptor.ptr, descriptor.count);
      }
      const metricRanges: PreviewAnalysis['metricRanges'] = {};
      for (const [field, values] of Object.entries(metrics) as Array<[PreviewMetricKey, Float32Array]>) {
        let min = Infinity;
        let max = -Infinity;
        for (const value of values) {
          if (!Number.isFinite(value)) continue;
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
        if (min !== Infinity) metricRanges[field] = { min, max };
      }
      const rawAnalysis = r.metadata?.analysis;
      const analysis: PreviewAnalysis | undefined = rawAnalysis ? {
        summary: {
          ...(Number.isFinite(rawAnalysis.summary?.estimated_time_seconds) ? {
            estimatedTimeSeconds: rawAnalysis.summary?.estimated_time_seconds,
          } : {}),
          ...(Number.isFinite(rawAnalysis.summary?.filament_length_meters) ? {
            filamentLengthMeters: rawAnalysis.summary?.filament_length_meters,
          } : {}),
          ...(Number.isFinite(rawAnalysis.summary?.filament_weight_grams) ? {
            filamentWeightGrams: rawAnalysis.summary?.filament_weight_grams,
          } : {}),
          ...(Number.isFinite(rawAnalysis.summary?.filament_cost) ? {
            filamentCost: rawAnalysis.summary?.filament_cost,
          } : {}),
        },
        featureStatistics: (rawAnalysis.feature_statistics ?? []).map((stats) => ({
          featureId: stats.feature_id,
          ...(Number.isFinite(stats.time_seconds) ? { timeSeconds: stats.time_seconds } : {}),
          ...(Number.isFinite(stats.filament_length_meters) ? { filamentLengthMeters: stats.filament_length_meters } : {}),
          ...(Number.isFinite(stats.filament_weight_grams) ? { filamentWeightGrams: stats.filament_weight_grams } : {}),
        })),
        metricRanges,
      } : (Object.keys(metricRanges).length > 0 ? {
        summary: {}, featureStatistics: [], metricRanges,
      } : undefined);
      const sourceText = r.metadata?.source_text;
      const sourceByteLength = sourceText?.byte_length;
      const metadata: PreviewMetadata = {
        resultId: Number(r.metadata?.result_id ?? 0),
        ...(r.metadata?.source_filename ? { sourceFilename: r.metadata.source_filename } : {}),
        layerRanges: (r.metadata?.layer_ranges ?? []).map((layer) => ({
          id: layer.id, z: layer.z, firstSegment: layer.first_segment, segmentCount: layer.segment_count,
        })),
        featurePalette: r.metadata?.feature_palette ?? t.features,
        ...(r.metadata?.extruder_palette ? { extruderPalette: r.metadata.extruder_palette } : {}),
        ...(r.metadata?.source_line_mapping ? {
          sourceLineMapping: {
            available: r.metadata.source_line_mapping.available,
            lineCount: r.metadata.source_line_mapping.line_count,
          },
        } : {}),
        ...(sourceText ? {
          sourceText: {
            available: sourceText.available,
            ...(typeof sourceByteLength === 'number' && Number.isSafeInteger(sourceByteLength) && sourceByteLength >= 0
              ? { byteLength: sourceByteLength } : {}),
          },
        } : {}),
        ...(analysis ? { analysis } : {}),
      };
      const moveOrders = readU32(t.move_order_ptr, segmentCount);
      const gcodeIds = readU32(t.gcode_id_ptr, segmentCount);
      const sourceLineOrderValid = gcodeIds.every((line, index) => index === 0 || line >= gcodeIds[index - 1]);
      const toolpath: ClientToolpath = {
        vertexCount: segmentCount,
        positions: resolvedEnds,
        layers: layerIds,
        features,
        palette: t.features,
        segmentCount,
        starts: resolvedStarts,
        ends: resolvedEnds,
        layerIds,
        moveOrders,
        gcodeIds,
        sourceLineOrderValid,
        moveTypes: readU8(t.move_type_ptr, segmentCount),
        extrusionRoles: readU16(t.extrusion_role_ptr, segmentCount),
        extruderIds: readU8(t.extruder_id_ptr, segmentCount),
        colorPrintIds: readU8(t.color_print_id_ptr, segmentCount),
        widths: readF32(t.width_ptr, segmentCount),
        heights: readF32(t.height_ptr, segmentCount),
        metrics,
      };

      return { ok: true, objects: r.objects ?? 0, layers: r.layers ?? 0, toolpath, metadata };
    },

    async exportGcode(): Promise<ExportGcodeResult> {
      const m = await module();
      const r = callJson(m, 'orc_export_gcode', [], []) as { ok: boolean; path?: string; error?: string };
      if (!r.ok) return r as ExportGcodeResult;
      const bytes = m.FS.readFile('/out.gcode');
      return { ok: true, path: r.path ?? '/out.gcode', bytes };
    },

    async exportProject(): Promise<ExportProjectResult> {
      const m = await module();
      const r = callJson(m, 'orc_export_project', [], []) as {
        ok: boolean; path?: string; bytes_ptr?: number; bytes_length?: number;
        objects?: number; plate_count?: number; error?: string;
      };
      if (!r.ok) return {
        ok: false, path: r.path ?? '', bytes: new Uint8Array(0), error: r.error,
      };
      const bytesPtr = Number(r.bytes_ptr ?? 0);
      try {
        const length = Number(r.bytes_length ?? 0);
        if (!Number.isSafeInteger(length) || length < 0 || !bytesPtr)
          throw new Error('project export bridge returned an invalid byte buffer');
        const bytes = m.HEAPU8.slice(bytesPtr, bytesPtr + length);
        return {
          ok: true, path: r.path ?? '', bytes,
          objects: Number(r.objects ?? 0), plateCount: Number(r.plate_count ?? 1),
        };
      } finally {
        if (bytesPtr) m._free(bytesPtr);
      }
    },

    async readTextChunk(request: PreviewTextChunkRequest): Promise<PreviewTextChunk> {
      const offset = request?.offset;
      const length = request?.length;
      if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(length) || length < 0 ||
          length > PREVIEW_TEXT_CHUNK_MAX_BYTES)
        throw new RangeError(`preview text chunk must be a safe range of at most ${PREVIEW_TEXT_CHUNK_MAX_BYTES} bytes`);
      const m = await module();
      const r = callJson(m, 'orc_read_gcode_chunk', ['number', 'number', 'number'], [
        // The result id is intentionally read from the caller's completed
        // result metadata in the app. A zero id is rejected by the bridge.
        request.resultId,
        offset,
        length,
      ]) as {
        ok: boolean;
        error?: string;
        offset?: number;
        length?: number;
        eof?: boolean;
        bytes_ptr?: number;
        bytes_length?: number;
      };
      if (!r.ok) throw new Error(r.error ?? 'preview text is unavailable');
      const actualOffset = Number(r.offset);
      const byteLength = Number(r.bytes_length ?? r.length ?? 0);
      if (!Number.isSafeInteger(actualOffset) || actualOffset < 0 ||
          !Number.isSafeInteger(byteLength) || byteLength < 0 ||
          byteLength > PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES || !r.bytes_ptr)
        throw new Error('preview text bridge returned an invalid chunk');
      const bytes = readBytes(m, Number(r.bytes_ptr), byteLength);
      // The bridge aligns the range to UTF-8 boundaries. Decode as one
      // complete chunk so no decoder state leaks across coalesced requests.
      return {
        offset: actualOffset,
        text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
        eof: r.eof === true,
      };
    },

    async readTextLines(request: PreviewTextLinesRequest): Promise<PreviewTextLines> {
      const startLine = request?.startLine;
      const lineCount = request?.lineCount;
      if (!Number.isSafeInteger(request?.resultId) || request.resultId < 1 ||
          !Number.isSafeInteger(startLine) || startLine < 1 ||
          !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > PREVIEW_TEXT_LINES_MAX)
        throw new RangeError(`preview text page must contain 1-${PREVIEW_TEXT_LINES_MAX} lines`);
      const m = await module();
      const r = callJson(m, 'orc_read_gcode_lines', ['number', 'number', 'number'], [
        request.resultId, startLine, lineCount,
      ]) as {
        ok: boolean; error?: string; start_line?: number; line_count?: number;
        eof?: boolean; bytes_ptr?: number; bytes_length?: number;
      };
      if (!r.ok) throw new Error(r.error ?? 'preview text page is unavailable');
      const actualStart = Number(r.start_line);
      const actualCount = Number(r.line_count);
      const byteLength = Number(r.bytes_length ?? 0);
      if (!Number.isSafeInteger(actualStart) || actualStart < 1 ||
          !Number.isSafeInteger(actualCount) || actualCount < 1 || actualCount > PREVIEW_TEXT_LINES_MAX ||
          !Number.isSafeInteger(byteLength) || byteLength < 0 ||
          byteLength > PREVIEW_TEXT_CHUNK_MAX_BYTES || !r.bytes_ptr)
        throw new Error('preview text bridge returned an invalid page');
      const bytes = readBytes(m, Number(r.bytes_ptr), byteLength);
      return {
        startLine: actualStart,
        lineCount: actualCount,
        text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
        eof: r.eof === true,
      };
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
