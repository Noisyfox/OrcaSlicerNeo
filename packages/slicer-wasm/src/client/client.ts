// packages/slicer-wasm/src/client/client.ts
// ----------------------------------------------------------------
// The typed promise-based bridge client — the ONLY JS that talks to
// the WASM module (design §Bridge API). Synchronous bridge calls run
// inside the worker; every function returns a promise so the API is
// uniform when wrapped by worker messaging (Task 3).
// ----------------------------------------------------------------
import type {
  OrcaModule, OrcaModuleFactory, SlicerClient,
  InitResult, ProfileSnapshot, ProfileSnapshotResult,
  PlateSessionPlate, PlateSessionSnapshot, PlateSessionSnapshotResult, PlateSessionMutationResult, PlateSelectionResult,
  PrimeTowerBuildArea, PrimeTowerFootprint, PrimeTowerBand, PrimeTowerPlateProjection,
  PrimeTowerProjection, PrimeTowerProjectionResult, PrimeTowerMoveRequest,
  PrimeTowerMoveResultOrError,
  ProjectConfigOverrideTarget, ProjectConfigOverlayResultOrError, ProjectConfigOverlay,
  ConfigurationStatus,
  ClearModelResult, ProjectCloseResult, ProjectClosedCallback,
  OptionMetadata, LoadModelResult, ProjectLoadMode, ProjectLoadResult, ProjectProgressCallback,
  ModelMeshResult, SliceResultStatus, ClientSliceResult, PlateOperationTarget, SliceResultReceipt, ResultReadStatus,
  ExportGcodeResult, ExportProjectResult, CancelResult, ModelObjectBuffer, DeleteObjectsResult,
  DeleteVolumesResult, CloneObjectsResult, ReorderStructureResult,
  ModelStructureResult, MutationResult, SplitVolumeResult, SplitObjectResult,
  MergeObjectsResult, SeparateInstancesResult, AddInstanceResult, RemoveInstanceResult, VolumeType,
  ClientToolpath, ToolpathFeature, ModelTransform,
  ReadLogResult, PreviewMetadata, PreviewToolpathMetrics,
  PreviewAnalysis, PreviewMetricKey,
  PreviewTextChunk, PreviewTextChunkRequest,
  PreviewTextLines, PreviewTextLinesRequest,
  FilamentSessionSnapshotResult, FilamentSessionSnapshot, FilamentSessionSlot,
  FilamentAssignmentProjection, FilamentRoutingProjection,
  FilamentMutationResultOrError, FilamentMutationResult,
  FilamentSlotPresetRequest, FilamentSlotColourRequest,
  FilamentCommandRequest, FilamentSlotDeleteRequest, FilamentSlotMergeRequest,
  RememberedFilamentRackRequest,
  FilamentAssignmentRequest, FilamentRoutingRequest,
  NativePerformanceProfile,
} from './types';
import type {
  HistoryContext, HistoryStatus, HistoryTransactionId, HistoryEntryId, HistoryLabel, HistoryJumpDirection,
  HistoryCategory, HistoryDiagnosticLayer, HistoryTimingDiagnostic, HistoryTransactionOptions, RestoreResult,
} from './history';
import { PREVIEW_TEXT_CHUNK_MAX_BYTES, PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES, PREVIEW_TEXT_LINES_MAX } from './types';
import { writeBytes, callJson, readBytes } from './heap';

const REAL_PROJECT_PROFILE_BUILD = import.meta.env.VITE_REAL_PROJECT_PROFILE === '1';
const REAL_PROJECT_PROFILE_JS_SENTINEL = 'ORCA_REAL_PROJECT_PROFILE_JS_V1';

