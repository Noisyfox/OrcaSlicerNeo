// packages/slicer-wasm/src/client/types.ts
// ----------------------------------------------------------------
// Shared types: the OrcaModule shape (structural Emscripten factory
// surface the client needs) and the client's result types. The
// layout of every binary buffer here is the M2 bridge contract
// (Task 1 mock / Task 7 bridge.cpp).
// ----------------------------------------------------------------

export interface OrcaModule {
  ccall: (name: string, ret: string, argTypes: string[], args: unknown[]) => unknown;
  UTF8ToString: (ptr: number) => string;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  addFunction: (fn: (...args: unknown[]) => void, sig: string) => number;
  removeFunction?: (idx: number) => void;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    mkdir?: (path: string) => void;
  };
}

/** Fixed layout published by the threaded C++ bridge in shared Wasm memory. */
export interface ProgressMailbox {
  buffer: SharedArrayBuffer;
  byteOffset: number;
  textCapacity: number;
}

export type OrcaModuleFactory = (opts?: {
  noInitialRun?: boolean;
  print?: (s: string) => void;
  printErr?: (s: string) => void;
}) => Promise<OrcaModule>;

export interface InitResult {
  ok: boolean;
  prints: number;
  filaments: number;
  printers: number;
  error?: string;
}

/** A single headless editing plate owned by the WASM session. */
export interface PlateSessionPlate {
  /** Opaque identity; never derive or persist this value. */
  readonly plateId: string;
  /** Native OrcaSlicer display/order index (zero based). */
  readonly displayIndex: number;
  /** Native world-space origin in millimetres. */
  readonly origin: readonly [number, number, number];
  /** Native-compatible default display name. */
  readonly name: string;
}

/** Atomic read of the WASM-owned plate session. */
export interface PlateSessionSnapshot {
  readonly ok: true;
  readonly version: 1;
  readonly plates: readonly PlateSessionPlate[];
  readonly currentPlateId: string;
}

/** A malformed or rejected plate-session command has no partial state. */
export interface PlateSessionSnapshotError {
  readonly ok?: false;
  readonly error: string;
}

export type PlateSessionSnapshotResult = PlateSessionSnapshot | PlateSessionSnapshotError;

export interface PresetInfo {
  name: string;
  /** Real preset visibility result from the bundled profile state. */
  is_visible: boolean;
  is_default: boolean;
  /** vendor id, empty when the preset has no vendor profile */
  vendor_id: string;
  model: string;
  variant: string;
  /** true when this entry is the collection's current selection (the
   *  picker's value source at boot; updated by selectPreset responses) */
  selected: boolean;
}

export interface PresetSelection {
  name: string;
  /** Index in the engine's complete collection, not the filtered candidate list. */
  idx: number;
}

/**
 * One coherent, picker-ready FFF preset state from the C++ profile engine.
 * The candidate arrays are already filtered by the engine: printers are
 * visible, while prints and filaments are visible and compatible with the
 * final selection context. Preserve their order; do not re-filter or sort in
 * JavaScript.
 */
export interface PresetSnapshot {
  ok: true;
  printers: PresetInfo[];
  prints: PresetInfo[];
  filaments: PresetInfo[];
  printer: PresetSelection;
  print: PresetSelection;
  filament: PresetSelection;
  /** Selected printer's build-plate polygon in slicer XY coordinates (mm). */
  printable_area?: Array<[number, number]>;
}

/** A bridge rejection has no partial snapshot and leaves engine state unchanged. */
export interface PresetSnapshotError {
  ok?: false;
  error: string;
}

export type PresetSnapshotResult = PresetSnapshot | PresetSnapshotError;

/** @deprecated Use PresetSnapshotResult; retained during the API migration. */
export type SelectPresetResult = PresetSnapshotResult;

export type OptionMetaType =
  | 'float' | 'int' | 'string' | 'bool' | 'percent' | 'floats' | 'ints'
  | 'strings' | 'bools' | 'enum' | 'float_or_percent' | 'percents'
  | 'point' | 'points' | 'point3' | 'unknown';

export interface OptionMeta {
  type: OptionMetaType;
  label?: string;
  full_label?: string;
  tooltip?: string;
  category?: string;
  mode?: number;
  enum_values?: string[];
  enum_labels?: string[];
  min?: number;
  max?: number;
  default?: string;
}

export type OptionMetadata = Record<string, OptionMeta>;

