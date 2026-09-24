// packages/slicer-wasm/src/client/testing/mock-module.ts
// ----------------------------------------------------------------
// Bridge-shaped mock Emscripten module for unit tests (no emsdk).
// Implements the ORC bridge contract exactly as bridge.cpp does for
// real (see doc/2026-08-13-m2-implementation-plan.md Task 1) — the
// client's tests pin this contract; Task 7 implements it in C++.
// Also usable in the app's dev fallback worker (VITE_USE_MOCK=1).
// ----------------------------------------------------------------

import type {
  NativeScopedConfigScope,
  PresetDraftEditorScalarType,
  PresetDraftEditorValue,
  ProjectLoadResult,
  VolumeType,
} from '../types';

export interface MockFeature {
  id: number;
  role: number;
  name: string;
  color: [number, number, number];
}

export interface MockSliceFixture {
  layers: number;
  toolpathVertices: number; // per vertex: xyz (Float32)
  features: MockFeature[];
  optionalMetrics?: Record<string, number[]>;
  extruderPalette?: Array<Omit<MockFeature, 'role'> & { tool?: number }>;
  resultId?: number;
  sourceFilename?: string;
  sourceText?: string;
  analysis?: {
    summary?: {
      estimatedTimeSeconds?: number;
      filamentLengthMeters?: number;
      filamentWeightGrams?: number;
      filamentCost?: number;
    };
    featureStatistics?: Array<{
      featureId: number;
      timeSeconds?: number;
      filamentLengthMeters?: number;
      filamentWeightGrams?: number;
    }>;
  };
}

const HEAP_BYTES = 64 * 1024 * 1024;

export interface MockModule {
  ccall: (name: string, ret: string, argTypes: string[], args: unknown[]) => unknown;
  UTF8ToString: (ptr: number) => string;
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  addFunction: (fn: (...args: unknown[]) => void, sig: string) => number;
  removeFunction: (idx: number) => void;
  FS: {
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
  };
  _freedPointers: number[];
  _functionRegistrations: number;
  /** Test-only injection seam for ordered task-mailbox delivery. */
  _publishTaskMessage: (taskId: string, message: Record<string, unknown>) => void;
}

export interface MockModuleOptions {
  sliceFixture?: MockSliceFixture;
  metadataKeys?: Record<string, { type: string; enum_values?: string[]; min?: number; max?: number; category?: string; scopes?: readonly NativeScopedConfigScope[] }>;
  printErr?: (msg: string) => void;
  /** Number of instances initially exposed by getModelMesh. */
  instanceCount?: number;
  /** Number of composite render volumes initially present in each object. */
  volumeCount?: number;
  /** Number of parts a splittable volume yields on orc_split_volume_to_parts. */
  splitParts?: number;
  /** Simulate the shared-memory mailbox transport used by the pthread build. */
  threaded?: boolean;
  /** Warning metadata returned by the native BBS project-load bridge. */
  embeddedPresetWarnings?: Partial<NonNullable<ProjectLoadResult['embeddedPresetWarnings']>>;
  /** Optional wire snapshot override for malformed/unsupported-version tests. */
  filamentSession?: unknown;
  /** Optional raw mutation response override for client normalization tests. */
  filamentMutation?: unknown;
  /** Optional raw project-configuration response override for normalization tests. */
  nativeScopedConfigOverride?: unknown;
  /** Optional raw Prime Tower projection override for normalization tests. */
  primeTowerProjection?: unknown;
  /** Optional raw native performance profile override for normalization tests. */
  nativePerformanceProfile?: unknown;
  /** Deterministic eligible tower projections for mock Electron interaction tests. */
  primeTowerFixture?: boolean;
  /** Native-shaped advisory warnings returned by the deterministic slice fixture. */
  sliceWarnings?: readonly string[];
}

