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

export interface PresetInfo {
  name: string;
  /** Real set_visible_from_appconfig result (driven by the app config's
   *  installed-state) — the picker's installed/available grouping. */
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

export interface PresetList {
  presets: PresetInfo[];
  error?: string;
}

/** The app-config JSON (fork's USE_JSON_CONFIG schema): models (installed
 *  vendor/model/variant), presets (machine/process/filament selections),
 *  filaments (installed filaments). The renderer persists this. */
export type AppConfig = Record<string, unknown>;

export interface SelectPresetResult {
  ok: boolean;
  printer: { name: string; idx: number };
  print: { name: string; idx: number };
  filament: { name: string; idx: number };
  error?: string;
}

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
}

export interface ModelMeshResult {
  ok: boolean;
  objects: ModelObjectBuffer[];
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
}

export interface ClientSlicedMesh {
  vertexCount: number;
  /** Float32Array xyz per mesh vertex */
  positions: Float32Array;
  /** Uint32Array triangle index triples */
  indices: Uint32Array;
  indexCount: number;
  /** Uint32Array layer_id per TRIANGLE (index triple) */
  layerRanges: Uint32Array;
}

export interface ClientSliceResult {
  ok: boolean;
  objects: number;
  layers: number;
  toolpath: ClientToolpath;
  mesh: ClientSlicedMesh;
  error?: string;
}

export interface ExportGcodeResult {
  ok: boolean;
  path: string;
  bytes: Uint8Array;
  error?: string;
}

export interface CancelResult {
  ok: boolean;
  error?: string;
}

export interface SlicerClient {
  /** Initialize the preset bundle. appConfig is the persisted app-config
   *  JSON (installed printers + selections); omit for a fresh config
   *  (bridge installs everything and picks the first non-default printer). */
  init(appConfig?: AppConfig | null): Promise<InitResult>;
  setAppConfig(appConfig: AppConfig): Promise<InitResult>;
  getAppConfig(): Promise<AppConfig & { ok: boolean; error?: string }>;
  getPresets(kind: 'printer' | 'print' | 'filament'): Promise<PresetList>;
  getOptionMetadata(): Promise<OptionMetadata>;
  /** Add a model file to the current scene without replacing existing objects. */
  addModel(bytes: Uint8Array, ext: string): Promise<LoadModelResult>;
  /** Reset the complete scene in the WASM model and invalidate its Print. */
  clearModel(): Promise<{ ok: boolean; error?: string }>;
  setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number): Promise<{ ok: boolean; error?: string }>;
  setModelTransform(
    objIdx: number, volumeIdx: number, instIdx: number,
    instanceTransform: ModelTransform, volumeTransform: ModelTransform,
  ): Promise<{ ok: boolean; error?: string }>;
  getModelMesh(): Promise<ModelMeshResult>;
  /** Select a preset by name; printer selection re-runs compatibility so
   *  print/filament follow the active machine. Reports all three selections. */
  selectPreset(kind: 'printer' | 'print' | 'filament', name: string): Promise<SelectPresetResult>;
  slice(config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus>;
  getSliceResult(): Promise<ClientSliceResult>;
  exportGcode(): Promise<ExportGcodeResult>;
  cancel(): Promise<CancelResult>;
}