export interface LoadModelResult {
  ok: boolean;
  objects: number;
  instances: number;
  error?: string;
}

export type ProjectLoadMode = 'project' | 'geometry-only';

export interface EmbeddedPresetEvidence {
  type: 'printer' | 'filament';
  name: string;
  inherits: string;
  hasMatchingSystemPreset: boolean;
  modifiedGcodeKeys: string[];
}

/** Result metadata from the native BBS 3MF reader. */
export interface ProjectLoadResult {
  ok: boolean;
  objects: number;
  instances: number;
  mode?: ProjectLoadMode;
  displayName?: string;
  compatibility?: 'orca' | 'bambu' | 'generic' | 'unsupported';
  projectSettingsAvailable?: boolean;
  isBbl3mf?: boolean;
  isOrca3mf?: boolean;
  fileVersion?: string;
  multiPlate?: boolean;
  plateCount?: number;
  embeddedPresetWarnings?: {
    present: boolean;
    count: number;
    printerCount: number;
    processCount: number;
    filamentCount: number;
    modifiedPrinterGcode: boolean;
    modifiedFilamentGcode: boolean;
    missingSystemPreset: boolean;
    requiresConfirmation: boolean;
    modifiedGcodeKeys?: string[];
    missingSystemPresetTypes?: Array<'printer' | 'filament'>;
    presetEvidence?: EmbeddedPresetEvidence[];
  };
  /** Candidate picker state captured in the same native load response. */
  presetSnapshot?: PresetSnapshot;
  error?: string;
}

export interface ModelObjectBuffer {
  objectIdx: number;
  volumeIdx: number;
  instanceIdx: number;
  /** Float32Array xyz per vertex, copied out of the wasm heap */
  positions: Float32Array;
  vertexCount: number;
  /** Uint32Array triangle index triples */
  indices: Uint32Array;
  indexCount: number;
  offset: [number, number, number];
  instanceTransform: ModelTransform;
  volumeTransform: ModelTransform;
}

export interface ModelTransform {
  offset: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  mirror: [number, number, number];
  /**
   * Optional full affine matrix (16 values, column-major, three.js layout).
   * Authoritative when present — it can carry shear (e.g. a non-uniform world
   * scale of a rotated object) that T·R·S cannot represent. The TRS fields
   * above remain the closest decomposition for clean transforms and for the
   * gizmo/panel display.
   */
  matrix?: [
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
    number, number, number, number,
  ];
}

export interface ModelMeshResult {
  ok: boolean;
  objects: ModelObjectBuffer[];
  error?: string;
}

export interface DeleteObjectsResult {
  ok: boolean;
  /** Remaining object count after the delete. */
  objects?: number;
  /** Number of objects actually removed (duplicates are ignored). */
  deleted?: number;
  error?: string;
}

/** Multi-delete of parts by stable ObjectID. */
export interface DeleteVolumesResult {
  ok: boolean;
  /** Remaining object count after the delete. */
  objects?: number;
  /** Number of volumes actually removed (duplicates are ignored). */
  deleted?: number;
  error?: string;
}

/** Clone result: the freshly minted stable ObjectIDs of the clones. */
export interface CloneObjectsResult {
  ok: boolean;
  newObjectIds: number[];
  /** Object count after cloning. */
  objects?: number;
  error?: string;
}

/** Reorder operations return the current structure in the same shape as getModelStructure. */
export interface ReorderStructureResult {
  ok: boolean;
  objects: ModelObjectStructure[];
  error?: string;
}

/** Split-to-parts result: the freshly generated volume IDs + current structure. */
export interface SplitVolumeResult {
  ok: boolean;
  /** Number of parts produced (1 means the volume was not split). */
  parts?: number;
  /** Generated volume IDs; the original volumeId is now stale. */
  newVolumeIds?: number[];
  /** Current structure after the split. */
  objects?: ModelObjectStructure[];
  error?: string;
}

/** Split-object-to-objects result: the freshly generated object IDs. */
export interface SplitObjectResult {
  ok: boolean;
  newObjectIds: number[];
  /** Object count after splitting. */
  objects?: number;
  error?: string;
}

/** Assemble result: the newly created multipart object's stable ID. */
export interface MergeObjectsResult {
  ok: boolean;
  objectId?: number;
  /** Object count after assembling. */
  objects?: number;
  error?: string;
}