export function createMockModule(opts: MockModuleOptions = {}): MockModule {
  const heap = opts.threaded ? new SharedArrayBuffer(HEAP_BYTES) : new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(heap);
  const HEAPU32 = new Uint32Array(heap);
  const HEAPF32 = new Float32Array(heap);
  const files = new Map<string, Uint8Array>();
  let previewSourceBytes: Uint8Array | undefined;
  const freedPointers: number[] = [];

  // ---- heap allocator (bump; free records for leak checks) ----
  let bump = 1024;
  function malloc(size: number): number {
    const p = bump;
    bump += (size + 7) & ~7;
    if (bump > HEAP_BYTES) throw new Error('mock heap exhausted');
    return p;
  }
  function free(ptr: number): void {
    freedPointers.push(ptr);
  }

  function utf8ToString(ptr: number): string {
    let end = ptr;
    while (HEAPU8[end] !== 0) end++;
    return new TextDecoder().decode(HEAPU8.subarray(ptr, end));
  }

  // ---- write a JSON C string into the heap, return its ptr ----
  function putJson(value: unknown): number {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const p = malloc(bytes.length + 1);
    HEAPU8.set(bytes, p);
    return p;
  }

  // ---- fixture state ----
  const fixture = opts.sliceFixture ?? {
    layers: 40,
    toolpathVertices: 2400,
    features: [
      { id: 0, role: 0, name: 'ExternalPerimeter', color: [255, 140, 0] as [number, number, number] },
      { id: 1, role: 1, name: 'InternalPerimeter', color: [255, 180, 0] as [number, number, number] },
      { id: 2, role: 2, name: 'SparseInfill', color: [0, 160, 255] as [number, number, number] },
    ],
  };
  const metadata: Record<string, { type: string; enum_values?: string[]; min?: number; max?: number; category?: string; scopes?: readonly NativeScopedConfigScope[] }> =
    opts.metadataKeys ?? {
      // Keep the mock catalogue aligned with bridge_profiles.cpp. Plate scope
      // is limited to the explicit editable override keys; native BBS plate
      // metadata/config fields outside this catalogue are not generic targets.
      layer_height: { type: 'float', scopes: ['project', 'object'] },
      wall_loops: { type: 'int', scopes: ['object', 'part'] },
      sparse_infill_density: { type: 'percent', scopes: ['object', 'part'] },
      sparse_infill_pattern: { type: 'enum', enum_values: ['grid', 'gyroid', 'lines'], scopes: ['object', 'part'] },
      enable_support: { type: 'bool', scopes: ['object'] },
      nozzle_temperature: { type: 'float', category: 'Temperature', scopes: ['project'] },
      printable_height: { type: 'float', category: 'Printer', min: 1, max: 1000 },
      nozzle_diameter: { type: 'floats', category: 'Printer' },
      filament_flow_ratio: { type: 'floats', category: 'Filament', min: 0.5, max: 1.5 },
      default_filament_colour: { type: 'strings', category: 'Filament' },
      filament_type: { type: 'strings', category: 'Filament' },
      filament_soluble: { type: 'bools', category: 'Filament' },
      filament_diameter: { type: 'floats', category: 'Filament' },
      filament_adhesiveness_category: { type: 'ints', category: 'Filament' },
      filament_shrink: { type: 'percents', category: 'Filament' },
      filament_retract_lift_enforce: { type: 'enums', category: 'Filament', enum_values: ['All Surfaces', 'Top Only'] },
      overhang_fan_threshold: { type: 'enums', category: 'Filament', enum_values: ['0%', '10%', '25%', '50%', '75%', '95%'] },
      filament_start_gcode: { type: 'strings', category: 'Filament' },
      filament_change_extrusion_role_gcode: { type: 'strings', category: 'Filament' },
      filament_end_gcode: { type: 'strings', category: 'Filament' },
      filament_notes: { type: 'strings', category: 'Filament' },
      enable_prime_tower: { type: 'bool', scopes: ['project'] },
      prime_tower_width: { type: 'float', scopes: ['project'] },
      printable_area: { type: 'points', category: 'Printer', scopes: ['project'] },
      gcode_flavor: { type: 'enum', enum_values: ['marlin', 'klipper', 'repetier'], scopes: ['project'] },
      curr_bed_type: { type: 'enum', enum_values: ['Cool Plate', 'Engineering Plate', 'Textured PEI Plate'], scopes: ['project', 'plate'] },
      print_sequence: { type: 'enum', enum_values: ['by layer', 'by object'], scopes: ['project', 'plate'] },
      first_layer_print_sequence: { type: 'ints', scopes: ['project', 'plate'] },
      other_layers_print_sequence: { type: 'ints', scopes: ['project', 'plate'] },
      other_layers_print_sequence_nums: { type: 'int', scopes: ['project', 'plate'] },
      spiral_mode: { type: 'bool', scopes: ['project', 'plate'] },
      filament_map_mode: { type: 'enum', enum_values: ['Auto', 'Manual'], scopes: ['project', 'plate'] },
      filament_map: { type: 'ints', scopes: ['project', 'plate'] },
      filament_volume_map: { type: 'ints', scopes: ['project', 'plate'] },
    };
  const projectWarningFixture = {
    modifiedPrinterGcode: false,
    modifiedFilamentGcode: false,
    missingSystemPreset: false,
    modifiedGcodeKeys: [] as string[],
    missingSystemPresetTypes: [] as Array<'printer' | 'filament'>,
    presetEvidence: [],
    ...opts.embeddedPresetWarnings,
  };
  // The default mock project is a plain synthetic archive and has no embedded
  // safety warning; warning-focused tests opt in through this fixture.
  const hasProjectWarning = Boolean(
    projectWarningFixture.modifiedPrinterGcode ||
    projectWarningFixture.modifiedFilamentGcode ||
    projectWarningFixture.missingSystemPreset ||
    projectWarningFixture.modifiedGcodeKeys.length > 0 ||
    projectWarningFixture.missingSystemPresetTypes.length > 0 ||
    projectWarningFixture.presetEvidence.length > 0,
  );

  // The OrcaSlicer "Add Primitive" menu set (GUI_Factories.cpp
  // append_submenu_add_generic): the shapes the native bridge's orc_add_shape
  // can build.
  const SUPPORTED_PRIMITIVES = ['Cube', 'Cylinder', 'Sphere', 'Cone', 'Disc', 'Torus'];

  // ---- Compatibility-aware FFF preset fixture. The mock intentionally owns
  // only simple explicit relations; real compatible_printers / conditions /
  // inheritance remain C++ engine behaviour. Afinia and the hidden print /
  // filament entries exercise visibility filtering. ----
  type PresetKind = 'printer' | 'print' | 'filament';
  type PresetFixture = {
    name: string; is_visible: boolean; is_default: boolean;
    vendor_id: string; model: string; variant: string;
    printable_area?: Array<[number, number]>;
    compatible_printers?: string[];
    compatible_prints?: string[];
  };
  const presetFixtures: Record<PresetKind, PresetFixture[]> = {
    printer: [
      { name: 'Bambu Lab X1 Carbon 0.4 nozzle', is_visible: true, is_default: false, vendor_id: 'bambulab', model: 'X1 Carbon', variant: '0.4', printable_area: [[0, 0], [220, 0], [220, 220], [0, 220]] },
      { name: 'Bambu Lab P1S 0.4 nozzle', is_visible: true, is_default: false, vendor_id: 'bambulab', model: 'P1S', variant: '0.4', printable_area: [[0, 0], [256, 0], [256, 256], [0, 256]] },
      { name: 'Afinia H+1(HS)', is_visible: false, is_default: false, vendor_id: 'afinia', model: 'H+1(HS)', variant: '0.4' },
    ],
    print: [
      { name: '0.20mm Standard @BBL X1C', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] },
      { name: '0.16mm Optimal @BBL X1C', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] },
      { name: '0.20mm Standard @BBL P1S', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', compatible_printers: ['Bambu Lab P1S 0.4 nozzle'] },
      { name: 'Hidden process', is_visible: false, is_default: false, vendor_id: '', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'] },
    ],
    filament: [
      { name: 'Bambu PLA Basic @BBL X1C', is_visible: true, is_default: false, vendor_id: 'bambulab', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'], compatible_prints: ['0.20mm Standard @BBL X1C', '0.16mm Optimal @BBL X1C'] },
      { name: 'Bambu PLA Matte @BBL X1C', is_visible: true, is_default: false, vendor_id: 'bambulab', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'], compatible_prints: ['0.20mm Standard @BBL X1C'] },
      { name: 'Bambu PLA Silk @BBL X1C', is_visible: true, is_default: false, vendor_id: 'bambulab', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'], compatible_prints: ['0.16mm Optimal @BBL X1C'] },
      { name: 'Bambu PLA Basic @BBL P1S', is_visible: true, is_default: false, vendor_id: 'bambulab', model: '', variant: '', compatible_printers: ['Bambu Lab P1S 0.4 nozzle'], compatible_prints: ['0.20mm Standard @BBL P1S'] },
      { name: 'Generic PLA @System', is_visible: true, is_default: false, vendor_id: 'OrcaFilamentLibrary', model: '', variant: '' },
      { name: 'Hidden filament', is_visible: false, is_default: false, vendor_id: '', model: '', variant: '', compatible_printers: ['Bambu Lab X1 Carbon 0.4 nozzle'], compatible_prints: ['0.20mm Standard @BBL X1C'] },
    ],
  };
  const selected: Record<'printer' | 'print', string> = {
    printer: presetFixtures.printer[0].name,
    print: presetFixtures.print[0].name,
  };
  type MockPresetDraftRegistry = Record<'printer' | 'filament', Record<string, Record<string, string>>>;
  type MockPresetEditorOption = {
    readonly scalarType: PresetDraftEditorScalarType;
    readonly metadataType: string;
    readonly values: PresetDraftEditorValue[];
    readonly guiType?: string;
    readonly guiFlags?: string;
    readonly multiline?: boolean;
    readonly isCode?: boolean;
    readonly nullable?: boolean;
    readonly readOnly?: boolean;
    readonly enumOptions?: Array<{ value: number; name: string; label: string }>;
  };
  type MockPresetEditorDraftRegistry = Record<'printer' | 'filament', Record<string, Record<string, PresetDraftEditorValue[]>>>;
  let presetDraftRegistry: MockPresetDraftRegistry = { printer: {}, filament: {} };
  let presetDraftEditorRegistry: MockPresetEditorDraftRegistry = { printer: {}, filament: {} };
  let presetDraftRevision = 0;

  function isCompatible(kind: 'print' | 'filament', fixture: PresetFixture): boolean {
    if (fixture.compatible_printers && !fixture.compatible_printers.includes(selected.printer)) return false;
    return kind !== 'filament' || !fixture.compatible_prints || fixture.compatible_prints.includes(selected.print);
  }

  function candidates(kind: PresetKind): PresetFixture[] {
    const list = presetFixtures[kind];
    if (kind === 'printer') return list.filter((preset) => preset.is_visible);
    return list.filter((preset) => preset.is_visible && isCompatible(kind, preset));
  }

  function selectedEntry(kind: 'printer' | 'print') {
    return {
      name: selected[kind],
      idx: presetFixtures[kind].findIndex((preset) => preset.name === selected[kind]),
    };
  }

  function snapshot() {
    const selectableEntry = (kind: 'printer' | 'print', preset: PresetFixture) => ({
      ...preset,
      selected: preset.name === selected[kind],
    });
    const filamentEntry = (preset: PresetFixture) => ({ ...preset });
    return {
      ok: true,
      printers: candidates('printer').map((preset) => selectableEntry('printer', preset)),
      prints: candidates('print').map((preset) => selectableEntry('print', preset)),
      filament_catalog: candidates('filament').map(filamentEntry),
      printer: selectedEntry('printer'),
      print: selectedEntry('print'),
      printable_area: presetFixtures.printer.find((preset) => preset.name === selected.printer)?.printable_area
        ?? [[0, 0], [220, 0], [220, 220], [0, 220]],
    };
  }

  function selectFallback(kind: 'print'): boolean {
    const fallback = candidates(kind)[0];
    if (!fallback) return false;
    selected[kind] = fallback.name;
    return true;
  }

  function resolveAfterPrinterChange(): boolean {
    const activePrint = presetFixtures.print.find((preset) => preset.name === selected.print);
    if (!activePrint || !isCompatible('print', activePrint)) {
      if (!selectFallback('print')) return false;
    }
    return true;
  }

  function resolveAfterPrintChange(): boolean {
    return true;
  }

  const identityTransform = () => ({
    offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1],
  });
  const instanceCount = Math.max(1, Math.floor(opts.instanceCount ?? 1));
  const volumeCount = Math.max(1, Math.floor(opts.volumeCount ?? 1));
  const splitParts = Math.max(1, Math.floor(opts.splitParts ?? 2));
  const createObjectTransforms = (origin: [number, number] = [0, 0]) => Array.from({ length: instanceCount }, (_, index) => ({
    ...identityTransform(),
    // Keep mock instances visibly separate so selection tests can hit each
    // one without a model fixture that depends on the native build.
    offset: [origin[0] + index * 50, origin[1], 0],
  }));
  // A ModelVolume belongs to the object, not to an instance.  Its transform
  // is therefore shared by every instance of that object, just as in the
  // native model.  Instance placement remains per-instance in
  // objectTransforms above.
  const createObjectVolumeTransforms = () => Array.from(
    { length: volumeCount },
    () => identityTransform(),
  );
  let objectTransforms: Array<ReturnType<typeof createObjectTransforms>> = [];
  let objectVolumeTransforms: Array<ReturnType<typeof createObjectVolumeTransforms>> = [];
  // --- stable model structure metadata (mirrors bridge.cpp) ---
  // The mock tracks stable ObjectIDs per object/volume/instance so
  // getModelStructure / selection-restoration tests behave like the real
  // bridge. IDs are minted once at add/delete and do not shift across
  // structural mutations.
  let nextObjectId = 1000;
  let nextVolumeId = 2000;
  let nextInstanceId = 3000;
  let objectMeta: Array<{ id: number; name: string; printable: boolean; primitive?: string }> = [];
  let volumeMeta: Array<Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }>> = [];
  let instanceMeta: Array<Array<{ id: number; printable: boolean }>> = [];
  let modelLoaded = false;
  let sliced = false;
  let slicedPlateId = '';
  let slicedPlateRevision = 0;
  const sliceReceipts = new Map<string, { inputStamp: number; resultGeneration: string; sliceTaskId: string }>();
  let plateSessionSequence = 0;
  let plateSessionId = '';
  let plateIds: string[] = [];
  let plateOrigins: Array<[number, number, number]> = [];
  let currentPlateId = '';
  let plateInputRevisions: Record<string, number> = {};
  let objectPlateIds: string[] = [];
  type MockNativeScopedConfig = {
    project: Record<string, string>;
    objects: Record<string, Record<string, string>>;
    parts: Record<string, Record<string, string>>;
    plates: Record<string, Record<string, string>>;
  };
  const emptyNativeScopedConfig = (): MockNativeScopedConfig => ({ project: {}, objects: {}, parts: {}, plates: {} });
  function nativeScopedConfigProjection(): MockNativeScopedConfig {
    // Prime Tower coordinates remain one native project-level array pair;
    // plate buckets carry only ordinary plate-local overrides.
    return clone(nativeScopedConfig);
  }
  const sliceWarnings = opts.sliceWarnings ? [...opts.sliceWarnings] : [];
  let nativeScopedConfig = opts.primeTowerFixture
    ? { ...emptyNativeScopedConfig(), project: { enable_prime_tower: '1' } }
    : emptyNativeScopedConfig();
  let exportedNativeScopedConfig = emptyNativeScopedConfig();
  let primeTowerProjectionState: any;

  type MockHistoryState = {
    modelLoaded: boolean;
    objectTransforms: Array<Array<ReturnType<typeof identityTransform>>>;
    objectVolumeTransforms: Array<Array<ReturnType<typeof identityTransform>>>;
    objectMeta: Array<{ id: number; name: string; printable: boolean; primitive?: string }>;
    volumeMeta: Array<Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }>>;
    instanceMeta: Array<Array<{ id: number; printable: boolean }>>;
    objectPlateIds: string[];
    currentPlateId: string;
    plateIds: string[];
    plateOrigins: Array<[number, number, number]>;
    plateInputRevisions: Record<string, number>;
    nativeScopedConfig: MockNativeScopedConfig;
    selectedProfiles: Record<'printer' | 'print', string>;
    presetDraftRegistry: MockPresetDraftRegistry;
    presetDraftEditorRegistry: MockPresetEditorDraftRegistry;
    presetDraftRevision: number;
    primeTowerProjection?: unknown;
  };
  type MockHistoryEntry = MockHistoryState & { id: string; label: string; category: 'project'; context: any };
  let historyEntries: MockHistoryEntry[] = [];
  let historyCursor = 0;
  let historyTransaction: { id: string; label: string; category: 'project'; before: MockHistoryState; beforeContext: any; targets: Array<{ scope: 'project' | 'object' | 'part' | 'plate'; id: string }> } | null = null;
  const historyNestedTransactions: Array<{ id: string; before: MockHistoryState; beforeContext: any }> = [];
  let nextHistoryTransactionId = 1;
  let nextHistoryEntryId = 1;
  let historyRevision = 0;
  let historyDisabled = false;
  let savedHistoryCursor: number | null = null;
  let savedHistoryCheckpointEvicted = false;
  let historyEvictedEntryCount = 0;
  let historyLastEvictedEntryId: string | null = null;

  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const presetEditorOptions: Record<'printer' | 'filament', Record<string, MockPresetEditorOption>> = {
    printer: {
      nozzle_diameter: { scalarType: 'float', metadataType: 'floats', values: [0.4] },
    },
    filament: {
      filament_flow_ratio: { scalarType: 'float', metadataType: 'floats', values: [1, 1] },
      default_filament_colour: { scalarType: 'string', metadataType: 'strings', values: ['#F2754E'], guiType: 'color' },
      filament_type: { scalarType: 'string', metadataType: 'strings', values: ['PLA'], guiType: 'f_enum_open', guiFlags: 'show_value' },
      filament_soluble: { scalarType: 'bool', metadataType: 'bools', values: [false] },
      filament_diameter: { scalarType: 'float', metadataType: 'floats', values: [1.75] },
      filament_adhesiveness_category: { scalarType: 'int', metadataType: 'ints', values: [0] },
      filament_shrink: { scalarType: 'percent', metadataType: 'percents', values: [100] },
      overhang_fan_threshold: {
        scalarType: 'enum', metadataType: 'enums', values: [2],
        enumOptions: [
          { value: 0, name: '0%', label: '0%' },
          { value: 1, name: '10%', label: '10%' },
          { value: 2, name: '25%', label: '25%' },
          { value: 3, name: '50%', label: '50%' },
          { value: 4, name: '75%', label: '75%' },
          { value: 5, name: '95%', label: '95%' },
        ],
      },
      filament_retract_lift_enforce: {
        scalarType: 'enum', metadataType: 'enums', values: [null], nullable: true,
        enumOptions: [
          { value: 0, name: 'All Surfaces', label: 'All Surfaces' },
          { value: 1, name: 'Top Only', label: 'Top Only' },
        ],
      },
      filament_start_gcode: { scalarType: 'string', metadataType: 'strings', values: ['G28\n'], multiline: true, isCode: true },
      filament_change_extrusion_role_gcode: { scalarType: 'string', metadataType: 'strings', values: ['; role change\n'], multiline: true, isCode: true },
      filament_end_gcode: { scalarType: 'string', metadataType: 'strings', values: ['M104 S0\n'], multiline: true, isCode: true },
      filament_notes: { scalarType: 'string', metadataType: 'strings', values: [''], multiline: true },
    },
  };
  const serializePresetEditorValues = (values: readonly PresetDraftEditorValue[]) => JSON.stringify(values);
  function editorValuesFor(kind: 'printer' | 'filament', canonicalName: string, key: string): PresetDraftEditorValue[] | undefined {
    return presetDraftEditorRegistry[kind][canonicalName]?.[key] ?? presetEditorOptions[kind][key]?.values;
  }
  function parseMockEditorValue(raw: string, option: MockPresetEditorOption): PresetDraftEditorValue[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as PresetDraftEditorValue[];
      if (parsed === null || typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean')
        return [parsed as PresetDraftEditorValue];
    } catch {
      // A legacy whole-option scalar string remains accepted by the mock bridge.
    }
    if (raw === 'nil' && option.nullable) return [null];
    if (option.scalarType === 'bool') return [raw === '1' || raw.toLocaleLowerCase() === 'true'];
    if (option.scalarType === 'float' || option.scalarType === 'int' || option.scalarType === 'percent' || option.scalarType === 'enum') {
      const numeric = Number(raw);
      return Number.isFinite(numeric) ? [numeric] : [...option.values];
    }
    return [raw];
  }
  function editorBindingsFor(kind: 'printer' | 'filament', canonicalName: string): Record<string, unknown> {
    return Object.fromEntries(Object.entries(presetEditorOptions[kind]).flatMap(([key, option]) => {
      const sourceValues = option.values;
      const effectiveValues = editorValuesFor(kind, canonicalName, key) ?? sourceValues;
      if (sourceValues.length === 0 || effectiveValues.length === 0) return [];
      return [[key, {
        scalar_type: option.scalarType,
        index: 0,
        element_count: effectiveValues.length,
        nullable: option.nullable ?? false,
        gui_type: option.guiType ?? 'undefined',
        gui_flags: option.guiFlags ?? '',
        multiline: option.multiline ?? false,
        is_code: option.isCode ?? false,
        readonly: option.readOnly ?? false,
        source_value: clone(sourceValues[0]),
        effective_value: clone(effectiveValues[0]),
        ...(option.scalarType === 'enum' ? { enum_options: clone(option.enumOptions ?? []) } : {}),
      }]];
    }));
  }
  function presetDraftRegistrySnapshot() {
    return { entries: (['printer', 'filament'] as const).flatMap((kind) =>
      Object.entries(presetDraftRegistry[kind]).map(([canonical_name, overrides]) => ({
        kind, canonical_name, overrides: clone(overrides),
      }))) };
  }
  function presetSourceValues(kind: 'printer' | 'filament', canonicalName: string): Record<string, string> | undefined {
    const preset = presetFixtures[kind].find((entry) => entry.name === canonicalName);
    if (!preset) return undefined;
    const source: Record<string, string> = kind === 'printer' ? {
      nozzle_temperature: '220',
      printable_height: '256',
      printable_area: JSON.stringify(preset.printable_area ?? [[0, 0], [220, 0], [220, 220], [0, 220]]),
      nozzle_diameter: serializePresetEditorValues(presetEditorOptions.printer.nozzle_diameter!.values),
    } : {
      filament_vendor: 'Generic',
      enable_pressure_advance: '0',
    };
    for (const [key, option] of Object.entries(presetEditorOptions[kind]))
      source[key] = serializePresetEditorValues(option.values);
    return source;
  }
  function presetDraftSnapshot(kind: 'printer' | 'filament', canonicalName: string): Record<string, unknown> {
    const sourceValues = presetSourceValues(kind, canonicalName);
    if (!sourceValues) return { ok: false, error_code: 'preset_not_found',
      error: `preset not found: ${canonicalName}`, revision: historyRevision };
    const draft = presetDraftRegistry[kind][canonicalName];
    const overrides = draft ? clone(draft) : {};
    const optionMetadata = Object.fromEntries(Object.keys(sourceValues)
      .filter((key) => metadata[key] !== undefined).map((key) => [key, clone(metadata[key])]));
    return { ok: true, kind, canonical_name: canonicalName,
      draft_exists: draft !== undefined, modified: Object.keys(overrides).length > 0,
      overrides, source_values: sourceValues, effective_values: { ...sourceValues, ...overrides },
      option_metadata: optionMetadata, editor_bindings: editorBindingsFor(kind, canonicalName), revision: historyRevision };
  }
  function nativePresetDraftHistoryContext() {
    return {
      selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
      activePlateId: currentPlateId || null,
      gizmo: null,
      nativeScopedConfig: clone(nativeScopedConfig),
      plateSession: plateSessionSnapshot(),
      presetDraftRegistry: presetDraftRegistrySnapshot(),
      presetDraftRevision,
    };
  }
  function mutatePresetDraft(requestJson: string): Record<string, unknown> {
    let request: any;
    try { request = JSON.parse(requestJson); }
    catch { return { ok: false, error_code: 'invalid_request', error: 'invalid preset draft request', revision: historyRevision }; }
    const fail = (errorCode: string, error: string) => ({ ok: false, error_code: errorCode, error, revision: historyRevision });
    if (!request || !['printer', 'filament'].includes(request.kind) ||
        typeof request.canonical_name !== 'string' || !request.canonical_name || typeof request.action !== 'string')
      return fail('invalid_request', 'invalid preset draft request');
    if (historyTransaction) return fail('history_transaction_active', 'preset draft command cannot run inside another history transaction');
    if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision !== historyRevision)
      return fail('stale_revision', 'preset draft revision is stale');
    const kind = request.kind as 'printer' | 'filament';
    const sourceValues = presetSourceValues(kind, request.canonical_name);
    if (!sourceValues) return fail('preset_not_found', `preset not found: ${request.canonical_name}`);
    const action = request.action as string;
    const resetKeys: string[] = [];
    if (action === 'set') {
      if (typeof request.key !== 'string' || !(request.key in sourceValues) || typeof request.value !== 'string')
        return fail('unsupported_option', 'option is not available on this preset');
      const meta = metadata[request.key];
      if ((meta?.type === 'float' || meta?.type === 'floats' || meta?.type === 'int' || meta?.type === 'ints' || meta?.type === 'percent' || meta?.type === 'percents') &&
          (!request.value.trim() || !Number.isFinite(Number(request.value))))
        return fail('native_validation_failure', 'native option validation failed');
    } else if (action === 'set-element') {
      if (typeof request.key !== 'string' || !(request.key in sourceValues))
        return fail('unsupported_option', 'option is not available on this preset');
      const option = presetEditorOptions[kind][request.key];
      if (!option || request.scalar_type !== option.scalarType)
        return fail('invalid_element_type', 'preset editor element type does not match native option');
      const values = editorValuesFor(kind, request.canonical_name, request.key) ?? option.values;
      if (!Number.isSafeInteger(request.index) || request.index < 0 || request.index >= values.length)
        return fail('invalid_index', 'preset editor vector index is out of range');
      const value = request.value as PresetDraftEditorValue;
      if (value === null) {
        if (!option.nullable) return fail('invalid_value', 'null is not valid for this preset editor element');
      } else if (option.scalarType === 'string') {
        if (typeof value !== 'string') return fail('invalid_value', 'preset editor element requires text');
      } else if (option.scalarType === 'bool') {
        if (typeof value !== 'boolean') return fail('invalid_value', 'preset editor element requires a boolean');
      } else if (option.scalarType === 'float_or_percent') {
        if (typeof value !== 'object' || !Number.isFinite(value.value) || typeof value.percent !== 'boolean')
          return fail('invalid_value', 'preset editor element requires {value, percent}');
      } else if (option.scalarType === 'int' || option.scalarType === 'enum') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value))
          return fail('invalid_value', 'preset editor element requires an integer');
      } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('invalid_value', 'preset editor element requires a finite number');
      }
    } else if (action === 'reset-field') {
      if (typeof request.key !== 'string' || !(request.key in sourceValues))
        return fail('unsupported_option', 'option is not available on this preset');
      resetKeys.push(request.key);
    } else if (action === 'reset-category') {
      if (!Array.isArray(request.keys) || request.keys.length === 0 ||
          !request.keys.every((key: unknown) => typeof key === 'string' && key in sourceValues) ||
          new Set(request.keys).size !== request.keys.length)
        return fail('unsupported_option', 'reset-category requires distinct available option keys');
      resetKeys.push(...request.keys);
    } else if (action !== 'reset-preset') {
      return fail('invalid_request', 'unknown preset draft action');
    }

    const beforeState = captureHistoryState();
    const beforeContext = nativePresetDraftHistoryContext();
    if (historyEntries.length === 0) {
      historyEntries.push({ ...beforeState, id: 'entry-0', label: '', category: 'project', context: clone(beforeContext) });
      historyCursor = 0;
      savedHistoryCursor = 0;
    }
    const revisionBefore = historyRevision;
    const canonicalName = request.canonical_name as string;
    if (action === 'set') {
      const current = presetDraftRegistry[kind][canonicalName] ?? {};
      const option = presetEditorOptions[kind][request.key];
      if (option) {
        const values = parseMockEditorValue(request.value, option);
        const editorValues = presetDraftEditorRegistry[kind][canonicalName] ?? {};
        editorValues[request.key] = values;
        presetDraftEditorRegistry[kind][canonicalName] = editorValues;
        current[request.key] = serializePresetEditorValues(values);
      } else {
        current[request.key] = request.value;
      }
      presetDraftRegistry[kind][canonicalName] = current;
    } else if (action === 'set-element') {
      const option = presetEditorOptions[kind][request.key] as MockPresetEditorOption;
      const values = [...(editorValuesFor(kind, canonicalName, request.key) ?? option.values)];
      values[request.index] = clone(request.value as PresetDraftEditorValue);
      const editorValues = presetDraftEditorRegistry[kind][canonicalName] ?? {};
      editorValues[request.key] = values;
      presetDraftEditorRegistry[kind][canonicalName] = editorValues;
      const current = presetDraftRegistry[kind][canonicalName] ?? {};
      current[request.key] = serializePresetEditorValues(values);
      presetDraftRegistry[kind][canonicalName] = current;
    } else if (action === 'reset-field' || action === 'reset-category') {
      const current = presetDraftRegistry[kind][canonicalName] ?? {};
      const editorValues = presetDraftEditorRegistry[kind][canonicalName] ?? {};
      for (const key of resetKeys) {
        delete current[key];
        delete editorValues[key];
      }
      presetDraftRegistry[kind][canonicalName] = current;
      presetDraftEditorRegistry[kind][canonicalName] = editorValues;
    } else {
      delete presetDraftRegistry[kind][canonicalName];
      delete presetDraftEditorRegistry[kind][canonicalName];
    }
    presetDraftRevision += 1;
    for (const id of plateIds) plateInputRevisions[id] = (plateInputRevisions[id] ?? 0) + 1;
    sliced = false;
    for (const id of [...sliceReceipts.keys()]) sliceReceipts.delete(id);

    if (historyCursor + 1 < historyEntries.length && savedHistoryCursor !== null && savedHistoryCursor > historyCursor)
      savedHistoryCheckpointEvicted = true;
    historyEntries.splice(historyCursor + 1);
    historyRevision += 1;
    const context = nativePresetDraftHistoryContext();
    historyEntries.push({ ...captureHistoryState(), id: `entry-${nextHistoryEntryId++}`,
      label: `Edit ${canonicalName}`, category: 'project', context: clone(context) });
    historyCursor = historyEntries.length - 1;

    const result = presetDraftSnapshot(kind, canonicalName) as Record<string, unknown>;
    const plateSession = plateSessionSnapshot() as Record<string, unknown>;
    plateSession.affected_plate_ids_before = [...plateIds];
    plateSession.affected_plate_ids_after = [...plateIds];
    plateSession.affected_plate_ids = [...plateIds];
    plateSession.dirty_reasons = ['shared-configuration'];
    plateSession.native_scoped_config = nativeScopedConfigFullTransport();
    const filamentSnapshot = filamentSessionSnapshot() as any;
    filamentSnapshot.revisions = { ...filamentSnapshot.revisions,
      session: historyRevision, project: historyRevision, plates: { ...plateInputRevisions } };
    filamentSessionState = clone(filamentSnapshot);
    return { ...result, history_entry_delta: 1, revision_before: revisionBefore,
      revision_after: historyRevision, dirty: true, affected_plate_ids: [...plateIds],
      all_plate_results_invalidated: true, plate_session: plateSession,
      filament_session: filamentSnapshot,
      history_status: historyStatus(), native_scoped_config: nativeScopedConfigFullTransport() };
  }
  type MockScopedTarget = { scope: 'project' | 'object' | 'part' | 'plate'; id?: string };
  function nativeScopedConfigRemovedTargets(before: MockNativeScopedConfig, after: MockNativeScopedConfig): MockScopedTarget[] {
    return (['objects', 'parts', 'plates'] as const).flatMap((bucket) => {
      const scope = bucket === 'objects' ? 'object' : bucket === 'parts' ? 'part' : 'plate';
      return Object.keys(before[bucket])
        .filter((id) => !(id in after[bucket]))
        .map((id) => ({ scope, id }));
    });
  }
  function nativeScopedConfigFullTransport(removedTargets: MockScopedTarget[] = []) {
    return { version: 1, revision: historyRevision, kind: 'full' as const,
      snapshot: nativeScopedConfigProjection(), removed_targets: clone(removedTargets) };
  }
  function nativeScopedConfigAffectedTransport(
    targets: Array<{ scope: 'project' | 'object' | 'part' | 'plate'; id: string }>,
    removedTargets: MockScopedTarget[] = [],
  ) {
    const seen = new Set<string>();
    const removed = new Set(removedTargets.map((target) => `${target.scope}:${target.id ?? ''}`));
    const replacements = targets.flatMap((target) => {
      const identity = `${target.scope}:${target.id}`;
      if (seen.has(identity) || removed.has(identity)) return [];
      seen.add(identity);
      const values = target.scope === 'project' ? nativeScopedConfig.project
        : target.scope === 'object' ? nativeScopedConfig.objects[target.id]
          : target.scope === 'part' ? nativeScopedConfig.parts[target.id]
            : nativeScopedConfig.plates[target.id];
      return [{ scope: target.scope, ...(target.scope === 'project' ? {} : { id: target.id }), values: clone(values ?? {}) }];
    });
    return { version: 1, revision: historyRevision, kind: 'affected' as const,
      replacements, removed_targets: clone(removedTargets) };
  }
  primeTowerProjectionState = opts.primeTowerProjection !== undefined ? clone(opts.primeTowerProjection) : undefined;
  function captureHistoryState(): MockHistoryState {
    return clone({ modelLoaded, objectTransforms, objectVolumeTransforms, objectMeta, volumeMeta,
      instanceMeta, objectPlateIds, currentPlateId, plateIds, plateOrigins, plateInputRevisions,
      nativeScopedConfig, selectedProfiles: selected, presetDraftRegistry, presetDraftRevision,
      presetDraftEditorRegistry,
      primeTowerProjection: primeTowerProjectionState });
  }
  function restoreHistoryState(snapshot: MockHistoryState): void {
    modelLoaded = snapshot.modelLoaded;
    objectTransforms = clone(snapshot.objectTransforms);
    objectVolumeTransforms = clone(snapshot.objectVolumeTransforms);
    objectMeta = clone(snapshot.objectMeta);
    volumeMeta = clone(snapshot.volumeMeta);
    instanceMeta = clone(snapshot.instanceMeta);
    objectPlateIds = clone(snapshot.objectPlateIds);
    currentPlateId = snapshot.currentPlateId;
    plateIds = clone(snapshot.plateIds);
    plateOrigins = clone(snapshot.plateOrigins);
    plateInputRevisions = clone(snapshot.plateInputRevisions);
    nativeScopedConfig = clone(snapshot.nativeScopedConfig ?? emptyNativeScopedConfig());
    Object.assign(selected, snapshot.selectedProfiles);
    presetDraftRegistry = clone(snapshot.presetDraftRegistry);
    presetDraftEditorRegistry = clone(snapshot.presetDraftEditorRegistry ?? { printer: {}, filament: {} });
    presetDraftRevision = snapshot.presetDraftRevision;
    primeTowerProjectionState = snapshot.primeTowerProjection === undefined ? undefined : clone(snapshot.primeTowerProjection);
    sliced = false;
  }
  function affectedHistoryPlateIds(before: MockHistoryState, after: MockHistoryState): string[] {
    const affected = new Set<string>();
    const add = (plateId: string | undefined) => { if (plateId) affected.add(plateId); };
    const objectById = (state: MockHistoryState) => new Map(state.objectMeta.map((object, index) => [object.id, {
      plateId: state.objectPlateIds[index], transforms: state.objectTransforms[index],
      volumeTransforms: state.objectVolumeTransforms[index], volumes: state.volumeMeta[index],
      instances: state.instanceMeta[index],
    }]));
    const beforeObjects = objectById(before);
    const afterObjects = objectById(after);
    for (const id of new Set([...beforeObjects.keys(), ...afterObjects.keys()])) {
      const previous = beforeObjects.get(id);
      const next = afterObjects.get(id);
      if (!previous || !next || JSON.stringify(previous) !== JSON.stringify(next)) {
        add(previous?.plateId);
        add(next?.plateId);
      }
    }
    if (JSON.stringify(before.nativeScopedConfig.project) !== JSON.stringify(after.nativeScopedConfig.project)) {
      for (const plateId of after.plateIds) add(plateId);
    }
    const changedKeys = (beforeValues: Record<string, unknown>, afterValues: Record<string, unknown>) =>
      new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)].filter((key) =>
        JSON.stringify(beforeValues[key]) !== JSON.stringify(afterValues[key])));
    for (const objectId of changedKeys(before.nativeScopedConfig.objects, after.nativeScopedConfig.objects)) {
      add(beforeObjects.get(Number(objectId))?.plateId);
      add(afterObjects.get(Number(objectId))?.plateId);
    }
    for (const volumeId of changedKeys(before.nativeScopedConfig.parts, after.nativeScopedConfig.parts)) {
      const owner = (state: MockHistoryState) => state.volumeMeta.findIndex((volumes) => volumes.some((volume) => String(volume.id) === volumeId));
      const beforeIndex = owner(before);
      const afterIndex = owner(after);
      add(beforeIndex >= 0 ? before.objectPlateIds[beforeIndex] : undefined);
      add(afterIndex >= 0 ? after.objectPlateIds[afterIndex] : undefined);
    }
    for (const plateId of changedKeys(before.nativeScopedConfig.plates, after.nativeScopedConfig.plates)) add(plateId);
    return [...affected].sort();
  }
  function historyStatus() {
    const project = (entry: MockHistoryEntry): boolean => entry.id !== 'entry-0';
    const undoEntries = historyEntries.slice(1, historyCursor + 1).reverse()
      .filter(project).map(({ id, label, category }) => ({ id, label, category }));
    const redoEntries = historyEntries.slice(historyCursor + 1)
      .filter(project).map(({ id, label, category }) => ({ id, label, category }));
    let undoIndex = -1;
    for (let index = historyCursor; index > 0; index--)
      if (project(historyEntries[index])) { undoIndex = index; break; }
    const redoIndex = historyEntries.findIndex((entry, index) => index > historyCursor && project(entry));
    const undo = undoIndex >= 0 ? historyEntries[undoIndex] : undefined;
    const redo = redoIndex >= 0 ? historyEntries[redoIndex] : undefined;
    const checkpoint = savedHistoryCursor;
    let dirty = savedHistoryCheckpointEvicted || checkpoint === null;
    if (!dirty && checkpoint !== historyCursor) {
      const checkpointValue = checkpoint as number;
      const [lo, hi] = checkpointValue < historyCursor
        ? [checkpointValue, historyCursor] : [historyCursor, checkpointValue];
      dirty = historyEntries.slice(lo + 1, hi + 1).some(project);
    }
    return {
      canUndo: undoIndex >= 0, canRedo: redoIndex >= 0,
      ...(undo ? { undoLabel: undo.label } : {}),
      ...(redo ? { redoLabel: redo.label } : {}), undoEntries, redoEntries,
      cursor: historyCursor, savedCheckpoint: savedHistoryCursor, savedCheckpointEvicted: savedHistoryCheckpointEvicted,
      dirty, bytesUsed: JSON.stringify(historyEntries).length,
      evictedEntryCount: historyEvictedEntryCount,
      lastEvictedEntryId: historyLastEvictedEntryId,
      oldestRetainedEntryId: historyEntries[0]?.id ?? null,
      oversizedEntryRetained: false,
      byteBudget: 256 * 1024 * 1024, disabled: historyDisabled,
      activeTransactionId: historyTransaction?.id ?? null, revision: historyRevision,
    };
  }
  function validateHistoryContext(context: any): void {
    if (!context || typeof context !== 'object' || !context.selection ||
        !context.nativeScopedConfig || !('activePlateId' in context) || !('gizmo' in context))
      throw new Error('invalid history context');
  }
  function resetHistory(): void {
    historyEntries = []; historyCursor = 0; historyTransaction = null; historyNestedTransactions.length = 0;
    savedHistoryCursor = null; savedHistoryCheckpointEvicted = false;
    historyEvictedEntryCount = 0;
    historyLastEvictedEntryId = null;
    historyRevision++; historyDisabled = false;
  }
  function mockSceneDelta(before: MockHistoryState, after: MockHistoryState) {
    const describe = (state: MockHistoryState, id: number) => {
      const i = state.objectMeta.findIndex((object) => object.id === id);
      return i < 0 ? null : [state.objectMeta[i], state.volumeMeta[i], state.instanceMeta[i],
        state.objectTransforms[i], state.objectVolumeTransforms[i]];
    };
    const ids = [...new Set([...before.objectMeta, ...after.objectMeta].map((object) => object.id))];
    const touched = ids.filter((id) => JSON.stringify(describe(before, id)) !== JSON.stringify(describe(after, id)));
    const volumes: number[] = [], instances: number[] = [];
    for (const state of [before, after]) state.objectMeta.forEach((object, index) => {
      if (!touched.includes(object.id)) return;
      volumes.push(...state.volumeMeta[index].map((volume) => volume.id));
      instances.push(...state.instanceMeta[index].map((instance) => instance.id));
    });
    return { version: 1, object_ids: touched, volume_ids: [...new Set(volumes)],
      instance_ids: [...new Set(instances)], plate_ids: [...new Set([...before.plateIds, ...after.plateIds])],
      object_order: after.objectMeta.map((object) => object.id) };
  }
  function modelGeometry(requested: Set<number>, known: Set<number>) {
    const geometries: Record<string, unknown>[] = [];
    const renderables = objectTransforms.flatMap((instances, object_idx) => {
      if (!requested.has(objectMeta[object_idx].id)) return [];
      return objectVolumeTransforms[object_idx].flatMap((volume_transform, volume_idx) => {
        const volume_id = volumeMeta[object_idx][volume_idx].id;
        if (instances.length && !known.has(volume_id)) {
          const { verts, tris } = primitiveMesh(objectMeta[object_idx]?.primitive);
          const vertex_ptr = malloc(verts.length * 12), index_ptr = malloc(tris.length * 12);
          verts.forEach((vertex, i) => HEAPF32.set(vertex, vertex_ptr / 4 + i * 3));
          tris.forEach((triangle, i) => HEAPU32.set(triangle, index_ptr / 4 + i * 3));
          geometries.push({ volume_id, vertex_ptr, vertex_count: verts.length, index_ptr, index_count: tris.length * 3 });
        }
        return instances.map((instance_transform, instance_idx) => ({
          object_id: objectMeta[object_idx].id, volume_id, instance_id: instanceMeta[object_idx][instance_idx].id,
          object_idx, volume_idx, instance_idx, offset: instance_transform.offset, instance_transform, volume_transform,
        }));
      });
    });
    return { ok: true, renderables, geometries };
  }
  function historyRestore(entry: MockHistoryEntry) {
    const beforeState = captureHistoryState();
    const beforeDraftRegistry = JSON.stringify(beforeState.presetDraftRegistry);
    const beforePlateInputRevisions = { ...beforeState.plateInputRevisions };
    const before = nativeScopedConfigProjection();
    restoreHistoryState(entry);
    const presetDraftsChanged = beforeDraftRegistry !== JSON.stringify(entry.presetDraftRegistry);
    const profileSelection = JSON.stringify(beforeState.selectedProfiles) !== JSON.stringify(entry.selectedProfiles);
    if (presetDraftsChanged || profileSelection)
      for (const id of plateIds)
        plateInputRevisions[id] = Math.max(beforePlateInputRevisions[id] ?? 0, plateInputRevisions[id] ?? 0) + 1;
    historyRevision++;
    const removedTargets = nativeScopedConfigRemovedTargets(before, nativeScopedConfigProjection());
    const states = [...historyEntries, entry];
    const sceneDelta = {
      version: 1,
      object_ids: [...new Set(states.flatMap((state) => state.objectMeta.map((object) => object.id)))].sort((a, b) => a - b),
      volume_ids: [...new Set(states.flatMap((state) => state.volumeMeta.flatMap((volumes) => volumes.map((volume) => volume.id))))].sort((a, b) => a - b),
      instance_ids: [...new Set(states.flatMap((state) => state.instanceMeta.flatMap((instances) => instances.map((instance) => instance.id))))].sort((a, b) => a - b),
      plate_ids: [...new Set(states.flatMap((state) => state.plateIds))].sort(),
      object_order: entry.objectMeta.map((object) => object.id),
    };
    return { ok: true, context: { ...clone(entry.context), plateSession: plateSessionSnapshot() },
      native_scoped_config: nativeScopedConfigFullTransport(removedTargets), status: historyStatus(), entryId: entry.id,
      affected_plate_ids: presetDraftsChanged || profileSelection ? [...plateIds] : affectedHistoryPlateIds(beforeState, entry),
      ...(profileSelection ? { profile_snapshot: snapshot() } : {}),
      scene_delta: sceneDelta,
      impact: { version: 1, model: 'delta', plateSession: true, filamentRack: true, nativeScopedConfig: true,
          presetDrafts: presetDraftsChanged, profileSelection, selectionContext: true, primeTower: true, preview: 'all' } };
  }
  function plateStride(): number {
    const area = presetFixtures.printer.find((preset) => preset.name === selected.printer)?.printable_area;
    const width = area && area.length > 1 ? Math.max(...area.map((point) => point[0])) - Math.min(...area.map((point) => point[0])) : 200;
    // Preserve the mock's established 240 mm default grid spacing used by
    // existing renderer/e2e fixtures; printer changes still exercise the
    // contract by deriving the new stride from the selected bed.
    return selected.printer === 'Bambu Lab P1S 0.4 nozzle' ? width * 1.2 : 240;
  }

  function plateColumnCount(count: number): number {
    if (count <= 1) return 1;
    const root = Math.sqrt(count);
    const rounded = Math.round(root);
    return root > rounded ? rounded + 1 : rounded;
  }

  function plateOrigin(index: number, count = plateIds.length): [number, number, number] {
    const columns = plateColumnCount(count);
    return [(index % columns) * plateStride(), -Math.floor(index / columns) * plateStride(), 0];
  }

  function resetPlateSession(): void {
    plateSessionSequence += 1;
    plateSessionId = `plate-session-${plateSessionSequence}-plate-1`;
    plateIds = [plateSessionId];
    plateOrigins = [[0, 0, 0]];
    currentPlateId = plateSessionId;
    plateInputRevisions = { [plateSessionId]: 0 };
    objectPlateIds = objectMeta.map(() => plateSessionId);
  }
  resetPlateSession();
  function plateSessionSnapshot() {
    const result: Record<string, unknown> = {
      ok: true,
      version: 1,
      current_plate_id: currentPlateId,
      input_revisions: { ...plateInputRevisions },
      plates: plateIds.map((id, index) => ({
        plate_id: id, display_index: index, origin: plateOrigins[index], name: `Plate ${index + 1}`,
        instance_ids: instanceMeta.flatMap((instances, objectIndex) =>
          objectPlateIds[objectIndex] === id ? instances.map((instance) => instance.id) : []),
        out_of_bounds_instance_ids: [], valid: true,
      })),
    };
    result.instance_transforms = [];
    result.instances = objectTransforms.flatMap((transforms, objectIndex) =>
      transforms.map((_transform, instanceIndex) => {
        const instance = instanceMeta[objectIndex]?.[instanceIndex];
        return {
          instance_id: instance?.id ?? 0,
          object_id: objectMeta[objectIndex]?.id ?? 0,
          object_index: objectIndex,
          instance_index: instanceIndex,
          plate_id: objectPlateIds[objectIndex] ?? currentPlateId,
          member: true,
          unprintable: false,
          out_of_bounds: false,
        };
      }));

    return result;
  }

  function primeTowerProjection(): unknown {
    if (primeTowerProjectionState !== undefined) return clone(primeTowerProjectionState);
    const area = { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 };
    if (opts.primeTowerFixture) {
      const enabled = nativeScopedConfig.project.enable_prime_tower !== '0';
      return {
        ok: true, version: 1, current_plate_id: currentPlateId, build_area: area,
        plates: plateIds.map((plateId, index) => ({
          plate_id: plateId, display_index: index, eligible: enabled, empty: false, forced: false,
          used_slots: enabled ? [1, 2] : [], width: enabled ? 24 : 0, depth: enabled ? 36 : 0, height: enabled ? 18 : 0,
          position: { x: 30, y: 40 }, rotation: 0, brim_margin: 3,
          footprint: { min_x: 27, max_x: 57, min_y: 37, max_y: 77 },
          bands: enabled ? [
            { slot: 1, start_depth: 0, end_depth: 18, colour: '#333333', opacity: 0.66 },
            { slot: 2, start_depth: 18, end_depth: 36, colour: '#ffd700', opacity: 0.66 },
          ] : [], build_area: area,
        })),
      };
    }
    return {
      ok: true, version: 1, current_plate_id: currentPlateId, build_area: area,
      plates: plateIds.map((plateId, index) => ({
        plate_id: plateId, display_index: index, eligible: false, empty: true, forced: false,
        used_slots: [], width: 0, depth: 0, height: 0,
        position: { x: 15, y: 220 }, rotation: 0, brim_margin: 3,
        footprint: { min_x: 15, max_x: 15, min_y: 220, max_y: 220 }, bands: [], build_area: area,
      })),
    };
  }

  function movePrimeTower(requestJson: string): unknown {
    let request: any;
    try { request = JSON.parse(requestJson); } catch {
      return { ok: false, version: 1, error: 'invalid prime tower move request', error_code: 'invalid_command', status: { state: 'error', error: 'invalid prime tower move request' } };
    }
    if (!request || request.version !== 1 || typeof request.plate_id !== 'string' ||
        !Number.isSafeInteger(request.revision) || !Number.isFinite(request.x) || !Number.isFinite(request.y))
      return { ok: false, version: 1, error: 'invalid prime tower move request', error_code: 'invalid_command', status: { state: 'error', error: 'invalid prime tower move request' } };
    const current: any = primeTowerProjection();
    const plate = current.plates?.find((entry: any) => entry.plate_id === request.plate_id);
    if (!plate) return { ok: false, version: 1, error: 'plate not found', error_code: 'unsupported_reference', status: { state: 'error', error: 'plate not found' } };
    if (request.revision !== (plateInputRevisions[request.plate_id] ?? 0))
      return { ok: false, version: 1, error: 'prime tower plate revision is stale', error_code: 'stale_revision', status: { state: 'error', error: 'prime tower plate revision is stale' } };
    if (request.inject_failure === true)
      return { ok: false, version: 1, error: 'prime tower move validation failed', error_code: 'native_validation_failure', status: { state: 'error', error: 'prime tower move validation failed' } };
    if (!plate.eligible) return { ok: false, version: 1, error: 'prime tower is not available on this plate', error_code: 'ineligible_target', status: { state: 'error', error: 'prime tower is not available on this plate' } };
    const old = { x: plate.position.x, y: plate.position.y };
    const widthX = plate.footprint.max_x - plate.footprint.min_x;
    const widthY = plate.footprint.max_y - plate.footprint.min_y;
    const offsetMinX = plate.footprint.min_x - old.x;
    const offsetMaxX = plate.footprint.max_x - old.x;
    const offsetMinY = plate.footprint.min_y - old.y;
    const offsetMaxY = plate.footprint.max_y - old.y;
    const clamp = (value: number, minOffset: number, maxOffset: number, min: number, max: number) => {
      const low = min - minOffset;
      const high = max - maxOffset;
      return low <= high ? Math.min(high, Math.max(low, value)) : (min + max - minOffset - maxOffset) / 2;
    };
    const area = plate.build_area;
    const x = clamp(request.x, offsetMinX, offsetMaxX, area.min_x, area.max_x);
    const y = clamp(request.y, offsetMinY, offsetMaxY, area.min_y, area.max_y);
    if (x === old.x && y === old.y) return { ok: true, version: 1, result: { history_status: historyStatus(), mutation: {
      kind: 'move', plate_id: request.plate_id, history_entry_delta: 0, revision_before: plateInputRevisions[request.plate_id] ?? 0,
      revision_after: plateInputRevisions[request.plate_id] ?? 0, dirty: false, affected_plate_ids: [], position: old, footprint: plate.footprint,
    } } };
    const beforeState = captureHistoryState();
    const next = clone(current) as any;
    const target = next.plates.find((entry: any) => entry.plate_id === request.plate_id);
    target.position = { x, y };
    target.footprint = { min_x: target.footprint.min_x + x - old.x, max_x: target.footprint.max_x + x - old.x,
      min_y: target.footprint.min_y + y - old.y, max_y: target.footprint.max_y + y - old.y };
    primeTowerProjectionState = next;
    const xValues = (nativeScopedConfig.project.wipe_tower_x ?? '').split(',').filter(Boolean);
    const yValues = (nativeScopedConfig.project.wipe_tower_y ?? '').split(',').filter(Boolean);
    xValues[plate.display_index] = String(x);
    yValues[plate.display_index] = String(y);
    nativeScopedConfig.project.wipe_tower_x = xValues.join(',');
    nativeScopedConfig.project.wipe_tower_y = yValues.join(',');
    historyRevision += 1;
    if (slicedPlateId === request.plate_id) sliced = false;
    plateMutation('prime-tower-position');
    const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
      activePlateId: currentPlateId, gizmo: null, nativeScopedConfig: clone(nativeScopedConfig),
      primeTowerMove: { plateId: request.plate_id, before: old, after: { x, y } } };
    if (historyEntries.length === 0) {
      historyEntries.push({ ...beforeState, id: 'entry-0', label: '', category: 'project', context: clone(context) });
      historyCursor = 0; savedHistoryCursor = 0;
    }
    if (historyCursor + 1 < historyEntries.length && savedHistoryCursor !== null && savedHistoryCursor > historyCursor)
      savedHistoryCheckpointEvicted = true;
    historyEntries.splice(historyCursor + 1);
    historyEntries.push({ ...captureHistoryState(), id: `entry-${nextHistoryEntryId++}`, label: 'Move Prime Tower', category: 'project', context: clone(context) });
    historyCursor = historyEntries.length - 1;
    return { ok: true, version: 1, result: { history_status: historyStatus(), mutation: {
      kind: 'move', plate_id: request.plate_id, history_entry_delta: 1, revision_before: request.revision,
      revision_after: historyRevision, dirty: true, affected_plate_ids: [request.plate_id],
      clamped: x !== request.x || y !== request.y, outside_boundary_warning: widthX > area.max_x - area.min_x || widthY > area.max_y - area.min_y,
      position: { x, y }, footprint: target.footprint,
    } } };
  }

  function filamentSessionSnapshot(): unknown {
    if (filamentSessionState !== undefined) {
      const snapshot = clone(filamentSessionState) as any;
      // Slot mutations replace the mock's projected session object. Keep its
      // model-backed assignment projection live when a later Add Primitive
      // changes the model; the native bridge derives this from the current
      // Model on every snapshot read.
      if (objectMeta.length > 0) {
        const previousObjects = new Map((snapshot.assignments?.objects ?? []).map((entry: any) => [entry.id, entry]));
        const previousParts = new Map((snapshot.assignments?.parts ?? []).map((entry: any) => [entry.id, entry]));
        const objects = objectMeta.map((object) => previousObjects.get(object.id) ?? ({
          target: 'object', id: object.id, object_id: object.id,
          explicit_slot: 1, effective_slot: 1, inherited: false,
        }));
        const parts = objectMeta.flatMap((object, index) => (volumeMeta[index] ?? [])
          .filter((volume) => volume.type === 'model_part')
          .map((volume) => previousParts.get(volume.id) ?? ({
            target: 'model-part', id: volume.id, object_id: object.id,
            explicit_slot: 0, effective_slot: 1, inherited: true,
          })));
        snapshot.assignments = { ...snapshot.assignments, objects, parts, modifiers: snapshot.assignments?.modifiers ?? [] };
      }
      return snapshot;
    }
    const objects = objectMeta.map((object) => ({
      target: 'object', id: object.id, object_id: object.id,
      explicit_slot: 1, effective_slot: 1, inherited: false,
    }));
    const parts = objectMeta.flatMap((object, index) => (volumeMeta[index] ?? [])
      .filter((volume) => volume.type === 'model_part')
      .map((volume) => ({ target: 'model-part', id: volume.id, object_id: object.id,
        explicit_slot: 0, effective_slot: 1, inherited: true })));
    return {
      ok: true, version: 1,
      slots: [{ slot: 1, preset: { id: 'Generic PLA @System', name: 'Generic PLA @System' },
        colour: { effective: '#F2754E', provenance: 'preset' } }],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physical_extruder: [0] },
      flushing: { matrix: [0], vector: [], matrix_dimension: 1, plane_count: 1, source: 'default' },
      capabilities: { min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true,
        can_add: true, can_delete: false, can_merge: false },
      routing: [],
      assignments: { objects, parts, modifiers: [] },
      revisions: { session: historyRevision, project: historyRevision, result: 0, plates: { ...plateInputRevisions } },
      status: { state: 'ready', error: null },
    };
  }
  let filamentSessionState: any = opts.filamentSession !== undefined ? clone(opts.filamentSession) : undefined;
  function filamentMutation(requestJson: string, kind: string): unknown {
    if (opts.filamentMutation !== undefined) return clone(opts.filamentMutation);
    let request: any;
    try { request = JSON.parse(requestJson); } catch { return { ok: false, version: 1, error: 'invalid command', error_code: 'invalid_command',
      status: { state: 'error', error: 'invalid command' } }; }
    const snapshot: any = filamentSessionSnapshot();
    const errorEnvelope = (error: string, code: string) => ({ ok: false, version: 1, error, error_code: code,
      status: { state: 'error', error } });
    if (!request || request.version !== 1)
      return errorEnvelope('unsupported filament command version', 'invalid_command');
    if (!Number.isSafeInteger(request.revision) || request.revision !== snapshot.revisions.session)
      return errorEnvelope('filament session revision is stale', 'stale_revision');
    if (request.inject_failure)
      return errorEnvelope('injected native validation failure', 'native_validation_failure');
    const next: any = clone(snapshot);
    const fail = (error: string, code: string) => errorEnvelope(error, code);
    const slot = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= next.slots.length ? (value as number) - 1 : null;
    if (kind === 'select-preset' || kind === 'set-colour') {
      const index = slot(request.slot);
      if (index === null) return fail('unsupported filament slot reference', 'unsupported_reference');
      if (kind === 'select-preset') {
        if (typeof request.preset !== 'string') return fail('preset is required', 'invalid_command');
        next.slots[index].preset = { id: request.preset, name: request.preset };
      } else {
        if (typeof request.colour !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(request.colour))
          return fail('native filament colour validation failed', 'native_validation_failure');
        next.slots[index].colour = { effective: request.colour, provenance: 'user' };
      }
    } else if (kind === 'add') {
      if (next.slots.length >= next.capabilities.max_slots || !next.capabilities.flexible)
        return fail('filament slot capacity or capability rejected', 'capability_rejected');
      const colour = next.slots.at(-1)?.colour?.effective ?? '#26A69A';
      next.slots.push({ slot: next.slots.length + 1, preset: clone(next.slots.at(-1).preset), colour: { effective: colour, provenance: 'preset' } });
      for (const key of ['filament', 'volume', 'nozzle', 'filament2']) next.mappings[key].push(key === 'volume' ? 0 : 1);
      const n = next.slots.length;
      const planes = next.flushing.plane_count;
      const oldN = n - 1;
      const matrix: number[] = Array(n * n * planes).fill(0);
      for (let p = 0; p < planes; p++) for (let r = 0; r < oldN; r++) for (let c = 0; c < oldN; c++)
        matrix[p * n * n + r * n + c] = next.flushing.matrix[p * oldN * oldN + r * oldN + c];
      next.flushing.matrix = matrix; next.flushing.matrix_dimension = n;
    } else {
      const source = slot(kind === 'merge' ? request.source : request.slot);
      if (source === null || next.slots.length <= next.capabilities.min_slots)
        return fail('filament slot capability rejected', 'capability_rejected');
      let replacement: number | null = null;
      if (kind === 'merge') {
        const destination = slot(request.destination);
        if (destination === null || destination === source) return fail('unsupported filament reference', 'unsupported_reference');
        replacement = destination > source ? destination - 1 : destination;
      }
      next.slots.splice(source, 1);
      next.slots.forEach((entry: any, index: number) => { entry.slot = index + 1; });
      for (const key of ['filament', 'volume', 'nozzle', 'filament2']) next.mappings[key].splice(source, 1);
      const n = next.slots.length;
      const planes = next.flushing.plane_count;
      const oldN = n + 1;
      const oldMatrix = next.flushing.matrix;
      const matrix: number[] = Array(n * n * planes).fill(0);
      const mapIndex = (old: number) => old === source ? (replacement ?? 0) : (old > source ? old - 1 : old);
      for (let p = 0; p < planes; p++) for (let r = 0; r < oldN; r++) for (let c = 0; c < oldN; c++) {
        if (r === source || c === source) continue;
        matrix[p * n * n + mapIndex(r) * n + mapIndex(c)] = oldMatrix[p * oldN * oldN + r * oldN + c];
      }
      next.flushing.matrix = matrix; next.flushing.matrix_dimension = n;
      for (const group of ['objects', 'parts', 'modifiers']) for (const item of next.assignments[group]) {
        const value = item.effective_slot - 1;
        item.effective_slot = (value === source ? (replacement ?? 0) : value > source ? value - 1 : value) + 1;
        if (item.explicit_slot > 0) {
          const explicit = item.explicit_slot - 1;
          item.explicit_slot = (explicit === source ? (replacement ?? 0) : explicit > source ? explicit - 1 : explicit) + 1;
        }
      }
    }
    next.capabilities.can_add = next.capabilities.flexible && next.slots.length < next.capabilities.max_slots;
    next.capabilities.can_delete = next.capabilities.flexible && next.slots.length > next.capabilities.min_slots;
    next.capabilities.can_merge = next.capabilities.can_delete;
    next.revisions.session += 1; next.revisions.project = next.revisions.session;
    historyRevision = next.revisions.session;
    filamentSessionState = next;
    const mutation: Record<string, unknown> = {
      kind, history_entry_delta: 1, revision_before: request.revision,
      revision_after: next.revisions.session, dirty: true, all_plate_results_invalidated: true,
      affected_plate_ids: [...plateIds],
    };
    if (kind === 'add') mutation.slot = next.slots.length;
    else if (kind === 'select-preset' || kind === 'set-colour') {
      mutation.slot = request.slot;
      if (kind === 'select-preset') mutation.preset = request.preset;
      else mutation.colour = request.colour;
    } else {
      mutation.source = request.source ?? request.slot;
      mutation.destination = kind === 'merge'
        ? (request.destination > request.source ? request.destination - 1 : request.destination)
        : null;
      mutation.slot_count = next.slots.length;
    }
    return { ok: true, version: 1, result: { snapshot: clone(next), mutation,
      history_status: { ...historyStatus(), revision: next.revisions.session, dirty: true } } };
  }
  function filamentAssignmentMutation(requestJson: string, kind: 'assign' | 'routing'): unknown {
    if (opts.filamentMutation !== undefined) return clone(opts.filamentMutation);
    let request: any;
    try { request = JSON.parse(requestJson); } catch { return { ok: false, version: 1, error: 'invalid command', error_code: 'invalid_command', status: { state: 'error', error: 'invalid command' } }; }
    const snapshot: any = filamentSessionSnapshot();
    const errorEnvelope = (error: string, code: string) => ({ ok: false, version: 1, error, error_code: code, status: { state: 'error', error } });
    if (!request || request.version !== 1) return errorEnvelope('unsupported filament command version', 'invalid_command');
    if (!Number.isSafeInteger(request.revision) || request.revision !== snapshot.revisions.session) return errorEnvelope('filament session revision is stale', 'stale_revision');
    if (request.inject_failure) return errorEnvelope('injected native validation failure', 'native_validation_failure');
    const next: any = clone(snapshot);
    const targets = Array.isArray(request.targets) ? request.targets : (request.target ? [request.target] : []);
    if (targets.length === 0) return errorEnvelope('assignment targets are required', 'invalid_command');
    const accepted: any[] = [];
    if (kind === 'assign') {
      if (!Number.isSafeInteger(request.slot) || request.slot < 0 || request.slot > next.slots.length) return errorEnvelope('assignment slot is outside the ordered filament slots', 'unsupported_reference');
      const normalized: Array<{ group: 'objects' | 'parts' | 'modifiers'; id: number; objectId: number; source: any }> = [];
      const seen = new Set<string>();
      for (const target of targets) {
        if (!target || !['object', 'instance', 'instance-as-object', 'model-part', 'parameter-modifier'].includes(target.kind) || !Number.isSafeInteger(target.id)) return errorEnvelope('target is not eligible', 'ineligible_target');
        const group = target.kind === 'object' || target.kind === 'instance' || target.kind === 'instance-as-object' ? 'objects' : target.kind === 'model-part' ? 'parts' : 'modifiers';
        if (group === 'objects' && request.slot === 0) return errorEnvelope('object assignment cannot inherit', 'invalid_command');
        const source = next.assignments[group].find((entry: any) => entry.id === target.id || (group === 'objects' && entry.object_id === target.id));
        if (!source) return errorEnvelope('target is not eligible', 'ineligible_target');
        const objectId = source.object_id;
        const id = group === 'objects' ? objectId : source.id;
        if (seen.has(`${group}:${id}`)) continue;
        seen.add(`${group}:${id}`); normalized.push({ group, id, objectId, source });
      }
      const objectIds = new Set(normalized.filter((target) => target.group === 'objects').map((target) => target.objectId));
      const effective = normalized
        .filter((target) => target.group !== 'parts' || !objectIds.has(target.objectId))
        .sort((left, right) => ({ objects: 0, parts: 1, modifiers: 2 }[left.group] - { objects: 0, parts: 1, modifiers: 2 }[right.group]));
      for (const target of effective) {
        accepted.push({ kind: target.group === 'objects' ? 'object' : target.group === 'parts' ? 'model-part' : 'parameter-modifier', id: target.id, object_id: target.objectId });
        target.source.explicit_slot = request.slot;
        target.source.effective_slot = request.slot || (next.assignments.objects.find((entry: any) => entry.object_id === target.objectId)?.effective_slot ?? target.source.effective_slot);
        target.source.inherited = request.slot === 0;
        if (target.group === 'objects') for (const part of next.assignments.parts) if (part.object_id === target.objectId) { part.explicit_slot = 0; part.effective_slot = request.slot; part.inherited = true; }
      }
    } else {
      if (!Number.isSafeInteger(request.slot) || request.slot < 0 || request.slot > next.slots.length || typeof request.selector !== 'string') return errorEnvelope('invalid routing command', 'invalid_command');
      const feature = request.selector !== 'support-base' && request.selector !== 'support-interface';
      for (const target of targets) {
        if (!target || !['project', 'object', 'model-part'].includes(target.kind)) return errorEnvelope('target is not eligible', 'ineligible_target');
        if ((feature && target.kind === 'project') || (!feature && target.kind === 'model-part')) return errorEnvelope('target is not eligible', 'ineligible_target');
        const id = target.kind === 'project' ? 0 : target.id;
        if (target.kind !== 'project' && (!Number.isSafeInteger(id) || id < 1)) return errorEnvelope('target is not eligible', 'ineligible_target');
        accepted.push({ kind: target.kind, id, object_id: target.kind === 'project' ? 0 : id });
      }
    }
    next.revisions.session += 1; next.revisions.project = next.revisions.session;
    historyRevision = next.revisions.session;
    filamentSessionState = next;
    return { ok: true, version: 1, result: { snapshot: clone(next), history_status: {
      ...historyStatus(), revision: next.revisions.session, dirty: true }, mutation: {
      kind, history_entry_delta: 1, revision_before: request.revision, revision_after: next.revisions.session,
      dirty: true, all_plate_results_invalidated: kind === 'routing' && accepted.some((target: any) => target.kind === 'project'), accepted_targets: accepted,
      ...(kind === 'routing' ? { selector: request.selector, slot: request.slot } : { slot: request.slot }),
      affected_plate_ids: kind === 'routing' && accepted.some((target: any) => target.kind === 'project')
        ? [...plateIds]
        : [...new Set(accepted.map((target: any) => objectPlateIds[objectMeta.findIndex((object) => object.id === target.object_id)]).filter((id): id is string => typeof id === 'string'))],
    } } };
  }
  function plateMutation(
    reason: string,
    before = [currentPlateId],
    after = [currentPlateId],
    instanceTransforms: readonly Record<string, unknown>[] = [],
  ) {
    const affected = [...new Set([...before, ...after])];
    for (const id of affected) if (plateIds.includes(id)) plateInputRevisions[id] = (plateInputRevisions[id] ?? 0) + 1;
    const result = plateSessionSnapshot() as Record<string, unknown>;
    result.instance_transforms = instanceTransforms;
    result.affected_plate_ids_before = before;
    result.affected_plate_ids_after = after;
    result.affected_plate_ids = affected;
    result.dirty_reasons = [reason];
    result.native_scoped_config = nativeScopedConfigFullTransport();
    return result;
  }

  function modelStructureMutation(beforePlates: readonly string[]) {
    const affected = [...new Set(beforePlates.filter((id) => plateIds.includes(id)))];
    return plateMutation('model-structure', affected, affected);
  }

  function reflowMockPlateOrigins(): Array<Record<string, unknown>> {
    const oldOrigins = plateOrigins.map((origin) => [...origin] as [number, number, number]);
    plateOrigins = plateIds.map((_id, index) => plateOrigin(index, plateIds.length));
    const changed: Array<Record<string, unknown>> = [];
    for (let objectIndex = 0; objectIndex < objectTransforms.length; objectIndex += 1) {
      const plateIndex = plateIds.indexOf(objectPlateIds[objectIndex] ?? '');
      if (plateIndex < 0) continue;
      const delta = plateOrigins[plateIndex].map((value, axis) => value - oldOrigins[plateIndex][axis]);
      if (delta.every((value) => value === 0)) continue;
      for (let instanceIndex = 0; instanceIndex < objectTransforms[objectIndex].length; instanceIndex += 1) {
        const transform = objectTransforms[objectIndex][instanceIndex];
        transform.offset = transform.offset.map((value, axis) => value + delta[axis]);
        const instance = instanceMeta[objectIndex]?.[instanceIndex];
        changed.push({
          instance_id: instance?.id ?? 0,
          object_id: objectMeta[objectIndex]?.id ?? 0,
          object_index: objectIndex,
          instance_index: instanceIndex,
          world_transform: transform,
        });
      }
    }
    return changed;
  }
  let asyncTaskCallback = 0;
  const functionTable = new Map<number, (...args: unknown[]) => void>();
  let nextFunctionIndex = 1000;
  let functionRegistrations = 0;
  const mailboxOffset = 128;
  const mailboxWords = new Int32Array(heap, mailboxOffset, 4);
  let nextAsyncTaskId = 1;
  let nextTaskMessageSequence = 1;
  let serialTerminalEpoch = 0;
  let foregroundProgressTaskId: string | undefined;
  const taskMessages: Array<Record<string, unknown>> = [];

  function publishTaskMessage(taskId: string, message: Record<string, unknown>, mainRuntimeProducer = false): void {
    taskMessages.push({ ...message, task_id: taskId, sequence: String(nextTaskMessageSequence++) });
    Atomics.add(mailboxWords, 0, 1);
    Atomics.add(mailboxWords, 1, 1);
    const id = BigInt(taskId);
    Atomics.store(mailboxWords, 2, Number(id & 0xffff_ffffn));
    Atomics.store(mailboxWords, 3, Number(id >> 32n));
    Atomics.add(mailboxWords, 0, 1);
    if (asyncTaskCallback && (!opts.threaded || mainRuntimeProducer))
      functionTable.get(asyncTaskCallback)?.();
  }

  function publishProgress(percent: number, text: string): void {
    if (!foregroundProgressTaskId) foregroundProgressTaskId = String(nextAsyncTaskId++);
    publishTaskMessage(foregroundProgressTaskId, {
      type: 'progress', kind: 'project-load', percent, text,
    }, true);
    if (percent === 100) {
      publishTaskMessage(foregroundProgressTaskId, {
        type: 'task-terminal', kind: 'project-load', terminal: 'completed', result: { ok: true },
      }, true);
      foregroundProgressTaskId = undefined;
    }
  }

  function runMockSlice(plateId: string, revision: number): unknown {
    if (!modelLoaded) return { error: 'no model loaded' };
    if (plateId !== currentPlateId) return { error: 'plate operation target is not the current plate' };
    if (revision !== (plateInputRevisions[plateId] ?? 0)) return { error: 'plate operation target is stale' };
    const taskId = String(nextAsyncTaskId++);
    for (let pct = 0; pct <= 100; pct += 25)
      publishTaskMessage(taskId, { type: 'progress', kind: 'slice', plate_id: plateId,
        entry_incarnation: '1', percent: pct, text: `slice ${pct}%` });
    sliced = true;
    slicedPlateId = plateId;
    slicedPlateRevision = revision;
    const priorGeneration = Number(sliceReceipts.get(plateId)?.resultGeneration ?? '0');
    const receipt = { inputStamp: revision, resultGeneration: String(priorGeneration + 1), sliceTaskId: taskId };
    sliceReceipts.set(plateId, receipt);
    const gcode = fixture.sourceText ?? [
      '; mock gcode (unit-test fixture)', 'G21', 'G90',
      'G1 X0 Y0 Z0.2 F1200', 'G1 X20 Y0 E1.0', 'M104 S0', '',
    ].join('\n');
    previewSourceBytes = new TextEncoder().encode(gcode);
    files.set(`/plate-result-${plateId}-${receipt.resultGeneration}.gcode`, previewSourceBytes);
    const result = { ok: true, unrecognized_keys: [], warnings: [...sliceWarnings], receipt: {
      plate_id: plateId, input_stamp: receipt.inputStamp,
      result_generation: receipt.resultGeneration, slice_task_id: receipt.sliceTaskId,
    } };
    publishTaskMessage(taskId, { type: 'task-terminal', kind: 'slice', plate_id: plateId,
      entry_incarnation: '1', terminal: 'completed', result });
    if (!opts.threaded) serialTerminalEpoch++;
    return { accepted: true, kind: 'slice', task_id: taskId, plate_id: plateId, entry_incarnation: '1' };
  }

  // Serialize the current structure in the bridge's object/part/instance shape.
  // Shared by the structure read and the reorder returns (spec §9.1/§9.2).
  function buildStructure() {
    return objectTransforms.map((_instances, oi) => ({
      id: objectMeta[oi].id,
      index: oi,
      name: objectMeta[oi].name,
      printable: objectMeta[oi].printable,
      instanceCount: instanceMeta[oi].length,
      volumes: volumeMeta[oi].map((v, vi) => ({
        id: v.id, index: vi, name: v.name, type: v.type, isSplittable: v.isSplittable,
      })),
      instances: instanceMeta[oi].map((i, ii) => ({
        id: i.id, index: ii, printable: i.printable,
      })),
    }));
  }

  // Move element `from` so it ends up at final index `toIndex` (0-based);
  // `toIndex == arr.length` (or beyond) appends it to the end. Matches the
  // bridge's destination-index reorder semantics.
  function moveToIndex<T>(arr: T[], from: number, toIndex: number) {
    if (arr.length <= 1) return;
    const target = Math.min(Math.max(toIndex, 0), arr.length - 1);
    if (from === target) return;
    const [el] = arr.splice(from, 1);
    arr.splice(target, 0, el);
  }

  // Port of the libslic3r primitive builders (TriangleMesh.cpp its_make_*)
  // parameterized like Orca's create_mesh (GUI_ObjectList.cpp) so per-type
  // vertex/index counts match the native bridge at the app's 20 mm side:
  // Cube 8/36, Cylinder 362/2160, Sphere 16022/96120, Cone 182/1080,
  // Disc 362/2160, Torus 14400/86400. Every other object (file imports,
  // splits, assemblies) keeps the canonical 20 mm cube, as before.
  function primitiveMesh(type: string | undefined) {
    const CUBE_VERTS = [
      [20, 20, 0], [20, 0, 0], [0, 0, 0], [0, 20, 0],
      [20, 20, 20], [0, 20, 20], [0, 0, 20], [20, 0, 20],
    ];
    const CUBE_TRIS = [
      [0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7], [0, 4, 7], [0, 7, 1],
      [1, 7, 6], [1, 6, 2], [2, 6, 5], [2, 5, 3], [4, 0, 3], [4, 3, 5],
    ];
    const side = 20;
    if (type === 'Cylinder' || type === 'Disc') {
      // its_make_cylinder(r, h, fa): centers at z = 0 and z = h, ring points
      // Eigen::Rotation2Df(angle) * (0, r) => (-r·sin a, r·cos a).
      const r = 0.5 * side;
      const h = type === 'Disc' ? 0.2 : side;
      const n = Math.ceil((2 * Math.PI) / ((2 * Math.PI) / 180));
      const step = (2 * Math.PI) / n;
      const verts: number[][] = [[0, 0, 0], [0, 0, h]];
      const tris: number[][] = [];
      for (let i = 0; i < n; i++) {
        const x = -r * Math.sin(step * i);
        const y = r * Math.cos(step * i);
        verts.push([x, y, 0], [x, y, h]);
      }
      for (let i = 1; i < n; i++) {
        const id = 2 + i * 2 + 1;
        tris.push([0, id - 1, id - 3], [id, 1, id - 2], [id, id - 2, id - 3], [id, id - 3, id - 1]);
      }
      const id = verts.length - 1;
      tris.push([0, 2, id - 1], [3, 1, id], [id, 2, 3], [id, id - 1, 2]);
      return { verts, tris };
    }
    if (type === 'Cone') {
      const r = 0.5 * side;
      const fa = (2 * Math.PI) / 180;
      const verts: number[][] = [[0, 0, 0], [0, 0, side]];
      const tris: number[][] = [];
      for (let angle = 0; angle < 2 * Math.PI; angle += fa) {
        verts.push([r * Math.cos(angle), r * Math.sin(angle), 0]);
        if (angle > 0) {
          tris.push([0, verts.length - 1, verts.length - 2], [1, verts.length - 2, verts.length - 1]);
        }
      }
      tris.push([0, 2, verts.length - 1], [1, verts.length - 1, 2]);
      return { verts, tris };
    }
    if (type === 'Torus') {
      // its_make_torus(r, h, fa): n_major == n_minor == ceil(2·π/fa).
      const r = 0.5 * side;
      const tube = 0.125 * side;
      const n = Math.ceil((2 * Math.PI) / (Math.PI / 60));
      const step = (2 * Math.PI) / n;
      const verts: number[][] = [];
      const tris: number[][] = [];
      for (let i = 0; i < n; i++) {
        const ma = step * i;
        for (let j = 0; j < n; j++) {
          const na = step * j;
          const ring = r + tube * Math.cos(na);
          verts.push([ring * Math.cos(ma), ring * Math.sin(ma), tube * Math.sin(na)]);
        }
      }
      for (let i = 0; i < n; i++) {
        const inext = (i + 1) % n;
        for (let j = 0; j < n; j++) {
          const jnext = (j + 1) % n;
          const v0 = i * n + j;
          const vNext = inext * n + j;
          const v2 = inext * n + jnext;
          const v3 = i * n + jnext;
          tris.push([v0, vNext, v2], [v0, v2, v3]);
        }
      }
      return { verts, tris };
    }
    if (type === 'Sphere') {
      const radius = 0.5 * side;
      const fa = Math.PI / 90;
      const sectorCount = Math.ceil((2 * Math.PI) / fa);
      const stackCount = Math.ceil(Math.PI / fa);
      const sectorStep = (2 * Math.PI) / sectorCount;
      const stackStep = Math.PI / stackCount;
      const verts: number[][] = [];
      for (let i = 0; i <= stackCount; i++) {
        const stackAngle = 0.5 * Math.PI - stackStep * i;
        const xy = radius * Math.cos(stackAngle);
        const z = radius * Math.sin(stackAngle);
        if (i === 0 || i === stackCount) verts.push([xy, 0, z]);
        else for (let j = 0; j < sectorCount; j++) {
          const sectorAngle = sectorStep * j;
          verts.push([xy * Math.cos(sectorAngle), xy * Math.sin(sectorAngle), z]);
        }
      }
      const tris: number[][] = [];
      for (let i = 0; i < stackCount; i++) {
        let k1 = i === 0 ? 0 : 1 + (i - 1) * sectorCount;
        const k1_first = k1;
        let k2 = i === 0 ? 1 : k1 + sectorCount;
        const k2_first = k2;
        for (let j = 0; j < sectorCount; j++) {
          let k1_next = k1;
          let k2_next = k2;
          if (i !== 0) {
            k1_next = j + 1 === sectorCount ? k1_first : k1 + 1;
            tris.push([k1, k2, k1_next]);
          }
          if (i + 1 !== stackCount) {
            k2_next = j + 1 === sectorCount ? k2_first : k2 + 1;
            tris.push([k1_next, k2, k2_next]);
          }
          k1 = k1_next;
          k2 = k2_next;
        }
      }
      return { verts, tris };
    }
    return { verts: CUBE_VERTS, tris: CUBE_TRIS };
  }

  function appendMockObject(name = `Object ${objectTransforms.length + 1}`): void {
    modelLoaded = true;
    const currentPlateIndex = Math.max(0, plateIds.indexOf(currentPlateId));
    objectTransforms.push(createObjectTransforms(plateOrigins[currentPlateIndex]?.slice(0, 2) as [number, number] ?? [0, 0]));
    objectVolumeTransforms.push(createObjectVolumeTransforms());
    objectPlateIds.push(currentPlateId);
    objectMeta.push({ id: nextObjectId++, name, printable: true });
    volumeMeta.push(Array.from({ length: volumeCount }, (_, vi) => ({
      id: nextVolumeId++, name: `Part ${vi + 1}`,
      type: 'model_part' as VolumeType, isSplittable: vi === 0,
    })));
    instanceMeta.push(Array.from({ length: instanceCount }, () => ({
      id: nextInstanceId++, printable: true,
    })));
    sliced = false;
  }

  // ---- the bridge functions ----
  const bridge: Record<string, (...args: any[]) => unknown> = {
    orc_init(_optionsJson?: string) {
      presetDraftRegistry = { printer: {}, filament: {} };
      presetDraftEditorRegistry = { printer: {}, filament: {} };
      presetDraftRevision = 0;
      resetPlateSession();
      resetHistory();
      return {
        ok: true,
        prints: presetFixtures.print.length,
        filaments: presetFixtures.filament.length,
        printers: presetFixtures.printer.length,
      };
    },
    orc_history_begin(label: string, category: string, beforeContextJson: string, optionsJson?: string) {
      if (historyDisabled) return { error: 'history is disabled' };
      if (typeof label !== 'string' || !label) return { error: 'history label is required' };
      if (category !== 'project') return { error: 'history category must be project' };
      let beforeContext: any;
      try { beforeContext = JSON.parse(beforeContextJson); validateHistoryContext(beforeContext); } catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
      let options: any = {};
      try { if (optionsJson) options = JSON.parse(optionsJson); } catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
      if (historyTransaction && options?.coalesce === true &&
          options.parentTransactionId === (historyNestedTransactions.length
            ? historyNestedTransactions[historyNestedTransactions.length - 1].id : historyTransaction.id)) {
        const id = `tx-${nextHistoryTransactionId++}`;
        historyNestedTransactions.push({ id, before: captureHistoryState(), beforeContext: clone(beforeContext) });
        return { ok: true, transactionId: id, status: historyStatus() };
      }
      if (historyTransaction) return { error: 'history transaction is already active' };
      if (historyEntries.length === 0) {
        historyEntries.push({ ...captureHistoryState(), id: 'entry-0', label: '', category: 'project', context: clone(beforeContext) });
        historyCursor = 0;
        savedHistoryCursor = 0;
      }
      const id = `tx-${nextHistoryTransactionId++}`;
      historyTransaction = { id, label, category: 'project', before: captureHistoryState(), beforeContext: clone(beforeContext), targets: [] };
      return { ok: true, transactionId: id, status: historyStatus() };
    },
    orc_history_commit(transactionId: string, afterContextJson: string) {
      if (!historyTransaction) return { error: 'history transaction is not active' };
      const nested = historyNestedTransactions.length
        ? historyNestedTransactions[historyNestedTransactions.length - 1] : undefined;
      if (nested) {
        if (transactionId !== nested.id) return { error: 'history transaction is stale or belongs to another writer' };
        historyNestedTransactions.pop();
        return { status: historyStatus(), scene_delta: null };
      }
      if (transactionId !== historyTransaction.id) return { error: 'history transaction is stale or belongs to another writer' };
      let afterContext: any;
      try { afterContext = JSON.parse(afterContextJson); validateHistoryContext(afterContext); } catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
      const current = captureHistoryState();
      const previous = historyEntries[historyCursor];
      const previousState = previous ? { modelLoaded: previous.modelLoaded, objectTransforms: previous.objectTransforms,
        objectVolumeTransforms: previous.objectVolumeTransforms, objectMeta: previous.objectMeta, volumeMeta: previous.volumeMeta,
        instanceMeta: previous.instanceMeta, objectPlateIds: previous.objectPlateIds, currentPlateId: previous.currentPlateId,
        plateIds: previous.plateIds, plateOrigins: previous.plateOrigins, plateInputRevisions: previous.plateInputRevisions,
        nativeScopedConfig: previous.nativeScopedConfig, selectedProfiles: previous.selectedProfiles,
        presetDraftRegistry: previous.presetDraftRegistry, presetDraftRevision: previous.presetDraftRevision,
        presetDraftEditorRegistry: previous.presetDraftEditorRegistry } : null;
      const changed = !previous || JSON.stringify(previousState) !== JSON.stringify(current) ||
        JSON.stringify(previous.context) !== JSON.stringify(afterContext);
      if (changed) {
        if (previous) Object.assign(previous, clone(historyTransaction.before), {
          context: clone(historyTransaction.beforeContext),
        });
        if (historyCursor + 1 < historyEntries.length && savedHistoryCursor !== null && savedHistoryCursor > historyCursor)
          savedHistoryCheckpointEvicted = true;
        historyEntries.splice(historyCursor + 1);
        historyEntries.push({ ...current, id: `entry-${nextHistoryEntryId++}`, label: historyTransaction.label,
          category: historyTransaction.category, context: clone(afterContext) });
        historyCursor = historyEntries.length - 1;
        historyRevision++;
      }
      const sceneDelta = changed ? mockSceneDelta(historyTransaction.before, current) : null;
      const committedTargets = historyTransaction.targets;
      const removedTargets = nativeScopedConfigRemovedTargets(
        historyTransaction.before.nativeScopedConfig, nativeScopedConfigProjection());
      historyTransaction = null;
      const status = historyStatus() as Record<string, unknown>;
      if (changed) status.native_scoped_config = committedTargets.length > 0
        ? nativeScopedConfigAffectedTransport(committedTargets, removedTargets)
        : nativeScopedConfigFullTransport(removedTargets);
      return { status, scene_delta: sceneDelta };
    },
    orc_history_abort(transactionId: string) {
      if (!historyTransaction) return { error: 'history transaction is not active' };
      const nested = historyNestedTransactions.length
        ? historyNestedTransactions[historyNestedTransactions.length - 1] : undefined;
      if (nested) {
        if (transactionId !== nested.id) return { error: 'history transaction is stale or belongs to another writer' };
        const before = nativeScopedConfigProjection();
        restoreHistoryState(nested.before);
        const removedTargets = nativeScopedConfigRemovedTargets(before, nativeScopedConfigProjection());
        historyNestedTransactions.pop();
        historyRevision++;
        return { ok: true, context: { ...clone(nested.beforeContext), plateSession: plateSessionSnapshot() },
          native_scoped_config: nativeScopedConfigFullTransport(removedTargets), status: historyStatus(), scene_delta: {
          version: 1, object_ids: [], volume_ids: [], instance_ids: [], plate_ids: [],
          object_order: objectMeta.map((object) => object.id),
        }, affected_plate_ids: [], impact: { version: 1, model: 'delta', plateSession: true, filamentRack: true, presetDrafts: false, profileSelection: false, nativeScopedConfig: true, selectionContext: true, primeTower: true, preview: 'all' } };
      }
      if (transactionId !== historyTransaction.id) return { error: 'history transaction is stale or belongs to another writer' };
      const modelChanged = JSON.stringify(captureHistoryState()) !== JSON.stringify(historyTransaction.before);
      const before = nativeScopedConfigProjection();
      restoreHistoryState(historyTransaction.before);
      const removedTargets = nativeScopedConfigRemovedTargets(before, nativeScopedConfigProjection());
      const context = historyTransaction.beforeContext;
      historyTransaction = null;
      if (modelChanged) historyRevision++;
      return { ok: true, context: { ...clone(context), plateSession: plateSessionSnapshot() },
        native_scoped_config: nativeScopedConfigFullTransport(removedTargets), status: historyStatus(), scene_delta: {
        version: 1, object_ids: [], volume_ids: [], instance_ids: [], plate_ids: [],
        object_order: objectMeta.map((object) => object.id),
      }, affected_plate_ids: [], impact: { version: 1, model: 'delta', plateSession: true, filamentRack: true, presetDrafts: false, profileSelection: false, nativeScopedConfig: true, selectionContext: true, primeTower: true, preview: 'all' } };
    },
    orc_history_undo() {
      if (historyTransaction) return { error: 'history transaction is active' };
      const project = (entry: MockHistoryEntry): boolean => entry.id !== 'entry-0' && entry.category === 'project';
      let currentProject = historyCursor;
      while (currentProject >= 0 && currentProject < historyEntries.length &&
             !project(historyEntries[currentProject])) currentProject--;
      if (currentProject < 1) return { error: 'no undo history' };
      let target = currentProject - 1;
      while (target > 0 && !project(historyEntries[target])) target--;
      // The baseline is the valid restore target for the first project edit.
      if (!historyEntries[target] || (target > 0 && !project(historyEntries[target])))
        target = 0;
      historyCursor = target;
      return historyRestore(historyEntries[target]);
    },
    orc_history_redo() {
      if (historyTransaction) return { error: 'history transaction is active' };
      const project = (entry: MockHistoryEntry): boolean => entry.id !== 'entry-0' && entry.category === 'project';
      let target = historyCursor + 1;
      while (target < historyEntries.length && !project(historyEntries[target])) target++;
      if (target >= historyEntries.length) return { error: 'no redo history' };
      historyCursor = target;
      return historyRestore(historyEntries[target]);
    },
    orc_history_jump(entryId: string, direction: 'undo' | 'redo') {
      if (historyTransaction) return { error: 'history transaction is active' };
      if (direction !== 'undo' && direction !== 'redo') return { error: 'invalid history jump direction' };
      const index = historyEntries.findIndex((entry) => entry.id === entryId);
      if (index < 0) return { error: 'history entry is stale or unavailable' };
      if (historyEntries[index].category !== 'project' || historyEntries[index].id === 'entry-0')
        return { error: 'history entry is not a directional project operation' };
      if (direction === 'undo') {
        if (index > historyCursor)
          return { error: 'history entry is outside the requested direction' };
        let target = index;
        if (historyEntries[index].id !== 'entry-0') {
          do { target--; } while (target > 0 && historyEntries[target].category !== 'project');
          if (!historyEntries[target] || historyEntries[target].category !== 'project')
            return { error: 'history entry has no prior project state' };
        }
        historyCursor = target;
      } else {
        if (index <= historyCursor && historyEntries[index].id !== 'entry-0')
          return { error: 'history entry is outside the requested direction' };
        historyCursor = index;
      }
      const current = historyEntries[historyCursor];
      return historyRestore(current);
    },
    orc_history_status() {
      return historyStatus();
    },
    orc_history_mark_saved(contextJson?: string) {
      if (historyEntries.length === 0 && contextJson) {
        let context: any;
        try { context = JSON.parse(contextJson); validateHistoryContext(context); }
        catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
        historyEntries.push({ ...captureHistoryState(), id: 'entry-0', label: '', category: 'project', context: clone(context) });
        historyCursor = 0;
      }
      if (historyEntries.length > 0) {
        savedHistoryCursor = historyCursor;
        savedHistoryCheckpointEvicted = false;
      }
      return historyStatus();
    },
    orc_history_reset(contextJson: string) {
      let context: any;
      try { context = JSON.parse(contextJson); validateHistoryContext(context); }
      catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
      resetHistory();
      historyEntries.push({ ...captureHistoryState(), id: 'entry-0', label: '', category: 'project', context: clone(context) });
      historyCursor = 0;
      savedHistoryCursor = 0;
      historyRevision++;
      return historyStatus();
    },
    orc_get_plate_session_snapshot() {
      return plateSessionSnapshot();
    },
    orc_get_prime_tower_projection() {
      return primeTowerProjection();
    },
    orc_take_performance_profile() {
      return opts.nativePerformanceProfile ?? { version: 1, samples: [] };
    },
    orc_move_prime_tower(requestJson: string) {
      return movePrimeTower(requestJson);
    },
    orc_get_filament_session_snapshot() {
      return filamentSessionSnapshot();
    },
    orc_select_filament_slot_preset(requestJson: string) {
      return filamentMutation(requestJson, 'select-preset');
    },
    orc_set_filament_slot_colour(requestJson: string) {
      return filamentMutation(requestJson, 'set-colour');
    },
    orc_add_filament_slot(requestJson: string) {
      return filamentMutation(requestJson, 'add');
    },
    orc_delete_filament_slot(requestJson: string) {
      return filamentMutation(requestJson, 'delete');
    },
    orc_merge_filament_slots(requestJson: string) {
      return filamentMutation(requestJson, 'merge');
    },
    orc_apply_remembered_filament_rack(requestJson: string) {
      let request: any;
      try { request = JSON.parse(requestJson); } catch { return { ok: false, version: 1, error: 'invalid command', error_code: 'invalid_command', status: { state: 'error', error: 'invalid command' } }; }
      const current: any = filamentSessionSnapshot();
      if (!request || request.version !== 1 || !Array.isArray(request.slots) || request.slots.length === 0)
        return { ok: false, version: 1, error: 'invalid remembered filament rack', error_code: 'invalid_command', status: { state: 'error', error: 'invalid remembered filament rack' } };
      if (!Number.isSafeInteger(request.revision) || request.revision !== current.revisions.session)
        return { ok: false, version: 1, error: 'filament session revision is stale', error_code: 'stale_revision', status: { state: 'error', error: 'filament session revision is stale' } };
      const next: any = clone(current);
      next.slots = request.slots.map((slot: any, index: number) => ({ slot: index + 1,
        preset: { id: slot.preset, name: slot.preset }, colour: { effective: slot.colour, provenance: 'user' } }));
      const slotCount = next.slots.length;
      next.mappings.filament = Array(slotCount).fill(1);
      next.mappings.volume = Array(slotCount).fill(0);
      next.mappings.nozzle = Array(slotCount).fill(1);
      next.mappings.filament2 = Array(slotCount).fill(1);
      next.flushing.matrix = Array(slotCount * slotCount * next.flushing.plane_count).fill(0);
      next.flushing.matrix_dimension = slotCount;
      next.capabilities.can_add = next.capabilities.flexible && slotCount < next.capabilities.max_slots;
      next.capabilities.can_delete = next.capabilities.flexible && slotCount > next.capabilities.min_slots;
      next.capabilities.can_merge = next.capabilities.can_delete;
      next.revisions.session += 1;
      next.revisions.project = next.revisions.session;
      filamentSessionState = next;
      historyRevision = next.revisions.session;
      return clone(next);
    },
    orc_assign_filament(requestJson: string) {
      return filamentAssignmentMutation(requestJson, 'assign');
    },
    orc_set_filament_routing(requestJson: string) {
      return filamentAssignmentMutation(requestJson, 'routing');
    },
    orc_reset_plate_session() {
      resetPlateSession();
      return plateSessionSnapshot();
    },
    orc_select_plate(plateId: string) {
      if (typeof plateId !== 'string' || plateId.length === 0) return { error: 'plateId is required' };
      if (!plateIds.includes(plateId)) return { error: 'plate not found' };
      currentPlateId = plateId;
      return { ok: true, version: 1, current_plate_id: currentPlateId };
    },
    orc_add_plate() {
      if (plateIds.length >= 36) return { error: 'maximum of 36 plates' };
      const id = `plate-session-${++plateSessionSequence}-plate-${plateIds.length + 1}`;
      plateIds.push(id);
      plateInputRevisions[id] = 0;
      plateOrigins.push([0, 0, 0]);
      currentPlateId = id;
      const changed = reflowMockPlateOrigins();
      const result = plateSessionSnapshot() as Record<string, unknown>;
      result.instance_transforms = changed;
      result.native_scoped_config = nativeScopedConfigFullTransport();
      return result;
    },
    orc_reorder_plates(plateIdsJson: string) {
      let requested: unknown;
      try { requested = JSON.parse(plateIdsJson); } catch { return { error: 'plate order must contain every plate exactly once' }; }
      if (!Array.isArray(requested) || requested.length !== plateIds.length ||
          requested.some((id) => typeof id !== 'string') || new Set(requested).size !== plateIds.length ||
          requested.some((id) => !plateIds.includes(id)))
        return { error: 'plate order must contain every plate exactly once' };
      const oldOrigins = new Map(plateIds.map((id, index) => [id, plateOrigins[index]]));
      const changedOrigins: string[] = [];
      plateIds = [...requested] as string[];
      plateOrigins = plateIds.map((id, index) => {
        const next = plateOrigin(index, plateIds.length);
        const before = oldOrigins.get(id)!;
        if (before.some((value, axis) => value !== next[axis])) {
          plateInputRevisions[id] = (plateInputRevisions[id] ?? 0) + 1;
          changedOrigins.push(id);
        }
        return next;
      });
      const result = plateSessionSnapshot() as Record<string, unknown>;
      result.affected_plate_ids_before = changedOrigins;
      result.affected_plate_ids_after = changedOrigins;
      result.affected_plate_ids = changedOrigins;
      result.dirty_reasons = ['plate-structure'];
      result.native_scoped_config = nativeScopedConfigFullTransport();
      return result;
    },
    orc_delete_plate(plateId: string) {
      if (plateIds.length <= 1) return { error: 'at least one plate must remain' };
      const index = plateIds.indexOf(plateId);
      if (index < 0) return { error: 'plate not found' };
      const deletingCurrent = currentPlateId === plateId;
      plateIds.splice(index, 1);
      plateOrigins.splice(index, 1);
      delete plateInputRevisions[plateId];
      if (deletingCurrent) currentPlateId = plateIds[Math.min(index, plateIds.length - 1)];
      const changed = reflowMockPlateOrigins();
      const result = plateMutation('plate-delete', [plateId], plateIds, changed) as Record<string, unknown>;
      result.native_scoped_config = nativeScopedConfigFullTransport();
      return result;
    },
    orc_recompute_plate_membership() {
      return plateSessionSnapshot();
    },
    orc_mark_shared_configuration_mutation() {
      const affected = [...plateIds];
      const changed = reflowMockPlateOrigins();
      for (const id of affected) plateInputRevisions[id] = (plateInputRevisions[id] ?? 0) + 1;
      const result = plateSessionSnapshot() as Record<string, unknown>;
      result.instance_transforms = changed;
      result.affected_plate_ids_before = affected;
      result.affected_plate_ids_after = affected;
      result.affected_plate_ids = affected;
      result.dirty_reasons = ['shared-configuration'];
      return result;
    },
    orc_get_native_scoped_config() {
      return { version: 1, ok: true, native_scoped_config: nativeScopedConfigFullTransport() };
    },
    orc_mutate_native_scoped_config(requestJson: string) {
      if (opts.nativeScopedConfigOverride !== undefined) return opts.nativeScopedConfigOverride;
      let request: any;
      try { request = JSON.parse(requestJson); } catch {
        return { version: 1, ok: false, error: 'mutation request is not valid JSON', error_code: 'invalid_command',
          status: { state: 'error', error: 'mutation request is not valid JSON' } };
      }
      const fail = (error: string, errorCode = 'invalid_command') =>
        ({ version: 1, ok: false, error, error_code: errorCode, status: { state: 'error', error } });
      if (!request || request.version !== 1 || typeof request.operation !== 'string' || !Array.isArray(request.targets) || request.targets.length === 0)
        return fail('invalid native mutation request');
      if (!['set', 'reset', 'reset-category', 'reset-all'].includes(request.operation))
        return fail('unsupported native mutation operation');
      const values: Record<string, string> = request.operation === 'set'
        ? (request.values && typeof request.values === 'object' && !Array.isArray(request.values)
          ? request.values
          : typeof request.key === 'string' && typeof request.value === 'string' ? { [request.key]: request.value } : {})
        : request.operation === 'reset' && typeof request.key === 'string' ? { [request.key]: '' } : {};
      if ((request.operation === 'set' && Object.keys(values).length === 0) ||
          (request.operation === 'reset' && Object.keys(values).length !== 1) ||
          (request.operation === 'reset-category' && typeof request.category !== 'string'))
        return fail('invalid native mutation operation payload');
      const targets: Array<{ scope: 'project' | 'object' | 'part' | 'plate'; id: string }> = [];
      const seen = new Set<string>();
      for (const target of request.targets) {
        if (!target || !['project', 'object', 'part', 'plate'].includes(target.scope)) return fail('invalid project configuration scope');
        const scope = target.scope as 'project' | 'object' | 'part' | 'plate';
        const id = target.id === undefined ? '' : String(target.id);
        if (scope !== 'project' && !id) return fail('scope id is required');
        if (scope === 'project' && id) return fail('project mutation target must not have an id');
        const identity = `${scope}:${id}`;
        if (seen.has(identity)) return fail('duplicate mutation target');
        seen.add(identity);
        targets.push({ scope, id });
      }
      const next = clone(nativeScopedConfig);
      const affected = new Set<string>();
      const dirtyReasons = new Set<string>();
      let projectChanged = false;
      const corrections: Array<{ key: string; requested: string; effective: string }> = [];
      const resettable = (key: string) => key !== 'extruder' && !key.includes('filament') && !key.includes('rack') && !key.includes('ams') && !key.includes('gcode');
      const clamp = (key: string, value: string): string => {
        const option = metadata[key];
        if (!option) throw new Error(`unsupported project configuration option: ${key}`);
        if (!['float', 'int', 'percent'].includes(option.type)) return value;
        const numeric = Number(value.replace(/%$/, ''));
        if (!Number.isFinite(numeric)) throw new Error('invalid native configuration value');
        const bounded = Math.min(option.max ?? Number.POSITIVE_INFINITY, Math.max(option.min ?? Number.NEGATIVE_INFINITY, numeric));
        return option.type === 'int' ? String(Math.trunc(bounded)) : `${bounded}${value.endsWith('%') ? '%' : ''}`;
      };
      try {
        for (const target of targets) {
          let bucket: Record<string, string>;
          if (target.scope === 'project') bucket = next.project;
          else if (target.scope === 'object') {
            const index = objectMeta.findIndex((object) => String(object.id) === target.id);
            if (index < 0) return fail('object not found', 'unsupported_reference');
            bucket = next.objects[target.id] ??= {};
            if (objectPlateIds[index]) affected.add(objectPlateIds[index]);
          } else if (target.scope === 'part') {
            const index = volumeMeta.findIndex((volumes) => volumes.some((volume) => String(volume.id) === target.id));
            if (index < 0) return fail('part not found', 'unsupported_reference');
            bucket = next.parts[target.id] ??= {};
            if (objectPlateIds[index]) affected.add(objectPlateIds[index]);
          } else {
            if (!plateIds.includes(target.id)) return fail('plate not found', 'unsupported_reference');
            bucket = next.plates[target.id] ??= {};
            affected.add(target.id);
          }
          const before = JSON.stringify(bucket);
          if (request.operation === 'set') {
            for (const [key, value] of Object.entries(values)) {
              if (key === 'wipe_tower_x' || key === 'wipe_tower_y') return fail('prime tower coordinates are scene-only', 'unsupported_reference');
              if (target.scope === 'plate' && !metadata[key]?.scopes?.includes('plate'))
                return fail(`configuration option ${key} is not supported for plate scope`, 'unsupported_reference');
              const effective = clamp(key, value);
              bucket[key] = effective;
              if (effective !== value && !corrections.some((item) => item.key === key && item.effective === effective))
                corrections.push({ key, requested: value, effective });
            }
          } else if (request.operation === 'reset') {
            const key = Object.keys(values)[0];
            if (!(key in metadata)) return fail(`unsupported project configuration option: ${key}`, 'unsupported_reference');
            if (key === 'wipe_tower_x' || key === 'wipe_tower_y') return fail('prime tower coordinates are scene-only', 'unsupported_reference');
            if (target.scope === 'plate' && !metadata[key]?.scopes?.includes('plate'))
              return fail(`configuration option ${key} is not supported for plate scope`, 'unsupported_reference');
            delete bucket[key];
          } else {
            for (const key of Object.keys(bucket)) {
              if (!resettable(key)) continue;
              if (request.operation === 'reset-category' && metadata[key]?.category !== request.category) continue;
              delete bucket[key];
            }
          }
          if (target.scope === 'project' && before !== JSON.stringify(bucket)) {
            projectChanged = true;
            for (const id of plateIds) affected.add(id);
          }
          if (before !== JSON.stringify(bucket)) dirtyReasons.add(`${target.scope}-configuration`);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'native configuration validation failed', 'native_validation_failure');
      }
      nativeScopedConfig = next;
      if (historyTransaction) {
        for (const target of targets) historyTransaction.targets.push(target);
      }
      let mutation: Record<string, unknown> | undefined;
      if (dirtyReasons.size > 0) {
        mutation = projectChanged
          ? bridge.orc_mark_shared_configuration_mutation() as Record<string, unknown>
          : plateMutation([...dirtyReasons][0], [...affected], [...affected]);
      }
      if (dirtyReasons.size > 0 && !historyTransaction) historyRevision++;
      const result: Record<string, unknown> = { version: 1, ok: true,
        native_scoped_config: nativeScopedConfigAffectedTransport(targets),
        configuration_status: { state: 'ready', corrections, warnings: [], errors: [] } };
      if (mutation) result.plate_session = mutation;
      return result;
    },
    orc_revalidate_native_scoped_config() {
      // The native bridge validates against the current option metadata. The
      // fixture exposes the same contract while retaining valid keys.
      for (const key of Object.keys(nativeScopedConfig.project))
        if (!(key in metadata)) delete nativeScopedConfig.project[key];
      for (const scope of [nativeScopedConfig.objects, nativeScopedConfig.parts, nativeScopedConfig.plates]) {
        for (const [id, values] of Object.entries(scope)) {
          for (const key of Object.keys(values)) {
            if (!(key in metadata) || (scope === nativeScopedConfig.plates && !metadata[key]?.scopes?.includes('plate')))
              delete values[key];
          }
          if (Object.keys(values).length === 0) delete scope[id];
        }
      }
      return { version: 1, ok: true, native_scoped_config: nativeScopedConfigFullTransport() };
    },
    orc_get_preset_snapshot() {
      return snapshot();
    },
    orc_get_preset_draft(kind: string, canonicalName: string) {
      if (kind !== 'printer' && kind !== 'filament')
        return { ok: false, error_code: 'invalid_request', error: 'kind must be printer|filament', revision: historyRevision };
      if (typeof canonicalName !== 'string' || !canonicalName)
        return { ok: false, error_code: 'invalid_request', error: 'canonical preset name required', revision: historyRevision };
      return presetDraftSnapshot(kind, canonicalName);
    },
    orc_mutate_preset_draft(requestJson: string) {
      return mutatePresetDraft(requestJson);
    },
    orc_select_preset(kind: string, name: string) {
      if (kind !== 'printer' && kind !== 'print') return 'kind must be print|printer';
      const presetKind = kind as 'printer' | 'print';
      const list = presetFixtures[presetKind];
      const requested = list.find((preset) => preset.name === name);
      if (!requested) return `preset not found: ${name}`;
      if (!requested.is_visible) return `preset is not visible: ${name}`;
      if (presetKind !== 'printer' && !isCompatible(presetKind, requested)) {
        return `preset is incompatible: ${name}`;
      }

      // Validate before mutation, then mirror the bridge's printer → print
      // fallback chain. Filament compatibility is represented by the rack
      // session and never changes a single selected catalogue item. Every success returns
      // one complete state, while every rejection leaves selected untouched.
      const previous = { ...selected };
      selected[presetKind] = name;
      const resolved = presetKind === 'printer'
        ? resolveAfterPrinterChange()
        : presetKind === 'print'
          ? resolveAfterPrintChange()
          : true;
      if (!resolved) {
        Object.assign(selected, previous);
        return 'no compatible preset available';
      }
      return snapshot();
    },
    orc_select_printer_with_remembered_rack(requestJson: string) {
      let request: any;
      try { request = JSON.parse(requestJson); }
      catch { return { ok: false, error_code: 'invalid_request', error: 'invalid Printer transition request' }; }
      if (typeof request?.printer !== 'string' || !request.printer)
        return { ok: false, error_code: 'invalid_request', error: 'invalid Printer transition request' };
      const printer = presetFixtures.printer.find((item) => item.name === request.printer && item.is_visible);
      if (!printer) return { ok: false, error_code: 'preset_not_found', error: 'Printer preset not found' };
      const before = historyRevision;
      selected.printer = request.printer;
      if (!resolveAfterPrinterChange())
        return { ok: false, error_code: 'native_validation_failure', error: 'no compatible Process preset available' };

      const current = filamentSessionSnapshot() as any;
      const requestedSlots = request.remembered_rack?.version === 1 && Array.isArray(request.remembered_rack.slots)
        ? request.remembered_rack.slots : undefined;
      if (requestedSlots?.length) {
        const slots = requestedSlots.map((item: any, index: number) => ({
          slot: index + 1,
          preset: { id: item.preset, name: item.preset },
          colour: { effective: item.colour, provenance: 'user' },
        }));
        const size = slots.length;
        current.slots = slots;
        current.mappings = {
          ...current.mappings,
          filament: Array(size).fill(1), volume: Array(size).fill(0),
          nozzle: Array(size).fill(1), filament2: Array(size).fill(1),
        };
        current.flushing = { matrix: Array(size * size).fill(0), vector: [],
          matrix_dimension: size, plane_count: current.capabilities.nozzle_count, source: 'default' };
        current.capabilities = { ...current.capabilities, min_slots: 1, max_slots: 64,
          can_add: true, can_delete: size > 1, can_merge: size > 1, flexible: true };
      }
      historyRevision += 1;
      current.revisions = { ...current.revisions, session: historyRevision, project: historyRevision };
      filamentSessionState = current;
      const context = { selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] },
        activePlateId: currentPlateId || null, gizmo: null, nativeScopedConfig: clone(nativeScopedConfig) };
      if (historyEntries.length === 0) {
        historyEntries.push({ ...captureHistoryState(), id: 'entry-0', label: '', category: 'project', context: clone(context) });
        historyCursor = 0;
        savedHistoryCursor = 0;
      }
      historyEntries.splice(historyCursor + 1);
      historyEntries.push({ ...captureHistoryState(), id: `entry-${nextHistoryEntryId++}`,
        label: 'Select Printer', category: 'project', context: clone(context) });
      historyCursor = historyEntries.length - 1;
      const plateSession = plateMutation('shared-configuration', [...plateIds], [...plateIds]);
      const status = historyStatus();
      const affectedPlateIds = plateSession.affected_plate_ids as string[];
      return {
        ok: true, profile_snapshot: snapshot(), filament_session: filamentSessionSnapshot(),
        plate_session: plateSession, history_status: status,
        native_scoped_config: nativeScopedConfigFullTransport(),
        mutation: { kind: 'select-printer-with-remembered-rack', history_entry_delta: 1,
          revision_before: before, revision_after: historyRevision, dirty: status.dirty,
          all_plate_results_invalidated: true, affected_plate_ids: affectedPlateIds },
      };
    },
    orc_get_option_metadata() {
      const out: Record<string, { type: string; enum_values?: string[] }> = {};
      for (const [k, v] of Object.entries(metadata)) out[k] = { ...v };
      return out;
    },
    orc_add_model(_ptr: number, len: number, ext: string, displayName: string) {
      if (len <= 0) return { error: 'no model bytes' };
      // Keep the established STL mock labels distinct for object-list
      // regressions. DRC alone models its upstream filename behaviour.
      appendMockObject(ext.toLowerCase() === 'drc' && displayName
        ? displayName : undefined);
      // Model imports belong to the current plate; they do not recreate the
      // runtime plate session or change its current identity.
      return { ok: true, objects: objectTransforms.length, instances: objectTransforms.reduce((total, instances) => total + instances.length, 0), plate_session: plateMutation('model-import') };
    },
    orc_close_project() {
      objectTransforms = [];
      objectVolumeTransforms = [];
      objectPlateIds = [];
      objectMeta = [];
      volumeMeta = [];
      instanceMeta = [];
      nativeScopedConfig = emptyNativeScopedConfig();
      presetDraftRegistry = { printer: {}, filament: {} };
      presetDraftEditorRegistry = { printer: {}, filament: {} };
      presetDraftRevision = 0;
      modelLoaded = false;
      sliced = false;
      resetPlateSession();
      return { ok: true, plate_session: plateSessionSnapshot() };
    },
    orc_load_project(_ptr: number, len: number, geometryOnly: number, displayName: string, closeBeforeLoad = true) {
      if (!geometryOnly && closeBeforeLoad) bridge.orc_close_project();
      if (len <= 0) return { error: 'no project bytes' };
      publishProgress(0, geometryOnly ? 'Preparing geometry import' : 'Preparing project load');
      publishProgress(10, 'Reading project metadata');
      if (!geometryOnly) {
        nativeScopedConfig = emptyNativeScopedConfig();
        nativeScopedConfig = clone(exportedNativeScopedConfig);
      }
      appendMockObject(displayName || undefined);
      publishProgress(55, geometryOnly ? 'Preparing imported geometry' : 'Reading project settings');
      if (!geometryOnly) resetPlateSession();
      publishProgress(75, geometryOnly ? 'Finalizing geometry import' : 'Applying project settings');
      publishProgress(90, 'Finalizing project');
      publishProgress(100, geometryOnly ? 'Geometry import complete' : 'Project load complete');
      if (!geometryOnly) {
        historyEntries = [];
        historyCursor = 0;
        historyTransaction = null;
        historyNestedTransactions.length = 0;
        savedHistoryCursor = 0;
        savedHistoryCheckpointEvicted = false;
        historyRevision++;
      }
      return {
        ok: true, objects: objectTransforms.length,
        instances: objectTransforms.reduce((total, instances) => total + instances.length, 0),
        mode: geometryOnly ? 'geometry-only' : 'project',
        display_name: displayName || '', compatibility: 'bambu',
        project_settings_available: !geometryOnly, is_bbl_3mf: true, is_orca_3mf: false,
        file_version: '1.0.0', multi_plate: false, plate_count: 1,
        embedded_preset_warnings: {
          present: !geometryOnly && hasProjectWarning, count: !geometryOnly && hasProjectWarning ? 1 : 0,
          printer_count: !geometryOnly && hasProjectWarning ? 1 : 0,
          process_count: !geometryOnly && hasProjectWarning ? 1 : 0,
          filament_count: !geometryOnly && hasProjectWarning ? 1 : 0,
          modified_printer_gcode: projectWarningFixture.modifiedPrinterGcode,
          modified_filament_gcode: projectWarningFixture.modifiedFilamentGcode,
          missing_system_preset: projectWarningFixture.missingSystemPreset,
          modified_gcode_keys: projectWarningFixture.modifiedGcodeKeys,
          missing_system_preset_types: projectWarningFixture.missingSystemPresetTypes,
          preset_evidence: projectWarningFixture.presetEvidence,
          requires_confirmation: !geometryOnly && hasProjectWarning,
        },
        preset_snapshot: geometryOnly ? undefined : snapshot(),
        native_scoped_config: geometryOnly ? undefined : nativeScopedConfigFullTransport(),
        history_status: geometryOnly ? undefined : historyStatus(),
        plate_session: geometryOnly ? plateMutation('model-import') : plateSessionSnapshot(),
      };
    },
    orc_load_project_after_close(_ptr: number, len: number, displayName: string) {
      return bridge.orc_load_project(_ptr, len, 0, displayName, false);
    },
    orc_import_project_geometry(_ptr: number, len: number, displayName: string) {
      return bridge.orc_load_project(_ptr, len, 1, displayName);
    },
    orc_add_shape(type: string, name?: string) {
      if (!SUPPORTED_PRIMITIVES.includes(type)) return { error: `unsupported primitive type: ${type}` };
      const shapeName = name || type;
      // Mirror the native bridge: the primitive is built in the engine, and
      // the object + its single part are named after the primitive label.
      // Every shape is one closed shell, so it is not splittable into parts.
      // The object records its type so orc_get_model_mesh returns the
      // per-shape geometry (primitiveMesh below).
      modelLoaded = true;
      const currentPlateIndex = Math.max(0, plateIds.indexOf(currentPlateId));
      objectTransforms.push(createObjectTransforms(plateOrigins[currentPlateIndex]?.slice(0, 2) as [number, number] ?? [0, 0]));
      objectVolumeTransforms.push([identityTransform()]);
      objectPlateIds.push(currentPlateId);
      objectMeta.push({ id: nextObjectId++, name: shapeName, printable: true, primitive: type });
      volumeMeta.push([{ id: nextVolumeId++, name: shapeName, type: 'model_part' as VolumeType, isSplittable: false }]);
      instanceMeta.push(Array.from({ length: instanceCount }, (_, ii) => ({
        id: nextInstanceId++,
        printable: true,
      })));
      sliced = false;
      return { ok: true, objects: objectTransforms.length, instances: objectTransforms.reduce((total, instances) => total + instances.length, 0), plate_session: plateMutation('model-import') };
    },
    orc_clear_model() {
      objectTransforms = [];
      objectVolumeTransforms = [];
      objectPlateIds = [];
      objectMeta = [];
      volumeMeta = [];
      instanceMeta = [];
      nativeScopedConfig = emptyNativeScopedConfig();
      modelLoaded = false;
      if (filamentSessionState !== undefined)
        filamentSessionState.assignments = { objects: [], parts: [], modifiers: [] };
      sliced = false;
      resetPlateSession();
      return { ok: true, plate_session: plateMutation('model-clear', [], []) };
    },
    orc_delete_objects(objectIdsJson: string) {
      const ids = JSON.parse(objectIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no object ids' };
      const toDelete: number[] = [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'object id must be a positive integer' };
        const oi = objectMeta.findIndex((o) => o.id === item);
        if (oi < 0) return { error: 'object not found' };
        if (!toDelete.includes(oi)) toDelete.push(oi);
      }
      // Descending order keeps earlier indices valid while the arrays shrink.
      toDelete.sort((a, b) => b - a);
      const affectedBefore = toDelete.map((oi) => objectPlateIds[oi]).filter((id): id is string => typeof id === 'string');
      for (const oi of toDelete) {
        delete nativeScopedConfig.objects[String(objectMeta[oi].id)];
        for (const volume of volumeMeta[oi]) delete nativeScopedConfig.parts[String(volume.id)];
        objectTransforms.splice(oi, 1);
        objectVolumeTransforms.splice(oi, 1);
        objectMeta.splice(oi, 1);
        volumeMeta.splice(oi, 1);
        instanceMeta.splice(oi, 1);
        objectPlateIds.splice(oi, 1);
      }
      sliced = false;
      return { ok: true, objects: objectTransforms.length, deleted: toDelete.length,
        plate_session: plateMutation('model-delete', affectedBefore, affectedBefore) };
    },
    orc_delete_volumes(volumeIdsJson: string) {
      const ids = JSON.parse(volumeIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no volume ids' };
      const toDelete: Array<{ oi: number; vi: number }> = [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'volume id must be a positive integer' };
        let found = false;
        for (let oi = 0; oi < volumeMeta.length; oi++) {
          const vi = volumeMeta[oi].findIndex((v) => v.id === item);
          if (vi >= 0) {
            const vol = volumeMeta[oi][vi];
            if (vol.type === 'model_part') {
              const modelPartCount = volumeMeta[oi].filter((v) => v.type === 'model_part').length;
              if (modelPartCount === 1) return { error: 'deleting the last solid part is not allowed' };
            }
            if (!toDelete.some((d) => d.oi === oi && d.vi === vi)) toDelete.push({ oi, vi });
            found = true;
            break;
          }
        }
        if (!found) return { error: 'volume not found' };
      }
      // Group by object ascending, volume index descending within each object.
      toDelete.sort((a, b) => (a.oi !== b.oi ? a.oi - b.oi : b.vi - a.vi));
      const affectedBefore = toDelete.map(({ oi }) => objectPlateIds[oi]).filter((id): id is string => typeof id === 'string');
      for (const { oi, vi } of toDelete) {
        delete nativeScopedConfig.parts[String(volumeMeta[oi][vi].id)];
        volumeMeta[oi].splice(vi, 1);
        objectVolumeTransforms[oi].splice(vi, 1);
      }
      sliced = false;
      return { ok: true, objects: objectTransforms.length, deleted: toDelete.length,
        plate_session: plateMutation('model-delete', affectedBefore, affectedBefore) };
    },
    orc_clone_objects(objectIdsJson: string) {
      const ids = JSON.parse(objectIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no object ids' };
      const newObjectIds: number[] = [];
      const affectedBefore: string[] = [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'object id must be a positive integer' };
        const oi = objectMeta.findIndex((o) => o.id === item);
        if (oi < 0) return { error: 'object not found' };
        if (objectPlateIds[oi]) affectedBefore.push(objectPlateIds[oi]);
        const sourceObjectId = String(objectMeta[oi].id);
        const sourceVolumeIds = volumeMeta[oi].map((volume) => String(volume.id));
        objectTransforms.push(JSON.parse(JSON.stringify(objectTransforms[oi])));
        objectVolumeTransforms.push(JSON.parse(JSON.stringify(objectVolumeTransforms[oi])));
        objectMeta.push({ id: nextObjectId++, name: objectMeta[oi].name, printable: objectMeta[oi].printable, primitive: objectMeta[oi].primitive });
        const clonedObjectId = objectMeta[objectMeta.length - 1].id;
        if (nativeScopedConfig.objects[sourceObjectId])
          nativeScopedConfig.objects[String(clonedObjectId)] = clone(nativeScopedConfig.objects[sourceObjectId]);
        const clonedVolumes = volumeMeta[oi].map((v) => ({ ...v, id: nextVolumeId++ }));
        volumeMeta.push(clonedVolumes);
        clonedVolumes.forEach((volume, index) => {
          const values = nativeScopedConfig.parts[sourceVolumeIds[index]];
          if (values) nativeScopedConfig.parts[String(volume.id)] = clone(values);
        });
        instanceMeta.push(instanceMeta[oi].map((i) => ({ ...i, id: nextInstanceId++ })));
        objectPlateIds.push(objectPlateIds[oi] ?? currentPlateId);
        newObjectIds.push(objectMeta[objectMeta.length - 1].id);
      }
      sliced = false;
      return { ok: true, newObjectIds, objects: objectTransforms.length,
        plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_reorder_objects(fromObjectId: number, toIndex: number) {
      const fromIdx = objectMeta.findIndex((o) => o.id === fromObjectId);
      if (fromIdx < 0) return { error: 'object not found' };
      const affectedBefore = objectPlateIds[fromIdx] ? [objectPlateIds[fromIdx]] : [];
      moveToIndex(objectTransforms, fromIdx, toIndex);
      moveToIndex(objectVolumeTransforms, fromIdx, toIndex);
      moveToIndex(objectMeta, fromIdx, toIndex);
      moveToIndex(volumeMeta, fromIdx, toIndex);
      moveToIndex(instanceMeta, fromIdx, toIndex);
      moveToIndex(objectPlateIds, fromIdx, toIndex);
      sliced = false;
      return { ok: true, objects: buildStructure(), plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_reorder_volumes(objectId: number, fromVolumeId: number, toIndex: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const fromIdx = volumeMeta[oi].findIndex((v) => v.id === fromVolumeId);
      if (fromIdx < 0) return { error: 'volume not found' };
      moveToIndex(volumeMeta[oi], fromIdx, toIndex);
      moveToIndex(objectVolumeTransforms[oi], fromIdx, toIndex);
      sliced = false;
      const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
      return { ok: true, objects: buildStructure(), plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_split_volume_to_parts(volumeId: number, _maxExtruders: number, _remapPaint: number) {
      for (let oi = 0; oi < volumeMeta.length; oi++) {
        const vi = volumeMeta[oi].findIndex((v) => v.id === volumeId);
        if (vi >= 0) {
          const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
          const source = volumeMeta[oi][vi];
          const sourceValues = nativeScopedConfig.parts[String(source.id)];
          if (!source.isSplittable) return { error: 'volume is not splittable' };
          const parts: Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }> = [];
          for (let p = 0; p < splitParts; p++) {
            parts.push({ id: nextVolumeId++, name: `${source.name}_${p + 1}`, type: source.type, isSplittable: false });
            if (sourceValues) nativeScopedConfig.parts[String(parts[p].id)] = clone(sourceValues);
          }
          delete nativeScopedConfig.parts[String(source.id)];
          volumeMeta[oi].splice(vi, 1, ...parts);
          const transform = objectVolumeTransforms[oi][vi];
          objectVolumeTransforms[oi].splice(vi, 1,
            ...Array.from({ length: splitParts }, () => JSON.parse(JSON.stringify(transform))));
          sliced = false;
          return { ok: true, parts: splitParts, newVolumeIds: parts.map((p) => p.id), objects: buildStructure(),
            plate_session: modelStructureMutation(affectedBefore) };
        }
      }
      return { error: 'volume not found' };
    },
    orc_split_object_to_objects(objectId: number, _autoDrop: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      if (volumeMeta[oi].length === 1 && !volumeMeta[oi][0].isSplittable) return { error: 'object is not splittable' };
      const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
      const newIds: number[] = [];
      const srcVolume = volumeMeta[oi][0];
      const srcInstance = instanceMeta[oi][0];
      const sourceObjectId = String(objectMeta[oi].id);
      const sourceVolumeId = String(srcVolume.id);
      const sourceObjectValues = nativeScopedConfig.objects[sourceObjectId];
      const sourceVolumeValues = nativeScopedConfig.parts[sourceVolumeId];
      for (let p = 0; p < splitParts; p++) {
        objectTransforms.push(JSON.parse(JSON.stringify(objectTransforms[oi])));
        objectVolumeTransforms.push([JSON.parse(JSON.stringify(objectVolumeTransforms[oi][0]))]);
        objectMeta.push({ id: nextObjectId++, name: `${objectMeta[oi].name}_${p + 1}`, printable: objectMeta[oi].printable });
        const newObjectId = objectMeta[objectMeta.length - 1].id;
        // ModelObject::split() starts each derived object's config from the
        // source object and applies the source volume config over it. The
        // resulting ModelVolume config is reset, so do not create a derived
        // part map entry here.
        const mergedObjectValues = {
          ...(sourceObjectValues ? clone(sourceObjectValues) : {}),
          ...(sourceVolumeValues ? clone(sourceVolumeValues) : {}),
        };
        if (Object.keys(mergedObjectValues).length > 0)
          nativeScopedConfig.objects[String(newObjectId)] = mergedObjectValues;
        const newVolume = { id: nextVolumeId++, name: srcVolume.name, type: srcVolume.type, isSplittable: false };
        volumeMeta.push([newVolume]);
        instanceMeta.push([{ id: nextInstanceId++, printable: srcInstance.printable }]);
        objectPlateIds.push(objectPlateIds[oi] ?? currentPlateId);
        newIds.push(objectMeta[objectMeta.length - 1].id);
      }
      objectTransforms.splice(oi, 1);
      objectVolumeTransforms.splice(oi, 1);
      objectMeta.splice(oi, 1);
      delete nativeScopedConfig.objects[sourceObjectId];
      for (const volume of volumeMeta[oi]) delete nativeScopedConfig.parts[String(volume.id)];
      volumeMeta.splice(oi, 1);
      instanceMeta.splice(oi, 1);
      objectPlateIds.splice(oi, 1);
      sliced = false;
      return { ok: true, newObjectIds: newIds, objects: objectTransforms.length,
        plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_merge_objects_to_multipart(objectIdsJson: string, name: string) {
      const ids = JSON.parse(objectIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no object ids' };
      const srcIdxs: number[] = [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'object id must be a positive integer' };
        const oi = objectMeta.findIndex((o) => o.id === item);
        if (oi < 0) return { error: 'object not found' };
        if (!srcIdxs.includes(oi)) srcIdxs.push(oi);
      }
      const affectedBefore = srcIdxs.map((oi) => objectPlateIds[oi]).filter((id): id is string => typeof id === 'string');
      const newObjectId = nextObjectId++;
      const newName = (typeof name === 'string' && name.length > 0) ? name : 'Assembly';
      const newVolumes: Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }> = [];
      const newVolTransforms: Array<ReturnType<typeof identityTransform>> = [];
      for (const oi of srcIdxs) {
        for (let vi = 0; vi < volumeMeta[oi].length; vi++) {
          const newVolumeId = nextVolumeId++;
          newVolumes.push({ id: newVolumeId, name: volumeMeta[oi][vi].name, type: volumeMeta[oi][vi].type, isSplittable: false });
          const values = nativeScopedConfig.parts[String(volumeMeta[oi][vi].id)];
          if (values) nativeScopedConfig.parts[String(newVolumeId)] = clone(values);
          newVolTransforms.push(JSON.parse(JSON.stringify(objectVolumeTransforms[oi][vi])) as ReturnType<typeof identityTransform>);
        }
      }
      objectTransforms.push([JSON.parse(JSON.stringify(objectTransforms[srcIdxs[0]][0]))]);
      objectVolumeTransforms.push(newVolTransforms);
      objectMeta.push({ id: newObjectId, name: newName, printable: objectMeta[srcIdxs[0]].printable });
      volumeMeta.push(newVolumes);
      instanceMeta.push([{ id: nextInstanceId++, printable: instanceMeta[srcIdxs[0]][0].printable }]);
      objectPlateIds.push(objectPlateIds[srcIdxs[0]] ?? currentPlateId);
      srcIdxs.sort((a, b) => b - a);
      for (const oi of srcIdxs) {
        delete nativeScopedConfig.objects[String(objectMeta[oi].id)];
        for (const volume of volumeMeta[oi]) delete nativeScopedConfig.parts[String(volume.id)];
        objectTransforms.splice(oi, 1);
        objectVolumeTransforms.splice(oi, 1);
        objectMeta.splice(oi, 1);
        volumeMeta.splice(oi, 1);
        instanceMeta.splice(oi, 1);
        objectPlateIds.splice(oi, 1);
      }
      sliced = false;
      return { ok: true, objectId: newObjectId, objects: objectTransforms.length,
        plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_instances_to_separate_objects(objectId: number, instanceIdsJson: string) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const ids = JSON.parse(instanceIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no instance ids' };
      const newIds: number[] = [];
      const toRemove: number[] = [];
      const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'instance id must be a positive integer' };
        const ii = instanceMeta[oi].findIndex((inst) => inst.id === item);
        if (ii < 0) return { error: 'instance not found' };
        if (!toRemove.includes(ii)) toRemove.push(ii);
        const srcInst = instanceMeta[oi][ii];
        objectTransforms.push([JSON.parse(JSON.stringify(objectTransforms[oi][ii]))]);
        objectVolumeTransforms.push(JSON.parse(JSON.stringify(objectVolumeTransforms[oi])));
        objectMeta.push({ id: nextObjectId++, name: objectMeta[oi].name, printable: objectMeta[oi].printable, primitive: objectMeta[oi].primitive });
        const separatedVolumes = volumeMeta[oi].map((v) => ({ ...v, id: nextVolumeId++ }));
        volumeMeta.push(separatedVolumes);
        separatedVolumes.forEach((volume, volumeIndex) => {
          const values = nativeScopedConfig.parts[String(volumeMeta[oi][volumeIndex].id)];
          if (values) nativeScopedConfig.parts[String(volume.id)] = clone(values);
        });
        instanceMeta.push([{ id: nextInstanceId++, printable: srcInst.printable }]);
        objectPlateIds.push(objectPlateIds[oi] ?? currentPlateId);
        newIds.push(objectMeta[objectMeta.length - 1].id);
      }
      toRemove.sort((a, b) => b - a);
      for (const ii of toRemove) {
        instanceMeta[oi].splice(ii, 1);
        objectTransforms[oi].splice(ii, 1);
      }
      sliced = false;
      return { ok: true, newObjectIds: newIds, objects: objectTransforms.length,
        plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_add_instance(objectId: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
      const instance = { id: nextInstanceId++, printable: true };
      instanceMeta[oi].push(instance);
      const lastTransform = objectTransforms[oi][objectTransforms[oi].length - 1];
      const newTransform = JSON.parse(JSON.stringify(lastTransform));
      newTransform.offset[0] += 50;
      objectTransforms[oi].push(newTransform);
      sliced = false;
      return { ok: true, objectId, instanceId: instance.id,
        plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_remove_instance(objectId: number, instanceId: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      if (instanceMeta[oi].length <= 1) return { error: 'cannot remove the last instance' };
      const ii = instanceMeta[oi].findIndex((inst) => inst.id === instanceId);
      if (ii < 0) return { error: 'instance not found' };
      const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
      instanceMeta[oi].splice(ii, 1);
      objectTransforms[oi].splice(ii, 1);
      sliced = false;
      return { ok: true, plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_set_instance_offset(obj: number, inst: number, x: number, y: number, z: number) {
      if (obj < 0 || obj >= objectTransforms.length || inst < 0 || inst >= objectTransforms[obj].length) return { error: 'no such instance' };
      objectTransforms[obj][inst].offset = [x, y, z];
      return { ok: true };
    },
    orc_set_model_transform(obj: number, volume: number, inst: number, instanceJson: string, volumeJson: string) {
      if (obj < 0 || obj >= objectTransforms.length || volume < 0 || volume >= objectVolumeTransforms[obj].length || inst < 0 || inst >= objectTransforms[obj].length) return { error: 'no such composite id' };
      objectTransforms[obj][inst] = JSON.parse(instanceJson);
      objectVolumeTransforms[obj][volume] = JSON.parse(volumeJson);
      return { ok: true };
    },
    orc_set_model_transforms(transactionId: string, transformsJson: string) {
      if (transactionId !== historyTransaction?.id) return { error: 'history transaction is stale or belongs to another writer' };
      const transforms = JSON.parse(transformsJson) as Array<{ objectIdx: number; volumeIdx: number; instanceIdx: number; instanceTransform: unknown; volumeTransform: unknown }>;
      if (!Array.isArray(transforms)) return { error: 'transforms must be an array' };
      for (const transform of transforms) {
        if (!Number.isInteger(transform.objectIdx) || !Number.isInteger(transform.volumeIdx) || !Number.isInteger(transform.instanceIdx) ||
            transform.objectIdx < 0 || transform.objectIdx >= objectTransforms.length ||
            transform.volumeIdx < 0 || transform.volumeIdx >= objectVolumeTransforms[transform.objectIdx].length ||
            transform.instanceIdx < 0 || transform.instanceIdx >= objectTransforms[transform.objectIdx].length)
          return { error: 'no such composite id' };
      }
      for (const transform of transforms) {
        objectTransforms[transform.objectIdx][transform.instanceIdx] = clone(transform.instanceTransform as ReturnType<typeof identityTransform>);
        objectVolumeTransforms[transform.objectIdx][transform.volumeIdx] = clone(transform.volumeTransform as ReturnType<typeof identityTransform>);
      }
      return plateSessionSnapshot();
    },
    orc_get_model_mesh() {
      return modelGeometry(new Set(objectMeta.map((object) => object.id)), new Set());
    },
    orc_get_model_scene_patch(requestJson: string) {
      const { object_ids, known_volume_ids } = JSON.parse(requestJson);
      if (![object_ids, known_volume_ids].every((ids) => Array.isArray(ids) && ids.every((id: number) => Number.isSafeInteger(id) && id > 0)))
        return { error: 'scene patch ids must be positive integers' };
      const requested = new Set<number>(object_ids);
      const structure = buildStructure();
      return { ...modelGeometry(requested, new Set<number>(known_volume_ids)),
        object_order: structure.map((object) => object.id), objects: structure.filter((object) => requested.has(object.id)) };
    },
    orc_get_model_structure() {
      return {
        ok: true,
        objects: buildStructure(),
      };
    },
    orc_rename_object(objectId: number, name: string) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      if (typeof name !== 'string' || name.length === 0) return { error: 'name is required' };
      objectMeta[oi].name = name;
      sliced = false;
      return { ok: true };
    },
    orc_rename_volume(volumeId: number, name: string) {
      for (let oi = 0; oi < volumeMeta.length; oi++) {
        const vi = volumeMeta[oi].findIndex((v) => v.id === volumeId);
        if (vi >= 0) {
          if (typeof name !== 'string' || name.length === 0) return { error: 'name is required' };
          volumeMeta[oi][vi].name = name;
          sliced = false;
          return { ok: true };
        }
      }
      return { error: 'volume not found' };
    },
    orc_set_volume_type(volumeId: number, type: string) {
      const valid: VolumeType[] = [
        'model_part', 'negative_volume', 'parameter_modifier',
        'support_blocker', 'support_enforcer',
      ];
      if (!valid.includes(type as VolumeType)) return { error: 'invalid volume type' };
      for (let oi = 0; oi < volumeMeta.length; oi++) {
        const vi = volumeMeta[oi].findIndex((v) => v.id === volumeId);
        if (vi >= 0) {
          const vol = volumeMeta[oi][vi];
          if (vol.type === 'model_part' && type !== 'model_part') {
            const modelPartCount = volumeMeta[oi].filter((v) => v.type === 'model_part').length;
            if (modelPartCount === 1) return { error: 'changing the last solid part is not allowed' };
          }
          vol.type = type as VolumeType;
          sliced = false;
          const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
          return { ok: true, plate_session: modelStructureMutation(affectedBefore) };
        }
      }
      return { error: 'volume not found' };
    },
    orc_set_object_printable(objectId: number, printable: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const value = printable !== 0;
      objectMeta[oi].printable = value;
      for (const inst of instanceMeta[oi]) inst.printable = value;
      sliced = false;
      const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
      return { ok: true, plate_session: modelStructureMutation(affectedBefore) };
    },
    orc_set_instance_printable(instanceId: number, printable: number) {
      for (let oi = 0; oi < instanceMeta.length; oi++) {
        const ii = instanceMeta[oi].findIndex((inst) => inst.id === instanceId);
        if (ii >= 0) {
          instanceMeta[oi][ii].printable = printable !== 0;
          sliced = false;
          const affectedBefore = objectPlateIds[oi] ? [objectPlateIds[oi]] : [];
          return { ok: true, plate_session: modelStructureMutation(affectedBefore) };
        }
      }
      return { error: 'instance not found' };
    },
    orc_set_async_task_callback(ptr: number) {
      asyncTaskCallback = ptr;
    },
    orc_get_threading_info() {
      return { ok: true, threaded: !!opts.threaded, max_concurrency: opts.threaded ? 4 : 1,
        arena_concurrency: opts.threaded ? 4 : 1, serial_terminal_epoch: String(serialTerminalEpoch) };
    },
    orc_get_async_task_mailbox() {
      return { ok: true, byte_offset: mailboxOffset, capacity: 8192 };
    },
    orc_drain_async_task_mailbox() {
      return { ok: true, messages: taskMessages.splice(0) };
    },
    orc_check_serial_admission(observedEpoch: string) {
      return opts.threaded || observedEpoch === String(serialTerminalEpoch)
        ? { ok: true, terminal_epoch: String(serialTerminalEpoch) }
        : { error: 'slice_busy' };
    },
    orc_slice(_config: string) {
      return runMockSlice(currentPlateId, plateInputRevisions[currentPlateId] ?? 0);
    },
    orc_slice_plate(_config: string, plateId: string, revision: number) {
      return runMockSlice(plateId, revision);
    },
    orc_get_slice_result(plateId: string, inputStamp: number, resultGeneration: number) {
      const receipt = sliceReceipts.get(plateId);
      if (!receipt || receipt.inputStamp !== inputStamp ||
          receipt.inputStamp !== (plateInputRevisions[plateId] ?? 0) ||
          receipt.resultGeneration !== String(resultGeneration) ||
          (!sliced && slicedPlateId === plateId))
        return { ok: false, status: 'unavailable', error: 'plate slice result is stale or unavailable' };
      const n = fixture.toolpathVertices;
      const allocF32 = (values: number[]) => {
        const ptr = malloc(values.length * 4);
        HEAPF32.set(values, ptr / 4);
        return ptr;
      };
      const allocU32 = (values: number[]) => {
        const ptr = malloc(values.length * 4);
        HEAPU32.set(values, ptr / 4);
        return ptr;
      };
      const allocU8 = (values: number[]) => {
        const ptr = malloc(values.length);
        HEAPU8.set(values, ptr);
        return ptr;
      };
      const allocU16 = (values: number[]) => {
        const ptr = malloc(values.length * 2);
        new Uint16Array(heap, ptr, values.length).set(values);
        return ptr;
      };
      const starts: number[] = [], ends: number[] = [];
      const layerIds: number[] = [], moveOrders: number[] = [], gcodeIds: number[] = [];
      const moveTypes: number[] = [], roles: number[] = [], extruders: number[] = [], colors: number[] = [];
      const widths: number[] = [], heights: number[] = [];
      let previousLayer = -1;
      for (let i = 0; i < n; i++) {
        const layer = Math.floor((i / Math.max(1, n)) * fixture.layers);
        const order = layer === previousLayer ? moveOrders[i - 1] + 1 : 0;
        previousLayer = layer;
        starts.push(i === 0 ? 0 : i, i === 0 ? 0 : ((i - 1) * 3 + 1) % 200,
          i === 0 ? 0 : Math.floor(((i - 1) / Math.max(1, n)) * fixture.layers) * 0.2);
        ends.push(i + 1, (i * 3 + 1) % 200, layer * 0.2);
        layerIds.push(layer); moveOrders.push(order); gcodeIds.push(i + 1);
        moveTypes.push(i % 4 === 0 ? 8 : 10); // Travel / Extrude
        roles.push(i % fixture.features.length); extruders.push(i % 2); colors.push(i % 2);
        widths.push(0.4 + (i % 3) * 0.05); heights.push(0.2);
      }
      const sptr = allocF32(starts), eptr = allocF32(ends);
      const lptr = allocU32(layerIds), optr = allocU32(moveOrders), gptr = allocU32(gcodeIds);
      const mtptr = allocU8(moveTypes), rptr = allocU16(roles), xptr = allocU8(extruders), cptr = allocU8(colors);
      const wptr = allocF32(widths), hptr = allocF32(heights);
      const metrics: Record<string, { ptr: number; count: number }> = {};
      for (const [name, values] of Object.entries(fixture.optionalMetrics ?? {})) {
        if (values.length !== n) throw new Error(`mock metric ${name} must match segment count`);
        metrics[name] = { ptr: allocF32(values), count: n };
      }
      const layerRanges = Array.from({ length: fixture.layers }, (_, id) => {
        const first = layerIds.indexOf(id);
        return { id, z: id * 0.2, first_segment: Math.max(0, first), segment_count: layerIds.filter((v) => v === id).length };
      }).filter((x) => x.segment_count > 0);
      return {
        ok: true, preview_version: 2,
        receipt: { plate_id: plateId, input_stamp: receipt.inputStamp,
          result_generation: receipt.resultGeneration, slice_task_id: receipt.sliceTaskId },
        objects: objectTransforms.length,
        layers: fixture.layers,
        metadata: {
          result_id: fixture.resultId ?? 1,
          source_filename: fixture.sourceFilename ?? '/out.gcode',
          layer_ranges: layerRanges,
          feature_palette: fixture.features,
          ...(fixture.extruderPalette ? { extruder_palette: fixture.extruderPalette } : {}),
          source_line_mapping: { available: true, line_count: n + 1 },
          source_text: { available: true },
          ...(fixture.analysis ? {
            analysis: {
              ...(fixture.analysis.summary ? {
                summary: {
                  ...(fixture.analysis.summary.estimatedTimeSeconds === undefined ? {} : { estimated_time_seconds: fixture.analysis.summary.estimatedTimeSeconds }),
                  ...(fixture.analysis.summary.filamentLengthMeters === undefined ? {} : { filament_length_meters: fixture.analysis.summary.filamentLengthMeters }),
                  ...(fixture.analysis.summary.filamentWeightGrams === undefined ? {} : { filament_weight_grams: fixture.analysis.summary.filamentWeightGrams }),
                  ...(fixture.analysis.summary.filamentCost === undefined ? {} : { filament_cost: fixture.analysis.summary.filamentCost }),
                },
              } : {}),
              ...(fixture.analysis.featureStatistics ? {
                feature_statistics: fixture.analysis.featureStatistics.map((stats) => ({
                  feature_id: stats.featureId,
                  ...(stats.timeSeconds === undefined ? {} : { time_seconds: stats.timeSeconds }),
                  ...(stats.filamentLengthMeters === undefined ? {} : { filament_length_meters: stats.filamentLengthMeters }),
                  ...(stats.filamentWeightGrams === undefined ? {} : { filament_weight_grams: stats.filamentWeightGrams }),
                })),
              } : {}),
            },
          } : {}),
        },
        toolpath: {
          segment_count: n, starts_ptr: sptr, ends_ptr: eptr,
          layer_id_ptr: lptr, move_order_ptr: optr, gcode_id_ptr: gptr,
          move_type_ptr: mtptr, extrusion_role_ptr: rptr,
          extruder_id_ptr: xptr, color_print_id_ptr: cptr,
          width_ptr: wptr, height_ptr: hptr, metrics,
        },
      };
    },
    orc_export_gcode_plate(plateId: string, revision: number, resultGeneration: number) {
      if (plateId !== currentPlateId) return { error: 'plate operation target is not the current plate' };
      if (revision !== (plateInputRevisions[plateId] ?? 0)) return { error: 'plate operation target is stale' };
      const receipt = sliceReceipts.get(plateId);
      if (!receipt || receipt.inputStamp !== revision || receipt.resultGeneration !== String(resultGeneration))
        return { error: 'plate slice result is stale or unavailable' };
      const path = `/plate-result-${plateId}-${receipt.resultGeneration}.gcode`;
      return { ok: true, path };
    },
    orc_export_project() {
      if (!modelLoaded) return { error: 'no model loaded' };
      exportedNativeScopedConfig = clone(nativeScopedConfig);
      const archive = new TextEncoder().encode(JSON.stringify({
        format: 'bbs-3mf', objects: buildStructure(), plate_count: 1,
        native_scoped_config: exportedNativeScopedConfig,
      }));
      const ptr = malloc(Math.max(1, archive.length));
      HEAPU8.set(archive, ptr);
      return {
        ok: true, path: '/tmp/mock-project.3mf', bytes_ptr: ptr,
        bytes_length: archive.length, objects: objectTransforms.length, plate_count: 1,
      };
    },
    orc_read_gcode_chunk(plateId: string, inputStamp: number, resultGeneration: number,
        resultId: number, offset: number, length: number) {
      const maxChunkBytes = 64 * 1024;
      const receipt = sliceReceipts.get(plateId);
      if (!receipt || receipt.inputStamp !== inputStamp ||
          receipt.resultGeneration !== String(resultGeneration))
        return { ok: false, error: 'preview text is unavailable' };
      if (!Number.isSafeInteger(resultId) || resultId !== (fixture.resultId ?? 1))
        return { ok: false, error: 'preview text is unavailable' };
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
          length < 0 || length > maxChunkBytes)
        return { ok: false, error: 'invalid chunk range' };
      if (!previewSourceBytes) {
        const gcode = fixture.sourceText ?? [
          '; mock gcode (unit-test fixture)', 'G21', 'G90',
          'G1 X0 Y0 Z0.2 F1200', 'G1 X20 Y0 E1.0', 'M104 S0', '',
        ].join('\n');
        previewSourceBytes = new TextEncoder().encode(gcode);
      }
      if (offset > previewSourceBytes.length)
        return { ok: false, error: 'chunk range is outside the preview text' };
      let actualOffset = offset;
      let actualEnd = Math.min(previewSourceBytes.length, offset + length);
      let continuationBytes = 0;
      while (length > 0 && actualOffset > 0 && continuationBytes < 3 &&
             (previewSourceBytes[actualOffset] & 0xc0) === 0x80) {
        actualOffset--;
        continuationBytes++;
      }
      while (length > 0 && actualEnd < previewSourceBytes.length && actualEnd < offset + length + 3 &&
             (previewSourceBytes[actualEnd] & 0xc0) === 0x80) actualEnd++;
      const bytes = previewSourceBytes.slice(actualOffset, actualEnd);
      const ptr = malloc(Math.max(1, bytes.length));
      HEAPU8.set(bytes, ptr);
      return {
        ok: true, result_id: fixture.resultId ?? 1, offset: actualOffset,
        length: bytes.length, eof: actualEnd >= previewSourceBytes.length,
        bytes_ptr: ptr, bytes_length: bytes.length,
      };
    },
    orc_read_gcode_lines(plateId: string, inputStamp: number, resultGeneration: number,
        resultId: number, startLine: number, lineCount: number) {
      const maxLineCount = 128;
      const maxPageBytes = 64 * 1024;
      const receipt = sliceReceipts.get(plateId);
      if (!receipt || receipt.inputStamp !== inputStamp ||
          receipt.resultGeneration !== String(resultGeneration))
        return { ok: false, error: 'preview text is unavailable' };
      if (!Number.isSafeInteger(resultId) || resultId !== (fixture.resultId ?? 1))
        return { ok: false, error: 'preview text is unavailable' };
      if (!Number.isSafeInteger(startLine) || startLine < 1 ||
          !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > maxLineCount)
        return { ok: false, error: 'invalid source line page' };
      if (!previewSourceBytes) {
        const gcode = fixture.sourceText ?? [
          '; mock gcode (unit-test fixture)', 'G21', 'G90',
          'G1 X0 Y0 Z0.2 F1200', 'G1 X20 Y0 E1.0', 'M104 S0', '',
        ].join('\n');
        previewSourceBytes = new TextEncoder().encode(gcode);
      }
      const ends: number[] = [];
      for (let i = 0; i < previewSourceBytes.length; i++)
        if (previewSourceBytes[i] === 10) ends.push(i + 1);
      if (startLine > ends.length)
        return { ok: false, error: 'source line page is outside the preview' };
      const endLine = Math.min(ends.length, startLine + lineCount - 1);
      const startByte = startLine === 1 ? 0 : ends[startLine - 2];
      const endByte = ends[endLine - 1];
      if (endByte - startByte > maxPageBytes)
        return { ok: false, error: 'source line page exceeds byte bound' };
      const bytes = previewSourceBytes.slice(startByte, endByte);
      const ptr = malloc(Math.max(1, bytes.length));
      HEAPU8.set(bytes, ptr);
      return {
        ok: true, result_id: fixture.resultId ?? 1, start_line: startLine,
        line_count: endLine - startLine + 1, eof: endLine === ends.length,
        bytes_ptr: ptr, bytes_length: bytes.length,
      };
    },
    orc_cancel() {
      return { ok: true };
    },
  };

  // ---- ccall dispatch with per-function signature conversion ----
  const SIGNATURES: Record<string, { ret: string; args: string[] }> = {
    orc_init: { ret: 'number', args: ['string'] },
    orc_history_begin: { ret: 'number', args: ['string', 'string', 'string', 'string'] },
    orc_history_commit: { ret: 'number', args: ['string', 'string'] },
    orc_history_abort: { ret: 'number', args: ['string'] },
    orc_history_undo: { ret: 'number', args: [] },
    orc_history_redo: { ret: 'number', args: [] },
    orc_history_jump: { ret: 'number', args: ['string', 'string'] },
    orc_history_status: { ret: 'number', args: [] },
    orc_history_mark_saved: { ret: 'number', args: ['string'] },
    orc_history_reset: { ret: 'number', args: ['string'] },
    orc_select_preset: { ret: 'number', args: ['string', 'string'] },
    orc_select_printer_with_remembered_rack: { ret: 'number', args: ['string'] },
    orc_get_preset_snapshot: { ret: 'number', args: [] },
    orc_get_preset_draft: { ret: 'number', args: ['string', 'string'] },
    orc_mutate_preset_draft: { ret: 'number', args: ['string'] },
    orc_get_option_metadata: { ret: 'number', args: [] },
    orc_add_model: { ret: 'number', args: ['pointer', 'number', 'string', 'string'] },
    orc_load_project: { ret: 'number', args: ['pointer', 'number', 'number', 'string'] },
    orc_close_project: { ret: 'number', args: [] },
    orc_load_project_after_close: { ret: 'number', args: ['pointer', 'number', 'string'] },
    orc_import_project_geometry: { ret: 'number', args: ['pointer', 'number', 'string'] },
    orc_add_shape: { ret: 'number', args: ['string', 'string'] },
    orc_clear_model: { ret: 'number', args: [] },
    orc_get_plate_session_snapshot: { ret: 'number', args: [] },
    orc_get_prime_tower_projection: { ret: 'number', args: [] },
    orc_take_performance_profile: { ret: 'number', args: [] },
    orc_move_prime_tower: { ret: 'number', args: ['string'] },
    orc_get_filament_session_snapshot: { ret: 'number', args: [] },
    orc_select_filament_slot_preset: { ret: 'number', args: ['string'] },
    orc_set_filament_slot_colour: { ret: 'number', args: ['string'] },
    orc_add_filament_slot: { ret: 'number', args: ['string'] },
    orc_delete_filament_slot: { ret: 'number', args: ['string'] },
    orc_merge_filament_slots: { ret: 'number', args: ['string'] },
    orc_apply_remembered_filament_rack: { ret: 'number', args: ['string'] },
    orc_assign_filament: { ret: 'number', args: ['string'] },
    orc_set_filament_routing: { ret: 'number', args: ['string'] },
    orc_reset_plate_session: { ret: 'number', args: [] },
    orc_select_plate: { ret: 'number', args: ['string'] },
    orc_add_plate: { ret: 'number', args: [] },
    orc_reorder_plates: { ret: 'number', args: ['string'] },
    orc_delete_plate: { ret: 'number', args: ['string'] },
    orc_recompute_plate_membership: { ret: 'number', args: [] },
    orc_mark_shared_configuration_mutation: { ret: 'number', args: [] },
    orc_get_native_scoped_config: { ret: 'number', args: [] },
    orc_mutate_native_scoped_config: { ret: 'number', args: ['string'] },
    orc_revalidate_native_scoped_config: { ret: 'number', args: [] },
    orc_delete_objects: { ret: 'number', args: ['string'] },
    orc_delete_volumes: { ret: 'number', args: ['string'] },
    orc_clone_objects: { ret: 'number', args: ['string'] },
    orc_reorder_objects: { ret: 'number', args: ['number', 'number'] },
    orc_reorder_volumes: { ret: 'number', args: ['number', 'number', 'number'] },
    orc_split_volume_to_parts: { ret: 'number', args: ['number', 'number', 'number'] },
    orc_split_object_to_objects: { ret: 'number', args: ['number', 'number'] },
    orc_merge_objects_to_multipart: { ret: 'number', args: ['string', 'string'] },
    orc_instances_to_separate_objects: { ret: 'number', args: ['number', 'string'] },
    orc_add_instance: { ret: 'number', args: ['number'] },
    orc_remove_instance: { ret: 'number', args: ['number', 'number'] },
    orc_rename_object: { ret: 'number', args: ['number', 'string'] },
    orc_rename_volume: { ret: 'number', args: ['number', 'string'] },
    orc_set_volume_type: { ret: 'number', args: ['number', 'string'] },
    orc_set_object_printable: { ret: 'number', args: ['number', 'number'] },
    orc_set_instance_printable: { ret: 'number', args: ['number', 'number'] },
    orc_set_instance_offset: { ret: 'number', args: ['number', 'number', 'number', 'number', 'number'] },
    orc_set_model_transform: { ret: 'number', args: ['number', 'number', 'number', 'string', 'string'] },
    orc_set_model_transforms: { ret: 'number', args: ['string', 'string'] },
    orc_get_model_mesh: { ret: 'number', args: [] },
    orc_get_model_scene_patch: { ret: 'number', args: ['string'] },
    orc_get_model_structure: { ret: 'number', args: [] },
    orc_set_async_task_callback: { ret: 'void', args: ['pointer'] },
    orc_get_threading_info: { ret: 'number', args: [] },
    orc_get_async_task_mailbox: { ret: 'number', args: [] },
    orc_drain_async_task_mailbox: { ret: 'number', args: [] },
    orc_check_serial_admission: { ret: 'number', args: ['string'] },
    orc_slice: { ret: 'number', args: ['string'] },
    orc_slice_plate: { ret: 'number', args: ['string', 'string', 'number'] },
    orc_get_slice_result: { ret: 'number', args: ['string', 'number', 'number'] },
    orc_export_gcode_plate: { ret: 'number', args: ['string', 'number', 'number'] },
    orc_export_project: { ret: 'number', args: [] },
    orc_read_gcode_chunk: { ret: 'number', args: ['string', 'number', 'number', 'number', 'number', 'number'] },
    orc_read_gcode_lines: { ret: 'number', args: ['string', 'number', 'number', 'number', 'number', 'number'] },
    orc_cancel: { ret: 'number', args: [] },
  };

  return {
    ccall(name: string, _ret: string, _argTypes: string[], args: unknown[]): unknown {
      const sig = SIGNATURES[name];
      if (!sig) throw new Error(`mock: unknown bridge fn ${name}`);
      const fn = bridge[name];
      if (!fn) throw new Error(`mock: unregistered bridge fn ${name}`);
      const result = fn(...args);
      if (sig.ret === 'void') return undefined;
      if (typeof result === 'string') return putJson({ error: result });
      return putJson(result);
    },
    UTF8ToString: utf8ToString,
    _malloc: malloc,
    _free: free,
    HEAPU8,
    HEAPU32,
    HEAPF32,
    addFunction(fn: (...args: unknown[]) => void): number {
      functionRegistrations++;
      const idx = nextFunctionIndex++;
      functionTable.set(idx, fn);
      return idx;
    },
    removeFunction(idx: number): void {
      functionTable.delete(idx);
    },
    FS: {
      writeFile(path: string, data: Uint8Array) {
        files.set(path, data);
      },
      readFile(path: string) {
        const f = files.get(path);
        if (!f) throw new Error(`ENOENT: ${path}`);
        // Match Emscripten FS.readFile: callers receive an owned snapshot.
        // Returning the stored view lets a host transfer detach the mock's
        // canonical file, making a second export fail unlike real MEMFS.
        return f.slice();
      },
    },
    _freedPointers: freedPointers,
    get _functionRegistrations() { return functionRegistrations; },
    _publishTaskMessage(taskId: string, message: Record<string, unknown>) {
      publishTaskMessage(taskId, message);
    },
  };
}