function emptyHistoryTiming(): HistoryTimingDiagnostic {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

function emptyHistoryDiagnosticLayer(): HistoryDiagnosticLayer {
  return { mutation: emptyHistoryTiming(), restore: emptyHistoryTiming(),
    directRestore: emptyHistoryTiming(), fullRestore: emptyHistoryTiming() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSliceResultStatus(raw: unknown): SliceResultStatus {
  if (!isRecord(raw)) throw new Error('slice bridge returned an invalid result');
  const receipt = raw.receipt;
  let normalizedReceipt: SliceResultReceipt | undefined;
  if (receipt !== undefined) {
    if (!isRecord(receipt) || typeof receipt.plate_id !== 'string' ||
        !Number.isSafeInteger(receipt.input_stamp) || Number(receipt.input_stamp) < 0 ||
        typeof receipt.result_generation !== 'string' || !/^[1-9]\d*$/.test(receipt.result_generation) ||
        typeof receipt.slice_task_id !== 'string' || !/^\d+$/.test(receipt.slice_task_id))
      throw new Error('slice bridge returned an invalid result receipt');
    normalizedReceipt = {
      plateId: receipt.plate_id,
      inputStamp: Number(receipt.input_stamp),
      resultGeneration: receipt.result_generation,
      sliceTaskId: receipt.slice_task_id,
    };
  }
  return {
    ok: raw.ok === true,
    unrecognized_keys: Array.isArray(raw.unrecognized_keys)
      ? raw.unrecognized_keys.filter((key): key is string => typeof key === 'string') : [],
    ...(Array.isArray(raw.warnings)
      ? { warnings: raw.warnings.filter((warning): warning is string => typeof warning === 'string') } : {}),
    ...(normalizedReceipt ? { receipt: normalizedReceipt } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  };
}

function normalizeModelTransform(raw: unknown): ModelTransform | undefined {
  if (!isRecord(raw)) return undefined;
  const tuple = (value: unknown, length: number): value is number[] =>
    Array.isArray(value) && value.length === length && value.every((item) => typeof item === 'number' && Number.isFinite(item));
  if (!tuple(raw.offset, 3) || !tuple(raw.rotation, 3) || !tuple(raw.scale, 3) || !tuple(raw.mirror, 3) ||
      (raw.matrix !== undefined && !tuple(raw.matrix, 16))) return undefined;
  return {
    offset: [...raw.offset] as [number, number, number], rotation: [...raw.rotation] as [number, number, number],
    scale: [...raw.scale] as [number, number, number], mirror: [...raw.mirror] as [number, number, number],
    ...(raw.matrix !== undefined ? { matrix: [...raw.matrix] as ModelTransform['matrix'] } : {}),
  };
}

function normalizeNativePerformanceProfile(raw: unknown): NativePerformanceProfile {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.samples))
    throw new Error('invalid native performance profile');
  if (raw.samples.length > 16) throw new Error('invalid native performance profile sample count');
  const aggregateStages = [
    'session_preparation', 'bounds_scan', 'effective_config_construction',
    'plate_local_model_construction', 'used_slot_summary_hit', 'used_slot_summary_delta',
    'used_slot_full_scan_fallback', 'used_slot_scan', 'printable_height_bounds_scan',
    'direct_wipe_tower_estimate', 'print_apply_wipe_tower_data_fallback',
    'footprint_bands_projection_json',
    'final_json_serialization', 'final_json_copy', 'total',
  ];
  const plateStages = [
    'effective_config_construction', 'plate_local_model_construction', 'used_slot_summary_hit',
    'used_slot_summary_delta', 'used_slot_full_scan_fallback', 'used_slot_scan',
    'printable_height_bounds_scan', 'direct_wipe_tower_estimate',
    'print_apply_wipe_tower_data_fallback',
    'footprint_bands_projection_json', 'total',
  ];
  const samples = raw.samples.map((sample): NativePerformanceProfile['samples'][number] => {
    if (!isRecord(sample) || typeof sample.operation !== 'string' || !isRecord(sample.stages_ms))
      throw new Error('invalid native performance sample');
    const stagesMs: Record<string, number> = {};
    for (const [stage, value] of Object.entries(sample.stages_ms)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        throw new Error('invalid native performance stage');
      stagesMs[stage] = value;
    }
    if (sample.operation === 'prime_tower_projection') {
      if (!sameKeys(stagesMs, aggregateStages) || !Array.isArray(sample.per_plate_stages_ms))
        throw new Error('invalid prime tower performance stages');
      const perPlateStagesMs = sample.per_plate_stages_ms.map((plate) => {
        if (!isRecord(plate)) throw new Error('invalid prime tower performance plate stages');
        const normalized: Record<string, number> = {};
        for (const [stage, value] of Object.entries(plate)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
            throw new Error('invalid prime tower performance plate stage');
          normalized[stage] = value;
        }
        if (!sameKeys(normalized, plateStages)) throw new Error('invalid prime tower performance plate stages');
        return normalized;
      });
      return { operation: sample.operation, stagesMs, perPlateStagesMs };
    }
    if (sample.per_plate_stages_ms !== undefined)
      throw new Error('invalid native performance sample');
    return { operation: sample.operation, stagesMs };
  });
  return { version: 1, samples };
}

function sameKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function normalizeConfigurationStatus(raw: unknown, allowReady: boolean): ConfigurationStatus | null {
  if (!isRecord(raw) || (raw.state !== 'ready' && raw.state !== 'error')) return null;
  if (raw.state === 'error') {
    return typeof raw.error === 'string' ? { state: 'error', error: raw.error } : null;
  }
  if (!allowReady || !Array.isArray(raw.corrections) || !Array.isArray(raw.warnings) || !Array.isArray(raw.errors) ||
      !raw.warnings.every((value) => typeof value === 'string') || !raw.errors.every((value) => typeof value === 'string'))
    return null;
  const corrections = raw.corrections.map((value) => {
    if (!isRecord(value) || typeof value.key !== 'string' || typeof value.requested !== 'string' || typeof value.effective !== 'string') return null;
    return { key: value.key, requested: value.requested, effective: value.effective };
  });
  if (corrections.some((value) => value === null)) return null;
  return { state: 'ready', corrections: corrections as { key: string; requested: string; effective: string }[],
    warnings: raw.warnings as string[], errors: raw.errors as string[] };
}

function normalizeProjectConfigOverlay(raw: unknown): ProjectConfigOverlayResultOrError {
  if (!isRecord(raw)) return { ok: false, error: 'invalid project configuration response' };
  if (raw.ok !== true) {
    if (raw.ok !== false || typeof raw.error !== 'string') return { ok: false, error: 'invalid project configuration error envelope' };
    const result: { ok: false; error: string; errorCode?: string; status?: { state: 'error'; error: string } } = { ok: false, error: raw.error };
    if (raw.error_code !== undefined) {
      if (typeof raw.error_code !== 'string') return { ok: false, error: 'invalid project configuration error code' };
      result.errorCode = raw.error_code;
    }
    if (raw.status !== undefined) {
      const status = normalizeConfigurationStatus(raw.status, false);
      if (!status || status.state !== 'error') return { ok: false, error: 'invalid project configuration error status' };
      result.status = status;
    }
    return result;
  }
  const overlay = raw.overlay;
  if (!isRecord(overlay)) return { ok: false, error: 'invalid project configuration overlay' };
  if (Object.keys(overlay).length !== 4 || !Object.hasOwn(overlay, 'project') ||
      !Object.hasOwn(overlay, 'objects') || !Object.hasOwn(overlay, 'parts') ||
      !Object.hasOwn(overlay, 'plates'))
    return { ok: false, error: 'invalid project configuration overlay' };
  const normalizeBucket = (value: unknown): Record<string, string> | null => {
    if (!isRecord(value)) return null;
    const entries: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') return null;
      entries[key] = item;
    }
    return entries;
  };
  const project = normalizeBucket(overlay.project);
  const normalizeScopedBucket = (value: unknown): Record<string, Record<string, string>> | null => {
    if (!isRecord(value)) return null;
    const result: Record<string, Record<string, string>> = {};
    for (const [id, item] of Object.entries(value)) {
      const bucket = normalizeBucket(item);
      if (!bucket) return null;
      result[id] = bucket;
    }
    return result;
  };
  const objects = normalizeScopedBucket(overlay.objects);
  const parts = normalizeScopedBucket(overlay.parts);
  const plates = normalizeScopedBucket(overlay.plates);
  if (!project || !objects || !parts || !plates) return { ok: false, error: 'invalid project configuration overlay' };
  const result: { ok: true; overlay: ProjectConfigOverlay; plateSession?: unknown; configurationStatus?: unknown } = {
    ok: true, overlay: { project, objects, parts, plates },
  };
  if (raw.plate_session !== undefined) {
    const plateSession = normalizePlateMutationResult(raw.plate_session);
    if (!plateSession.ok) return { ok: false, error: plateSession.error };
    result.plateSession = plateSession;
  }
  const rawStatus = raw.configuration_status ?? raw.configurationStatus;
  if (rawStatus !== undefined) {
    const status = normalizeConfigurationStatus(rawStatus, true);
    if (!status || status.state !== 'ready') return { ok: false, error: 'invalid project configuration status' };
    result.configurationStatus = status;
  }
  return result as ProjectConfigOverlayResultOrError;
}

function normalizeFilamentSessionResult(raw: unknown): FilamentSessionSnapshotResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid filament session response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) {
    if (value.version !== 1) return { ok: false, error: 'unsupported filament session version' };
    if (value.ok !== false || typeof value.error !== 'string' || typeof value.error_code !== 'string')
      return { ok: false, error: 'invalid filament session error envelope' };
    const error = typeof value.error === 'string' ? value.error : 'filament session request failed';
    const status = value.status;
    const errorStatus = status && typeof status === 'object' &&
      (status as Record<string, unknown>).state === 'error' &&
      typeof (status as Record<string, unknown>).error === 'string'
      ? { state: 'error' as const, error: (status as Record<string, unknown>).error as string }
      : undefined;
    if (!errorStatus) return { ok: false, error: 'invalid filament session error envelope' };
    return { ok: false, error,
      ...(typeof value.error_code === 'string' ? { errorCode: value.error_code } : {}),
      ...(errorStatus ? { status: errorStatus } : {}),
    };
  }
  if (value.version !== 1) return { ok: false, error: 'unsupported filament session version' };
  const integer = (entry: unknown, min = 0): entry is number =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= min;
  const numberArray = (entry: unknown): number[] | null =>
    Array.isArray(entry) && entry.every((item) => typeof item === 'number' && Number.isFinite(item))
      ? entry as number[] : null;
  const integerArray = (entry: unknown): number[] | null =>
    Array.isArray(entry) && entry.every((item) => integer(item)) ? entry as number[] : null;
  if (!Array.isArray(value.slots)) return { ok: false, error: 'invalid filament session slots' };
  const slots = value.slots.map((entry): FilamentSessionSlot | null => {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    const preset = item.preset;
    const colour = item.colour;
    if (!integer(item.slot, 1) || !preset || typeof preset !== 'object' ||
        !colour || typeof colour !== 'object') return null;
    const p = preset as Record<string, unknown>;
    const c = colour as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string' || typeof c.effective !== 'string' ||
        (c.provenance !== 'preset' && c.provenance !== 'user')) return null;
    return { slot: item.slot as number, preset: { id: p.id, name: p.name },
      colour: { effective: c.effective, provenance: c.provenance } };
  });
  if (slots.some((slot) => slot === null)) return { ok: false, error: 'invalid filament session slots' };
  const orderedSlots = slots as FilamentSessionSlot[];
  if (orderedSlots.length === 0) return { ok: false, error: 'invalid filament session slots' };
  if (orderedSlots.some((slot, index) => slot.slot !== index + 1))
    return { ok: false, error: 'invalid filament session slot ordering' };

  const mappings = value.mappings;
  if (!mappings || typeof mappings !== 'object') return { ok: false, error: 'invalid filament session mappings' };
  const m = mappings as Record<string, unknown>;
  const filament = integerArray(m.filament);
  const volume = integerArray(m.volume);
  const nozzle = integerArray(m.nozzle);
  const filament2 = integerArray(m.filament2);
  const physicalExtruder = integerArray(m.physical_extruder);
  if (!filament || !volume || !nozzle || !filament2 || !physicalExtruder ||
      filament.length !== orderedSlots.length || volume.length !== orderedSlots.length ||
      nozzle.length !== orderedSlots.length || filament2.length !== orderedSlots.length)
    return { ok: false, error: 'invalid filament session mappings' };

  const flushing = value.flushing;
  if (!flushing || typeof flushing !== 'object') return { ok: false, error: 'invalid filament session flushing state' };
  const f = flushing as Record<string, unknown>;
  const matrix = numberArray(f.matrix);
  const vector = numberArray(f.vector);
  if (!matrix || !vector || !integer(f.matrix_dimension, 1) || !integer(f.plane_count, 1) ||
      (f.source !== 'native' && f.source !== 'default') ||
      f.matrix_dimension !== orderedSlots.length ||
      matrix.length !== f.matrix_dimension * f.matrix_dimension * f.plane_count)
    return { ok: false, error: 'invalid filament session flushing state' };

  const capabilities = value.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return { ok: false, error: 'invalid filament session capabilities' };
  const cap = capabilities as Record<string, unknown>;
  if (!integer(cap.min_slots, 1) || !integer(cap.max_slots, cap.min_slots) ||
      !integer(cap.nozzle_count, 1) || typeof cap.can_add !== 'boolean' ||
      typeof cap.can_delete !== 'boolean' || typeof cap.can_merge !== 'boolean' ||
      typeof cap.flexible !== 'boolean')
    return { ok: false, error: 'invalid filament session capabilities' };
  const slotCount = orderedSlots.length;
  const minSlots = cap.min_slots as number;
  const maxSlots = cap.max_slots as number;
  const nozzleCount = cap.nozzle_count as number;
  const flexible = cap.flexible as boolean;
  if (maxSlots !== 64 || slotCount < minSlots || slotCount > maxSlots ||
      (flexible
        ? (minSlots !== 1 || cap.can_add !== (slotCount < maxSlots) ||
           cap.can_delete !== (slotCount > 1) || cap.can_merge !== (slotCount > 1))
        : (minSlots !== nozzleCount || slotCount < nozzleCount ||
           cap.can_add !== false || cap.can_delete !== false || cap.can_merge !== false)))
    return { ok: false, error: 'inconsistent filament session capabilities' };
  if (physicalExtruder.length !== nozzleCount)
    return { ok: false, error: 'invalid filament session mappings' };
  if (f.plane_count !== nozzleCount)
    return { ok: false, error: 'inconsistent filament session flushing planes' };

  const routing: FilamentRoutingProjection[] = [];
  const routingSelectors = new Set(['support-base', 'support-interface', 'outer-wall', 'inner-wall',
    'sparse-infill', 'internal-solid-infill', 'top-surface', 'bottom-surface']);
  if (value.routing !== undefined) {
    if (!Array.isArray(value.routing)) return { ok: false, error: 'invalid filament session routing' };
    for (const candidate of value.routing) {
      if (!candidate || typeof candidate !== 'object') return { ok: false, error: 'invalid filament session routing' };
      const item = candidate as Record<string, unknown>;
      if ((item.target !== 'project' && item.target !== 'object' && item.target !== 'model-part') ||
          !integer(item.id) || !integer(item.object_id) || typeof item.selector !== 'string' ||
          !routingSelectors.has(item.selector) || !integer(item.explicit_slot) ||
          !integer(item.effective_slot) || typeof item.inherited !== 'boolean' || typeof item.defaulted !== 'boolean' ||
          (item.target === 'project' && (item.id !== 0 || item.object_id !== 0 ||
            (item.selector !== 'support-base' && item.selector !== 'support-interface'))) ||
          (item.target === 'object' && (item.id === 0 || item.object_id !== item.id)) ||
          (item.target === 'model-part' && (item.id === 0 || item.object_id === 0 ||
            item.selector === 'support-base' || item.selector === 'support-interface')) ||
          (item.effective_slot === 0 && item.defaulted !== true) ||
          (item.effective_slot !== 0 && item.defaulted !== false))
        return { ok: false, error: 'invalid filament session routing' };
      if ((item.effective_slot as number) > slotCount || (item.explicit_slot as number) > slotCount)
        return { ok: false, error: 'invalid filament session routing' };
      routing.push({ target: item.target as FilamentRoutingProjection['target'], id: item.id as number,
        objectId: item.object_id as number, selector: item.selector as FilamentRoutingProjection['selector'],
        explicitSlot: item.explicit_slot as number, effectiveSlot: item.effective_slot as number,
        inherited: item.inherited as boolean, defaulted: item.defaulted as boolean });
    }
  }

  const assignments = value.assignments;
  if (!assignments || typeof assignments !== 'object') return { ok: false, error: 'invalid filament session assignments' };
  const assignmentSet = assignments as Record<string, unknown>;
  const assignmentArray = (entry: unknown, target: FilamentAssignmentProjection['target']): FilamentAssignmentProjection[] | null => {
    if (!Array.isArray(entry)) return null;
    const result = entry.map((candidate): FilamentAssignmentProjection | null => {
      if (!candidate || typeof candidate !== 'object') return null;
      const item = candidate as Record<string, unknown>;
      if (item.target !== target || !integer(item.id) || !integer(item.object_id) ||
          !integer(item.explicit_slot) || !integer(item.effective_slot, 1) || typeof item.inherited !== 'boolean') return null;
      const explicitSlot = item.explicit_slot as number;
      const effectiveSlot = item.effective_slot as number;
      if (effectiveSlot > slotCount || (target === 'object' && (item.inherited !== false || explicitSlot < 1)) ||
          (target !== 'object' && explicitSlot > slotCount) ||
          (target !== 'object' && item.inherited !== (explicitSlot === 0)) ||
          (target === 'object' && effectiveSlot !== explicitSlot) ||
          (target !== 'object' && explicitSlot > 0 && effectiveSlot !== explicitSlot)) return null;
      return { target, id: item.id as number, objectId: item.object_id as number,
        explicitSlot, effectiveSlot,
        inherited: item.inherited as boolean };
    });
    return result.some((item) => item === null) ? null : (result as FilamentAssignmentProjection[]);
  };
  const objects = assignmentArray(assignmentSet.objects, 'object');
  const parts = assignmentArray(assignmentSet.parts, 'model-part');
  const modifiers = assignmentArray(assignmentSet.modifiers, 'parameter-modifier');
  if (!objects || !parts || !modifiers) return { ok: false, error: 'invalid filament session assignments' };
  for (const entries of [objects, parts, modifiers]) {
    const ids = new Set(entries.map((entry) => `${entry.objectId}:${entry.id}`));
    if (ids.size !== entries.length) return { ok: false, error: 'invalid filament session assignments' };
  }

  const revisions = value.revisions;
  if (!revisions || typeof revisions !== 'object') return { ok: false, error: 'invalid filament session revisions' };
  const rev = revisions as Record<string, unknown>;
  if (!integer(rev.session) || !integer(rev.project) || !integer(rev.result) ||
      !rev.plates || typeof rev.plates !== 'object' || Array.isArray(rev.plates))
    return { ok: false, error: 'invalid filament session revisions' };
  const plates: Record<string, number> = {};
  for (const [id, revision] of Object.entries(rev.plates as Record<string, unknown>)) {
    if (!integer(revision)) return { ok: false, error: 'invalid filament session revisions' };
    plates[id] = revision;
  }
  const status = value.status;
  if (!status || typeof status !== 'object') return { ok: false, error: 'invalid filament session status' };
  const s = status as Record<string, unknown>;
  if (s.state !== 'ready' || s.error !== null) return { ok: false, error: 'invalid filament session status' };
  const result: FilamentSessionSnapshot = {
    ok: true, version: 1, slots: orderedSlots,
    mappings: { filament, volume, nozzle, filament2, physicalExtruder },
    flushing: { matrix, vector, matrixDimension: f.matrix_dimension as number,
      planeCount: f.plane_count as number, source: f.source as 'native' | 'default' },
    capabilities: { minSlots, maxSlots, nozzleCount, flexible,
      canAdd: cap.can_add as boolean,
      canDelete: cap.can_delete as boolean, canMerge: cap.can_merge as boolean },
    ...(value.routing !== undefined ? { routing } : {}),
    assignments: { objects, parts, modifiers },
    revisions: { session: rev.session as number, project: rev.project as number,
      result: rev.result as number, plates },
    status: { state: 'ready', error: null },
  };
  return result;
}