/** Separate-instances result: the newly created per-instance object IDs. */
export interface SeparateInstancesResult {
  ok: boolean;
  newObjectIds: number[];
  /** Object count after separating. */
  objects?: number;
  error?: string;
}

/** Add-instance result: the freshly minted stable instance ID. */
export interface AddInstanceResult {
  ok: boolean;
  objectId?: number;
  instanceId?: number;
  error?: string;
}

/** Remove-instance result. */
export interface RemoveInstanceResult {
  ok: boolean;
  error?: string;
}

/** Simple success/error payload returned by non-destructive metadata mutations. */
export interface MutationResult {
  ok: boolean;
  error?: string;
}

/** Volume kinds as reported by the bridge structure read (spec §9.1). */
export type VolumeType =
  | 'model_part'
  | 'negative_volume'
  | 'parameter_modifier'
  | 'support_blocker'
  | 'support_enforcer';

export interface ModelVolumeStructure {
  /** Stable ObjectID for React keys and selection restoration. */
  id: number;
  /** Current positional index within the object (for operation dispatch). */
  index: number;
  name: string;
  type: VolumeType;
  /** Whether this volume can be split into multiple parts. */
  isSplittable: boolean;
}

export interface ModelInstanceStructure {
  id: number;
  index: number;
  printable: boolean;
}

export interface ModelObjectStructure {
  id: number;
  index: number;
  name: string;
  /** Object-level flag; distinct from per-instance `printable`. */
  printable: boolean;
  instanceCount: number;
  volumes: ModelVolumeStructure[];
  instances: ModelInstanceStructure[];
}

export interface ModelStructureResult {
  ok: boolean;
  objects: ModelObjectStructure[];
  error?: string;
}

export interface SliceResultStatus {
  ok: boolean;
  unrecognized_keys: string[];
  error?: string;
}

export interface ToolpathFeature {
  id: number;
  name: string;
  color: [number, number, number];
  role?: number;
}

export interface PreviewLayerRange {
  id: number;
  z: number;
  firstSegment: number;
  segmentCount: number;
}

export interface PreviewPaletteEntry extends ToolpathFeature {
  tool?: number;
}

export type PreviewMetricKey = keyof PreviewToolpathMetrics;

export interface PreviewMetricRange {
  min: number;
  max: number;
}

export interface PreviewAnalysisSummary {
  estimatedTimeSeconds?: number;
  filamentLengthMeters?: number;
  filamentWeightGrams?: number;
  filamentCost?: number;
}

export interface PreviewFeatureStatistics {
  featureId: number;
  timeSeconds?: number;
  filamentLengthMeters?: number;
  filamentWeightGrams?: number;
}

export interface PreviewAnalysis {
  summary: PreviewAnalysisSummary;
  featureStatistics: PreviewFeatureStatistics[];
  metricRanges: Partial<Record<PreviewMetricKey, PreviewMetricRange>>;
}

export type PreviewSourceKind = 'slice-result' | 'external-gcode';

export interface PreviewTextChunkRequest {
  /** Completed preview result identity; stale results are rejected by bridge. */
  resultId: number;
  offset: number;
  length: number;
}

export interface PreviewTextChunk {
  offset: number;
  text: string;
  eof: boolean;
}

/** Bounded, seekable source-text page addressed by 1-based source lines. */
export interface PreviewTextLinesRequest {
  resultId: number;
  startLine: number;
  lineCount: number;
}

export interface PreviewTextLines {
  startLine: number;
  lineCount: number;
  text: string;
  eof: boolean;
}

/** Maximum source bytes returned by one lazy preview text request. */
export const PREVIEW_TEXT_CHUNK_MAX_BYTES = 64 * 1024;
/** At most three UTF-8 continuation bytes may be included at either edge. */
export const PREVIEW_TEXT_CHUNK_MAX_ALIGNMENT_BYTES = 3;
/** Explicit upper bound after both UTF-8 edge alignments. */
export const PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES = PREVIEW_TEXT_CHUNK_MAX_BYTES + PREVIEW_TEXT_CHUNK_MAX_ALIGNMENT_BYTES * 2;
export const PREVIEW_TEXT_LINES_MAX = 128;

/** Source-neutral read-only preview input; external G-code is future work. */
export interface PreviewSource {
  kind: PreviewSourceKind;
  getPreviewResult(): Promise<ClientSliceResult>;
  readTextChunk?: (request: PreviewTextChunkRequest) => Promise<PreviewTextChunk>;
}

