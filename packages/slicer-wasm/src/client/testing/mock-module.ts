// packages/slicer-wasm/src/client/testing/mock-module.ts
// ----------------------------------------------------------------
// Bridge-shaped mock Emscripten module for unit tests (no emsdk).
// Implements the ORC bridge contract exactly as bridge.cpp does for
// real (see doc/2026-08-13-m2-implementation-plan.md Task 1) — the
// client's tests pin this contract; Task 7 implements it in C++.
// Also usable in the app's dev fallback worker (VITE_USE_MOCK=1).
// ----------------------------------------------------------------

import type { ProjectLoadResult, VolumeType } from '../types';

export interface MockFeature {
  id: number;
  name: string;
  color: [number, number, number];
}

export interface MockSliceFixture {
  layers: number;
  toolpathVertices: number; // per vertex: xyz (Float32)
  features: MockFeature[];
  optionalMetrics?: Record<string, number[]>;
  extruderPalette?: Array<MockFeature & { tool?: number }>;
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
}

export interface MockModuleOptions {
  sliceFixture?: MockSliceFixture;
  metadataKeys?: Record<string, { type: string; enum_values?: string[] }>;
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
      { id: 0, name: 'ExternalPerimeter', color: [255, 140, 0] as [number, number, number] },
      { id: 1, name: 'InternalPerimeter', color: [255, 180, 0] as [number, number, number] },
      { id: 2, name: 'SparseInfill', color: [0, 160, 255] as [number, number, number] },
    ],
  };
  const metadata: Record<string, { type: string; enum_values?: string[] }> =
    opts.metadataKeys ?? {
      layer_height: { type: 'float' },
      wall_loops: { type: 'int' },
      sparse_infill_density: { type: 'percent' },
      sparse_infill_pattern: { type: 'enum', enum_values: ['grid', 'gyroid', 'lines'] },
      enable_support: { type: 'bool' },
      nozzle_temperature: { type: 'float' },
      printable_area: { type: 'points' },
      gcode_flavor: { type: 'enum', enum_values: ['marlin', 'klipper', 'repetier'] },
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

  // The OrcaSlicer "Add Primitive" menu set (GUI_Factories.cpp
  // append_submenu_add_generic): the shapes the native bridge's orc_add_shape
  // can build.
  const SUPPORTED_PRIMITIVES = ['Cube', 'Cylinder', 'Sphere', 'Cone', 'Disc', 'Torus'];

  // ---- Compatibility-aware FFF preset fixture. The mock intentionally owns
  // only simple explicit relations; real compatible_printers / conditions /
  // inheritance remain C++ engine behaviour. Afinia and the hidden print /
  // filament entries exercise the legacy visibility surface. ----
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
  const selected: Record<PresetKind, string> = {
    printer: presetFixtures.printer[0].name,
    print: presetFixtures.print[0].name,
    filament: presetFixtures.filament[0].name,
  };

  function isCompatible(kind: 'print' | 'filament', fixture: PresetFixture): boolean {
    if (fixture.compatible_printers && !fixture.compatible_printers.includes(selected.printer)) return false;
    return kind !== 'filament' || !fixture.compatible_prints || fixture.compatible_prints.includes(selected.print);
  }

  function candidates(kind: PresetKind): PresetFixture[] {
    const list = presetFixtures[kind];
    if (kind === 'printer') return list.filter((preset) => preset.is_visible);
    return list.filter((preset) => preset.is_visible && isCompatible(kind, preset));
  }

  function selectedEntry(kind: PresetKind) {
    return {
      name: selected[kind],
      idx: presetFixtures[kind].findIndex((preset) => preset.name === selected[kind]),
    };
  }

  function snapshot() {
    const entry = (kind: PresetKind, preset: PresetFixture) => ({
      ...preset,
      selected: preset.name === selected[kind],
    });
    return {
      ok: true,
      printers: candidates('printer').map((preset) => entry('printer', preset)),
      prints: candidates('print').map((preset) => entry('print', preset)),
      filaments: candidates('filament').map((preset) => entry('filament', preset)),
      printer: selectedEntry('printer'),
      print: selectedEntry('print'),
      filament: selectedEntry('filament'),
      printable_area: presetFixtures.printer.find((preset) => preset.name === selected.printer)?.printable_area
        ?? [[0, 0], [220, 0], [220, 220], [0, 220]],
    };
  }

  function selectFallback(kind: 'print' | 'filament'): boolean {
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
    const activeFilament = presetFixtures.filament.find((preset) => preset.name === selected.filament);
    if (!activeFilament || !isCompatible('filament', activeFilament)) return selectFallback('filament');
    return true;
  }

  function resolveAfterPrintChange(): boolean {
    const activeFilament = presetFixtures.filament.find((preset) => preset.name === selected.filament);
    if (!activeFilament || !isCompatible('filament', activeFilament)) return selectFallback('filament');
    return true;
  }

  const identityTransform = () => ({
    offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1],
  });
  const instanceCount = Math.max(1, Math.floor(opts.instanceCount ?? 1));
  const volumeCount = Math.max(1, Math.floor(opts.volumeCount ?? 1));
  const splitParts = Math.max(1, Math.floor(opts.splitParts ?? 2));
  const createObjectTransforms = (originX = 0) => Array.from({ length: instanceCount }, (_, index) => ({
    ...identityTransform(),
    // Keep mock instances visibly separate so selection tests can hit each
    // one without a model fixture that depends on the native build.
    offset: [originX + index * 50, 0, 0],
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
  let plateSessionSequence = 0;
  let plateSessionId = '';
  let plateIds: string[] = [];
  let currentPlateId = '';
  let plateInputRevisions: Record<string, number> = {};
  function resetPlateSession(): void {
    plateSessionSequence += 1;
    plateSessionId = `plate-session-${plateSessionSequence}-plate-1`;
    plateIds = [plateSessionId];
    currentPlateId = plateSessionId;
    plateInputRevisions = { [plateSessionId]: 0 };
  }
  resetPlateSession();
  function plateSessionSnapshot(includeMutation = false) {
    const result: Record<string, unknown> = {
      ok: true,
      version: 1,
      current_plate_id: currentPlateId,
      input_revisions: { ...plateInputRevisions },
      plates: plateIds.map((id, index) => includeMutation ? ({
        plate_id: id, display_index: index, origin: [index * 240, 0, 0], name: `Plate ${index + 1}`,
        instance_ids: [], out_of_bounds_instance_ids: [], valid: true,
      }) : ({ plate_id: id, display_index: index, origin: [index * 240, 0, 0], name: `Plate ${index + 1}` })),
    };
    if (includeMutation) {
      result.instance_transforms = [];
      result.instances = objectTransforms.flatMap((transforms, objectIndex) =>
        transforms.map((_transform, instanceIndex) => {
          const instance = instanceMeta[objectIndex]?.[instanceIndex];
          return {
            instance_id: instance?.id ?? 0,
            object_id: objectMeta[objectIndex]?.id ?? 0,
            object_index: objectIndex,
            instance_index: instanceIndex,
            plate_id: currentPlateId,
            member: true,
            unprintable: false,
            out_of_bounds: false,
          };
        }));
    }
    return result;
  }
  function plateMutation(
    reason: string,
    before = [currentPlateId],
    after = [currentPlateId],
    instanceTransforms: readonly Record<string, unknown>[] = [],
  ) {
    const affected = [...new Set([...before, ...after])];
    for (const id of affected) if (plateIds.includes(id)) plateInputRevisions[id] = (plateInputRevisions[id] ?? 0) + 1;
    const result = plateSessionSnapshot(true) as Record<string, unknown>;
    result.instance_transforms = instanceTransforms;
    result.affected_plate_ids_before = before;
    result.affected_plate_ids_after = after;
    result.affected_plate_ids = affected;
    result.dirty_reasons = [reason];
    return result;
  }
  let progressCallback = 0;
  const functionTable = new Map<number, (...args: unknown[]) => void>();
  let nextFunctionIndex = 1000;
  let functionRegistrations = 0;
  const mailboxOffset = 128;
  const mailboxWords = new Int32Array(heap, mailboxOffset, 4);
  const mailboxText = new Uint8Array(heap, mailboxOffset + 16, 512);
  function publishMailboxProgress(percent: number, text: string): void {
    const bytes = new TextEncoder().encode(text).slice(0, mailboxText.length - 1);
    Atomics.add(mailboxWords, 0, 1);
    mailboxText.set(bytes);
    mailboxText[bytes.length] = 0;
    Atomics.store(mailboxWords, 1, percent);
    Atomics.store(mailboxWords, 2, bytes.length);
    Atomics.add(mailboxWords, 0, 1);
  }

  function runMockSlice(plateId: string, revision: number): unknown {
    if (!modelLoaded) return { error: 'no model loaded' };
    if (plateId !== currentPlateId) return { error: 'plate operation target is not the current plate' };
    if (revision !== (plateInputRevisions[plateId] ?? 0)) return { error: 'plate operation target is stale' };
    for (let pct = 0; pct <= 100; pct += 25) {
      if (opts.threaded) {
        publishMailboxProgress(pct, `slice ${pct}%`);
        continue;
      }
      if (!progressCallback) continue;
      const bytes = new TextEncoder().encode(`slice ${pct}%`);
      const tp = malloc(bytes.length + 1);
      HEAPU8.set(bytes, tp);
      functionTable.get(progressCallback)?.(pct, tp);
    }
    sliced = true;
    slicedPlateId = plateId;
    slicedPlateRevision = revision;
    return { ok: true, unrecognized_keys: [] };
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
          const v1 = inext * n + j;
          const v2 = inext * n + jnext;
          const v3 = i * n + jnext;
          tris.push([v0, v1, v2], [v0, v2, v3]);
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
    objectTransforms.push(createObjectTransforms(currentPlateIndex * 240));
    objectVolumeTransforms.push(createObjectVolumeTransforms());
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
    orc_init(_legacyPreferencesJson?: string) {
      resetPlateSession();
      return {
        ok: true,
        prints: presetFixtures.print.length,
        filaments: presetFixtures.filament.length,
        printers: presetFixtures.printer.length,
      };
    },
    orc_get_plate_session_snapshot() {
      return plateSessionSnapshot();
    },
    orc_reset_plate_session() {
      resetPlateSession();
      return plateSessionSnapshot();
    },
    orc_select_plate(plateId: string) {
      if (typeof plateId !== 'string' || plateId.length === 0) return { error: 'plateId is required' };
      if (!plateIds.includes(plateId)) return { error: 'plate not found' };
      currentPlateId = plateId;
      return plateSessionSnapshot();
    },
    orc_add_plate() {
      if (plateIds.length >= 36) return { error: 'maximum of 36 plates' };
      const id = `plate-session-${++plateSessionSequence}-plate-${plateIds.length + 1}`;
      plateIds.push(id);
      plateInputRevisions[id] = 0;
      currentPlateId = id;
      return plateSessionSnapshot(true);
    },
    orc_delete_plate(plateId: string) {
      if (plateIds.length <= 1) return { error: 'at least one plate must remain' };
      const index = plateIds.indexOf(plateId);
      if (index < 0) return { error: 'plate not found' };
      const deletingCurrent = currentPlateId === plateId;
      const oldTransforms = objectTransforms.map((instances) => instances.map((transform) => structuredClone(transform)));
      plateIds.splice(index, 1);
      delete plateInputRevisions[plateId];
      if (deletingCurrent) currentPlateId = plateIds[Math.min(index, plateIds.length - 1)];
      const changed: Record<string, unknown>[] = [];
      for (let objectIndex = 0; objectIndex < objectTransforms.length; objectIndex += 1) {
        for (let instanceIndex = 0; instanceIndex < objectTransforms[objectIndex].length; instanceIndex += 1) {
          const transform = objectTransforms[objectIndex][instanceIndex];
          if (transform.offset[0] < index * 240) continue;
          transform.offset = [transform.offset[0] - 240, transform.offset[1], transform.offset[2]];
          if (JSON.stringify(transform) === JSON.stringify(oldTransforms[objectIndex][instanceIndex])) continue;
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
      return plateMutation('plate-delete', [plateId], plateIds, changed);
    },
    orc_recompute_plate_membership() {
      return plateSessionSnapshot(true);
    },
    orc_mark_shared_configuration_mutation() {
      const affected = [...plateIds];
      for (const id of affected) plateInputRevisions[id] = (plateInputRevisions[id] ?? 0) + 1;
      const result = plateSessionSnapshot(true) as Record<string, unknown>;
      result.affected_plate_ids_before = affected;
      result.affected_plate_ids_after = affected;
      result.affected_plate_ids = affected;
      result.dirty_reasons = ['shared-configuration'];
      return result;
    },
    orc_get_preset_snapshot() {
      return snapshot();
    },
    orc_select_preset(kind: string, name: string) {
      const presetKind = kind as PresetKind;
      const list = presetFixtures[presetKind];
      if (!list) return `kind must be print|filament|printer`;
      const requested = list.find((preset) => preset.name === name);
      if (!requested) return `preset not found: ${name}`;
      if (!requested.is_visible) return `preset is not visible: ${name}`;
      if (presetKind !== 'printer' && !isCompatible(presetKind, requested)) {
        return `preset is incompatible: ${name}`;
      }

      // Validate before mutation, then mirror the bridge's printer → print →
      // filament and print → filament fallback chains. Every success returns
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
    orc_load_project(_ptr: number, len: number, geometryOnly: number, displayName: string) {
      if (len <= 0) return { error: 'no project bytes' };
      if (!geometryOnly) {
        objectTransforms = [];
        objectVolumeTransforms = [];
        objectMeta = [];
        volumeMeta = [];
        instanceMeta = [];
      }
      appendMockObject(displayName || undefined);
      resetPlateSession();
      return {
        ok: true, objects: objectTransforms.length,
        instances: objectTransforms.reduce((total, instances) => total + instances.length, 0),
        mode: geometryOnly ? 'geometry-only' : 'project',
        display_name: displayName || '', compatibility: 'bambu',
        project_settings_available: !geometryOnly, is_bbl_3mf: true, is_orca_3mf: false,
        file_version: '1.0.0', multi_plate: false, plate_count: 1,
        embedded_preset_warnings: {
          present: !geometryOnly, count: geometryOnly ? 0 : 1,
          printer_count: geometryOnly ? 0 : 1, process_count: geometryOnly ? 0 : 1,
          filament_count: geometryOnly ? 0 : 1,
          modified_printer_gcode: projectWarningFixture.modifiedPrinterGcode,
          modified_filament_gcode: projectWarningFixture.modifiedFilamentGcode,
          missing_system_preset: projectWarningFixture.missingSystemPreset,
          modified_gcode_keys: projectWarningFixture.modifiedGcodeKeys,
          missing_system_preset_types: projectWarningFixture.missingSystemPresetTypes,
          preset_evidence: projectWarningFixture.presetEvidence,
          requires_confirmation: !geometryOnly,
        },
        preset_snapshot: geometryOnly ? undefined : snapshot(),
        plate_session: geometryOnly ? plateMutation('model-import') : plateSessionSnapshot(true),
      };
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
      objectTransforms.push(createObjectTransforms(currentPlateIndex * 240));
      objectVolumeTransforms.push([identityTransform()]);
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
      objectMeta = [];
      volumeMeta = [];
      instanceMeta = [];
      modelLoaded = false;
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
      for (const oi of toDelete) {
        objectTransforms.splice(oi, 1);
        objectVolumeTransforms.splice(oi, 1);
        objectMeta.splice(oi, 1);
        volumeMeta.splice(oi, 1);
        instanceMeta.splice(oi, 1);
      }
      sliced = false;
      return { ok: true, objects: objectTransforms.length, deleted: toDelete.length, plate_session: plateMutation('model-delete') };
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
      for (const { oi, vi } of toDelete) {
        volumeMeta[oi].splice(vi, 1);
        objectVolumeTransforms[oi].splice(vi, 1);
      }
      sliced = false;
      return { ok: true, objects: objectTransforms.length, deleted: toDelete.length };
    },
    orc_clone_objects(objectIdsJson: string) {
      const ids = JSON.parse(objectIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no object ids' };
      const newObjectIds: number[] = [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'object id must be a positive integer' };
        const oi = objectMeta.findIndex((o) => o.id === item);
        if (oi < 0) return { error: 'object not found' };
        objectTransforms.push(JSON.parse(JSON.stringify(objectTransforms[oi])));
        objectVolumeTransforms.push(JSON.parse(JSON.stringify(objectVolumeTransforms[oi])));
        objectMeta.push({ id: nextObjectId++, name: objectMeta[oi].name, printable: objectMeta[oi].printable, primitive: objectMeta[oi].primitive });
        volumeMeta.push(volumeMeta[oi].map((v) => ({ ...v, id: nextVolumeId++ })));
        instanceMeta.push(instanceMeta[oi].map((i) => ({ ...i, id: nextInstanceId++ })));
        newObjectIds.push(objectMeta[objectMeta.length - 1].id);
      }
      sliced = false;
      return { ok: true, newObjectIds, objects: objectTransforms.length };
    },
    orc_reorder_objects(fromObjectId: number, toIndex: number) {
      const fromIdx = objectMeta.findIndex((o) => o.id === fromObjectId);
      if (fromIdx < 0) return { error: 'object not found' };
      moveToIndex(objectTransforms, fromIdx, toIndex);
      moveToIndex(objectVolumeTransforms, fromIdx, toIndex);
      moveToIndex(objectMeta, fromIdx, toIndex);
      moveToIndex(volumeMeta, fromIdx, toIndex);
      moveToIndex(instanceMeta, fromIdx, toIndex);
      sliced = false;
      return { ok: true, objects: buildStructure() };
    },
    orc_reorder_volumes(objectId: number, fromVolumeId: number, toIndex: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const fromIdx = volumeMeta[oi].findIndex((v) => v.id === fromVolumeId);
      if (fromIdx < 0) return { error: 'volume not found' };
      moveToIndex(volumeMeta[oi], fromIdx, toIndex);
      moveToIndex(objectVolumeTransforms[oi], fromIdx, toIndex);
      sliced = false;
      return { ok: true, objects: buildStructure() };
    },
    orc_split_volume_to_parts(volumeId: number, _maxExtruders: number, _remapPaint: number) {
      for (let oi = 0; oi < volumeMeta.length; oi++) {
        const vi = volumeMeta[oi].findIndex((v) => v.id === volumeId);
        if (vi >= 0) {
          const source = volumeMeta[oi][vi];
          if (!source.isSplittable) return { error: 'volume is not splittable' };
          const parts: Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }> = [];
          for (let p = 0; p < splitParts; p++) {
            parts.push({ id: nextVolumeId++, name: `${source.name}_${p + 1}`, type: source.type, isSplittable: false });
          }
          volumeMeta[oi].splice(vi, 1, ...parts);
          const transform = objectVolumeTransforms[oi][vi];
          objectVolumeTransforms[oi].splice(vi, 1,
            ...Array.from({ length: splitParts }, () => JSON.parse(JSON.stringify(transform))));
          sliced = false;
          return { ok: true, parts: splitParts, newVolumeIds: parts.map((p) => p.id), objects: buildStructure() };
        }
      }
      return { error: 'volume not found' };
    },
    orc_split_object_to_objects(objectId: number, _autoDrop: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      if (volumeMeta[oi].length === 1 && !volumeMeta[oi][0].isSplittable) return { error: 'object is not splittable' };
      const newIds: number[] = [];
      const srcVolume = volumeMeta[oi][0];
      const srcInstance = instanceMeta[oi][0];
      for (let p = 0; p < splitParts; p++) {
        objectTransforms.push(JSON.parse(JSON.stringify(objectTransforms[oi])));
        objectVolumeTransforms.push([JSON.parse(JSON.stringify(objectVolumeTransforms[oi][0]))]);
        objectMeta.push({ id: nextObjectId++, name: `${objectMeta[oi].name}_${p + 1}`, printable: objectMeta[oi].printable });
        volumeMeta.push([{ id: nextVolumeId++, name: srcVolume.name, type: srcVolume.type, isSplittable: false }]);
        instanceMeta.push([{ id: nextInstanceId++, printable: srcInstance.printable }]);
        newIds.push(objectMeta[objectMeta.length - 1].id);
      }
      objectTransforms.splice(oi, 1);
      objectVolumeTransforms.splice(oi, 1);
      objectMeta.splice(oi, 1);
      volumeMeta.splice(oi, 1);
      instanceMeta.splice(oi, 1);
      sliced = false;
      return { ok: true, newObjectIds: newIds, objects: objectTransforms.length };
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
      const newObjectId = nextObjectId++;
      const newName = (typeof name === 'string' && name.length > 0) ? name : 'Assembly';
      const newVolumes: Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }> = [];
      const newVolTransforms: Array<ReturnType<typeof identityTransform>> = [];
      for (const oi of srcIdxs) {
        for (let vi = 0; vi < volumeMeta[oi].length; vi++) {
          newVolumes.push({ id: nextVolumeId++, name: volumeMeta[oi][vi].name, type: volumeMeta[oi][vi].type, isSplittable: false });
          newVolTransforms.push(JSON.parse(JSON.stringify(objectVolumeTransforms[oi][vi])) as ReturnType<typeof identityTransform>);
        }
      }
      objectTransforms.push([JSON.parse(JSON.stringify(objectTransforms[srcIdxs[0]][0]))]);
      objectVolumeTransforms.push(newVolTransforms);
      objectMeta.push({ id: newObjectId, name: newName, printable: objectMeta[srcIdxs[0]].printable });
      volumeMeta.push(newVolumes);
      instanceMeta.push([{ id: nextInstanceId++, printable: instanceMeta[srcIdxs[0]][0].printable }]);
      srcIdxs.sort((a, b) => b - a);
      for (const oi of srcIdxs) {
        objectTransforms.splice(oi, 1);
        objectVolumeTransforms.splice(oi, 1);
        objectMeta.splice(oi, 1);
        volumeMeta.splice(oi, 1);
        instanceMeta.splice(oi, 1);
      }
      sliced = false;
      return { ok: true, objectId: newObjectId, objects: objectTransforms.length };
    },
    orc_instances_to_separate_objects(objectId: number, instanceIdsJson: string) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const ids = JSON.parse(instanceIdsJson ?? '[]') as unknown;
      if (!Array.isArray(ids) || ids.length === 0) return { error: 'no instance ids' };
      const newIds: number[] = [];
      const toRemove: number[] = [];
      for (const item of ids) {
        if (!Number.isInteger(item) || item < 1) return { error: 'instance id must be a positive integer' };
        const ii = instanceMeta[oi].findIndex((inst) => inst.id === item);
        if (ii < 0) return { error: 'instance not found' };
        if (!toRemove.includes(ii)) toRemove.push(ii);
        const srcInst = instanceMeta[oi][ii];
        objectTransforms.push([JSON.parse(JSON.stringify(objectTransforms[oi][ii]))]);
        objectVolumeTransforms.push(JSON.parse(JSON.stringify(objectVolumeTransforms[oi])));
        objectMeta.push({ id: nextObjectId++, name: objectMeta[oi].name, printable: objectMeta[oi].printable, primitive: objectMeta[oi].primitive });
        volumeMeta.push(volumeMeta[oi].map((v) => ({ ...v, id: nextVolumeId++ })));
        instanceMeta.push([{ id: nextInstanceId++, printable: srcInst.printable }]);
        newIds.push(objectMeta[objectMeta.length - 1].id);
      }
      toRemove.sort((a, b) => b - a);
      for (const ii of toRemove) {
        instanceMeta[oi].splice(ii, 1);
        objectTransforms[oi].splice(ii, 1);
      }
      sliced = false;
      return { ok: true, newObjectIds: newIds, objects: objectTransforms.length };
    },
    orc_add_instance(objectId: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      const instance = { id: nextInstanceId++, printable: true };
      instanceMeta[oi].push(instance);
      const lastTransform = objectTransforms[oi][objectTransforms[oi].length - 1];
      const newTransform = JSON.parse(JSON.stringify(lastTransform));
      newTransform.offset[0] += 50;
      objectTransforms[oi].push(newTransform);
      sliced = false;
      return { ok: true, objectId, instanceId: instance.id };
    },
    orc_remove_instance(objectId: number, instanceId: number) {
      const oi = objectMeta.findIndex((o) => o.id === objectId);
      if (oi < 0) return { error: 'object not found' };
      if (instanceMeta[oi].length <= 1) return { error: 'cannot remove the last instance' };
      const ii = instanceMeta[oi].findIndex((inst) => inst.id === instanceId);
      if (ii < 0) return { error: 'instance not found' };
      instanceMeta[oi].splice(ii, 1);
      objectTransforms[oi].splice(ii, 1);
      sliced = false;
      return { ok: true };
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
    orc_get_model_mesh() {
      if (!modelLoaded) return { error: 'no model loaded' };
      // Local coordinates — the bridge contract (bridge.cpp
      // orc_get_model_mesh) reports the instance offset separately, and the
      // renderer applies it as the group position. (The offset used to be
      // baked into the vertices too, which double-offset the cube after a
      // committed move + reload; offset 0 hid it.) File-import fixtures are
      // the 20 mm cube (8 verts, 12 tris); primitives return their own
      // geometry from primitiveMesh.
      return {
        ok: true,
        // The client frees every returned pair of heap buffers, so each
        // composite must own distinct allocations even though the geometry
        // itself is identical.
        objects: objectTransforms.flatMap((instances, object_idx) => instances.flatMap((instanceTransform, instance_idx) =>
          objectVolumeTransforms[object_idx].map((_volumeTransform, volume_idx) => {
          // Primitives return their built geometry; other objects the cube.
          const { verts, tris } = primitiveMesh(objectMeta[object_idx]?.primitive);
          const vptr = malloc(verts.length * 3 * 4);
          const iptr = malloc(tris.length * 3 * 4);
          const vo = vptr / 4;
          const io = iptr / 4;
          verts.forEach((v, i) => HEAPF32.set(v, vo + i * 3));
          tris.forEach((t, i) => HEAPU32.set(t, io + i * 3));
          return {
            object_idx,
            volume_idx,
            instance_idx,
            vertex_ptr: vptr,
            vertex_count: verts.length,
            index_ptr: iptr,
            index_count: tris.length * 3,
            offset: instanceTransform.offset,
            instance_transform: instanceTransform,
            volume_transform: objectVolumeTransforms[object_idx][volume_idx],
          };
          })),
        ),
      };
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
          return { ok: true };
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
      return { ok: true };
    },
    orc_set_instance_printable(instanceId: number, printable: number) {
      for (let oi = 0; oi < instanceMeta.length; oi++) {
        const ii = instanceMeta[oi].findIndex((inst) => inst.id === instanceId);
        if (ii >= 0) {
          instanceMeta[oi][ii].printable = printable !== 0;
          sliced = false;
          return { ok: true };
        }
      }
      return { error: 'instance not found' };
    },
    orc_set_progress_callback(ptr: number) {
      progressCallback = ptr;
    },
    orc_get_threading_info() {
      return { ok: true, threaded: !!opts.threaded, max_concurrency: opts.threaded ? 4 : 1, arena_concurrency: opts.threaded ? 4 : 1 };
    },
    orc_get_progress_mailbox() {
      return { ok: true, byte_offset: mailboxOffset, text_capacity: mailboxText.length };
    },
    orc_slice(_config: string) {
      return runMockSlice(currentPlateId, plateInputRevisions[currentPlateId] ?? 0);
    },
    orc_slice_plate(_config: string, plateId: string, revision: number) {
      return runMockSlice(plateId, revision);
    },
    orc_get_slice_result() {
      if (!sliced) return { error: 'no slice result' };
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
          vertex_ptr: eptr, vertex_count: n,
          layer_ptr: lptr, layer_count: n,
          feature_ptr: allocU32(roles), feature_count: n,
          features: fixture.features,
        },
      };
    },
    orc_export_gcode() {
      const gcode = fixture.sourceText ?? [
        '; mock gcode (unit-test fixture)',
        'G21', 'G90',
        'G1 X0 Y0 Z0.2 F1200',
        'G1 X20 Y0 E1.0',
        'M104 S0', '',
      ].join('\n');
      previewSourceBytes = new TextEncoder().encode(gcode);
      files.set('/out.gcode', previewSourceBytes);
      return { ok: true, path: '/out.gcode' };
    },
    orc_export_gcode_plate(plateId: string, revision: number) {
      if (plateId !== currentPlateId) return { error: 'plate operation target is not the current plate' };
      if (revision !== (plateInputRevisions[plateId] ?? 0)) return { error: 'plate operation target is stale' };
      if (!sliced || slicedPlateId !== plateId || slicedPlateRevision !== revision)
        return { error: 'plate slice result is stale or unavailable' };
      return bridge.orc_export_gcode();
    },
    orc_export_project() {
      if (!modelLoaded) return { error: 'no model loaded' };
      const archive = new TextEncoder().encode(JSON.stringify({
        format: 'bbs-3mf', objects: buildStructure(), plate_count: 1,
      }));
      const ptr = malloc(Math.max(1, archive.length));
      HEAPU8.set(archive, ptr);
      return {
        ok: true, path: '/tmp/mock-project.3mf', bytes_ptr: ptr,
        bytes_length: archive.length, objects: objectTransforms.length, plate_count: 1,
      };
    },
    orc_read_gcode_chunk(resultId: number, offset: number, length: number) {
      const maxChunkBytes = 64 * 1024;
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
    orc_read_gcode_lines(resultId: number, startLine: number, lineCount: number) {
      const maxLineCount = 128;
      const maxPageBytes = 64 * 1024;
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
    orc_select_preset: { ret: 'number', args: ['string', 'string'] },
    orc_get_preset_snapshot: { ret: 'number', args: [] },
    orc_get_option_metadata: { ret: 'number', args: [] },
    orc_add_model: { ret: 'number', args: ['pointer', 'number', 'string', 'string'] },
    orc_load_project: { ret: 'number', args: ['pointer', 'number', 'number', 'string'] },
    orc_import_project_geometry: { ret: 'number', args: ['pointer', 'number', 'string'] },
    orc_add_shape: { ret: 'number', args: ['string', 'string'] },
    orc_clear_model: { ret: 'number', args: [] },
    orc_get_plate_session_snapshot: { ret: 'number', args: [] },
    orc_reset_plate_session: { ret: 'number', args: [] },
    orc_select_plate: { ret: 'number', args: ['string'] },
    orc_add_plate: { ret: 'number', args: [] },
    orc_delete_plate: { ret: 'number', args: ['string'] },
    orc_recompute_plate_membership: { ret: 'number', args: [] },
    orc_mark_shared_configuration_mutation: { ret: 'number', args: [] },
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
    orc_get_model_mesh: { ret: 'number', args: [] },
    orc_get_model_structure: { ret: 'number', args: [] },
    orc_set_progress_callback: { ret: 'void', args: ['pointer'] },
    orc_get_threading_info: { ret: 'number', args: [] },
    orc_get_progress_mailbox: { ret: 'number', args: [] },
    orc_slice: { ret: 'number', args: ['string'] },
    orc_slice_plate: { ret: 'number', args: ['string', 'string', 'number'] },
    orc_get_slice_result: { ret: 'number', args: [] },
    orc_export_gcode: { ret: 'number', args: [] },
    orc_export_gcode_plate: { ret: 'number', args: ['string', 'number'] },
    orc_export_project: { ret: 'number', args: [] },
    orc_read_gcode_chunk: { ret: 'number', args: ['number', 'number', 'number'] },
    orc_read_gcode_lines: { ret: 'number', args: ['number', 'number', 'number'] },
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
        return f;
      },
    },
    _freedPointers: freedPointers,
    get _functionRegistrations() { return functionRegistrations; },
  };
}