function normalizeFilamentMutationResult(raw: unknown): FilamentMutationResultOrError {
  if (!raw || typeof raw !== 'object') return { ok: false, version: 1, error: 'invalid filament mutation response', errorCode: 'invalid_response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) {
    if (value.version !== 1 || value.ok !== false || typeof value.error !== 'string' || typeof value.error_code !== 'string')
      return { ok: false, version: 1, error: 'invalid filament mutation error envelope', errorCode: 'invalid_response' };
    if (!value.status || typeof value.status !== 'object' ||
        (value.status as Record<string, unknown>).state !== 'error' ||
        typeof (value.status as Record<string, unknown>).error !== 'string')
      return { ok: false, version: 1, error: 'invalid filament mutation error status', errorCode: 'invalid_response' };
    return { ok: false, version: 1, error: value.error, errorCode: value.error_code,
      ...(value.status && typeof value.status === 'object' ? {
        status: { state: 'error' as const, error: String((value.status as Record<string, unknown>).error ?? value.error) },
      } : {}) };
  }
  if (value.version !== 1 || !value.result || typeof value.result !== 'object')
    return { ok: false, version: 1, error: 'invalid filament mutation result envelope', errorCode: 'invalid_response' };
  const result = value.result as Record<string, unknown>;
  const snapshot = normalizeFilamentSessionResult(result.snapshot);
  if (!snapshot.ok || !result.mutation || typeof result.mutation !== 'object')
    return { ok: false, version: 1, error: snapshot.ok ? 'invalid filament mutation summary' : snapshot.error,
      errorCode: 'invalid_response' };
  if (!isRecord(result.history_status))
    return { ok: false, version: 1, error: 'missing filament mutation history status', errorCode: 'invalid_response' };
  let historyStatus: import('./history').HistoryStatus;
  try { historyStatus = normalizeHistoryStatus(result.history_status); }
  catch { return { ok: false, version: 1, error: 'invalid filament history status', errorCode: 'invalid_response' }; }
  const mutation = result.mutation as Record<string, unknown>;
  if (typeof mutation.kind !== 'string' || mutation.history_entry_delta !== 1 ||
      !Number.isSafeInteger(mutation.revision_before) || !Number.isSafeInteger(mutation.revision_after) ||
      Number(mutation.revision_after) !== Number(mutation.revision_before) + 1 ||
      Number(mutation.revision_after) !== snapshot.revisions.session ||
      mutation.dirty !== true || typeof mutation.all_plate_results_invalidated !== 'boolean')
    return { ok: false, version: 1, error: 'invalid filament mutation summary', errorCode: 'invalid_response' };
  if (historyStatus.revision !== mutation.revision_after || historyStatus.dirty !== mutation.dirty)
    return { ok: false, version: 1, error: 'filament mutation history status does not match receipt', errorCode: 'invalid_response' };
  const validMutationKinds = new Set(['select-preset', 'set-colour', 'add', 'delete', 'merge', 'assign', 'routing']);
  if (!validMutationKinds.has(String(mutation.kind)))
    return { ok: false, version: 1, error: 'invalid filament mutation kind', errorCode: 'invalid_response' };
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(mutation, key);
  const baseKeys = ['kind', 'history_entry_delta', 'revision_before', 'revision_after', 'dirty', 'all_plate_results_invalidated'];
  const kindKeys: Record<string, string[]> = {
    'select-preset': [...baseKeys, 'slot', 'preset'],
    'set-colour': [...baseKeys, 'slot', 'colour'],
    add: [...baseKeys, 'slot'],
    delete: [...baseKeys, 'source', 'destination', 'slot_count'],
    merge: [...baseKeys, 'source', 'destination', 'slot_count'],
    assign: [...baseKeys, 'slot', 'accepted_targets', 'affected_plate_ids'],
    routing: [...baseKeys, 'selector', 'slot', 'accepted_targets', 'affected_plate_ids'],
  };
  const allowedKeys = new Set(kindKeys[String(mutation.kind)] ?? []);
  if (Object.keys(mutation).some((key) => !allowedKeys.has(key)))
    return { ok: false, version: 1, error: 'extraneous filament mutation field', errorCode: 'invalid_response' };
  if (Object.keys(mutation).length !== allowedKeys.size || [...allowedKeys].some((key) => !has(key)))
    return { ok: false, version: 1, error: 'missing filament mutation field', errorCode: 'invalid_response' };
  if (mutation.kind !== 'assign' && mutation.kind !== 'routing' && mutation.all_plate_results_invalidated !== true)
    return { ok: false, version: 1, error: 'invalid filament invalidation scope', errorCode: 'invalid_response' };
  const requireSlot = mutation.kind === 'select-preset' || mutation.kind === 'set-colour' || mutation.kind === 'add' ||
    mutation.kind === 'assign' || mutation.kind === 'routing';
  const minimumSlot = mutation.kind === 'assign' || mutation.kind === 'routing' ? 0 : 1;
  if (requireSlot && (!Number.isSafeInteger(mutation.slot) || Number(mutation.slot) < minimumSlot))
    return { ok: false, version: 1, error: 'invalid filament mutation slot', errorCode: 'invalid_response' };
  if (requireSlot && Number(mutation.slot) > snapshot.slots.length)
    return { ok: false, version: 1, error: 'invalid filament mutation slot range', errorCode: 'invalid_response' };
  if (mutation.kind === 'add' && Number(mutation.slot) !== snapshot.slots.length)
    return { ok: false, version: 1, error: 'invalid filament add slot', errorCode: 'invalid_response' };
  if (mutation.kind === 'select-preset' && (!has('preset') || typeof mutation.preset !== 'string' || mutation.preset.length === 0))
    return { ok: false, version: 1, error: 'invalid filament mutation preset', errorCode: 'invalid_response' };
  if (mutation.kind === 'set-colour' && (!has('colour') || typeof mutation.colour !== 'string' ||
      !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(mutation.colour)))
    return { ok: false, version: 1, error: 'invalid filament mutation colour', errorCode: 'invalid_response' };
  if (mutation.kind === 'delete' || mutation.kind === 'merge') {
    if (!has('slot_count') || !Number.isSafeInteger(mutation.slot_count) ||
        Number(mutation.slot_count) !== snapshot.slots.length)
      return { ok: false, version: 1, error: 'invalid filament mutation slot count', errorCode: 'invalid_response' };
    if (!has('source') || !Number.isSafeInteger(mutation.source) || Number(mutation.source) < 1 ||
        Number(mutation.source) > snapshot.slots.length + 1)
      return { ok: false, version: 1, error: 'invalid filament mutation source range', errorCode: 'invalid_response' };
    if (mutation.kind === 'delete') {
      if (!has('destination') || mutation.destination !== null)
        return { ok: false, version: 1, error: 'invalid filament delete destination', errorCode: 'invalid_response' };
    } else if (!has('destination') || !Number.isSafeInteger(mutation.destination) ||
        Number(mutation.destination) < 1 || Number(mutation.destination) > snapshot.slots.length)
      return { ok: false, version: 1, error: 'invalid filament merge destination range', errorCode: 'invalid_response' };
  }
  if (mutation.kind === 'assign' || mutation.kind === 'routing') {
    if (!Array.isArray(mutation.affected_plate_ids) ||
        !mutation.affected_plate_ids.every((id) => typeof id === 'string'))
      return { ok: false, version: 1, error: 'invalid filament affected plate ids', errorCode: 'invalid_response' };
    if (!Array.isArray(mutation.accepted_targets) || mutation.accepted_targets.length === 0)
      return { ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' };
    const selector = mutation.kind === 'routing' ? mutation.selector : undefined;
    const routingSelectors = new Set(['support-base', 'support-interface', 'outer-wall', 'inner-wall',
      'sparse-infill', 'internal-solid-infill', 'top-surface', 'bottom-surface']);
    if (mutation.kind === 'routing' && (typeof selector !== 'string' || !routingSelectors.has(selector)))
      return { ok: false, version: 1, error: 'invalid filament routing selector', errorCode: 'invalid_response' };
    let projectAccepted = false;
    for (const candidate of mutation.accepted_targets) {
      if (!candidate || typeof candidate !== 'object')
        return { ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' };
      const target = candidate as Record<string, unknown>;
      if (Object.keys(target).sort().join(',') !== ['kind', 'id', 'object_id'].sort().join(',') ||
          typeof target.kind !== 'string' || !Number.isSafeInteger(target.id) ||
          !Number.isSafeInteger(target.object_id))
        return { ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' };
      const kind = target.kind;
      const id = target.id as number;
      const objectId = target.object_id as number;
      if (mutation.kind === 'assign') {
        if (!new Set(['object', 'model-part', 'parameter-modifier']).has(kind) || id < 1 || objectId < 1 ||
            (kind === 'object' && id !== objectId))
          return { ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' };
      } else {
        const feature = selector !== 'support-base' && selector !== 'support-interface';
        if ((kind === 'project' && (id !== 0 || objectId !== 0 || feature)) ||
            (kind === 'object' && (id < 1 || objectId !== id)) ||
            (kind === 'model-part' && (id < 1 || objectId < 1 || !feature)) ||
            !new Set(['project', 'object', 'model-part']).has(kind))
          return { ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' };
        projectAccepted = projectAccepted || kind === 'project';
      }
    }
    if ((mutation.kind === 'assign' && mutation.all_plate_results_invalidated !== false) ||
        (mutation.kind === 'routing' && mutation.all_plate_results_invalidated !== projectAccepted))
      return { ok: false, version: 1, error: 'invalid filament invalidation scope', errorCode: 'invalid_response' };
  }
  const summary = {
    kind: mutation.kind as FilamentMutationResult['mutation']['kind'],
    ...(Number.isSafeInteger(mutation.slot) ? { slot: mutation.slot as number } : {}),
    ...(Number.isSafeInteger(mutation.source) ? { source: mutation.source as number } : {}),
    ...(mutation.destination === null || Number.isSafeInteger(mutation.destination)
      ? { destination: mutation.destination as number | null } : {}),
    ...(typeof mutation.preset === 'string' ? { preset: mutation.preset } : {}),
    ...(typeof mutation.colour === 'string' ? { colour: mutation.colour } : {}),
    ...(Number.isSafeInteger(mutation.slot_count) ? { slotCount: mutation.slot_count as number } : {}),
    historyEntryDelta: 1 as const,
    revisionBefore: mutation.revision_before as number,
    revisionAfter: mutation.revision_after as number,
    dirty: true as const,
    allPlateResultsInvalidated: mutation.all_plate_results_invalidated as boolean,
    ...(Array.isArray(mutation.affected_plate_ids) && mutation.affected_plate_ids.every((id) => typeof id === 'string')
      ? { affectedPlateIds: mutation.affected_plate_ids as string[] } : {}),
    ...(Array.isArray(mutation.accepted_targets) ? { acceptedTargets: mutation.accepted_targets.map((target) => {
      const item = target as Record<string, unknown>;
      return { kind: item.kind as string, id: item.id as number, objectId: item.object_id as number };
    }) as FilamentMutationResult['mutation']['acceptedTargets'] } : {}),
    ...(typeof mutation.selector === 'string' ? { selector: mutation.selector } : {}),
  };
  return { ok: true, version: 1, result: { snapshot, mutation: summary, historyStatus } };
}

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
    const normalized = {
      plateId: plate.plate_id,
      displayIndex: plate.display_index as number,
      origin: [coordinates[0], coordinates[1], coordinates[2]] as [number, number, number],
      name: plate.name,
    };
    const hasSettings = plate.settings !== undefined;
    const settings = hasSettings && plate.settings && typeof plate.settings === 'object' && !Array.isArray(plate.settings)
      ? plate.settings as Readonly<Record<string, unknown>> : undefined;
    if (hasSettings && !settings) return null;
    const hasOpaqueMetadata = plate.opaque_metadata !== undefined;
    const opaqueMetadata = hasOpaqueMetadata && Array.isArray(plate.opaque_metadata)
      ? plate.opaque_metadata.map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const item = entry as Record<string, unknown>;
        return typeof item.key === 'string' && typeof item.value === 'string'
          ? { key: item.key, value: item.value } : null;
      }) : undefined;
    if (hasOpaqueMetadata && (!opaqueMetadata || opaqueMetadata.some((entry) => entry === null))) return null;
    const hasFutureMetadata = plate.future_metadata !== undefined;
    const futureMetadata = hasFutureMetadata && plate.future_metadata && typeof plate.future_metadata === 'object' && !Array.isArray(plate.future_metadata)
      ? plate.future_metadata as Readonly<Record<string, unknown>> : undefined;
    if (hasFutureMetadata && !futureMetadata) return null;
    return {
      ...normalized,
      ...(typeof plate.locked === 'boolean' ? { locked: plate.locked } : {}),
      ...(settings ? { settings } : {}),
      ...(opaqueMetadata ? { opaqueMetadata: opaqueMetadata as { key: string; value: string }[] } : {}),
      ...(futureMetadata ? { futureMetadata } : {}),
      ...(Array.isArray(plate.instance_ids) && plate.instance_ids.every((id) => Number.isSafeInteger(id))
        ? { instanceIds: plate.instance_ids as number[] } : {}),
      ...(Array.isArray(plate.out_of_bounds_instance_ids) && plate.out_of_bounds_instance_ids.every((id) => Number.isSafeInteger(id))
        ? { outOfBoundsInstanceIds: plate.out_of_bounds_instance_ids as number[] } : {}),
      ...(typeof plate.valid === 'boolean' ? { valid: plate.valid } : {}),
    };
  });
  if (plates.some((plate): plate is null => plate === null) || plates.length === 0) {
    return { ok: false, error: 'invalid plate session response' };
  }
  if (!plates.some((plate) => plate!.plateId === value.current_plate_id)) {
    return { ok: false, error: 'invalid plate session current identity' };
  }
  const result: PlateSessionSnapshot = {
    ok: true,
    version: 1,
    currentPlateId: value.current_plate_id,
    plates: plates as PlateSessionPlate[],
  };
  if (Array.isArray(value.instances)) {
    const instances = value.instances.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      if (![item.instance_id, item.object_id, item.object_index, item.instance_index]
        .every((id) => Number.isSafeInteger(id)) || typeof item.plate_id !== 'string' ||
          typeof item.member !== 'boolean' || typeof item.unprintable !== 'boolean' ||
          typeof item.out_of_bounds !== 'boolean') return null;
      return { instanceId: item.instance_id as number, objectId: item.object_id as number,
        objectIndex: item.object_index as number, instanceIndex: item.instance_index as number,
        plateId: item.plate_id, member: item.member, unprintable: item.unprintable,
        outOfBounds: item.out_of_bounds,
        ...(typeof item.parked === 'boolean' ? { parked: item.parked } : {}),
      };
    });
    if (instances.some((instance) => instance === null)) return { ok: false, error: 'invalid plate session instances' };
    result.instances = instances as NonNullable<typeof instances[number]>[];
  }
  if (Array.isArray(value.instance_transforms)) {
    const transforms = value.instance_transforms.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      if (![item.instance_id, item.object_id, item.object_index, item.instance_index]
        .every((id) => Number.isSafeInteger(id)) || !item.world_transform || typeof item.world_transform !== 'object') return null;
      const worldTransform = normalizeModelTransform(item.world_transform);
      if (!worldTransform) return null;
      return { instanceId: item.instance_id as number, objectId: item.object_id as number,
        objectIndex: item.object_index as number, instanceIndex: item.instance_index as number,
        worldTransform };
    });
    if (transforms.some((transform) => transform === null)) return { ok: false, error: 'invalid plate session transforms' };
    result.instanceTransforms = transforms as NonNullable<typeof transforms[number]>[];
  }
  if (value.input_revisions && typeof value.input_revisions === 'object' && !Array.isArray(value.input_revisions)) {
    const revisions: Record<string, number> = {};
    for (const [id, revision] of Object.entries(value.input_revisions as Record<string, unknown>))
      if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) revisions[id] = revision;
    result.inputRevisions = revisions;
  }
  const ids = (key: string): string[] | undefined => Array.isArray(value[key])
    && (value[key] as unknown[]).every((id) => typeof id === 'string')
    ? value[key] as string[] : undefined;
  const before = ids('affected_plate_ids_before');
  const after = ids('affected_plate_ids_after');
  const affected = ids('affected_plate_ids');
  const reasons = Array.isArray(value.dirty_reasons) && (value.dirty_reasons as unknown[]).every((reason) => typeof reason === 'string')
    ? value.dirty_reasons as string[] : undefined;
  if (before) result.affectedPlateIdsBefore = before;
  if (after) result.affectedPlateIdsAfter = after;
  if (affected) result.affectedPlateIds = affected;
  if (reasons) result.dirtyReasons = reasons;
  if (value.project_config_overlay !== undefined) {
    const overlay = normalizeProjectConfigOverlay({ ok: true, overlay: value.project_config_overlay });
    if (!overlay.ok) return { ok: false, error: 'invalid plate session project configuration overlay' };
    result.projectConfigOverlay = overlay.overlay;
  }
  return result;
}