export interface PreviewMetadata {
  resultId: number;
  sourceFilename?: string;
  layerRanges: PreviewLayerRange[];
  featurePalette: ToolpathFeature[];
  extruderPalette?: PreviewPaletteEntry[];
  sourceLineMapping?: { available: boolean; lineCount: number };
  sourceText?: { available: boolean; byteLength?: number };
  analysis?: PreviewAnalysis;
}

export interface PreviewToolpathMetrics {
  feedrate?: Float32Array;
  actualFeedrate?: Float32Array;
  volumetricFlow?: Float32Array;
  actualVolumetricFlow?: Float32Array;
  fanSpeed?: Float32Array;
  temperature?: Float32Array;
  pressureAdvance?: Float32Array;
  acceleration?: Float32Array;
  jerk?: Float32Array;
  time?: Float32Array;
  layerDuration?: Float32Array;
}

export interface ClientToolpath {
  vertexCount: number;
  /** Float32Array xyz per toolpath vertex */
  positions: Float32Array;
  /** Uint32Array layer_id per vertex */
  layers: Uint32Array;
  /** Uint32Array palette index per vertex */
  features: Uint32Array;
  /** per-feature id → palette color (palette may index beyond, client clamps) */
  palette: ToolpathFeature[];
  /** Explicit continuous segment arrays. Every array has segmentCount entries. */
  segmentCount: number;
  starts: Float32Array;
  ends: Float32Array;
  layerIds: Uint32Array;
  moveOrders: Uint32Array;
  gcodeIds: Uint32Array;
  /** True when processor source ids are non-decreasing in move order. */
  sourceLineOrderValid?: boolean;
  moveTypes: Uint8Array;
  extrusionRoles: Uint16Array;
  extruderIds: Uint8Array;
  colorPrintIds: Uint8Array;
  widths: Float32Array;
  heights: Float32Array;
  metrics: PreviewToolpathMetrics;
}

export interface ClientSliceResult {
  ok: boolean;
  objects: number;
  layers: number;
  toolpath: ClientToolpath;
  metadata: PreviewMetadata;
  error?: string;
}

export interface ExportGcodeResult {
  ok: boolean;
  path: string;
  bytes: Uint8Array;
  error?: string;
}

export interface ExportProjectResult {
  ok: boolean;
  /** Native temporary path, for diagnostics only; never a host path. */
  path: string;
  bytes: Uint8Array;
  objects?: number;
  plateCount?: number;
  error?: string;
}

export interface CancelResult {
  ok: boolean;
  error?: string;
}

/** The bridge's boost::log file sink output (/tmp/orca.log in MEMFS). */
export interface ReadLogResult {
  ok: boolean;
  path: string;
  /** File bytes; empty when no log file exists yet (error set then). */
  bytes: Uint8Array;
  error?: string;
}

