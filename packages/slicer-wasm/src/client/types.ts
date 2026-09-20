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
  /** Native Orca lock flag, retained but not acted on in this release. */
  readonly locked?: boolean;
  /** Opaque serialized per-plate setting slot. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Ordered unknown native metadata records, retained across save/load. */
  readonly opaqueMetadata?: readonly Readonly<{ key: string; value: string }>[];
  readonly instanceIds?: readonly number[];
  readonly outOfBoundsInstanceIds?: readonly number[];
  readonly valid?: boolean;
  /** Forward-compatible native metadata retained for session comparisons. */
  readonly futureMetadata?: Readonly<Record<string, unknown>>;
}

export interface PlateSessionInstance {
  readonly instanceId: number;
  readonly objectId: number;
  readonly objectIndex: number;
  readonly instanceIndex: number;
  readonly plateId: string;
  readonly member: boolean;
  readonly unprintable: boolean;
  readonly outOfBounds: boolean;
  readonly parked?: boolean;
}

export interface PlateSessionInstanceTransform {
  readonly instanceId: number;
  readonly objectId: number;
  readonly objectIndex: number;
  readonly instanceIndex: number;
  readonly worldTransform: ModelTransform;
}

/** Impact metadata emitted by one committed model/configuration transaction. */
export interface PlateMutationImpact {
  readonly inputRevisions?: Readonly<Record<string, number>>;
  readonly affectedPlateIdsBefore?: readonly string[];
  readonly affectedPlateIdsAfter?: readonly string[];
  readonly affectedPlateIds?: readonly string[];
  readonly dirtyReasons?: readonly string[];
}

/** Atomic read of the WASM-owned plate session. */
export interface PlateSessionSnapshot {
  readonly ok: true;
  readonly version: 1;
  readonly plates: readonly PlateSessionPlate[];
  readonly currentPlateId: string;
  instances: readonly PlateSessionInstance[];
  instanceTransforms?: readonly PlateSessionInstanceTransform[];
  inputRevisions?: Readonly<Record<string, number>>;
  affectedPlateIdsBefore?: readonly string[];
  affectedPlateIdsAfter?: readonly string[];
  affectedPlateIds?: readonly string[];
  dirtyReasons?: readonly string[];
  /** Present on structural plate mutations that normalize native per-plate
   * configuration arrays. Ordinary snapshots and transform mutations omit it. */
  nativeScopedConfig?: NativeScopedConfigTransport;
}

/** Narrow authoritative receipt returned by pure plate navigation. */
export interface PlateSelection {
  readonly ok: true;
  readonly version: 1;
  readonly currentPlateId: string;
}

export interface PlateSessionMutation extends PlateSessionSnapshot {
  readonly instanceTransforms: readonly PlateSessionInstanceTransform[];
}