/** Normalize the native-canonical session embedded in every history context.
 * A malformed optional session is omitted so an adjacent receipt cannot use
 * it as proof; the restore itself remains eligible for the full projection. */
export function normalizeHistoryContext(raw: unknown): HistoryContext | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.plateSession === undefined) return raw as unknown as HistoryContext;
  const session = normalizePlateSessionResult(raw.plateSession);
  if (!session.ok) {
    const { plateSession: _invalid, ...withoutSession } = raw;
    return withoutSession as unknown as HistoryContext;
  }
  return { ...raw, plateSession: session } as unknown as HistoryContext;
}

function normalizePlateSelectionResult(raw: unknown): PlateSelectionResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid plate selection response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) return { ok: false, error: typeof value.error === 'string' ? value.error : 'plate selection request failed' };
  if (value.version !== 1 || typeof value.current_plate_id !== 'string' || value.current_plate_id.length === 0)
    return { ok: false, error: 'invalid plate selection response' };
  return { ok: true, version: 1, currentPlateId: value.current_plate_id };
}

function normalizePlateMutationResult(raw: unknown): PlateSessionMutationResult {
  const result = normalizePlateSessionResult(raw);
  if (!result.ok) return result;
  if (!result.instanceTransforms) return { ok: false, error: 'plate mutation omitted instance transforms' };
  return result as PlateSessionMutationResult;
}

function normalizeCount(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
}

function normalizePrimeTowerProjection(raw: unknown): PrimeTowerProjectionResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid prime tower projection response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) {
    if (value.version !== 1 || typeof value.error !== 'string')
      return { ok: false, error: 'invalid prime tower projection error envelope' };
    return { ok: false, version: 1, error: value.error };
  }
  if (value.version !== 1 || typeof value.current_plate_id !== 'string' || !Array.isArray(value.plates))
    return { ok: false, error: 'invalid prime tower projection response' };
  const finite = (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry);
  const nonNegative = (entry: unknown): entry is number => finite(entry) && entry >= 0;
  const same = (left: number, right: number): boolean =>
    Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
  const area = (entry: unknown): PrimeTowerBuildArea | null => {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (![item.min_x, item.max_x, item.min_y, item.max_y, item.max_z].every(finite) ||
        (item.max_x as number) < (item.min_x as number) || (item.max_y as number) < (item.min_y as number) ||
        (item.max_z as number) < 0) return null;
    return { minX: item.min_x as number, maxX: item.max_x as number,
      minY: item.min_y as number, maxY: item.max_y as number, maxZ: item.max_z as number };
  };
  const buildArea = area(value.build_area);
  if (!buildArea) return { ok: false, error: 'invalid prime tower projection build area' };
  const ids = new Set<string>();
  const plates = value.plates.map((entry): PrimeTowerPlateProjection | null => {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    const plateArea = area(item.build_area);
    const position = item.position;
    const footprint = item.footprint;
    if (typeof item.plate_id !== 'string' || item.plate_id.length === 0 || ids.has(item.plate_id) ||
        !Number.isSafeInteger(item.display_index) || (item.display_index as number) < 0 ||
        typeof item.eligible !== 'boolean' ||
        typeof item.empty !== 'boolean' || typeof item.forced !== 'boolean' || !Array.isArray(item.used_slots) ||
        !item.used_slots.every((slot) => Number.isSafeInteger(slot) && (slot as number) >= 1) ||
        new Set(item.used_slots as number[]).size !== item.used_slots.length ||
        ![item.width, item.depth, item.height, item.rotation, item.brim_margin].every(finite) ||
        !position || typeof position !== 'object' || !finite((position as Record<string, unknown>).x) ||
        !finite((position as Record<string, unknown>).y) || !footprint || typeof footprint !== 'object' ||
        ![ 'min_x', 'max_x', 'min_y', 'max_y' ].every((key) => finite((footprint as Record<string, unknown>)[key])) ||
        !plateArea || !Array.isArray(item.bands)) return null;
    if ([item.width, item.depth, item.height, item.brim_margin].some((entry) => !nonNegative(entry)) ||
        (item.eligible !== ((item.width as number) > 0)) ||
        (item.eligible && (item.depth as number) <= 0) ||
        (item.eligible && (item.height as number) < 0.1) ||
        (item.eligible && (item.empty || (item.used_slots as unknown[]).length === 0))) return null;
    const bands = item.bands.map((entry): PrimeTowerBand | null => {
      if (!entry || typeof entry !== 'object') return null;
      const band = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(band.slot) || (band.slot as number) < 1 || !finite(band.start_depth) ||
          !finite(band.end_depth) || !nonNegative(band.start_depth) || !nonNegative(band.end_depth) ||
          (band.end_depth as number) < (band.start_depth as number) ||
          typeof band.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(band.colour) ||
          !finite(band.opacity) || (band.opacity as number) < 0 || (band.opacity as number) > 1) return null;
      return { slot: band.slot as number, startDepth: band.start_depth as number,
        endDepth: band.end_depth as number, colour: band.colour, opacity: band.opacity as number };
    });
    const typedBands = bands as PrimeTowerBand[];
    if (bands.some((band) => band === null) || bands.length !== (item.eligible ? (item.used_slots as unknown[]).length : 0) ||
        bands.some((band, index) => band!.slot !== (item.used_slots as number[])[index]) ||
        (typedBands.length > 0 && !same(typedBands[0].startDepth, 0)) ||
        typedBands.some((band, index) => index > 0 && !same(band.startDepth, typedBands[index - 1].endDepth)) ||
        (typedBands.length > 0 && !same(typedBands[typedBands.length - 1].endDepth, item.depth as number))) return null;
    ids.add(item.plate_id);
    const fp = footprint as Record<string, unknown>;
    if ((fp.max_x as number) < (fp.min_x as number) || (fp.max_y as number) < (fp.min_y as number)) return null;
    return { plateId: item.plate_id, displayIndex: item.display_index as number,
      eligible: item.eligible, empty: item.empty, forced: item.forced,
      usedSlots: item.used_slots as number[], width: item.width as number, depth: item.depth as number,
      height: item.height as number,
      position: { x: (position as Record<string, unknown>).x as number, y: (position as Record<string, unknown>).y as number },
        rotation: item.rotation as number, brimMargin: item.brim_margin as number,
      footprint: { minX: fp.min_x as number, maxX: fp.max_x as number,
        minY: fp.min_y as number, maxY: fp.max_y as number }, bands: typedBands,
      buildArea: plateArea,
      ...(typeof item.outside_boundary_warning === 'boolean'
        ? { outsideBoundaryWarning: item.outside_boundary_warning } : {}) };
  });
  if (plates.some((plate) => plate === null) || plates.length === 0 || !ids.has(value.current_plate_id))
    return { ok: false, error: 'invalid prime tower projection plates' };
  return { ok: true, version: 1, currentPlateId: value.current_plate_id,
    buildArea, plates: plates as PrimeTowerPlateProjection[] };
}

function normalizePrimeTowerMoveResult(raw: unknown): PrimeTowerMoveResultOrError {
  if (!isRecord(raw)) return { ok: false, version: 1, error: 'invalid prime tower move response', errorCode: 'invalid_response' };
  if (raw.ok !== true) {
    if (raw.version !== 1 || typeof raw.error !== 'string' || typeof raw.error_code !== 'string')
      return { ok: false, version: 1, error: 'invalid prime tower move error envelope', errorCode: 'invalid_response' };
    return { ok: false, version: 1, error: raw.error, errorCode: raw.error_code,
      ...(isRecord(raw.status) && raw.status.state === 'error' && typeof raw.status.error === 'string'
        ? { status: { state: 'error', error: raw.status.error } } : {}) };
  }
  if (raw.version !== 1 || !isRecord(raw.result))
    return { ok: false, version: 1, error: 'invalid prime tower move result envelope', errorCode: 'invalid_response' };
  const result = raw.result;
  const mutation = result.mutation;
  if (!isRecord(mutation))
    return { ok: false, version: 1, error: 'invalid prime tower move result', errorCode: 'invalid_response' };
  if (mutation.kind !== 'move' || typeof mutation.plate_id !== 'string' ||
      ![mutation.history_entry_delta, mutation.revision_before, mutation.revision_after].every((value) => typeof value === 'number' && Number.isSafeInteger(value)) ||
      (mutation.history_entry_delta !== 0 && mutation.history_entry_delta !== 1) ||
      typeof mutation.dirty !== 'boolean' || !Array.isArray(mutation.affected_plate_ids) ||
      !mutation.affected_plate_ids.every((value) => typeof value === 'string'))
    return { ok: false, version: 1, error: 'invalid prime tower move mutation', errorCode: 'invalid_response' };
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  const position = mutation.position;
  if (!isRecord(position) || !finite(position.x) || !finite(position.y))
    return { ok: false, version: 1, error: 'invalid prime tower move position', errorCode: 'invalid_response' };
  const footprint = mutation.footprint;
  if (!isRecord(footprint) || ![footprint.min_x, footprint.max_x, footprint.min_y, footprint.max_y].every(finite))
    return { ok: false, version: 1, error: 'invalid prime tower move footprint', errorCode: 'invalid_response' };
  const typedMutation = {
    kind: 'move' as const, plateId: mutation.plate_id,
    historyEntryDelta: mutation.history_entry_delta as 0 | 1,
    revisionBefore: mutation.revision_before as number, revisionAfter: mutation.revision_after as number,
    dirty: mutation.dirty, affectedPlateIds: mutation.affected_plate_ids as string[],
    ...(typeof mutation.clamped === 'boolean' ? { clamped: mutation.clamped } : {}),
    ...(typeof mutation.outside_boundary_warning === 'boolean' ? { outsideBoundaryWarning: mutation.outside_boundary_warning } : {}),
    ...(typeof mutation.warning === 'string' && mutation.warning.length > 0 ? { warning: mutation.warning } : {}),
    position: { x: position.x as number, y: position.y as number },
    footprint: { minX: footprint.min_x as number, maxX: footprint.max_x as number,
      minY: footprint.min_y as number, maxY: footprint.max_y as number },
  };
  if (!isRecord(result.history_status))
    return { ok: false, version: 1, error: 'invalid prime tower history status', errorCode: 'invalid_response' };
  let historyStatus: import('./history').HistoryStatus;
  try { historyStatus = normalizeHistoryStatus(result.history_status); }
  catch { return { ok: false, version: 1, error: 'invalid prime tower history status', errorCode: 'invalid_response' }; }
  return { ok: true, version: 1, result: { mutation: typedMutation, historyStatus } };
}

/** Convert the native profile/catalogue payload into the public profile
 * contract, including the engine-filtered filament catalogue. */
function normalizeProfileSnapshot(raw: Record<string, unknown>): ProfileSnapshotResult {
  if (raw.ok !== true) return raw as unknown as ProfileSnapshotResult;
  return {
    ok: true,
    printers: (Array.isArray(raw.printers) ? raw.printers : []) as ProfileSnapshot['printers'],
    prints: (Array.isArray(raw.prints) ? raw.prints : []) as ProfileSnapshot['prints'],
    filamentCatalog: (Array.isArray(raw.filament_catalog) ? raw.filament_catalog : []) as ProfileSnapshot['filamentCatalog'],
    printer: raw.printer as ProfileSnapshot['printer'],
    print: raw.print as ProfileSnapshot['print'],
    ...(Array.isArray(raw.printable_area) ? { printable_area: raw.printable_area as Array<[number, number]> } : {}),
    ...(raw.project_config && typeof raw.project_config === 'object'
      ? { project_config: raw.project_config as Record<string, string> } : {}),
  };
}