export interface SlicerClient {
  /** Initialize after the host has installed profile packages into MEMFS. */
  init(): Promise<InitResult>;
  /** Read the authoritative headless plate session snapshot. */
  getPlateSessionSnapshot(): Promise<PlateSessionSnapshotResult>;
  /** Reset to one fresh default Plate 1 and return its new runtime identity. */
  resetPlateSession(): Promise<PlateSessionSnapshotResult>;
  /** Select an existing plate by its opaque runtime identity. */
  selectPlate(plateId: string): Promise<PlateSessionSnapshotResult>;
  /** Read the engine-resolved, atomic picker state for initial loading. */
  getPresetSnapshot(): Promise<PresetSnapshotResult>;
  getOptionMetadata(): Promise<OptionMetadata>;
  /** Add a model file to the current scene without replacing existing objects. */
  addModel(bytes: Uint8Array, ext: string, displayName?: string): Promise<LoadModelResult>;
  /** Load a BBS 3MF as a project (replace) or geometry-only append. */
  loadProject(bytes: Uint8Array, mode?: ProjectLoadMode, displayName?: string): Promise<ProjectLoadResult>;
  /** Explicit geometry-only alias used by Add Model/project fallback callers. */
  importProjectGeometry(bytes: Uint8Array, displayName?: string): Promise<ProjectLoadResult>;
  /** Add an OrcaSlicer primitive to the current scene, exactly like its
   *  Add Cube: the bridge mirrors ObjectList::load_shape_object →
   *  create_mesh → load_mesh_object, building the mesh in the engine
   *  (its_make_cube) and naming the object and its part after the primitive
   *  — no staging file involved. `name` defaults to `type`. */
  addShape(type: string, name?: string): Promise<LoadModelResult>;
  /** Reset the complete scene in the WASM model and invalidate its Print. */
  clearModel(): Promise<{ ok: boolean; error?: string }>;
  setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number): Promise<{ ok: boolean; error?: string }>;
  setModelTransform(
    objIdx: number, volumeIdx: number, instIdx: number,
    instanceTransform: ModelTransform, volumeTransform: ModelTransform,
  ): Promise<{ ok: boolean; error?: string }>;
  getModelMesh(): Promise<ModelMeshResult>;
  /** Read the complete object/part/instance tree with stable IDs. */
  getModelStructure(): Promise<ModelStructureResult>;
  /** Delete whole objects by their stable ObjectIDs. */
  deleteObjects(objectIds: number[]): Promise<DeleteObjectsResult>;
  /** Delete specific parts (volumes) by their stable ObjectIDs. */
  deleteVolumes(volumeIds: number[]): Promise<DeleteVolumesResult>;
  /** Clone whole objects; returns the new stable ObjectIDs. */
  cloneObjects(objectIds: number[]): Promise<CloneObjectsResult>;
  /** Move an object to a destination index (0-based; index == count appends last); returns current structure. */
  reorderObjects(fromObjectId: number, toIndex: number): Promise<ReorderStructureResult>;
  /** Move a part to a destination index within its object (0-based; index == count appends last); returns current structure. */
  reorderVolumes(objectId: number, fromVolumeId: number, toIndex: number): Promise<ReorderStructureResult>;
  /** Split a volume into its disconnected parts; returns the generated volume IDs. */
  splitVolumeToParts(volumeId: number, maxExtruders?: number, remapPaint?: boolean): Promise<SplitVolumeResult>;
  /** Split an object into one object per connected shell; returns the generated object IDs. */
  splitObjectToObjects(objectId: number, autoDrop?: boolean): Promise<SplitObjectResult>;
  /** Assemble objects into one multipart object; returns the new object's stable ID. */
  mergeObjectsToMultipart(objectIds: number[], name: string): Promise<MergeObjectsResult>;
  /** Separate selected instances into their own objects; returns the new object IDs. */
  separateInstances(objectId: number, instanceIds: number[]): Promise<SeparateInstancesResult>;
  /** Add a new default instance to an object; returns the new instance ID. */
  addInstance(objectId: number): Promise<AddInstanceResult>;
  /** Remove a specific instance from an object by stable ID. */
  removeInstance(objectId: number, instanceId: number): Promise<RemoveInstanceResult>;
  /** Rename an object by its stable ObjectID. */
  renameObject(objectId: number, name: string): Promise<MutationResult>;
  /** Rename a specific part (volume) by its stable ObjectID. */
  renameVolume(volumeId: number, name: string): Promise<MutationResult>;
  /** Change a part's type among the spec's VolumeType strings. */
  setVolumeType(volumeId: number, type: VolumeType): Promise<MutationResult>;
  /** Toggle the object-level printable gate and every one of its instances. */
  setObjectPrintable(objectId: number, printable: boolean): Promise<MutationResult>;
  /** Toggle a single instance's printable state by its stable ObjectID. */
  setInstancePrintable(instanceId: number, printable: boolean): Promise<MutationResult>;
  /** Select a preset by name and return the final atomic compatibility state. */
  selectPreset(kind: 'printer' | 'print' | 'filament', name: string): Promise<PresetSnapshotResult>;
  slice(config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus>;
  getSliceResult(): Promise<ClientSliceResult>;
  /** Read a bounded UTF-8 chunk from the current completed slice result. */
  readTextChunk(request: PreviewTextChunkRequest): Promise<PreviewTextChunk>;
  /** Read a bounded, seekable source-text page from the current result. */
  readTextLines(request: PreviewTextLinesRequest): Promise<PreviewTextLines>;
  exportGcode(): Promise<ExportGcodeResult>;
  /** Export the active single-plate project as a secure BBS 3MF archive. */
  exportProject(): Promise<ExportProjectResult>;
  cancel(): Promise<CancelResult>;
  /** Read the C++ boost::log file sink output from MEMFS. */
  readLog(): Promise<ReadLogResult>;
}