/** Native printable-area bounds used by the Prime Tower proxy. */
export interface PrimeTowerBuildArea {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface PrimeTowerFootprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface PrimeTowerBand {
  readonly slot: number;
  readonly startDepth: number;
  readonly endDepth: number;
  readonly colour: string;
  readonly opacity: number;
}

/** Read-only Worker projection of the estimated Prepare Prime Tower. */
export interface PrimeTowerPlateProjection {
  readonly plateId: string;
  readonly displayIndex: number;
  readonly eligible: boolean;
  readonly empty: boolean;
  readonly forced: boolean;
  readonly usedSlots: readonly number[];
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly position: Readonly<{ x: number; y: number }>;
  readonly rotation: number;
  readonly brimMargin: number;
  readonly footprint: PrimeTowerFootprint;
  readonly bands: readonly PrimeTowerBand[];
  readonly buildArea: PrimeTowerBuildArea;
  readonly outsideBoundaryWarning?: boolean;
}

export interface PrimeTowerProjection {
  readonly ok: true;
  readonly version: 1;
  readonly currentPlateId: string;
  readonly buildArea: PrimeTowerBuildArea;
  readonly plates: readonly PrimeTowerPlateProjection[];
}

export interface PrimeTowerProjectionError {
  readonly ok?: false;
  readonly version?: 1;
  readonly error: string;
}

export type PrimeTowerProjectionResult = PrimeTowerProjection | PrimeTowerProjectionError;

export interface PrimeTowerMoveRequest {
  readonly version: 1;
  readonly plateId: string;
  readonly revision: number;
  readonly x: number;
  readonly y: number;
}

export interface PrimeTowerMoveMutation {
  readonly kind: 'move';
  readonly plateId: string;
  readonly historyEntryDelta: 0 | 1;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly dirty: boolean;
  readonly affectedPlateIds: readonly string[];
  readonly clamped?: boolean;
  readonly outsideBoundaryWarning?: boolean;
  readonly warning?: string;
  /** Authoritative, clamped coordinates for the moved plate. */
  readonly position: Readonly<{ x: number; y: number }>;
  /** Authoritative footprint at the returned coordinates. */
  readonly footprint: PrimeTowerFootprint;
}

export interface PrimeTowerMoveResult {
  readonly mutation: PrimeTowerMoveMutation;
  /** Native history status captured after the atomic move commit. */
  readonly historyStatus: import('./history').HistoryStatus;
}

export type PrimeTowerMoveResultOrError = AtomicCommandResult<PrimeTowerMoveResult>;

/** Disposable Worker projection of native project/plate/object/part configs.
 * Keys are native option names;
 * values are their native serialized representations. IDs are stable object /
 * part IDs, never renderer indices. Prime Tower X/Y are intentionally absent:
 * their native project-level arrays are edited only by the typed scene move
 * command, never through a second state root. */
export interface NativeScopedConfigSnapshot {
  readonly project: Readonly<Record<string, string>>;
  readonly objects: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly parts: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly plates: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export type NativeScopedConfigScope = 'project' | 'object' | 'part' | 'plate';

/** Stable identity of a native target removed by a committed transaction. */
export interface NativeScopedConfigTargetIdentity {
  readonly scope: NativeScopedConfigScope;
  /** Project has no id; every entity target uses its stable native id. */
  readonly id?: string;
}

/** One complete local map replacement in an incremental configuration receipt. */
export interface NativeScopedConfigTargetReplacement {
  readonly scope: NativeScopedConfigScope;
  /** Project has no id; every entity target uses its stable native id. */
  readonly id?: string;
  /** The complete local map after the committed mutation. An empty map is
   * meaningful and clears the previous target map. */
  readonly values: Readonly<Record<string, string>>;
}

/** Versioned full projection published at load/history/explicit refresh. */
export interface NativeScopedConfigFullTransport {
  readonly version: 1;
  readonly revision: number;
  readonly kind: 'full';
  readonly snapshot: NativeScopedConfigSnapshot;
  readonly removedTargets: readonly NativeScopedConfigTargetIdentity[];
}

/** Versioned replacement receipt published by an ordinary scoped mutation. */
export interface NativeScopedConfigAffectedTransport {
  readonly version: 1;
  readonly revision: number;
  readonly kind: 'affected';
  readonly replacements: readonly NativeScopedConfigTargetReplacement[];
  /** Stable targets deleted by the same native transaction. */
  readonly removedTargets: readonly NativeScopedConfigTargetIdentity[];
}

export type NativeScopedConfigTransport =
  | NativeScopedConfigFullTransport
  | NativeScopedConfigAffectedTransport;

export interface NativeScopedConfigTarget {
  readonly scope: NativeScopedConfigScope;
  readonly id?: number | string;
}

export interface ConfigurationCorrection {
  readonly key: string;
  readonly requested: string;
  readonly effective: string;
}

export interface ConfigurationReadyStatus {
  readonly state: 'ready';
  readonly corrections: readonly ConfigurationCorrection[];
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

export interface ConfigurationErrorStatus {
  readonly state: 'error';
  readonly error: string;
}

export type ConfigurationStatus = ConfigurationReadyStatus | ConfigurationErrorStatus;

export interface NativeScopedConfigResult {
  readonly ok: true;
  readonly nativeScopedConfig: NativeScopedConfigTransport;
  readonly plateSession?: PlateSessionMutation;
  /** Native option parse/normalization feedback for configuration commands. */
  readonly configurationStatus?: ConfigurationReadyStatus;
}

export interface NativeScopedConfigError {
  readonly version: 1;
  readonly ok?: false;
  readonly error: string;
  readonly errorCode?: string;
  readonly status?: ConfigurationErrorStatus;
}

export type NativeScopedConfigResultOrError = NativeScopedConfigResult | NativeScopedConfigError;

/** A malformed or rejected plate-session command has no partial state. */
export interface PlateSessionSnapshotError {
  readonly ok?: false;
  readonly error: string;
}

export type PlateSessionSnapshotResult = PlateSessionSnapshot | PlateSessionSnapshotError;
export type PlateSessionMutationResult = PlateSessionMutation | PlateSessionSnapshotError;
export type PlateSelectionResult = PlateSelection | PlateSessionSnapshotError;

/** Common identity and visibility fields for entries in the engine catalogue. */
export interface FilamentCatalogItem {
  name: string;
  /** Real preset visibility result from the bundled profile state. */
  is_visible: boolean;
  is_default: boolean;
  /** vendor id, empty when the preset has no vendor profile */
  vendor_id: string;
  model: string;
  variant: string;
}

/** A printer/process entry whose collection selection is meaningful. */
export interface PresetInfo extends FilamentCatalogItem {
  /** true when this entry is the collection's current selection (the
   *  picker's value source at boot; updated by selectProfile responses) */
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
 * visible, while prints and the multi-filament catalogue are visible and
 * compatible with the final selection context. Preserve their order; do not
 * re-filter or sort in JavaScript.
 */
export interface ProfileSnapshot {
  ok: true;
  printers: PresetInfo[];
  prints: PresetInfo[];
  /** Engine-filtered filament catalogue consumed by the multi-filament rack. */
  /** Engine-filtered rack catalogue. Items intentionally have no selected flag. */
  filamentCatalog: FilamentCatalogItem[];
  printer: PresetSelection;
  print: PresetSelection;
  /** Selected printer's build-plate polygon in slicer XY coordinates (mm). */
  printable_area?: Array<[number, number]>;
  /**
   * Effective native project/process configuration before local scoped values.
   * The settings UI uses this as its base value source; slicing remains
   * Worker-owned and composes the native project and plate configs.
   */
  project_config?: Record<string, string>;
}

/** A bridge rejection has no partial snapshot and leaves engine state unchanged. */
export interface ProfileSnapshotError {
  ok?: false;
  error: string;
}

export type ProfileSnapshotResult = ProfileSnapshot | ProfileSnapshotError;

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
  plateSession?: PlateSessionMutation;
}

export interface ClearModelResult {
  ok: boolean;
  error?: string;
  plateSession?: PlateSessionMutation;
}

export type ProjectLoadMode = 'project' | 'geometry-only';

export type ProjectProgressCallback = (percent: number, text: string) => void;
export type ProjectClosedCallback = (plateSession: PlateSessionMutation) => void;

export interface ProjectCloseResult {
  ok: boolean;
  error?: string;
  plateSession?: PlateSessionMutation;
}

export interface EmbeddedPresetEvidence {
  type: 'printer' | 'filament';
  name: string;
  inherits: string;
  hasMatchingSystemPreset: boolean;
  modifiedGcodeKeys: string[];
}

export interface FilamentSlotChange {
  slot: number;
  before: string;
  after: string;
  reason: 'native-compatibility';
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
    filamentSlotChanges?: FilamentSlotChange[];
  };
  /** Candidate picker state captured in the same native load response. */
  presetSnapshot?: ProfileSnapshot;
  /** Authoritative plate membership returned by the native model transaction. */
  plateSession?: PlateSessionMutation;
  /** Full native scoped configuration receipt published with the load. */
  nativeScopedConfig?: NativeScopedConfigFullTransport;
  /** History baseline published with the same load revision. */
  historyStatus?: import('./history').HistoryStatus;
  error?: string;
}

export interface ModelObjectBuffer {
  /** Stable native identities used for React/Three reconciliation. */
  objectId: number;
  volumeId: number;
  instanceId: number;
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

/** Targeted projection for the stable object IDs in one history SceneDelta. */
export interface ModelScenePatchResult {
  ok: boolean;
  objectOrder: number[];
  objects: ModelObjectStructure[];
  meshes: ModelObjectBuffer[];
  error?: string;
}

export interface DeleteObjectsResult {
  ok: boolean;
  /** Remaining object count after the delete. */
  objects?: number;
  /** Number of objects actually removed (duplicates are ignored). */
  deleted?: number;
  error?: string;
  plateSession?: PlateSessionMutation;
}

/** Multi-delete of parts by stable ObjectID. */
export interface DeleteVolumesResult {
  ok: boolean;
  /** Remaining object count after the delete. */
  objects?: number;
  /** Number of volumes actually removed (duplicates are ignored). */
  deleted?: number;
  error?: string;
  plateSession?: PlateSessionMutation;
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
  /** Native slice-time advisory warnings; these never replace hard errors. */
  warnings?: string[];
  /** Runtime-only identity of the retained core result produced by this Slice. */
  receipt?: SliceResultReceipt;
  error?: string;
}

/** One renderer CompositeID transform in an atomic Worker transform command. */
export interface ModelTransformMutation {
  readonly objectIdx: number;
  readonly volumeIdx: number;
  readonly instanceIdx: number;
  readonly instanceTransform: ModelTransform;
  readonly volumeTransform: ModelTransform;
}

/** Immutable identity captured when a current-plate operation starts. */
export interface PlateOperationTarget {
  readonly plateId: string;
  readonly inputRevision: number;
}

/**
 * Immutable address of one retained native result generation.
 *
 * `sliceTaskId` stays a decimal string across JSON so the eventual global
 * uint64 task generator cannot lose precision in JavaScript.
 */
export interface SliceResultReceipt {
  readonly plateId: string;
  readonly inputStamp: number;
  /** Plate-local successful generation, carried as decimal text. */
  readonly resultGeneration: string;
  readonly sliceTaskId: string;
}

export type ResultReadStatus = 'ok' | 'stale' | 'unavailable' | 'failed';

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
  receipt: SliceResultReceipt;
  offset: number;
  length: number;
}

export interface PreviewTextChunk {
  ok?: boolean;
  status?: ResultReadStatus;
  error?: string;
  offset: number;
  text: string;
  eof: boolean;
}

/** Bounded, seekable source-text page addressed by 1-based source lines. */
export interface PreviewTextLinesRequest {
  resultId: number;
  receipt: SliceResultReceipt;
  startLine: number;
  lineCount: number;
}

export interface PreviewTextLines {
  ok?: boolean;
  status?: ResultReadStatus;
  error?: string;
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
  /** Uint32Array local palette index derived from extrusionRoles and metadata.featurePalette */
  features: Uint32Array;
  /** Canonical v2 feature palette published in preview metadata. */
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
  /** Projection reads use typed terminals; stale/unavailable are normal races. */
  status?: ResultReadStatus;
  /** Address echoed by the Worker-side payload. */
  receipt?: SliceResultReceipt;
  objects: number;
  layers: number;
  toolpath: ClientToolpath;
  metadata: PreviewMetadata;
  error?: string;
}

export interface ExportGcodeResult {
  ok: boolean;
  status?: ResultReadStatus;
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

/**
 * Provenance for the colour currently shown for a material slot. This is
 * native effective-equivalence provenance: an explicit colour equal to the
 * selected preset is reported as preset because the read-only bridge cannot
 * recover edit history.
 */
export type FilamentColourProvenance = 'preset' | 'user';

/** One ordered, one-based material slot owned by the native session. */
export interface FilamentSessionSlot {
  readonly slot: number;
  readonly preset: { readonly id: string; readonly name: string };
  readonly colour: {
    readonly effective: string;
    readonly provenance: FilamentColourProvenance;
  };
}

export interface FilamentNativeMapping {
  readonly filament: readonly number[];
  readonly volume: readonly number[];
  readonly nozzle: readonly number[];
  readonly filament2: readonly number[];
  readonly physicalExtruder: readonly number[];
}

export interface FilamentFlushingState {
  readonly matrix: readonly number[];
  readonly vector: readonly number[];
  readonly matrixDimension: number;
  /** Number of native nozzle planes stored in matrix (matrix is not truncated). */
  readonly planeCount: number;
  readonly source: 'native' | 'default';
}

export interface FilamentSessionCapabilities {
  readonly minSlots: number;
  readonly maxSlots: number;
  readonly nozzleCount: number;
  /** Native SEMM/Bambu flexible-slot capability, not inferred from counts. */
  readonly flexible: boolean;
  readonly canAdd: boolean;
  readonly canDelete: boolean;
  readonly canMerge: boolean;
}

export type FilamentAssignmentTarget = 'object' | 'model-part' | 'parameter-modifier';

export type FilamentRoutingTarget = 'project' | 'object' | 'model-part';

export interface FilamentRoutingProjection {
  readonly target: FilamentRoutingTarget;
  readonly id: number;
  readonly objectId: number;
  readonly selector: 'support-base' | 'support-interface' | 'outer-wall' | 'inner-wall' |
    'sparse-infill' | 'internal-solid-infill' | 'top-surface' | 'bottom-surface';
  /** Zero means native Default; positive values are one-based slot IDs. */
  readonly explicitSlot: number;
  /** Zero for project-scoped support Default; otherwise the effective slot. */
  readonly effectiveSlot: number;
  /** True when the effective value is inherited from the native parent scope. */
  readonly inherited: boolean;
  readonly defaulted: boolean;
}

export interface FilamentAssignmentProjection {
  readonly target: FilamentAssignmentTarget;
  readonly id: number;
  readonly objectId: number;
  readonly explicitSlot: number;
  readonly effectiveSlot: number;
  readonly inherited: boolean;
}

export interface FilamentAssignmentProjectionSet {
  readonly objects: readonly FilamentAssignmentProjection[];
  readonly parts: readonly FilamentAssignmentProjection[];
  readonly modifiers: readonly FilamentAssignmentProjection[];
}

export interface FilamentSessionRevisions {
  readonly session: number;
  readonly project: number;
  readonly result: number;
  readonly plates: Readonly<Record<string, number>>;
}

export interface FilamentSessionStatus {
  readonly state: 'ready';
  readonly error: null;
}

/** Versioned, read-only authoritative projection of the native filament session. */
export interface FilamentSessionSnapshot {
  readonly ok: true;
  readonly version: 1;
  readonly slots: readonly FilamentSessionSlot[];
  readonly mappings: FilamentNativeMapping;
  readonly flushing: FilamentFlushingState;
  readonly capabilities: FilamentSessionCapabilities;
  readonly routing?: readonly FilamentRoutingProjection[];
  readonly assignments: FilamentAssignmentProjectionSet;
  readonly revisions: FilamentSessionRevisions;
  readonly status: FilamentSessionStatus;
}

export interface FilamentSessionSnapshotError {
  readonly ok?: false;
  readonly error: string;
  readonly errorCode?: string;
  readonly status?: { readonly state: 'error'; readonly error: string };
}

export type FilamentSessionSnapshotResult = FilamentSessionSnapshot | FilamentSessionSnapshotError;

export interface FilamentMutationSummary {
  readonly kind: 'select-preset' | 'set-colour' | 'add' | 'delete' | 'merge' | 'assign' | 'routing';
  readonly slot?: number;
  readonly source?: number;
  readonly destination?: number | null;
  readonly preset?: string;
  readonly colour?: string;
  readonly slotCount?: number;
  readonly historyEntryDelta: 1;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly dirty: true;
  readonly allPlateResultsInvalidated: boolean;
  readonly affectedPlateIds?: readonly string[];
  readonly acceptedTargets?: readonly { readonly kind: FilamentAssignmentTarget | FilamentRoutingTarget; readonly id: number; readonly objectId: number }[];
  readonly selector?: string;
}

export interface FilamentMutationResult {
  readonly snapshot: FilamentSessionSnapshot;
  readonly mutation: FilamentMutationSummary;
  /** Native history status captured after the same successful commit. */
  readonly historyStatus: import('./history').HistoryStatus;
}

export interface FilamentCommandRequest {
  readonly revision: number;
  readonly version: 1;
}

export interface FilamentSlotPresetRequest extends FilamentCommandRequest {
  readonly slot: number;
  readonly preset: string;
}

export interface FilamentSlotColourRequest extends FilamentCommandRequest {
  readonly slot: number;
  readonly colour: string;
}

export interface FilamentSlotDeleteRequest extends FilamentCommandRequest {
  readonly slot: number;
}

export interface FilamentSlotMergeRequest extends FilamentCommandRequest {
  readonly source: number;
  readonly destination: number;
}

export interface RememberedFilamentRackRequest extends FilamentCommandRequest {
  readonly slots: readonly { preset: string; colour: string }[];
}

export interface FilamentAssignmentTargetRequest {
  readonly kind: 'object' | 'instance' | 'instance-as-object' | 'model-part' | 'parameter-modifier';
  readonly id: number;
}

export interface FilamentAssignmentRequest extends FilamentCommandRequest {
  readonly slot: number;
  readonly targets: readonly FilamentAssignmentTargetRequest[];
}

export interface FilamentRoutingTargetRequest {
  readonly kind: FilamentRoutingTarget;
  readonly id?: number;
}

export type FilamentRoutingSelector = FilamentRoutingProjection['selector'];

export interface FilamentRoutingRequest extends FilamentCommandRequest {
  readonly selector: FilamentRoutingSelector;
  readonly slot: number;
  readonly targets: readonly FilamentRoutingTargetRequest[];
}

export type FilamentMutationResultOrError = AtomicCommandResult<FilamentMutationResult>;

/** Reusable versioned envelope reserved for Step 2 atomic commands. */
export interface AtomicCommandSuccessEnvelope<T> {
  readonly ok: true;
  readonly version: 1;
  readonly result: T;
}

/** Reusable versioned envelope reserved for Step 2 atomic command failures. */
export interface AtomicCommandErrorEnvelope {
  readonly ok: false;
  readonly version: 1;
  readonly error: string;
  readonly errorCode: string;
  readonly status?: { readonly state: 'error'; readonly error: string };
}

export type AtomicCommandResult<T> = AtomicCommandSuccessEnvelope<T> | AtomicCommandErrorEnvelope;

/** Bounded native timing sample used only by local performance diagnostics. */
export type NativePrimeTowerProjectionStage =
  | 'session_preparation'
  | 'bounds_scan'
  | 'effective_config_construction'
  | 'plate_local_model_construction'
  | 'used_slot_summary_hit'
  | 'used_slot_summary_delta'
  | 'used_slot_full_scan_fallback'
  | 'used_slot_scan'
  | 'printable_height_bounds_scan'
  | 'direct_wipe_tower_estimate'
  | 'print_apply_wipe_tower_data_fallback'
  | 'footprint_bands_projection_json'
  | 'final_json_serialization'
  | 'final_json_copy'
  | 'total';

export interface NativePerformanceSample {
  readonly operation: string;
  readonly stagesMs: Readonly<Record<string, number>>;
  /** Present only for the prime-tower projection sample; array index is the native plate index. */
  readonly perPlateStagesMs?: readonly Readonly<Record<string, number>>[];
}

/** Drains the bounded native diagnostic ring without retaining model data. */
export interface NativePerformanceProfile {
  readonly version: 1;
  readonly samples: readonly NativePerformanceSample[];
}

/** Worker-local execution state used to gate serial-only UI interactions. */
export interface RuntimeExecutionState {
  /** Null only before the WASM artifact has reported its threading mode. */
  readonly threaded: boolean | null;
  /** True from slice request admission until its public terminal response. */
  readonly sliceActive: boolean;
  readonly serialSliceActive: boolean;
  readonly serialTerminalEpoch: string;
}

/** Worker-local measurements available without C++ profiling instrumentation. */
export interface RuntimeMemorySnapshot {
  /** Chromium's non-standard, currently used Worker JavaScript heap. */
  readonly jsHeapUsedBytes?: number;
  /** Current capacity of the Emscripten/WASM linear-memory buffer. */
  readonly wasmLinearMemoryBytes: number;
}

export interface SlicerClient {
  /** Initialize after the host has installed profile packages into MEMFS. */
  init(): Promise<InitResult>;
  /** Read the complete native filament session; no renderer-side fallback is allowed. */
  getFilamentSessionSnapshot(): Promise<FilamentSessionSnapshotResult>;
  selectFilamentSlotPreset(request: FilamentSlotPresetRequest): Promise<FilamentMutationResultOrError>;
  setFilamentSlotColour(request: FilamentSlotColourRequest): Promise<FilamentMutationResultOrError>;
  addFilamentSlot(request: FilamentCommandRequest): Promise<FilamentMutationResultOrError>;
  deleteFilamentSlot(request: FilamentSlotDeleteRequest): Promise<FilamentMutationResultOrError>;
  mergeFilamentSlots(request: FilamentSlotMergeRequest): Promise<FilamentMutationResultOrError>;
  applyRememberedFilamentRack(request: RememberedFilamentRackRequest): Promise<FilamentSessionSnapshotResult>;
  assignFilament(request: FilamentAssignmentRequest): Promise<FilamentMutationResultOrError>;
  setFilamentRouting(request: FilamentRoutingRequest): Promise<FilamentMutationResultOrError>;
  /** Begin/commit/abort are serialized by the Worker; transaction IDs are opaque. */
  beginHistory(label: import('./history').HistoryLabel, category: import('./history').HistoryCategory,
               beforeContext: import('./history').HistoryContext,
               options?: import('./history').HistoryTransactionOptions): Promise<import('./history').HistoryTransactionId>;
  commitHistory(transactionId: import('./history').HistoryTransactionId,
                afterContext: import('./history').HistoryContext): Promise<import('./history').HistoryStatus>;
  abortHistory(transactionId: import('./history').HistoryTransactionId): Promise<import('./history').RestoreResult>;
  undoHistory(): Promise<import('./history').RestoreResult>;
  redoHistory(): Promise<import('./history').RestoreResult>;
  jumpHistory(entryId: import('./history').HistoryEntryId, direction: import('./history').HistoryJumpDirection): Promise<import('./history').RestoreResult>;
  getHistoryStatus(): Promise<import('./history').HistoryStatus>;
  /** Advance the saved checkpoint without clearing retained history. */
  markHistorySaved(context?: import('./history').HistoryContext): Promise<import('./history').HistoryStatus>;
  /** Clear the prior project session and establish a clean baseline. */
  resetHistory(context: import('./history').HistoryContext): Promise<import('./history').HistoryStatus>;
  /** Compact Worker/client timing counters for smoke and E2E diagnostics. */
  getHistoryDiagnostics(): import('./history').HistoryTransportDiagnostics;
  /** Read the already-known Worker execution state without another RPC. */
  getRuntimeExecutionState(): RuntimeExecutionState;
  /** Read current Worker JS heap and WASM linear-memory capacity. */
  getRuntimeMemory(): Promise<RuntimeMemorySnapshot>;
  /** Diagnostic-only native timing samples. Present in real WASM builds. */
  takeNativePerformanceProfile?(): Promise<NativePerformanceProfile>;
  runProjectHistoryTransaction<T>(
    label: import('./history').HistoryLabel,
    category: import('./history').HistoryCategory,
    beforeContext: import('./history').HistoryContext,
    mutation: import('./history').HistoryMutation<T>,
    afterContext: import('./history').HistoryContext | (() => import('./history').HistoryContext | Promise<import('./history').HistoryContext>),
  ): Promise<{ result: T; status: import('./history').HistoryStatus }>;
  /** Read the authoritative headless plate session snapshot. */
  getPlateSessionSnapshot(): Promise<PlateSessionSnapshotResult>;
  /** Read the native estimated Prepare Prime Tower for every plate. */
  getPrimeTowerProjection(): Promise<PrimeTowerProjectionResult>;
  /** Move one plate-local Prime Tower position through one atomic history command. */
  movePrimeTower(request: PrimeTowerMoveRequest): Promise<PrimeTowerMoveResultOrError>;
  /** Reset to one fresh default Plate 1 and return its new runtime identity. */
  resetPlateSession(): Promise<PlateSessionSnapshotResult>;
  /** Select an existing plate by its opaque runtime identity. */
  selectPlate(plateId: string): Promise<PlateSelectionResult>;
  addPlate(): Promise<PlateSessionMutationResult>;
  reorderPlates(plateIds: string[]): Promise<PlateSessionMutationResult>;
  deletePlate(plateId: string): Promise<PlateSessionMutationResult>;
  recomputePlateMembership(): Promise<PlateSessionMutationResult>;
  /** Advance every existing plate for a committed shared configuration edit. */
  markSharedConfigurationMutation(): Promise<PlateSessionMutationResult>;
  /** Read a disposable projection of native project/object/part/plate config. */
  getNativeScopedConfig(): Promise<NativeScopedConfigResultOrError>;
  /** Set one native scoped value and return the affected plate projection. */
  setNativeScopedConfig(target: NativeScopedConfigTarget, optionKey: string, value: string): Promise<NativeScopedConfigResultOrError>;
  /** Refresh the native scoped configuration projection after a preset transition. */
  revalidateNativeScopedConfig(): Promise<NativeScopedConfigResultOrError>;
  /** Read the engine-resolved, atomic picker state for initial loading. */
  getProfileSnapshot(): Promise<ProfileSnapshotResult>;
  getOptionMetadata(): Promise<OptionMetadata>;
  /** Add a model file to the current scene without replacing existing objects. */
  addModel(bytes: Uint8Array, ext: string, displayName?: string): Promise<LoadModelResult>;
  /** Close the current project/session and construct one fresh empty session. */
  closeProject(): Promise<ProjectCloseResult>;
  /** Load a BBS 3MF as a project (replace) or geometry-only append. */
  loadProject(bytes: Uint8Array, mode?: ProjectLoadMode, displayName?: string, onProgress?: ProjectProgressCallback, onProjectClosed?: ProjectClosedCallback): Promise<ProjectLoadResult>;
  /** Explicit geometry-only alias used by Add Model/project fallback callers. */
  importProjectGeometry(bytes: Uint8Array, displayName?: string, onProgress?: ProjectProgressCallback): Promise<ProjectLoadResult>;
  /** Add an OrcaSlicer primitive to the current scene, exactly like its
   *  Add Cube: the bridge mirrors ObjectList::load_shape_object →
   *  create_mesh → load_mesh_object, building the mesh in the engine
   *  (its_make_cube) and naming the object and its part after the primitive
   *  — no staging file involved. `name` defaults to `type`. */
  addShape(type: string, name?: string): Promise<LoadModelResult>;
  /** Reset the complete scene in the WASM model and invalidate its Print. */
  clearModel(): Promise<ClearModelResult>;
  setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number): Promise<{ ok: boolean; error?: string }>;
  setModelTransform(
    objIdx: number, volumeIdx: number, instIdx: number,
    instanceTransform: ModelTransform, volumeTransform: ModelTransform,
  ): Promise<{ ok: boolean; error?: string }>;
  /** Apply every transform from one gesture atomically inside its history transaction. */
  setModelTransforms(
    transactionId: import('./history').HistoryTransactionId,
    transforms: readonly ModelTransformMutation[],
  ): Promise<{ ok: boolean; error?: string; plateSession?: PlateSessionMutation }>;
  getModelMesh(): Promise<ModelMeshResult>;
  /** Materialize only objects touched by a native history SceneDelta. */
  getModelScenePatch(objectIds: readonly number[]): Promise<ModelScenePatchResult>;
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
  /** Select a printer or process profile and return the final atomic
   * compatibility state. Filament selection is owned by the multi-filament
   * session/rack commands. */
  selectProfile(kind: 'printer' | 'print', name: string): Promise<ProfileSnapshotResult>;
  slice(config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus>;
  /** Slice only the captured current plate; stale/non-current targets reject. */
  slicePlate(target: PlateOperationTarget, config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus>;
  /** Materialize a renderer projection for exactly one retained native result. */
  getSliceResult(receipt: SliceResultReceipt): Promise<ClientSliceResult>;
  /** Read a bounded UTF-8 chunk from the current completed slice result. */
  readTextChunk(request: PreviewTextChunkRequest): Promise<PreviewTextChunk>;
  /** Read a bounded, seekable source-text page from the current result. */
  readTextLines(request: PreviewTextLinesRequest): Promise<PreviewTextLines>;
  /** Export only the captured current plate's completed result. */
  exportGcodePlate(receipt: SliceResultReceipt): Promise<ExportGcodeResult>;
  /** Export the complete active plate session as a native-compatible BBS 3MF archive. */
  exportProject(): Promise<ExportProjectResult>;
  cancel(): Promise<CancelResult>;
  /** Read the C++ boost::log file sink output from MEMFS. */
  readLog(): Promise<ReadLogResult>;
}