function normalizeLoadModelResult(raw: unknown): LoadModelResult {
  if (!raw || typeof raw !== 'object') return { ok: false, objects: 0, instances: 0, error: 'invalid model mutation response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) return { ok: false, objects: 0, instances: 0, error: typeof value.error === 'string' ? value.error : 'model mutation failed' };
  const objects = normalizeCount(value.objects ?? 0);
  const instances = normalizeCount(value.instances ?? 0);
  if (objects === null || instances === null) {
    return { ok: false, objects: 0, instances: 0, error: 'invalid model mutation counts' };
  }
  const nested = value.plate_session;
  const plateSession = nested ? normalizePlateMutationResult(nested) : undefined;
  return { ok: true, objects, instances,
    ...(plateSession?.ok ? { plateSession } : {}) };
}

function normalizeDeleteResult(raw: unknown): DeleteObjectsResult & DeleteVolumesResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid model mutation response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) return { ok: false, error: typeof value.error === 'string' ? value.error : 'model mutation failed' };
  const nested = value.plate_session;
  const plateSession = nested ? normalizePlateMutationResult(nested) : undefined;
  return { ok: true, objects: Number(value.objects ?? 0), deleted: Number(value.deleted ?? 0),
    ...(plateSession?.ok ? { plateSession } : {}) };
}

function normalizeClearResult(raw: unknown): ClearModelResult {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'invalid model mutation response' };
  const value = raw as Record<string, unknown>;
  if (value.ok !== true) return { ok: false, error: typeof value.error === 'string' ? value.error : 'model mutation failed' };
  const nested = value.plate_session;
  const plateSession = nested ? normalizePlateMutationResult(nested) : undefined;
  return { ok: true, ...(plateSession?.ok ? { plateSession } : {}) };
}

function historyFailure(raw: unknown, fallback: string): never {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const error = value.error;
  const message = typeof error === 'string' ? error
    : error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
      ? String((error as Record<string, unknown>).message) : fallback;
  throw new Error(message);
}

function normalizeHistoryStatus(raw: unknown): HistoryStatus {
  if (!raw || typeof raw !== 'object') return historyFailure(raw, 'invalid history status');
  const value = raw as Record<string, unknown>;
  const bool = (key: string): boolean => typeof value[key] === 'boolean' ? value[key] as boolean : false;
  const integer = (key: string, fallback = 0): number =>
    typeof value[key] === 'number' && Number.isSafeInteger(value[key]) ? value[key] as number : fallback;
  const entries = (key: string): HistoryStatus['undoEntries'] => {
    if (!Array.isArray(value[key])) return [];
    return value[key].flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const item = entry as Record<string, unknown>;
      return typeof item.id === 'string' && typeof item.label === 'string' &&
        (item.category === 'project' || item.category === 'context')
        ? [{ id: item.id, label: item.label, category: item.category }] : [];
    });
  };
  const saved = value.savedCheckpoint;
  return {
    canUndo: bool('canUndo'), canRedo: bool('canRedo'),
    ...(typeof value.undoLabel === 'string' ? { undoLabel: value.undoLabel } : {}),
    ...(typeof value.redoLabel === 'string' ? { redoLabel: value.redoLabel } : {}),
    undoEntries: entries('undoEntries'), redoEntries: entries('redoEntries'),
    cursor: integer('cursor'),
    savedCheckpoint: saved === null ? null : typeof saved === 'number' && Number.isSafeInteger(saved) ? saved : null,
    savedCheckpointEvicted: bool('savedCheckpointEvicted'), dirty: bool('dirty'),
    bytesUsed: integer('bytesUsed'), byteBudget: integer('byteBudget'), disabled: bool('disabled'),
    optionalBytesReleased: integer('optionalBytesReleased'),
    evictedEntryCount: integer('evictedEntryCount'),
    lastEvictedEntryId: typeof value.lastEvictedEntryId === 'string' ? value.lastEvictedEntryId : null,
    oldestRetainedEntryId: typeof value.oldestRetainedEntryId === 'string' ? value.oldestRetainedEntryId : null,
    oversizedEntryRetained: bool('oversizedEntryRetained'),
    activeTransactionId: typeof value.activeTransactionId === 'string' ? value.activeTransactionId : null,
    revision: integer('revision'),
  };
}

function normalizeHistoryRestore(raw: unknown): RestoreResult {
  if (!raw || typeof raw !== 'object') return historyFailure(raw, 'invalid history restore response');
  const value = raw as Record<string, unknown>;
  // Restore failures are deliberately data, not thrown protocol errors.  The
  // Worker has preserved the old model/cursor and callers may retry after a
  // transient parse, memory, or validation failure.
  if (value.ok === false && value.error && typeof value.error === 'object') {
    const error = value.error as Record<string, unknown>;
    if (typeof error.message === 'string' && typeof error.code === 'string' &&
        typeof error.retryable === 'boolean') {
      return {
        ok: false,
        error: {
          code: error.code as import('./history').HistoryErrorCode,
          message: error.message,
          retryable: error.retryable,
          ...(typeof error.transactionId === 'string' ? { transactionId: error.transactionId } : {}),
        },
        ...(value.status ? { status: normalizeHistoryStatus(value.status) } : {}),
      };
    }
  }
  if (value.ok !== true) return historyFailure(raw, 'history restore failed');
  if (!value.context || typeof value.context !== 'object' || !value.status)
    return historyFailure(raw, 'invalid history restore response');
  const impact = normalizeRestoreImpact(value.impact);
  const primeTowerReceipt = normalizePrimeTowerRestoreReceipt(value.prime_tower_receipt, impact, value.narrow);
  const transformReceipt = normalizeTransformRestoreReceipt(value.transform_receipt, impact, value.direct, value.narrow);
  let instanceTransforms: import('./types').PlateSessionInstanceTransform[] | undefined;
  if (Array.isArray(value.instance_transforms)) {
    const transforms = value.instance_transforms.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as Record<string, unknown>;
      if (![item.instance_id, item.object_id].every((id) => Number.isSafeInteger(id) && (id as number) > 0) ||
        ![item.object_index, item.instance_index].every((id) => Number.isSafeInteger(id) && (id as number) >= 0) ||
        !item.world_transform || typeof item.world_transform !== 'object') return null;
      return { instanceId: item.instance_id as number, objectId: item.object_id as number,
        objectIndex: item.object_index as number, instanceIndex: item.instance_index as number,
        worldTransform: item.world_transform as import('./types').ModelTransform };
    });
    if (transforms.some((transform) => transform === null)) return historyFailure(raw, 'invalid history instance transforms');
    instanceTransforms = transforms as import('./types').PlateSessionInstanceTransform[];
  }
  const context = normalizeHistoryContext(value.context);
  if (!context) return historyFailure(raw, 'invalid history context');
  return {
    ok: true,
    context,
    status: normalizeHistoryStatus(value.status),
    ...(typeof value.entryId === 'string' ? { entryId: value.entryId } : {}),
    impact,
    ...(primeTowerReceipt ? { primeTowerReceipt } : {}),
    ...(transformReceipt ? { transformReceipt } : {}),
    ...(instanceTransforms ? { instanceTransforms } : {}),
  };
}

/**
 * Normalize the adjacent Move receipt without weakening the full-restore
 * fallback. Native deliberately keeps the impact descriptor broad; only an
 * explicitly direct/narrow response with the complete receipt is eligible
 * for renderer-local projection. A same-session missing/incompatible receipt
 * is a safety fallback, not a cross-version compatibility path.
 */
