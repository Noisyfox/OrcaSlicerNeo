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

export interface PresetList {
  presets: { name: string }[];
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
  /** Float32Array xyz per vertex, copied out of the wasm heap */
  positions: Float32Array;
  vertexCount: number;
  /** Uint32Array triangle index triples */
  indices: Uint32Array;
  indexCount: number;
  offset: [number, number, number];
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
  init(): Promise<InitResult>;
  getPresets(kind: 'printer' | 'print' | 'filament'): Promise<PresetList>;
  getOptionMetadata(): Promise<OptionMetadata>;
  loadModel(bytes: Uint8Array, ext: string): Promise<LoadModelResult>;
  setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number): Promise<{ ok: boolean; error?: string }>;
  getModelMesh(): Promise<ModelMeshResult>;
  slice(config: Record<string, string>, onProgress?: (percent: number, text: string) => void): Promise<SliceResultStatus>;
  getSliceResult(): Promise<ClientSliceResult>;
  exportGcode(): Promise<ExportGcodeResult>;
  cancel(): Promise<CancelResult>;
}
