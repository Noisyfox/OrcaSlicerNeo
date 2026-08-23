// packages/slicer-wasm/src/client/testing/mock-module.ts
// ----------------------------------------------------------------
// Bridge-shaped mock Emscripten module for unit tests (no emsdk).
// Implements the ORC bridge contract exactly as bridge.cpp does for
// real (see doc/2026-08-13-m2-implementation-plan.md Task 1) — the
// client's tests pin this contract; Task 7 implements it in C++.
// Also usable in the app's dev fallback worker (VITE_USE_MOCK=1).
// ----------------------------------------------------------------

import type { VolumeType } from '../types';

export interface MockFeature {
  id: number;
  name: string;
  color: [number, number, number];
}

export interface MockSliceFixture {
  layers: number;
  toolpathVertices: number; // per vertex: xyz (Float32)
  features: MockFeature[];
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
  /** Number of separately transformable instances exposed by getModelMesh. */
  instanceCount?: number;
  /** Number of composite render volumes in each mock instance. */
  volumeCount?: number;
  /** Simulate the shared-memory mailbox transport used by the pthread build. */
  threaded?: boolean;
}

export function createMockModule(opts: MockModuleOptions = {}): MockModule {
  const heap = opts.threaded ? new SharedArrayBuffer(HEAP_BYTES) : new ArrayBuffer(HEAP_BYTES);
  const HEAPU8 = new Uint8Array(heap);
  const HEAPU32 = new Uint32Array(heap);
  const HEAPF32 = new Float32Array(heap);
  const files = new Map<string, Uint8Array>();
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

  // ---- M4 preset fixtures (enriched bridge shape; Afinia is a hidden
  // "not installed" entry so the picker's grouping is testable) ----
  type PresetKind = 'printer' | 'print' | 'filament';
  const presetFixtures: Record<PresetKind, Array<{
    name: string; is_visible: boolean; is_default: boolean;
    vendor_id: string; model: string; variant: string;
  }>> = {
    printer: [
      { name: 'Bambu Lab X1 Carbon 0.4 nozzle', is_visible: true, is_default: false, vendor_id: 'bambulab', model: 'X1 Carbon', variant: '0.4' },
      { name: 'Bambu Lab P1S 0.4 nozzle', is_visible: true, is_default: false, vendor_id: 'bambulab', model: 'P1S', variant: '0.4' },
      { name: 'Afinia H+1(HS)', is_visible: false, is_default: false, vendor_id: 'afinia', model: 'H+1(HS)', variant: '0.4' },
    ],
    print: [
      { name: '0.20mm Standard @BBL X1C', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '' },
    ],
    filament: [
      { name: 'Bambu PLA Basic @BBL X1C', is_visible: true, is_default: false, vendor_id: 'bambulab', model: '', variant: '' },
      { name: 'Bambu PLA Matte @BBL X1C', is_visible: true, is_default: false, vendor_id: 'bambulab', model: '', variant: '' },
    ],
  };
  const selected: Record<PresetKind, string> = {
    printer: presetFixtures.printer[0].name,
    print: presetFixtures.print[0].name,
    filament: presetFixtures.filament[0].name,
  };

  const identityTransform = () => ({
    offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1],
  });
  const instanceCount = Math.max(1, Math.floor(opts.instanceCount ?? 1));
  const volumeCount = Math.max(1, Math.floor(opts.volumeCount ?? 1));
  const createObjectTransforms = () => Array.from({ length: instanceCount }, (_, index) => ({
    ...identityTransform(),
    // Keep mock instances visibly separate so selection tests can hit each
    // one without a model fixture that depends on the native build.
    offset: [index * 50, 0, 0],
  }));
  const createObjectVolumeTransforms = () => Array.from(
    { length: instanceCount },
    () => Array.from({ length: volumeCount }, () => identityTransform()),
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
  let objectMeta: Array<{ id: number; name: string; printable: boolean }> = [];
  let volumeMeta: Array<Array<{ id: number; name: string; type: VolumeType; isSplittable: boolean }>> = [];
  let instanceMeta: Array<Array<{ id: number; printable: boolean }>> = [];
  let modelLoaded = false;
  let sliced = false;
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

  // ---- the bridge functions ----
  const bridge: Record<string, (...args: any[]) => unknown> = {
    orc_init(_legacyPreferencesJson?: string) {
      return {
        ok: true,
        prints: presetFixtures.print.length,
        filaments: presetFixtures.filament.length,
        printers: presetFixtures.printer.length,
      };
    },
    orc_get_presets(kind: string) {
      const list = presetFixtures[kind as PresetKind] ?? [];
      return {
        presets: list.map((p) => ({ ...p, selected: p.name === selected[kind as PresetKind] })),
      };
    },
    orc_select_preset(kind: string, name: string) {
      const list = presetFixtures[kind as PresetKind];
      if (!list) return `kind must be print|filament|printer`;
      if (!list.some((p) => p.name === name)) return `preset not found: ${name}`;
      selected[kind as PresetKind] = name;
      const sel = (k: PresetKind) => ({
        name: selected[k],
        idx: presetFixtures[k].findIndex((p) => p.name === selected[k]),
      });
      return { ok: true, printer: sel('printer'), print: sel('print'), filament: sel('filament') };
    },
    orc_get_option_metadata() {
      const out: Record<string, { type: string; enum_values?: string[] }> = {};
      for (const [k, v] of Object.entries(metadata)) out[k] = { ...v };
      return out;
    },
    orc_add_model(_ptr: number, len: number, _ext: string) {
      if (len <= 0) return { error: 'no model bytes' };
      modelLoaded = true;
      objectTransforms.push(createObjectTransforms());
      objectVolumeTransforms.push(createObjectVolumeTransforms());
      objectMeta.push({ id: nextObjectId++, name: `Object ${objectTransforms.length}`, printable: true });
      volumeMeta.push(Array.from({ length: volumeCount }, (_, vi) => ({
        id: nextVolumeId++,
        name: `Part ${vi + 1}`,
        type: 'model_part' as VolumeType,
        isSplittable: vi === 0,
      })));
      instanceMeta.push(Array.from({ length: instanceCount }, (_, ii) => ({
        id: nextInstanceId++,
        printable: true,
      })));
      sliced = false;
      return { ok: true, objects: objectTransforms.length, instances: objectTransforms.length * instanceCount };
    },
    orc_clear_model() {
      objectTransforms = [];
      objectVolumeTransforms = [];
      objectMeta = [];
      volumeMeta = [];
      instanceMeta = [];
      modelLoaded = false;
      sliced = false;
      return { ok: true };
    },
    orc_delete_objects(indicesJson: string) {
      const indices = JSON.parse(indicesJson ?? '[]') as unknown;
      if (!Array.isArray(indices) || indices.length === 0) return { error: 'no object indices' };
      const toDelete: number[] = [];
      for (const item of indices) {
        if (!Number.isInteger(item)) return { error: 'object index must be an integer' };
        if (item < 0 || item >= objectTransforms.length) return { error: 'object index out of range' };
        if (!toDelete.includes(item)) toDelete.push(item);
      }
      // Descending order keeps earlier indices valid while the arrays shrink.
      toDelete.sort((a, b) => b - a);
      for (const idx of toDelete) {
        objectTransforms.splice(idx, 1);
        objectVolumeTransforms.splice(idx, 1);
        objectMeta.splice(idx, 1);
        volumeMeta.splice(idx, 1);
        instanceMeta.splice(idx, 1);
      }
      sliced = false;
      return { ok: true, objects: objectTransforms.length, deleted: toDelete.length };
    },
    orc_set_instance_offset(obj: number, inst: number, x: number, y: number, z: number) {
      if (obj < 0 || obj >= objectTransforms.length || inst < 0 || inst >= instanceCount) return { error: 'no such instance' };
      objectTransforms[obj][inst].offset = [x, y, z];
      return { ok: true };
    },
    orc_set_model_transform(obj: number, volume: number, inst: number, instanceJson: string, volumeJson: string) {
      if (obj < 0 || obj >= objectTransforms.length || volume < 0 || volume >= volumeCount || inst < 0 || inst >= instanceCount) return { error: 'no such composite id' };
      objectTransforms[obj][inst] = JSON.parse(instanceJson);
      objectVolumeTransforms[obj][inst][volume] = JSON.parse(volumeJson);
      return { ok: true };
    },
    orc_get_model_mesh() {
      if (!modelLoaded) return { error: 'no model loaded' };
      // 20 mm cube (8 verts, 12 tris) in LOCAL coordinates — the bridge
      // contract (bridge.cpp orc_get_model_mesh) reports the instance offset
      // separately, and the renderer applies it as the group position. (The
      // offset used to be baked into the vertices too, which double-offset
      // the cube after a committed move + reload; offset 0 hid it.)
      const verts = [
        [0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0],
        [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20],
      ];
      const tris = [
        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
      ];
      return {
        ok: true,
        // The client frees every returned pair of heap buffers, so each
        // composite must own distinct allocations even though the geometry
        // itself is identical.
        objects: objectTransforms.flatMap((instances, object_idx) => instances.flatMap((instanceTransform, instance_idx) =>
          Array.from({ length: volumeCount }, (_, volume_idx) => {
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
            volume_transform: objectVolumeTransforms[object_idx][instance_idx][volume_idx],
          };
          })),
        ),
      };
    },
    orc_get_model_structure() {
      return {
        ok: true,
        objects: objectTransforms.map((_instances, oi) => ({
          id: objectMeta[oi].id,
          index: oi,
          name: objectMeta[oi].name,
          printable: objectMeta[oi].printable,
          instanceCount,
          volumes: volumeMeta[oi].map((v, vi) => ({
            id: v.id,
            index: vi,
            name: v.name,
            type: v.type,
            isSplittable: v.isSplittable,
          })),
          instances: instanceMeta[oi].map((i, ii) => ({
            id: i.id,
            index: ii,
            printable: i.printable,
          })),
        })),
      };
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
      if (!modelLoaded) return { error: 'no model loaded' };
      // Drive progress 0..100 synchronously, exactly like the real bridge:
      // the callback's second arg is a const char* (malloc'd C string ptr),
      // matching the client's 'vij' wrapper which UTF8ToString()s it.
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
      return { ok: true, unrecognized_keys: [] };
    },
    orc_get_slice_result() {
      if (!sliced) return { error: 'no slice result' };
      const n = fixture.toolpathVertices;
      const vptr = malloc(n * 3 * 4);
      const lptr = malloc(n * 4);
      const fptr = malloc(n * 4);
      const vo = vptr / 4;
      const lo = lptr / 4;
      const fo = fptr / 4;
      for (let i = 0; i < n; i++) {
        const layer = Math.floor((i / n) * fixture.layers);
        HEAPF32.set([i % 200, (i * 3) % 200, layer * 0.2], vo + i * 3);
        HEAPU32[lo + i] = layer;
        HEAPU32[fo + i] = i % fixture.features.length;
      }
      return {
        ok: true,
        objects: objectTransforms.length,
        layers: fixture.layers,
        toolpath: {
          vertex_ptr: vptr, vertex_count: n,
          layer_ptr: lptr, layer_count: n,
          feature_ptr: fptr, feature_count: n,
          features: fixture.features,
        },
      };
    },
    orc_export_gcode() {
      const gcode = [
        '; mock gcode (unit-test fixture)',
        'G21', 'G90',
        'G1 X0 Y0 Z0.2 F1200',
        'G1 X20 Y0 E1.0',
        'M104 S0', '',
      ].join('\n');
      files.set('/out.gcode', new TextEncoder().encode(gcode));
      return { ok: true, path: '/out.gcode' };
    },
    orc_cancel() {
      return { ok: true };
    },
  };

  // ---- ccall dispatch with per-function signature conversion ----
  const SIGNATURES: Record<string, { ret: string; args: string[] }> = {
    orc_init: { ret: 'number', args: ['string'] },
    orc_select_preset: { ret: 'number', args: ['string', 'string'] },
    orc_get_presets: { ret: 'number', args: ['string'] },
    orc_get_option_metadata: { ret: 'number', args: [] },
    orc_add_model: { ret: 'number', args: ['pointer', 'number', 'string'] },
    orc_clear_model: { ret: 'number', args: [] },
    orc_delete_objects: { ret: 'number', args: ['string'] },
    orc_set_instance_offset: { ret: 'number', args: ['number', 'number', 'number', 'number', 'number'] },
    orc_set_model_transform: { ret: 'number', args: ['number', 'number', 'number', 'string', 'string'] },
    orc_get_model_mesh: { ret: 'number', args: [] },
    orc_get_model_structure: { ret: 'number', args: [] },
    orc_set_progress_callback: { ret: 'void', args: ['pointer'] },
    orc_get_threading_info: { ret: 'number', args: [] },
    orc_get_progress_mailbox: { ret: 'number', args: [] },
    orc_slice: { ret: 'number', args: ['string'] },
    orc_get_slice_result: { ret: 'number', args: [] },
    orc_export_gcode: { ret: 'number', args: [] },
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