export function normalizeTransformRestoreReceipt(
  raw: unknown,
  impact: import('./history').RestoreImpact,
  direct: unknown,
  narrow: unknown,
): import('./history').TransformRestoreReceipt | undefined {
  if (direct !== true || narrow !== true || impact.model !== 'full' || !impact.plateSession ||
      !impact.projectOverlay || !impact.selectionContext || impact.filamentRack || impact.preview !== 'all' ||
      !raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || (value.state !== 'before' && value.state !== 'after') ||
      !Number.isSafeInteger(value.before_revision) || (value.before_revision as number) < 0 ||
      !Number.isSafeInteger(value.after_revision) || (value.after_revision as number) < 0 ||
      (value.after_revision as number) !== (value.before_revision as number) + 1 ||
      !Array.isArray(value.records) || value.records.length === 0) return undefined;
  const finiteTuple = (entry: unknown, length: number): entry is number[] =>
    Array.isArray(entry) && entry.length === length && entry.every((item) => typeof item === 'number' && Number.isFinite(item));
  const normalizeTransform = (entry: unknown): import('./types').ModelTransform | undefined => {
    if (!entry || typeof entry !== 'object') return undefined;
    const transform = entry as Record<string, unknown>;
    if (!finiteTuple(transform.offset, 3) || !finiteTuple(transform.rotation, 3) ||
        !finiteTuple(transform.scale, 3) || !finiteTuple(transform.mirror, 3)) return undefined;
    if (transform.matrix !== undefined && !finiteTuple(transform.matrix, 16)) return undefined;
    return {
      offset: [...transform.offset] as [number, number, number],
      rotation: [...transform.rotation] as [number, number, number],
      scale: [...transform.scale] as [number, number, number],
      mirror: [...transform.mirror] as [number, number, number],
      ...(transform.matrix !== undefined ? { matrix: [...transform.matrix] as import('./types').ModelTransform['matrix'] } : {}),
    };
  };
  const seen = new Set<string>();
  const records = value.records.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    const ids = [item.object_id, item.volume_id, item.instance_id];
    const indexes = [item.object_index, item.volume_index, item.instance_index];
    if (!ids.every((id) => Number.isSafeInteger(id) && (id as number) > 0) ||
        !indexes.every((index) => Number.isSafeInteger(index) && (index as number) >= 0)) return null;
    const key = `${item.object_index}:${item.volume_index}:${item.instance_index}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const instanceTransform = normalizeTransform(item.instance_transform);
    const volumeTransform = normalizeTransform(item.volume_transform);
    if (!instanceTransform || !volumeTransform) return null;
    return {
      objectId: item.object_id as number, volumeId: item.volume_id as number, instanceId: item.instance_id as number,
      objectIndex: item.object_index as number, volumeIndex: item.volume_index as number, instanceIndex: item.instance_index as number,
      instanceTransform, volumeTransform,
    };
  });
  if (records.some((record) => record === null)) return undefined;
  return {
    version: 1, state: value.state, beforeRevision: value.before_revision as number,
    afterRevision: value.after_revision as number, records: records as import('./history').TransformRestoreRecord[],
  };
}

/**
 * Receipts are an optional acceleration contract. Invalid same-session data is
 * ignored so callers retain the authoritative projection fallback.
 */
export function normalizePrimeTowerRestoreReceipt(
  raw: unknown,
  impact: import('./history').RestoreImpact,
  narrow: unknown,
): import('./history').PrimeTowerRestoreReceipt | undefined {
  if (narrow !== true || impact.model !== 'none' || !impact.primeTower || !raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.plate_id !== 'string' || value.plate_id.length === 0 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return undefined;
  if (value.state === 'cleared') {
    return { version: 1, state: 'cleared', plateId: value.plate_id, revision: value.revision as number };
  }
  if (value.state !== 'available' || !value.position || typeof value.position !== 'object' ||
      !value.footprint || typeof value.footprint !== 'object') return undefined;
  const position = value.position as Record<string, unknown>;
  const footprint = value.footprint as Record<string, unknown>;
  const finite = (entry: unknown): entry is number => typeof entry === 'number' && Number.isFinite(entry);
  if (![position.x, position.y, footprint.min_x, footprint.max_x, footprint.min_y, footprint.max_y].every(finite) ||
      (footprint.max_x as number) < (footprint.min_x as number) ||
      (footprint.max_y as number) < (footprint.min_y as number)) return undefined;
  return { version: 1, state: 'available', plateId: value.plate_id, revision: value.revision as number,
    position: { x: position.x as number, y: position.y as number },
    footprint: { minX: footprint.min_x as number, maxX: footprint.max_x as number,
      minY: footprint.min_y as number, maxY: footprint.max_y as number } };
}

export function normalizeRestoreImpact(raw: unknown): import('./history').RestoreImpact {
  const fallback: import('./history').RestoreImpact = {
    version: 1, model: 'full', plateSession: true, filamentRack: true,
    projectOverlay: true, selectionContext: true, primeTower: true, preview: 'all',
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || (value.model !== 'full' && value.model !== 'none') ||
      typeof value.plateSession !== 'boolean' || typeof value.filamentRack !== 'boolean' ||
      typeof value.projectOverlay !== 'boolean' || typeof value.selectionContext !== 'boolean' ||
      typeof value.primeTower !== 'boolean' ||
      (value.preview !== 'all' && value.preview !== 'current-plate')) return fallback;
  return value as unknown as import('./history').RestoreImpact;
}

const clientAdmissionChecks = new WeakMap<SlicerClient,
  (observedEpoch: string) => Promise<Record<string, unknown>>>();

/** Worker-only dispatcher which applies the authoritative serial bridge gate. */
export async function dispatchClientRequest(
  client: SlicerClient, operation: string, args: unknown[],
  observedSerialEpoch: string, restricted: boolean,
): Promise<unknown> {
  if (restricted) {
    const check = clientAdmissionChecks.get(client);
    if (check) {
      const admitted = await check(observedSerialEpoch);
      if (admitted.ok !== true) return admitted;
    }
  }
  const method = (client as unknown as Record<string, (...values: unknown[]) => unknown>)[operation];
  if (typeof method !== 'function') throw new Error(`unknown op: ${operation}`);
  return method.apply(client, args);
}

export function createClient(
  moduleFactory: OrcaModuleFactory,
  onBridgeProgress?: (percent: number, text: string) => void,
  beforeInit?: (module: OrcaModule) => Promise<void>,
  onBridgeProjectClosed?: ProjectClosedCallback,
  onRuntimeState?: (state: { threaded: boolean; serialTerminalEpoch: string }) => void,
): SlicerClient {
  let modulePromise: Promise<OrcaModule> | null = null;
  // beforeInit (profile installation in the worker) runs once per client:
  // React StrictMode double-mounts the boot effect in dev, sending init
  // twice — the second call must not re-fetch/re-install profiles. A rejected
  // install clears the memo so a later init can retry.
  let beforeInitPromise: Promise<void> | null = null;
  const progressListeners = new Set<(percent: number, text: string) => void>();
  type TaskMessage = {
    type: 'progress' | 'task-terminal'; sequence: string; task_id: string; kind: string;
    plate_id?: string; entry_incarnation?: string; percent?: number; text?: string;
    terminal?: string; result?: unknown;
  };
  const pendingSliceTasks = new Map<string, {
    plateId: string; incarnation: string;
    resolve: (result: SliceResultStatus) => void;
  }>();
  const terminalSliceResults = new Map<string, SliceResultStatus>();
  let lastTaskMessageSequence = 0n;
  let asyncWake: { buffer: SharedArrayBuffer; byteOffset: number; sequence: number } | undefined;
  let asyncWakeTimer: ReturnType<typeof setInterval> | undefined;
  let activeModule: OrcaModule | undefined;
  let drainingTaskMessages = false;
  let runtimeThreaded = false;
  let serialTerminalEpoch = 0n;
  let serialSliceAdmissionInProgress = false;
  const realProjectProfileCalls: Array<{
    operation: string;
    wallMs: number;
    inputJsonBytes: number;
    outputJsonBytes: number;
  }> | null = REAL_PROJECT_PROFILE_BUILD ? [] : null;

  function callProfiledJson(
    wasm: OrcaModule,
    name: string,
    argTypes: string[],
    args: unknown[],
  ): unknown {
    if (!REAL_PROJECT_PROFILE_BUILD) return callJson(wasm, name, argTypes, args);
    const startedAt = performance.now();
    const result = callJson(wasm, name, argTypes, args);
    const encoder = new TextEncoder();
    const inputJsonBytes = args.reduce<number>((total, value) =>
      total + (typeof value === 'string' ? encoder.encode(value).byteLength : 0), 0);
    const outputJsonBytes = encoder.encode(JSON.stringify(result)).byteLength;
    realProjectProfileCalls!.push({
      operation: name,
      wallMs: performance.now() - startedAt,
      inputJsonBytes,
      outputJsonBytes,
    });
    if (realProjectProfileCalls!.length > 64) realProjectProfileCalls!.shift();
    return result;
  }

  function handleTaskMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as Partial<TaskMessage>;
    if (typeof message.sequence !== 'string' || typeof message.task_id !== 'string' ||
        typeof message.kind !== 'string' ||
        (message.type !== 'progress' && message.type !== 'task-terminal')) return;
    let sequence: bigint;
    try { sequence = BigInt(message.sequence); } catch { return; }
    if (sequence <= lastTaskMessageSequence) return;
    lastTaskMessageSequence = sequence;

    const pending = pendingSliceTasks.get(message.task_id);
    const identityMatches = message.kind !== 'slice' ||
      (pending !== undefined && message.plate_id === pending.plateId &&
        message.entry_incarnation === pending.incarnation) ||
      (pending === undefined && message.type === 'task-terminal') ||
      (!runtimeThreaded && serialSliceAdmissionInProgress);
    if (!identityMatches) return;
    if (message.type === 'progress') {
      // A slice record without the currently accepted task identity is a late
      // delivery from a superseded task. The serial producer is the one
      // exception: Print::process() and its callbacks run before the accepted
      // envelope returns, so that admission window is explicitly tracked.
      if (message.kind === 'slice' && pending === undefined &&
          (runtimeThreaded || !serialSliceAdmissionInProgress)) return;
      if (typeof message.percent !== 'number' || typeof message.text !== 'string') return;
      for (const listener of progressListeners) listener(message.percent, message.text);
      onBridgeProgress?.(message.percent, message.text);
      return;
    }
    if (message.kind !== 'slice') return;
    const result = normalizeSliceResultStatus(message.result);
    if (!runtimeThreaded) {
      serialTerminalEpoch += 1n;
      onRuntimeState?.({ threaded: false, serialTerminalEpoch: serialTerminalEpoch.toString() });
    }
    if (pending) {
      pendingSliceTasks.delete(message.task_id);
      pending.resolve(result);
    } else {
      terminalSliceResults.set(message.task_id, result);
    }
  }

  function drainTaskMessages(m = activeModule): void {
    if (!m || drainingTaskMessages) return;
    drainingTaskMessages = true;
    try {
      const drained = callJson(m, 'orc_drain_async_task_mailbox', [], []) as {
        ok?: boolean; messages?: unknown[];
      };
      if (drained.ok && Array.isArray(drained.messages))
        drained.messages.forEach(handleTaskMessage);
    } finally {
      drainingTaskMessages = false;
    }
  }

  function awaitSliceTask(accepted: Record<string, unknown>): Promise<SliceResultStatus> {
    const taskId = typeof accepted.task_id === 'string' ? accepted.task_id : '';
    const plateId = typeof accepted.plate_id === 'string' ? accepted.plate_id : '';
    const incarnation = typeof accepted.entry_incarnation === 'string' ? accepted.entry_incarnation : '';
    if (!taskId || !plateId || !incarnation)
      return Promise.resolve(normalizeSliceResultStatus({ error: 'malformed slice task acceptance' }));
    const terminal = terminalSliceResults.get(taskId);
    if (terminal) {
      terminalSliceResults.delete(taskId);
      return Promise.resolve(terminal);
    }
    return new Promise((resolve) => {
      pendingSliceTasks.set(taskId, { plateId, incarnation, resolve });
      drainTaskMessages();
    });
  }

  async function module(): Promise<OrcaModule> {
    if (!modulePromise) {
      modulePromise = moduleFactory({ noInitialRun: true }).then((m) => {
        activeModule = m;
        // Use the regular JSON bridge decoder instead of ccall('string') so
        // wasm64 and the mock module share the same pointer contract.
        const threading = callJson(m, 'orc_get_threading_info', [], []) as {
          threaded?: boolean; serial_terminal_epoch?: string;
        };
        runtimeThreaded = threading.threaded === true;
        try { serialTerminalEpoch = BigInt(threading.serial_terminal_epoch ?? '0'); }
        catch { serialTerminalEpoch = 0n; }
        onRuntimeState?.({ threaded: runtimeThreaded,
          serialTerminalEpoch: serialTerminalEpoch.toString() });
        const mailbox = callJson(m, 'orc_get_async_task_mailbox', [], []) as {
          ok?: boolean; byte_offset?: number;
        };
        if (threading.threaded) {
          const buffer = m.HEAPU8.buffer;
          if (mailbox.ok && buffer instanceof SharedArrayBuffer &&
              Number.isSafeInteger(mailbox.byte_offset)) {
            asyncWake = { buffer, byteOffset: Number(mailbox.byte_offset), sequence: -1 };
            asyncWakeTimer = setInterval(() => {
              if (!asyncWake) return;
              const words = new Int32Array(asyncWake.buffer, asyncWake.byteOffset, 4);
              const before = Atomics.load(words, 0);
              if ((before & 1) !== 0 || before === asyncWake.sequence) return;
              if (before !== Atomics.load(words, 0)) return;
              asyncWake.sequence = before;
              drainTaskMessages(m);
            }, 20);
          }
          return m;
        }

        // Serial producers notify after enqueue. Re-enter only the FIFO drain;
        // the mailbox mutex has already been released and no task state is
        // mutated by the callback itself.
        const cb = m.addFunction(() => drainTaskMessages(m), 'v');
        m.ccall('orc_set_async_task_callback', 'void', ['pointer'], [cb]);
        return m;
      });
    }
    return modulePromise;
  }

  async function beginHistory(label: HistoryLabel, category: HistoryCategory,
                              beforeContext: HistoryContext,
                              options?: HistoryTransactionOptions): Promise<HistoryTransactionId> {
    const m = await module();
    const raw = callProfiledJson(m, 'orc_history_begin', ['string', 'string', 'string', 'string'],
      [label, category, JSON.stringify(beforeContext), options ? JSON.stringify(options) : '']) as Record<string, unknown>;
    if (raw?.ok !== true || typeof raw.transactionId !== 'string')
      return historyFailure(raw, 'history begin failed');
    return raw.transactionId;
  }

  async function commitHistory(transactionId: HistoryTransactionId,
                               afterContext: HistoryContext): Promise<HistoryStatus> {
    const m = await module();
    const raw = callProfiledJson(m, 'orc_history_commit', ['string', 'string'],
      [transactionId, JSON.stringify(afterContext)]);
    if (raw && typeof raw === 'object' && 'error' in (raw as Record<string, unknown>))
      return historyFailure(raw, 'history commit failed');
    return normalizeHistoryStatus(raw);
  }

  async function abortHistory(transactionId: HistoryTransactionId): Promise<RestoreResult> {
    const m = await module();
    return normalizeHistoryRestore(callJson(m, 'orc_history_abort', ['string'], [transactionId]));
  }

  async function undoHistory(): Promise<RestoreResult> {
    const m = await module();
    return normalizeHistoryRestore(callProfiledJson(m, 'orc_history_undo', [], []));
  }

  async function redoHistory(): Promise<RestoreResult> {
    const m = await module();
    return normalizeHistoryRestore(callJson(m, 'orc_history_redo', [], []));
  }

  async function jumpHistory(entryId: HistoryEntryId, direction: HistoryJumpDirection): Promise<RestoreResult> {
    const m = await module();
    return normalizeHistoryRestore(callJson(m, 'orc_history_jump', ['string', 'string'], [entryId, direction]));
  }

  async function getHistoryStatus(): Promise<HistoryStatus> {
    const m = await module();
    return normalizeHistoryStatus(callJson(m, 'orc_history_status', [], []));
  }

  async function markHistorySaved(context?: HistoryContext): Promise<HistoryStatus> {
    const m = await module();
    return normalizeHistoryStatus(callJson(m, 'orc_history_mark_saved', ['string'], [context ? JSON.stringify(context) : '']));
  }

  async function recordHistoryContext(label: HistoryLabel, context: HistoryContext): Promise<HistoryStatus> {
    const m = await module();
    return normalizeHistoryStatus(callJson(m, 'orc_history_record_context', ['string', 'string'], [label, JSON.stringify(context)]));
  }

  async function resetHistory(context: HistoryContext): Promise<HistoryStatus> {
    const m = await module();
    return normalizeHistoryStatus(callJson(m, 'orc_history_reset', ['string'], [JSON.stringify(context)]));
  }

  async function runProjectHistoryTransaction<T>(
    label: HistoryLabel,
    category: HistoryCategory,
    beforeContext: HistoryContext,
    mutation: (transactionId: HistoryTransactionId) => Promise<T>,
    afterContext: HistoryContext | (() => HistoryContext | Promise<HistoryContext>),
  ): Promise<{ result: T; status: HistoryStatus }> {
    const transactionId = await beginHistory(label, category, beforeContext);
    try {
      const result = await mutation(transactionId);
      const context = typeof afterContext === 'function' ? await afterContext() : afterContext;
      return { result, status: await commitHistory(transactionId, context) };
    } catch (error) {
      try { await abortHistory(transactionId); } catch { /* preserve the mutation error */ }
      throw error;
    }
  }

  const client: SlicerClient = {
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

    async getFilamentSessionSnapshot(): Promise<FilamentSessionSnapshotResult> {
      const m = await module();
      return normalizeFilamentSessionResult(callJson(m, 'orc_get_filament_session_snapshot', [], []));
    },

    async selectFilamentSlotPreset(request: FilamentSlotPresetRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_select_filament_slot_preset', ['string'], [JSON.stringify(request)]));
    },

    async setFilamentSlotColour(request: FilamentSlotColourRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_set_filament_slot_colour', ['string'], [JSON.stringify(request)]));
    },

    async addFilamentSlot(request: FilamentCommandRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_add_filament_slot', ['string'], [JSON.stringify(request)]));
    },

    async deleteFilamentSlot(request: FilamentSlotDeleteRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_delete_filament_slot', ['string'], [JSON.stringify(request)]));
    },

    async mergeFilamentSlots(request: FilamentSlotMergeRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_merge_filament_slots', ['string'], [JSON.stringify(request)]));
    },

    async applyRememberedFilamentRack(request: RememberedFilamentRackRequest): Promise<FilamentSessionSnapshotResult> {
      const m = await module();
      return normalizeFilamentSessionResult(callJson(m, 'orc_apply_remembered_filament_rack', ['string'], [JSON.stringify(request)]));
    },

    async assignFilament(request: FilamentAssignmentRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_assign_filament', ['string'], [JSON.stringify(request)]));
    },

    async setFilamentRouting(request: FilamentRoutingRequest): Promise<FilamentMutationResultOrError> {
      const m = await module();
      return normalizeFilamentMutationResult(callJson(m, 'orc_set_filament_routing', ['string'], [JSON.stringify(request)]));
    },

    beginHistory,
    commitHistory,
    abortHistory,
    undoHistory,
    redoHistory,
    jumpHistory,
    getHistoryStatus,
    markHistorySaved,
    recordHistoryContext,
    resetHistory,
    getHistoryDiagnostics: () => ({ version: 1 as const, worker: emptyHistoryDiagnosticLayer(), client: emptyHistoryDiagnosticLayer() }),
    async takeNativePerformanceProfile(): Promise<NativePerformanceProfile> {
      const m = await module();
      return normalizeNativePerformanceProfile(callJson(m, 'orc_take_performance_profile', [], []));
    },
    runProjectHistoryTransaction,

    async getPlateSessionSnapshot(): Promise<PlateSessionSnapshotResult> {
      const m = await module();
      return normalizePlateSessionResult(callJson(m, 'orc_get_plate_session_snapshot', [], []));
    },

    async getPrimeTowerProjection(): Promise<PrimeTowerProjectionResult> {
      const m = await module();
      return normalizePrimeTowerProjection(callJson(m, 'orc_get_prime_tower_projection', [], []));
    },

    async movePrimeTower(request: PrimeTowerMoveRequest): Promise<PrimeTowerMoveResultOrError> {
      const m = await module();
      return normalizePrimeTowerMoveResult(callJson(m, 'orc_move_prime_tower', ['string'], [JSON.stringify({
        version: request.version, plate_id: request.plateId, revision: request.revision,
        x: request.x, y: request.y,
      })]));
    },

    async resetPlateSession(): Promise<PlateSessionSnapshotResult> {
      const m = await module();
      return normalizePlateSessionResult(callJson(m, 'orc_reset_plate_session', [], []));
    },

    async selectPlate(plateId: string): Promise<PlateSelectionResult> {
      const m = await module();
      return normalizePlateSelectionResult(callJson(m, 'orc_select_plate', ['string'], [plateId]));
    },

    async addPlate(): Promise<PlateSessionMutationResult> {
      const m = await module();
      return normalizePlateMutationResult(callProfiledJson(m, 'orc_add_plate', [], []));
    },

    async reorderPlates(plateIds: string[]): Promise<PlateSessionMutationResult> {
      const m = await module();
      return normalizePlateMutationResult(callJson(m, 'orc_reorder_plates', ['string'], [JSON.stringify(plateIds)]));
    },

    async deletePlate(plateId: string): Promise<PlateSessionMutationResult> {
      const m = await module();
      return normalizePlateMutationResult(callJson(m, 'orc_delete_plate', ['string'], [plateId]));
    },

    async recomputePlateMembership(): Promise<PlateSessionMutationResult> {
      const m = await module();
      return normalizePlateMutationResult(callJson(m, 'orc_recompute_plate_membership', [], []));
    },

    async markSharedConfigurationMutation(): Promise<PlateSessionMutationResult> {
      const m = await module();
      return normalizePlateMutationResult(callJson(m, 'orc_mark_shared_configuration_mutation', [], []));
    },

    async getProjectConfigOverlay(): Promise<ProjectConfigOverlayResultOrError> {
      const m = await module();
      return normalizeProjectConfigOverlay(callJson(m, 'orc_get_project_config_overlay', [], []));
    },

    async setProjectConfigOverride(target: ProjectConfigOverrideTarget, optionKey: string, value: string): Promise<ProjectConfigOverlayResultOrError> {
      const m = await module();
      const scopeId = target.id === undefined ? '' : String(target.id);
      const raw = callJson(m, 'orc_set_project_config_override', ['string', 'string', 'string', 'string'],
        [target.scope, scopeId, optionKey, value]);
      return normalizeProjectConfigOverlay(raw);
    },

    async revalidateProjectConfigOverlay(): Promise<ProjectConfigOverlayResultOrError> {
      const m = await module();
      return normalizeProjectConfigOverlay(callJson(m, 'orc_revalidate_project_config_overlay', [], []));
    },

    async getProfileSnapshot(): Promise<ProfileSnapshotResult> {
      const m = await module();
      return normalizeProfileSnapshot(callJson(m, 'orc_get_preset_snapshot', [], []) as Record<string, unknown>);
    },

    async selectProfile(kind: 'printer' | 'print', name: string): Promise<ProfileSnapshotResult> {
      const m = await module();
      return normalizeProfileSnapshot(callJson(m, 'orc_select_preset', ['string', 'string'], [kind, name]) as Record<string, unknown>);
    },

    async getOptionMetadata(): Promise<OptionMetadata> {
      const m = await module();
      return callJson(m, 'orc_get_option_metadata', [], []) as OptionMetadata;
    },

    async addModel(bytes: Uint8Array, ext: string, displayName?: string): Promise<LoadModelResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        return normalizeLoadModelResult(callJson(m, 'orc_add_model', ['pointer', 'number', 'string', 'string'],
                        [ptr, bytes.length, ext, displayName ?? '']));
      } finally {
        m._free(ptr);
      }
    },

    async closeProject(): Promise<ProjectCloseResult> {
      const m = await module();
      const r = callJson(m, 'orc_close_project', [], []) as Record<string, unknown>;
      if (!r.ok) return { ok: false, error: typeof r.error === 'string' ? r.error : 'project close failed' };
      const plateSession = normalizePlateMutationResult(r.plate_session);
      if (!plateSession.ok) return { ok: false, error: plateSession.error ?? 'invalid closed project session' };
      onBridgeProjectClosed?.(plateSession);
      return { ok: true, plateSession };
    },

    async loadProject(bytes: Uint8Array, mode: ProjectLoadMode = 'project', displayName?: string, onProgress?: ProjectProgressCallback, onProjectClosed?: ProjectClosedCallback): Promise<ProjectLoadResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      if (onProgress) progressListeners.add(onProgress);
      try {
        let nativeName = 'orc_load_project';
        let argumentTypes: ('pointer' | 'number' | 'string')[] = ['pointer', 'number', 'number', 'string'];
        let args: unknown[] = [ptr, bytes.length, mode === 'geometry-only' ? 1 : 0, displayName ?? ''];
        if (mode === 'project') {
          const closed = callJson(m, 'orc_close_project', [], []) as Record<string, unknown>;
          if (!closed.ok) return { ok: false, objects: 0, instances: 0,
            error: typeof closed.error === 'string' ? closed.error : 'project close failed' };
          const plateSession = normalizePlateMutationResult(closed.plate_session);
          if (!plateSession.ok) return { ok: false, objects: 0, instances: 0,
            error: plateSession.error ?? 'invalid closed project session' };
          onBridgeProjectClosed?.(plateSession);
          if (onProjectClosed !== onBridgeProjectClosed) onProjectClosed?.(plateSession);
          nativeName = 'orc_load_project_after_close';
          argumentTypes = ['pointer', 'number', 'string'];
          args = [ptr, bytes.length, displayName ?? ''];
        }
        const r = callJson(m, nativeName, argumentTypes, args) as Record<string, unknown>;
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
            filamentSlotChanges: Array.isArray(warnings.filament_slot_changes) ? warnings.filament_slot_changes.flatMap((change) => {
              if (!change || typeof change !== 'object') return [];
              const item = change as Record<string, unknown>;
              if (!Number.isInteger(item.slot) || (item.slot as number) < 1 || typeof item.before !== 'string' ||
                  typeof item.after !== 'string' || item.reason !== 'native-compatibility') return [];
              return [{ slot: item.slot as number, before: item.before, after: item.after, reason: 'native-compatibility' as const }];
            }) : undefined,
          } : undefined,
          presetSnapshot: r.preset_snapshot && typeof r.preset_snapshot === 'object'
            && (r.preset_snapshot as Record<string, unknown>).ok === true
            ? normalizeProfileSnapshot(r.preset_snapshot as Record<string, unknown>) as ProfileSnapshot : undefined,
          ...(r.plate_session ? (() => {
            const plateSession = normalizePlateMutationResult(r.plate_session);
            return plateSession.ok ? { plateSession } : {};
          })() : {}),
          ...(r.project_config_overlay && typeof r.project_config_overlay === 'object'
            ? { projectConfigOverlay: r.project_config_overlay as ProjectConfigOverlay } : {}),
        };
      } finally {
        drainTaskMessages(m);
        m._free(ptr);
        if (onProgress) progressListeners.delete(onProgress);
      }
    },

    async importProjectGeometry(bytes: Uint8Array, displayName?: string, onProgress?: ProjectProgressCallback): Promise<ProjectLoadResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      if (onProgress) progressListeners.add(onProgress);
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
          ...(r.plate_session ? (() => {
            const plateSession = normalizePlateMutationResult(r.plate_session);
            return plateSession.ok ? { plateSession } : {};
          })() : {}),
        };
      } finally {
        drainTaskMessages(m);
        m._free(ptr);
        if (onProgress) progressListeners.delete(onProgress);
      }
    },

    async addShape(type: string, name?: string): Promise<LoadModelResult> {
      const m = await module();
      return normalizeLoadModelResult(callJson(m, 'orc_add_shape', ['string', 'string'],
                      [type, name ?? '']));
    },

    async clearModel(): Promise<ClearModelResult> {
      const m = await module();
      return normalizeClearResult(callJson(m, 'orc_clear_model', [], []));
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

    async setModelTransforms(transactionId, transforms) {
      const m = await module();
      const raw = callProfiledJson(m, 'orc_set_model_transforms', ['string', 'string'],
        [transactionId, JSON.stringify(transforms)]);
      if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).ok !== true)
        return { ok: false, error: typeof (raw as Record<string, unknown> | null)?.error === 'string'
          ? (raw as Record<string, unknown>).error as string : 'atomic model transform failed' };
      const plateSession = normalizePlateMutationResult(raw);
      return plateSession.ok ? { ok: true, plateSession } : { ok: false, error: plateSession.error };
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
      return normalizeDeleteResult(callJson(m, 'orc_delete_objects', ['string'],
                      [JSON.stringify(objectIds)])) as DeleteObjectsResult;
    },

    async deleteVolumes(volumeIds: number[]): Promise<DeleteVolumesResult> {
      const m = await module();
      return normalizeDeleteResult(callJson(m, 'orc_delete_volumes', ['string'],
                      [JSON.stringify(volumeIds)])) as DeleteVolumesResult;
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
        if (!runtimeThreaded) serialSliceAdmissionInProgress = true;
        let raw: unknown;
        try {
          raw = callJson(m, 'orc_slice', ['string'], [JSON.stringify(config)]);
        } finally {
          serialSliceAdmissionInProgress = false;
        }
        if (isRecord(raw) && raw.accepted === true) return await awaitSliceTask(raw);
        drainTaskMessages(m);
        return normalizeSliceResultStatus(raw);
      } finally {
        if (onProgress) progressListeners.delete(onProgress);
      }
    },

    async slicePlate(target: PlateOperationTarget, config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus> {
      const m = await module();
      if (onProgress) progressListeners.add(onProgress);
      try {
        if (!runtimeThreaded) serialSliceAdmissionInProgress = true;
        let raw: unknown;
        try {
          raw = callJson(m, 'orc_slice_plate', ['string', 'string', 'number'], [
            JSON.stringify(config), target.plateId, target.inputRevision,
          ]);
        } finally {
          serialSliceAdmissionInProgress = false;
        }
        if (isRecord(raw) && raw.accepted === true) return await awaitSliceTask(raw);
        drainTaskMessages(m);
        return normalizeSliceResultStatus(raw);
      } finally {
        if (onProgress) progressListeners.delete(onProgress);
      }
    },

    async getSliceResult(expectedReceipt: SliceResultReceipt): Promise<ClientSliceResult> {
      const m = await module();
      const generation = Number(expectedReceipt.resultGeneration);
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error('slice result receipt has an invalid generation');
      const r = callJson(m, 'orc_get_slice_result', ['string', 'number', 'number'], [
        expectedReceipt.plateId, expectedReceipt.inputStamp, generation,
      ]) as {
        ok: boolean; error?: string; objects?: number; layers?: number; preview_version?: number;
        status?: ResultReadStatus;
        receipt?: { plate_id?: string; input_stamp?: number; result_generation?: string; slice_task_id?: string };
        metadata?: {
          result_id?: number; source_filename?: string;
          layer_ranges?: Array<{ id: number; z: number; first_segment: number; segment_count: number }>;
          feature_palette?: Array<ToolpathFeature & { role: number }>;
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
        };
      };
      if (!r.ok) return {
        ...r, status: r.status ?? 'failed',
        objects: 0, layers: 0,
      } as unknown as ClientSliceResult;
      const rawReceipt = r.receipt;
      if (!rawReceipt || typeof rawReceipt.plate_id !== 'string' ||
          !Number.isSafeInteger(rawReceipt.input_stamp) || rawReceipt.input_stamp! < 0 ||
          typeof rawReceipt.result_generation !== 'string' || !/^[1-9]\d*$/.test(rawReceipt.result_generation) ||
          typeof rawReceipt.slice_task_id !== 'string' || !/^\d+$/.test(rawReceipt.slice_task_id))
        throw new Error('slice result bridge returned an invalid receipt');
      const receipt: SliceResultReceipt = {
        plateId: rawReceipt.plate_id,
        inputStamp: rawReceipt.input_stamp!,
        resultGeneration: rawReceipt.result_generation,
        sliceTaskId: rawReceipt.slice_task_id,
      };
      if (receipt.plateId !== expectedReceipt.plateId ||
          receipt.inputStamp !== expectedReceipt.inputStamp ||
          receipt.resultGeneration !== expectedReceipt.resultGeneration ||
          receipt.sliceTaskId !== expectedReceipt.sliceTaskId) {
        return {
          ok: false, status: 'stale', receipt, objects: 0, layers: 0,
          error: 'slice result projection was superseded',
        } as unknown as ClientSliceResult;
      }
      if (r.preview_version !== 2 || !r.metadata || !r.toolpath)
        throw new Error('slice result bridge returned an invalid v2 envelope');

      const requireInteger = (value: unknown, field: string, minimum = 0): number => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
          throw new Error(`slice result bridge returned an invalid ${field}`);
        return value;
      };
      const requirePointer = (value: unknown, field: string, byteLength: number): number => {
        const pointer = requireInteger(value, `${field} pointer`);
        if ((byteLength > 0 && pointer === 0) || (byteLength === 0 && pointer !== 0))
          throw new Error(`slice result bridge returned an invalid ${field} buffer`);
        return pointer;
      };
      const t = r.toolpath;
      const segmentCount = requireInteger(t.segment_count, 'segment count');
      const metadataRaw = r.metadata;
      const resultId = requireInteger(metadataRaw.result_id, 'result id');
      if (!Array.isArray(metadataRaw.layer_ranges) || !Array.isArray(metadataRaw.feature_palette))
        throw new Error('slice result bridge returned incomplete v2 metadata');
      const featurePalette = metadataRaw.feature_palette;
      const roleToFeatureId = new Map<number, number>();
      featurePalette.forEach((entry, index) => {
        if (!entry || !Number.isSafeInteger(entry.id) || entry.id !== index ||
            !Number.isSafeInteger(entry.role) || typeof entry.name !== 'string' ||
            !Array.isArray(entry.color) || entry.color.length !== 3 ||
            !entry.color.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
            roleToFeatureId.has(entry.role))
          throw new Error('slice result bridge returned an invalid feature palette');
        roleToFeatureId.set(entry.role, entry.id);
      });
      const readF32 = (ptr: number | undefined, count: number, field: string): Float32Array => {
        const address = requirePointer(ptr, field, count * Float32Array.BYTES_PER_ELEMENT);
        return count > 0 ? new Float32Array(readBytes(m, address, count * 4).buffer) : new Float32Array(0);
      };
      const readU32 = (ptr: number | undefined, count: number, field: string): Uint32Array => {
        const address = requirePointer(ptr, field, count * Uint32Array.BYTES_PER_ELEMENT);
        return count > 0 ? new Uint32Array(readBytes(m, address, count * 4).buffer) : new Uint32Array(0);
      };
      const readU16 = (ptr: number | undefined, count: number, field: string): Uint16Array => {
        const address = requirePointer(ptr, field, count * Uint16Array.BYTES_PER_ELEMENT);
        return count > 0 ? new Uint16Array(readBytes(m, address, count * 2).buffer) : new Uint16Array(0);
      };
      const readU8 = (ptr: number | undefined, count: number, field: string): Uint8Array => {
        const address = requirePointer(ptr, field, count * Uint8Array.BYTES_PER_ELEMENT);
        return count > 0 ? readBytes(m, address, count) : new Uint8Array(0);
      };
      const requiredPointers: Array<[unknown, string, number]> = [
        [t.starts_ptr, 'starts', segmentCount * 3 * Float32Array.BYTES_PER_ELEMENT],
        [t.ends_ptr, 'ends', segmentCount * 3 * Float32Array.BYTES_PER_ELEMENT],
        [t.layer_id_ptr, 'layer ids', segmentCount * Uint32Array.BYTES_PER_ELEMENT],
        [t.move_order_ptr, 'move orders', segmentCount * Uint32Array.BYTES_PER_ELEMENT],
        [t.gcode_id_ptr, 'G-code ids', segmentCount * Uint32Array.BYTES_PER_ELEMENT],
        [t.move_type_ptr, 'move types', segmentCount * Uint8Array.BYTES_PER_ELEMENT],
        [t.extrusion_role_ptr, 'extrusion roles', segmentCount * Uint16Array.BYTES_PER_ELEMENT],
        [t.extruder_id_ptr, 'extruder ids', segmentCount * Uint8Array.BYTES_PER_ELEMENT],
        [t.color_print_id_ptr, 'colour-print ids', segmentCount * Uint8Array.BYTES_PER_ELEMENT],
        [t.width_ptr, 'widths', segmentCount * Float32Array.BYTES_PER_ELEMENT],
        [t.height_ptr, 'heights', segmentCount * Float32Array.BYTES_PER_ELEMENT],
      ];
      for (const [pointer, field, byteLength] of requiredPointers)
        requirePointer(pointer, field, byteLength);
      for (const [wireName, field] of Object.entries({
        feedrate: 'feedrate', actual_feedrate: 'actualFeedrate',
        volumetric_flow: 'volumetricFlow', actual_volumetric_flow: 'actualVolumetricFlow',
        fan_speed: 'fanSpeed', temperature: 'temperature', pressure_advance: 'pressureAdvance',
        acceleration: 'acceleration', jerk: 'jerk', time: 'time', layer_duration: 'layerDuration',
      })) {
        const descriptor = t.metrics?.[wireName];
        if (descriptor !== undefined) {
          if (!descriptor || descriptor.count !== segmentCount)
            throw new Error(`slice result bridge returned an invalid ${wireName} metric`);
          requirePointer(descriptor.ptr, `${wireName} metric`, descriptor.count * Float32Array.BYTES_PER_ELEMENT);
        }
      }
      const starts = readF32(t.starts_ptr, segmentCount * 3, 'starts');
      const ends = readF32(t.ends_ptr, segmentCount * 3, 'ends');
      const layerIds = readU32(t.layer_id_ptr, segmentCount, 'layer ids');
      const roles = readU16(t.extrusion_role_ptr, segmentCount, 'extrusion roles');
      const metricKeyMap: Record<string, keyof PreviewToolpathMetrics> = {
        feedrate: 'feedrate', actual_feedrate: 'actualFeedrate',
        volumetric_flow: 'volumetricFlow', actual_volumetric_flow: 'actualVolumetricFlow',
        fan_speed: 'fanSpeed', temperature: 'temperature', pressure_advance: 'pressureAdvance',
        acceleration: 'acceleration', jerk: 'jerk', time: 'time', layer_duration: 'layerDuration',
      };
      const metrics: PreviewToolpathMetrics = {};
      for (const [wireName, field] of Object.entries(metricKeyMap)) {
        const descriptor = t.metrics?.[wireName];
        if (descriptor !== undefined) {
          metrics[field] = readF32(descriptor.ptr, descriptor.count, `${wireName} metric`);
        }
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
      const rawAnalysis = metadataRaw.analysis;
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
      const sourceText = metadataRaw.source_text;
      const sourceByteLength = sourceText?.byte_length;
      const metadata: PreviewMetadata = {
        resultId,
        ...(metadataRaw.source_filename ? { sourceFilename: metadataRaw.source_filename } : {}),
        layerRanges: metadataRaw.layer_ranges.map((layer) => ({
          id: layer.id, z: layer.z, firstSegment: layer.first_segment, segmentCount: layer.segment_count,
        })),
        featurePalette,
        ...(metadataRaw.extruder_palette ? { extruderPalette: metadataRaw.extruder_palette } : {}),
        ...(metadataRaw.source_line_mapping ? {
          sourceLineMapping: {
            available: metadataRaw.source_line_mapping.available,
            lineCount: metadataRaw.source_line_mapping.line_count,
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
      const moveOrders = readU32(t.move_order_ptr, segmentCount, 'move orders');
      const gcodeIds = readU32(t.gcode_id_ptr, segmentCount, 'G-code ids');
      const features = new Uint32Array(segmentCount);
      for (let index = 0; index < roles.length; index++) {
        const featureId = roleToFeatureId.get(roles[index]!);
        if (featureId === undefined)
          throw new Error(`slice result bridge feature palette is missing role ${roles[index]}`);
        features[index] = featureId;
      }
      const sourceLineOrderValid = gcodeIds.every((line, index) => index === 0 || line >= gcodeIds[index - 1]);
      const toolpath: ClientToolpath = {
        features,
        palette: featurePalette,
        segmentCount,
        starts,
        ends,
        layerIds,
        moveOrders,
        gcodeIds,
        sourceLineOrderValid,
        moveTypes: readU8(t.move_type_ptr, segmentCount, 'move types'),
        extrusionRoles: roles,
        extruderIds: readU8(t.extruder_id_ptr, segmentCount, 'extruder ids'),
        colorPrintIds: readU8(t.color_print_id_ptr, segmentCount, 'colour-print ids'),
        widths: readF32(t.width_ptr, segmentCount, 'widths'),
        heights: readF32(t.height_ptr, segmentCount, 'heights'),
        metrics,
      };

      return {
        ok: true,
        status: 'ok', receipt,
        objects: requireInteger(r.objects, 'object count'),
        layers: requireInteger(r.layers, 'layer count'),
        toolpath, metadata,
      };
    },

    async exportGcodePlate(receipt: SliceResultReceipt): Promise<ExportGcodeResult> {
      const m = await module();
      const generation = Number(receipt.resultGeneration);
      if (!Number.isSafeInteger(generation) || generation < 1)
        return { ok: false, path: '', bytes: new Uint8Array(0), error: 'invalid result generation' };
      const r = callJson(m, 'orc_export_gcode_plate', ['string', 'number', 'number'], [
        receipt.plateId, receipt.inputStamp, generation,
      ]) as { ok: boolean; status?: ResultReadStatus; path?: string; error?: string };
      if (!r.ok) return {
        ok: false, status: r.status ?? 'failed', path: '', bytes: new Uint8Array(0), error: r.error,
      };
      const path = r.path ?? '';
      const bytes = m.FS.readFile(path);
      return { ok: true, path, bytes };
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
      const generation = Number(request.receipt.resultGeneration);
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new RangeError('preview text receipt has an invalid generation');
      const r = callJson(m, 'orc_read_gcode_chunk',
        ['string', 'number', 'number', 'number', 'number', 'number'], [
        request.receipt.plateId, request.receipt.inputStamp, generation,
        // The result id is intentionally read from the caller's completed
        // result metadata in the app. A zero id is rejected by the bridge.
        request.resultId,
        offset,
        length,
      ]) as {
        ok: boolean;
        status?: ResultReadStatus;
        error?: string;
        offset?: number;
        length?: number;
        eof?: boolean;
        bytes_ptr?: number;
        bytes_length?: number;
      };
      if (!r.ok) return {
        ok: false, status: r.status ?? 'failed', error: r.error,
        offset, text: '', eof: true,
      };
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
      const generation = Number(request.receipt.resultGeneration);
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new RangeError('preview text receipt has an invalid generation');
      const r = callJson(m, 'orc_read_gcode_lines',
        ['string', 'number', 'number', 'number', 'number', 'number'], [
        request.receipt.plateId, request.receipt.inputStamp, generation,
        request.resultId, startLine, lineCount,
      ]) as {
        ok: boolean; status?: ResultReadStatus; error?: string; start_line?: number; line_count?: number;
        eof?: boolean; bytes_ptr?: number; bytes_length?: number;
      };
      if (!r.ok) return {
        ok: false, status: r.status ?? 'failed', error: r.error,
        startLine, lineCount: 0, text: '', eof: true,
      };
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
  clientAdmissionChecks.set(client, async (observedEpoch) => {
    const m = await module();
    return callJson(m, 'orc_check_serial_admission', ['string'], [observedEpoch]) as Record<string, unknown>;
  });
  if (REAL_PROJECT_PROFILE_BUILD) {
    (client as unknown as Record<string, () => Promise<unknown>>).realProjectProfileActiveSliceCount = async () => {
      const m = await module();
      return m.ccall('orc_real_project_profile_active_slice_count', 'number', [], []);
    };
    (client as unknown as Record<string, () => Promise<unknown>>).takeRealProjectProfileSnapshot = async () => {
      const m = await module();
      const native = callJson(m, 'orc_take_real_project_profile_snapshot', [], []) as Record<string, unknown>;
      return {
        ...native,
        js_profile_identity: REAL_PROJECT_PROFILE_JS_SENTINEL,
        js_wasm_calls: realProjectProfileCalls!.splice(0),
        wasm_heap_buffer_bytes_after_read: m.HEAPU8.buffer.byteLength,
      };
    };
  }
  return client;
}
