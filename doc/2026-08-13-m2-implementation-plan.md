# M2 Implementation Plan: Electron Vertical Slice

Date: 2026-08-13
Status: Approved (writing-plans session, 2026-08-13)
Scope: Milestone 2 (Electron Vertical Slice, design Phases C–E) of
[`spec/Grand Plan.md`](../spec/Grand%20Plan.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The v1 user flow works end to end in the Electron app: load STL/3MF → configure → slice → 3D preview (toolpath + layer scrubber) → export G-code — with the WASM module running in a Web Worker behind a typed client.

**Architecture:** The renderer never touches the WASM module. A typed promise-based client (`packages/slicer-wasm/src/client`) marshals JSON + binary buffers across the wasm heap; a Vite-bundled Web Worker (app-owned entry, package-owned logic) is the only place the module is imported. The Electron main process gains native dialogs + COOP/COEP session headers; the renderer gets zustand stores, a metadata-driven settings panel (shadcn/ui), and a react-three-fiber viewport. Binary slice results (toolpath) are produced by new bridge functions in `bridge.cpp`, laid out so the client's unit tests (against a mock Emscripten module, no emsdk) pin the contract before the C++ exists.

**Tech Stack:** Electron 34 + electron-vite, React 18 + TypeScript 5, Tailwind + shadcn/ui (radix), zustand, three 0.160 + @react-three/fiber 8 + drei 9, vitest 2, Emscripten wasm64 module (built in M1).

**Spec:** [`doc/2026-08-12-electron-gui-rewrite-design.md`](../doc/2026-08-12-electron-gui-rewrite-design.md) (approved), Phases C–E; `doc/high_level_dev_plan.md` Epics 2.1–2.5; `spec/Grand Plan.md` Milestone 2.

## Global Constraints

Copied verbatim from the approved design and the roadmap docs — every task's requirements implicitly include these:

- **Bridge is the only seam**: renderer code never imports the WASM module directly; it goes through `packages/slicer-wasm/src/client`. Binary buffers cross via the heap (`_malloc`/`_free` + HEAPU8) and transferables — never JSON.
- **Submodule is read-only**: `packages/slicer-wasm/cpp/` → `Noisyfox/OrcaSlicer` pinned at `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`. Changes only via `packages/slicer-wasm/patches/*.patch`; never ad-hoc edits.
- **wasm64 consistency**: heap pointers cross the ccall boundary as BigInt — the client uses `'pointer'` arg types and `Number()`-casts (documented in `harness/bridge-smoke.mjs`; do not "fix").
- **Serial-first**: no pthreads in v1; parallelism is Milestone 4.
- **Bridge rules**: extern "C", JSON-in/JSON-out, synchronous on the worker thread; malloc'd C-string returns the JS side frees. All slice work on the worker; the UI thread never blocks.
- **Stale-callback discipline**: `g_progress` in the bridge is a raw fn ptr with no orc_* clear path. The worker registers the progress callback ONCE at init and never calls `removeFunction` on it (a stale index into a nulled table slot makes the next `process()` trap — uncatchable, module dies). Clear via `orc_set_progress_callback(0)` before any `removeFunction`.
- **Docs-first**: dated engineering notes in `doc/` (`YYYY-MM-DD-topic.md`); keep `spec/Grand Plan.md` + `doc/high_level_dev_plan.md` in sync with work.
- **Naming**: bridge functions `orc_*`; module name `orca_slice`; output dir `packages/slicer-wasm/out/`; client files under `packages/slicer-wasm/src/client/`; worker entry in `apps/desktop/src/renderer/src/slicer/`; UI components in `apps/desktop/src/renderer/src/components/`.
- **Pinned-SHA API drift** (documented in the M0/M1 plan + `bridge.cpp` comments): option keys are the post-rename names (`nozzle_temperature`, `wall_loops`, `top_shell_layers`, `sparse_infill_pattern`, `layer_change_gcode`, `machine_start_gcode`…); the metadata global is `print_config_def`; `SlicingStatus` is `PrintBase::SlicingStatus`; `validate()` returns `StringObjectException` (use `.string`). Ground truth is `orc_get_option_metadata()` — never hard-code a key without checking it there.
- **Dependency pins**: three `0.160.x`, `@react-three/fiber ^8.15`, `@react-three/drei ^9.99` (React-18 line), `zustand ^4`, `vitest ^2.1` (vite-5 compatible), tailwindcss `^3.4` (not v4), radix `^1.1` (`@radix-ui/react-select`, `@radix-ui/react-slider`, `@radix-ui/react-dialog`), `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`.
- **Mock-module pattern**: unit tests run against `packages/slicer-wasm/src/client/testing/mock-module.ts` (bridge-shaped, no emsdk, no node_modules wasm). The same mock drives the app's dev fallback when the real module isn't staged.
- **App dev without emsdk**: the real `.wasm` needs the ~50 GB M1 build. `stage:wasm` copies `out/orca_slice.{js,wasm}` into the renderer's public dir; when absent, the worker loads the mock module (env `VITE_USE_MOCK=1`) so UI work proceeds without emsdk.
- **WASM build is iterative**: bridge-buffer layout is the M2 iterate surface; `bridge-smoke.mjs` + client unit tests are the test.
- **Licensing**: AGPL-3.0 throughout (root `LICENSE` is a Milestone 3 task).

---

### Task 1: Test infra (vitest) + bridge-shaped mock module

The client's unit tests must run with no emsdk and no built module. This task
creates the vitest rig in both packages and the mock Emscripten module the
tests (and the app's dev fallback) drive. The mock implements the full bridge
contract — including the M2 binary-buffer functions defined here, which
`bridge.cpp` implements for real in Task 7. **The mock IS the contract spec.**

**Files:**
- Create: `packages/slicer-wasm/vitest.config.ts`, `packages/slicer-wasm/src/client/testing/mock-module.ts`
- Create: `apps/desktop/vitest.config.ts`, `apps/desktop/src/renderer/src/slicer/testing/setup.ts`
- Modify: `packages/slicer-wasm/package.json` (scripts `test`), `apps/desktop/package.json` (scripts `test`), `package.json` (root script `test`), `pnpm-workspace.yaml` (no change), `.gitignore` (no change)

**Interfaces:**
- Produces: `createMockModule(opts)` → a promise-based object whose shape mirrors the Emscripten MODULARIZE+EXPORT_ES6 factory (`Module`-like: `ccall`, `UTF8ToString`, `_malloc`, `_free`, `HEAPU8`/`HEAP32`/`HEAPF32`/`HEAPU32`, `addFunction`, `removeFunction`, `FS`). Tasks 2–3 unit-test the client against it; Task 6's dev fallback loads it in the worker.
- **The bridge contract the mock implements** (JSON-in/JSON-out via malloc'd C strings, binary via heap; client `callJson` mirrors `bridge-smoke.mjs`):
  - `orc_init()` → `{ok, prints, filaments, printers}`
  - `orc_get_presets(kind)` → `{presets: [{name}]}`
  - `orc_get_option_metadata()` → `{key: {type, label?, enum_values?, min?, max?, default?}}`
  - `orc_load_model(ptr, len, ext)` → `{ok, objects, instances}`
  - `orc_set_instance_offset(object_idx, instance_idx, x, y, z)` → `{ok}` *(new in M2)*
  - `orc_get_model_mesh()` → `{ok, objects: [{object_idx, vertex_ptr, vertex_count, index_ptr, index_count, offset:[x,y,z]}]}` — heap `Float32` xyz triplets + `Uint32` triangle index triples *(new in M2)*
  - `orc_set_progress_callback(cb_ptr)` → void
  - `orc_slice(config_json)` → `{ok, unrecognized_keys: []}`
  - `orc_get_slice_result()` → `{ok, objects, layers, toolpath: {vertex_ptr, vertex_count, layer_ptr, layer_count, feature_ptr, feature_count, features: [{id, name, color:[r,g,b]}]}, mesh: {vertex_ptr, vertex_count, index_ptr, index_count, layer_ptr, layer_count}}` — toolpath per-vertex `Float32` xyz + per-vertex `Uint32` layer_id + per-vertex `Uint32` feature palette index; mesh `Float32` xyz + `Uint32` triangle index triples + per-triangle `Uint32` layer_id *(new in M2; replaces the M1 JSON-stats-only return — keep `objects`/`layers` keys)*
  - `orc_export_gcode()` → `{ok, path}` (writes `/out.gcode` in FS)
  - `orc_cancel()` → `{ok}`
- Produces: vitest available in both packages (`pnpm --filter <pkg> test`), root `pnpm test` runs both.

- [ ] **Step 1: Add vitest to `packages/slicer-wasm/package.json`**

```json
"scripts": {
  "typecheck": "tsc --noEmit -p tsconfig.json",
  "test": "vitest run"
},
"devDependencies": {
  "typescript": "^5.5.0",
  "vitest": "^2.1.9"
}
```

- [ ] **Step 2: Write `packages/slicer-wasm/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Write the mock module**

The heap model: a 64 MB `ArrayBuffer` with Emscripten-style views. `_malloc`
bump-allocates (aligned); `_free` records the pointer for leak checks in
tests. `ccall` dispatches by name over the registered bridge functions,
converting args per a per-function signature table (mirroring
`bridge-smoke.mjs`'s `'pointer'`/`'number'`/`'string'` rules — wasm64 BigInt
is the real module's concern; the mock accepts Numbers throughout and the
client's `Number()`-casts work against both).

```ts
// packages/slicer-wasm/src/client/testing/mock-module.ts
// ----------------------------------------------------------------
// Bridge-shaped mock Emscripten module for unit tests (no emsdk).
// Implements the ORC bridge contract exactly as bridge.cpp does for
// real (see doc/2026-08-13-m2-implementation-plan.md Task 1) — the
// client's tests pin this contract; Task 7 implements it in C++.
// Also usable in the app's dev fallback worker (VITE_USE_MOCK=1).
// ----------------------------------------------------------------

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
}

export interface MockModuleOptions {
  sliceFixture?: MockSliceFixture;
  metadataKeys?: Record<string, { type: string; enum_values?: string[] }>;
  printErr?: (msg: string) => void;
}

export function createMockModule(opts: MockModuleOptions = {}): MockModule {
  const heap = new ArrayBuffer(HEAP_BYTES);
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

  const modelState = { objects: 1, instances: 1, offset: [0, 0, 0] as number[] };
  let modelLoaded = false;
  let sliced = false;
  let progressCallback = 0;
  const functionTable = new Map<number, (...args: unknown[]) => void>();
  let nextFunctionIndex = 1000;

  // ---- the bridge functions ----
  const bridge: Record<string, (...args: unknown[]) => unknown> = {
    orc_init() {
      return { ok: true, prints: 1, filaments: 2, printers: 3 };
    },
    orc_get_presets(kind: string) {
      const byKind: Record<string, string[]> = {
        printer: ['Bambu Lab X1 Carbon 0.4 nozzle', 'Bambu Lab P1S 0.4 nozzle'],
        print: ['0.20mm Standard @BBL X1C'],
        filament: ['Bambu PLA Basic @BBL X1C', 'Bambu PLA Matte @BBL X1C'],
      };
      return { presets: (byKind[kind] ?? []).map((name) => ({ name })) };
    },
    orc_get_option_metadata() {
      const out: Record<string, { type: string; enum_values?: string[] }> = {};
      for (const [k, v] of Object.entries(metadata)) out[k] = { ...v };
      return out;
    },
    orc_load_model(_ptr: number, len: number, _ext: string) {
      if (len <= 0) return { error: 'no model bytes' };
      modelLoaded = true;
      return { ok: true, objects: modelState.objects, instances: modelState.instances };
    },
    orc_set_instance_offset(obj: number, inst: number, x: number, y: number, z: number) {
      if (obj !== 0 || inst !== 0) return { error: 'no such instance' };
      modelState.offset = [x, y, z];
      return { ok: true };
    },
    orc_get_model_mesh() {
      if (!modelLoaded) return { error: 'no model loaded' };
      // 20 mm cube (8 verts, 12 tris) at the instance offset.
      const off = modelState.offset;
      const verts = [
        [0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0],
        [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20],
      ].map((v) => [v[0] + off[0], v[1] + off[1], v[2] + off[2]]);
      const tris = [
        [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
      ];
      const vptr = malloc(verts.length * 3 * 4);
      const iptr = malloc(tris.length * 3 * 4);
      const vo = vptr / 4;
      const io = iptr / 4;
      verts.forEach((v, i) => HEAPF32.set(v, vo + i * 3));
      tris.forEach((t, i) => HEAPU32.set(t, io + i * 3));
      return {
        ok: true,
        objects: [{
          object_idx: 0,
          vertex_ptr: vptr,
          vertex_count: verts.length,
          index_ptr: iptr,
          index_count: tris.length * 3,
          offset: off,
        }],
      };
    },
    orc_set_progress_callback(ptr: number) {
      progressCallback = ptr;
    },
    orc_slice(_config: string) {
      if (!modelLoaded) return { error: 'no model loaded' };
      // Drive progress 0..100 synchronously, exactly like the real bridge:
      // the callback's second arg is a const char* (malloc'd C string ptr),
      // matching the client's 'vij' wrapper which UTF8ToString()s it.
      for (let pct = 0; pct <= 100; pct += 25) {
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
      const m = 36; // mesh verts = 12 tris x 3 (triangle soup, one vertex set per tri)
      const t = 12; // triangles
      const mvptr = malloc(m * 3 * 4);
      const miptr = malloc(t * 3 * 4);
      const mlptr = malloc(t * 4);
      for (let i = 0; i < n; i++) {
        const layer = Math.floor((i / n) * fixture.layers);
        HEAPF32.set([i % 200, (i * 3) % 200, layer * 0.2], vo + i * 3);
        HEAPU32[lo + i] = layer;
        HEAPU32[fo + i] = i % fixture.features.length;
      }
      for (let i = 0; i < t; i++) {
        const layer = Math.floor((i / t) * fixture.layers);
        HEAPU32[mlptr / 4 + i] = layer;
        const base = miptr / 4 + i * 3;
        HEAPU32[base] = i * 3; HEAPU32[base + 1] = i * 3 + 1; HEAPU32[base + 2] = i * 3 + 2;
        const o = mvptr / 4 + i * 3 * 3;
        HEAPF32.set([(i * 5) % 200, (i * 7) % 200, layer * 0.2], o);
      }
      return {
        ok: true,
        objects: modelState.objects,
        layers: fixture.layers,
        toolpath: {
          vertex_ptr: vptr, vertex_count: n,
          layer_ptr: lptr, layer_count: n,
          feature_ptr: fptr, feature_count: n,
          features: fixture.features,
        },
        mesh: {
          vertex_ptr: mvptr, vertex_count: m,
          index_ptr: miptr, index_count: t * 3,
          layer_ptr: mlptr, layer_count: t,
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
    orc_init: { ret: 'number', args: [] },
    orc_get_presets: { ret: 'number', args: ['string'] },
    orc_get_option_metadata: { ret: 'number', args: [] },
    orc_load_model: { ret: 'number', args: ['pointer', 'number', 'string'] },
    orc_set_instance_offset: { ret: 'number', args: ['number', 'number', 'number', 'number', 'number'] },
    orc_get_model_mesh: { ret: 'number', args: [] },
    orc_set_progress_callback: { ret: 'void', args: ['pointer'] },
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
  };
}
```

- [ ] **Step 4: Write `apps/desktop/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname is undefined in ESM configs — derive the client package root
// from the config file's own URL (apps/desktop/ → ../../packages/...).
const clientRoot = fileURLToPath(new URL('../../packages/slicer-wasm/src/client', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // same aliases as electron.vite.config.ts (Task 4)
      '@slicer/client': resolve(clientRoot, 'index.ts'),
      '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
    },
  },
  test: {
    include: ['src/renderer/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
```

- [ ] **Step 5: Add `test` scripts**

`apps/desktop/package.json` scripts: add `"test": "vitest run"`. Root
`package.json` scripts: add `"test": "pnpm -r test"`.

- [ ] **Step 6: Install + verify**

Run: `pnpm install && pnpm --filter slicer-wasm typecheck && pnpm --filter desktop typecheck`
Expected: exit 0 (the mock module typechecks in both packages).

- [ ] **Step 7: Commit**

```bash
git add packages/slicer-wasm/vitest.config.ts packages/slicer-wasm/src/client/testing/mock-module.ts packages/slicer-wasm/package.json apps/desktop/vitest.config.ts apps/desktop/package.json package.json pnpm-lock.yaml
git commit -m "test: vitest rig + bridge-shaped mock module (M2 contract spec)"
```

---

### Task 2: Typed client core (`packages/slicer-wasm/src/client`)

The promise-based API over the bridge: `loadModel`, `getPresets`,
`getOptionMetadata`, `setInstanceOffset`, `getModelMesh`, `slice`,
`getSliceResult`, `exportGcode`, `cancel` — plus heap marshaling helpers and
binary-buffer extraction to transferable `ArrayBuffer`s. Unit tests pin the
contract against the mock (Task 1).

**Files:**
- Create: `packages/slicer-wasm/src/client/types.ts`, `packages/slicer-wasm/src/client/heap.ts`, `packages/slicer-wasm/src/client/client.ts`, `packages/slicer-wasm/src/client/client.test.ts`
- Modify: `packages/slicer-wasm/src/client/index.ts` (re-export)

**Interfaces:**
- Consumes: `createMockModule` (Task 1). The module surface: `ccall(name, ret, argTypes, args)`, `UTF8ToString(ptr)`, `_malloc(size)`, `_free(ptr)`, `HEAPU8`/`HEAPU32`/`HEAPF32`, `addFunction`, `FS`.
- Produces: `type OrcaModule` (structural module type), `type OrcaModuleFactory = (opts: { noInitialRun?: boolean; print?: (s: string) => void; printErr?: (s: string) => void }) => Promise<OrcaModule>`; `class SlicerClient` with the API above; `heapMarshaling` helpers (`writeBytes`, `readBytes`, `readF32`, `readU32`, `callJson`); `ClientSliceResult`/`ClientModelMesh`/`ClientToolpath` types. Task 3's worker wraps `SlicerClient`; Task 5's stores consume the types.

- [ ] **Step 1: Write the failing tests (contract pin)**

```ts
// packages/slicer-wasm/src/client/client.test.ts
import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createClient } from './client';

function makeClient() {
  return createClient(createMockModule());
}

describe('SlicerClient bridge contract', () => {
  it('init loads preset collections', async () => {
    const c = makeClient();
    const r = await c.init();
    expect(r.ok).toBe(true);
    expect(r.printers).toBeGreaterThan(0);
  });

  it('getPresets lists names per kind', async () => {
    const c = makeClient();
    const p = await c.getPresets('printer');
    expect(p.presets.length).toBeGreaterThan(0);
    expect(p.presets[0]).toHaveProperty('name');
  });

  it('getOptionMetadata exposes typed keys', async () => {
    const c = makeClient();
    const m = await c.getOptionMetadata();
    expect(m.layer_height?.type).toBe('float');
    expect(m.sparse_infill_pattern?.enum_values).toContain('grid');
  });

  it('loadModel stages bytes and reports objects', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await c.loadModel(bytes, 'stl');
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(1);
  });

  it('setInstanceOffset round-trips x/y', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await c.loadModel(bytes, 'stl');
    const r = await c.setInstanceOffset(0, 0, 10, 20, 0);
    expect(r.ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].offset[0]).toBe(10);
    expect(mesh.objects[0].offset[1]).toBe(20);
  });

  it('getModelMesh extracts vertices and indices, frees the heap', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].vertexCount).toBe(8);
    expect(mesh.objects[0].indexCount).toBe(36);
    expect(mesh.objects[0].positions.byteLength).toBe(8 * 3 * 4);
    expect(mesh.objects[0].indices.byteLength).toBe(36 * 4);
    expect(mesh.objects[0].indices[0]).toBe(0);
  });

  it('slice fires progress and returns unrecognized_keys', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const r = await c.slice({ layer_height: '0.2' }, (pct) => events.push(pct));
    expect(r.ok).toBe(true);
    expect(r.unrecognized_keys).toEqual([]);
    expect(events).toContain(0);
    expect(events).toContain(100);
  });

  it('getSliceResult extracts toolpath + mesh buffers with layer ranges', async () => {
    const c = makeClient();
    await c.loadModel(new Uint8Array(4), 'stl');
    await c.slice({}, () => {});
    const r = await c.getSliceResult();
    expect(r.layers).toBe(40);
    expect(r.toolpath.vertexCount).toBe(2400);
    expect(r.toolpath.positions.byteLength).toBe(2400 * 3 * 4);
    expect(r.toolpath.features.length).toBeGreaterThanOrEqual(2);
    expect(r.mesh.vertexCount).toBeGreaterThan(0);
    expect(r.mesh.indexCount).toBe(36);
    // every triangle index < vertex count
    const maxIdx = Math.max(...Array.from(r.mesh.indices));
    expect(maxIdx).toBeLessThan(r.mesh.vertexCount);
  });

  it('exportGcode returns the MEMFS bytes', async () => {
    const c = makeClient();
    const r = await c.exportGcode();
    expect(r.ok).toBe(true);
    expect(new TextDecoder().decode(r.bytes.slice(0, 6))).toBe('; mock');
  });

  it('cancel is safe', async () => {
    const c = makeClient();
    const r = await c.cancel();
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter slicer-wasm test`
Expected: FAIL — `createClient` not exported.

- [ ] **Step 3: Write `types.ts`**

```ts
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

export interface ClientSliceResult {
  ok: boolean;
  objects: number;
  layers: number;
  toolpath: ClientToolpath;
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
```

- [ ] **Step 4: Write `heap.ts`**

```ts
// packages/slicer-wasm/src/client/heap.ts
// ----------------------------------------------------------------
// Heap marshaling: strings in, bytes in, typed arrays out. All
// bridge returns are malloc'd C strings (or binary buffers on the
// heap); the JS side always _free()s what it allocates or reads.
// wasm64: pointer-bearing ccall args use 'pointer' and are
// Number()-cast on the way back (see harness/bridge-smoke.mjs).
// ----------------------------------------------------------------
import type { OrcaModule } from './types';

export function writeBytes(module: OrcaModule, bytes: Uint8Array): number {
  const ptr = Number(module._malloc(bytes.length));
  module.HEAPU8.set(bytes, ptr);
  return ptr;
}

/** Read a malloc'd JSON C string; frees it. */
export function readJsonString(module: OrcaModule, ptr: number): unknown {
  try {
    return JSON.parse(module.UTF8ToString(ptr));
  } finally {
    module._free(ptr);
  }
}

/** Copy [ptr, ptr+len) out of the heap into a fresh ArrayBuffer-backed array. */
export function readBytes(module: OrcaModule, ptr: number, len: number): Uint8Array {
  try {
    return module.HEAPU8.slice(ptr, ptr + len);
  } finally {
    module._free(ptr);
  }
}

/** The Emscripten-6 / wasm64 ccall convention used across the harness. */
export function callJson(
  module: OrcaModule,
  name: string,
  argTypes: string[],
  args: unknown[],
): unknown {
  const ptr = Number(module.ccall(name, 'number', argTypes, args));
  return readJsonString(module, ptr);
}
```

- [ ] **Step 5: Write `client.ts`**

```ts
// packages/slicer-wasm/src/client/client.ts
// ----------------------------------------------------------------
// The typed promise-based bridge client — the ONLY JS that talks to
// the WASM module (design §Bridge API). Synchronous bridge calls run
// inside the worker; every function returns a promise so the API is
// uniform when wrapped by worker messaging (Task 3).
// ----------------------------------------------------------------
import type {
  OrcaModule, OrcaModuleFactory, SlicerClient,
  InitResult, PresetList, OptionMetadata, LoadModelResult,
  ModelMeshResult, SliceResultStatus, ClientSliceResult,
  ExportGcodeResult, CancelResult, ModelObjectBuffer,
  ClientToolpath, ToolpathFeature,
} from './types';
import { writeBytes, callJson, readBytes } from './heap';

export function createClient(
  moduleFactory: OrcaModuleFactory,
  onBridgeProgress?: (percent: number, text: string) => void,
): SlicerClient {
  let modulePromise: Promise<OrcaModule> | null = null;
  const progressListeners = new Set<(percent: number, text: string) => void>();

  async function module(): Promise<OrcaModule> {
    if (!modulePromise) {
      modulePromise = moduleFactory({ noInitialRun: true }).then((m) => {
        // Register the progress callback ONCE at module init and NEVER
        // removeFunction it (stale-slot trap discipline, bridge-smoke Fix
        // round 1): the bridge's g_progress is a raw fn ptr with no orc_*
        // clear path; a removed slot re-used by a later slice traps the
        // whole module. The bridge calls it only while slicing; the sink
        // (the worker's progress-message post) lets the bridge-level stream
        // escape this module.
        const cb = m.addFunction((pct: number, text: number) => {
          const msg = m.UTF8ToString(Number(text));
          for (const l of progressListeners) l(Number(pct), msg);
          onBridgeProgress?.(Number(pct), msg);
        }, 'vij');
        m.ccall('orc_set_progress_callback', null, ['pointer'], [cb]);
        return m;
      });
    }
    return modulePromise;
  }

  return {
    async init(): Promise<InitResult> {
      const m = await module();
      return callJson(m, 'orc_init', [], []) as InitResult;
    },

    async getPresets(kind: 'printer' | 'print' | 'filament'): Promise<PresetList> {
      const m = await module();
      return callJson(m, 'orc_get_presets', ['string'], [kind]) as PresetList;
    },

    async getOptionMetadata(): Promise<OptionMetadata> {
      const m = await module();
      return callJson(m, 'orc_get_option_metadata', [], []) as OptionMetadata;
    },

    async loadModel(bytes: Uint8Array, ext: string): Promise<LoadModelResult> {
      const m = await module();
      const ptr = writeBytes(m, bytes);
      try {
        return callJson(m, 'orc_load_model', ['pointer', 'number', 'string'],
                        [ptr, bytes.length, ext]) as LoadModelResult;
      } finally {
        m._free(ptr);
      }
    },

    async setInstanceOffset(objIdx: number, instIdx: number, x: number, y: number, z: number) {
      const m = await module();
      return callJson(m, 'orc_set_instance_offset',
                      ['number', 'number', 'number', 'number', 'number'],
                      [objIdx, instIdx, x, y, z]) as { ok: boolean; error?: string };
    },

    async getModelMesh(): Promise<ModelMeshResult> {
      const m = await module();
      const r = callJson(m, 'orc_get_model_mesh', [], []) as {
        ok: boolean; error?: string; objects?: Array<{
          object_idx: number; vertex_ptr: number; vertex_count: number;
          index_ptr: number; index_count: number; offset: number[];
        }>;
      };
      if (!r.ok || !r.objects) return r as ModelMeshResult;
      const objects: ModelObjectBuffer[] = r.objects.map((o) => {
        const positions = new Float32Array(readBytes(m, Number(o.vertex_ptr), o.vertex_count * 3 * 4).buffer);
        const indices = new Uint32Array(readBytes(m, Number(o.index_ptr), o.index_count * 4).buffer);
        return {
          objectIdx: o.object_idx,
          positions, vertexCount: o.vertex_count,
          indices, indexCount: o.index_count,
          offset: [o.offset[0], o.offset[1], o.offset[2]] as [number, number, number],
        };
      });
      return { ok: true, objects };
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
      if (!r.ok || !r.toolpath) return r as ClientSliceResult;

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

    async cancel(): Promise<CancelResult> {
      const m = await module();
      return callJson(m, 'orc_cancel', [], []) as CancelResult;
    },
  };
}
```

- [ ] **Step 6: Update `index.ts`**

```ts
// packages/slicer-wasm/src/client/index.ts
export { createClient } from './client';
export type {
  SlicerClient, OrcaModule, OrcaModuleFactory,
  InitResult, PresetList, OptionMetadata, OptionMeta,
  LoadModelResult, ModelMeshResult, ModelObjectBuffer,
  SliceResultStatus, ClientSliceResult, ClientToolpath,
  ToolpathFeature, ExportGcodeResult, CancelResult,
} from './types';
export { createMockModule } from './testing/mock-module';
export type { MockModule, MockModuleOptions, MockSliceFixture } from './testing/mock-module';
export const CLIENT_VERSION = '0.1.0-m2';
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter slicer-wasm test`
Expected: 10 PASS. The mock's `_free` calls are exercised (heap.ts frees every read); `_freedPointers` grows — assert nothing here, the leak assertion arrives in Task 3's worker tests.

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm --filter slicer-wasm typecheck`
Expected: exit 0.

```bash
git add packages/slicer-wasm/src/client
git commit -m "feat: typed slicer client (loadModel/slice/getSliceResult/exportGcode/cancel + heap marshaling), contract tests vs mock"
```

---

### Task 3: Web Worker glue (message protocol + worker entry)

The worker is the only place the module is imported. App-side entry
(`apps/desktop`) is a thin re-export that Vite bundles as a module worker;
all logic lives in the client package so it is unit-testable without a
browser. Messages are `{id, op, args}` → `{id, ok, result}`; binary buffers
(transferables) are passed through `postMessage`'s transfer list.

**Files:**
- Create: `packages/slicer-wasm/src/client/worker.ts`, `packages/slicer-wasm/src/client/worker.test.ts`
- Create: `apps/desktop/src/renderer/src/slicer/slicer.worker.ts` (app entry)

**Interfaces:**
- Consumes: `SlicerClient` (Task 2); `OrcaModuleFactory` (Task 2) — the worker must resolve a factory from a runtime-known URL (real module staged at `/wasm/orca_slice.js`, or the mock when `VITE_USE_MOCK=1`).
- Produces: `startWorker(moduleFactory)` — sets `self.onmessage`; protocol `{type:'request', id, op, args}` / `{type:'response', id, ok, result}` / `{type:'progress', percent, text}` (progress events emitted as bare messages with no id). `createWorkerClient(factory)` — a `SlicerClient`-shaped object that posts requests to the worker and resolves on the matching id. The app's `slicer.worker.ts` imports `startWorker` and resolves the factory from `import.meta.env`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/slicer-wasm/src/client/worker.test.ts
import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';

// A transport that runs the worker side in-process (same-thread) so the
// protocol is testable without a real Worker. The real worker entry uses
// postMessage; here a Channel fans every message out to both sides
// (createWorkerClient's response handler + startWorker's request handler).
class Channel implements WorkerTransport {
  private listeners: ((msg: WorkerMessage) => void)[] = [];
  onMessage(fn: (msg: WorkerMessage) => void): void {
    this.listeners.push(fn);
  }
  post(msg: WorkerMessage): void {
    for (const l of this.listeners) l(msg);
  }
}

function setup() {
  const module = createMockModule();
  const channel = new Channel();
  const workerClient = createWorkerClient(channel);
  void startWorker(async () => module, (msg) => channel.post(msg), (fn) => channel.onMessage(fn));
  return { workerClient, module };
}

describe('worker protocol', () => {
  it('round-trips init through the message channel', async () => {
    const { workerClient } = setup();
    const r = await workerClient.init();
    expect(r.ok).toBe(true);
  });

  it('loads a model and slices with progress events', async () => {
    const { workerClient } = setup();
    await workerClient.init();
    await workerClient.loadModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const r = await workerClient.slice({ layer_height: '0.2' }, (pct) => events.push(pct));
    expect(r.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it('returns binary slice buffers as transferable-arrayable views', async () => {
    const { workerClient } = setup();
    await workerClient.init();
    await workerClient.loadModel(new Uint8Array(4), 'stl');
    await workerClient.slice({}, () => {});
    const res = await workerClient.getSliceResult();
    expect(res.toolpath.vertexCount).toBeGreaterThan(0);
    expect(res.toolpath.positions.byteLength).toBe(res.toolpath.vertexCount * 3 * 4);
  });

  it('rejects on missing op', async () => {
    const { workerClient } = setup();
    await expect(workerClient.nope()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter slicer-wasm test`
Expected: FAIL — `./worker` has no exports.

- [ ] **Step 3: Write `worker.ts`**

```ts
// packages/slicer-wasm/src/client/worker.ts
// ----------------------------------------------------------------
// Web Worker glue. startWorker() installs the message handler in a
// worker context (self); createWorkerClient() drives it from the
// main thread. All bridge work happens on the worker thread; binary
// buffers travel as transferable ArrayBuffers.
//
// Protocol:
//   main → worker: {type:'request', id, op, args}
//   worker → main: {type:'response', id, ok, result}
//   worker → main: {type:'progress', percent, text}   (no id)
// ----------------------------------------------------------------
import type { SlicerClient, OrcaModuleFactory } from './types';
import { createClient } from './client';

export type WorkerMessage =
  | { type: 'request'; id: number; op: string; args: unknown[] }
  | { type: 'response'; id: number; ok: boolean; result: unknown; error?: string }
  | { type: 'progress'; percent: number; text: string };

export interface WorkerTransport {
  post(msg: WorkerMessage): void;
  onMessage(fn: (msg: WorkerMessage) => void): void;
}

export function startWorker(
  moduleFactory: OrcaModuleFactory,
  post: (msg: WorkerMessage) => void = (msg) => (self as unknown as { postMessage(m: WorkerMessage): void }).postMessage(msg),
  onMessage: (fn: (msg: WorkerMessage) => void) => void = (fn) => {
    (self as unknown as { onmessage: (e: MessageEvent<WorkerMessage>) => void }).onmessage = (e) => fn(e.data);
  },
): void {
  // The client registers the bridge's progress callback ONCE at module init
  // and never removeFunction's it (stale-slot trap discipline, bridge-smoke
  // Fix round 1); its sink forwards every event here as {type:'progress'}.
  const client = createClient(moduleFactory, (pct, text) => {
    post({ type: 'progress', percent: pct, text });
  });

  onMessage(async (msg) => {
    if (msg.type !== 'request') return;
    const { id, op, args } = msg;
    try {
      const method = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[op];
      if (typeof method !== 'function') throw new Error(`unknown op: ${op}`);
      const result = await method(...(args ?? []));
      post({ type: 'response', id, ok: true, result });
    } catch (err) {
      post({ type: 'response', id, ok: false, error: String(err) });
    }
  });
}

export function createWorkerClient(transport: WorkerTransport): SlicerClient {
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  const progressListeners = new Set<(pct: number, text: string) => void>();

  transport.onMessage((msg) => {
    if (msg.type === 'progress') {
      for (const l of progressListeners) l(msg.percent, msg.text);
      return;
    }
    if (msg.type !== 'response') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'worker error'));
  });

  function call(op: string, args: unknown[]): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      transport.post({ type: 'request', id, op, args });
    });
  }

  return {
    init: () => call('init', []) as Promise<{ ok: boolean; prints: number; filaments: number; printers: number }>,
    getPresets: (kind) => call('getPresets', [kind]) as Promise<{ presets: { name: string }[] }>,
    getOptionMetadata: () => call('getOptionMetadata', []) as Promise<Record<string, unknown>>,
    loadModel: (bytes, ext) => {
      // bytes are Uint8Array; structured-cloned across postMessage fine.
      return call('loadModel', [bytes, ext]) as Promise<{ ok: boolean; objects: number; instances: number }>;
    },
    setInstanceOffset: (obj, inst, x, y, z) =>
      call('setInstanceOffset', [obj, inst, x, y, z]) as Promise<{ ok: boolean }>,
    getModelMesh: () => call('getModelMesh', []) as Promise<unknown>,
    slice: (config, onProgress) => {
      // Progress events arrive as bare {type:'progress'} messages (the
      // worker's persistent callback); subscribing here routes them to the
      // caller, keyed to the in-flight slice by add/delete.
      if (!onProgress) return call('slice', [config]) as Promise<{ ok: boolean; unrecognized_keys: string[] }>;
      progressListeners.add(onProgress);
      return call('slice', [config]).finally(() => progressListeners.delete(onProgress)) as Promise<{ ok: boolean; unrecognized_keys: string[] }>;
    },
    getSliceResult: () => call('getSliceResult', []) as Promise<unknown>,
    exportGcode: () => call('exportGcode', []) as Promise<unknown>,
    cancel: () => call('cancel', []) as Promise<{ ok: boolean }>,
  } as SlicerClient;
}
```

> **Note on the mock vs real module in tests:** `startWorker` in the tests is
> given the mock factory; in the app (Task 6) it gets the real factory or the
> mock fallback. Progress flows bridge callback → client's init-time
> registration → `onBridgeProgress` sink → `{type:'progress'}` messages on
> the transport; `createWorkerClient.slice` subscribes a listener that
> forwards to the caller's callback.

- [ ] **Step 4: Write the app worker entry**

```ts
// apps/desktop/src/renderer/src/slicer/slicer.worker.ts
// ----------------------------------------------------------------
// Worker entry (bundled by Vite as a module worker). The only file
// in the app that imports the WASM module. VITE_USE_MOCK=1 swaps in
// the bridge-shaped mock so UI dev needs no emsdk build.
// ----------------------------------------------------------------
import { startWorker } from '@slicer/client';
import type { OrcaModuleFactory } from '@slicer/client';
import { createMockModule } from '@slicer/testing';

const useMock = import.meta.env.VITE_USE_MOCK === '1';

const factory: OrcaModuleFactory = useMock
  ? async () => createMockModule()
  : async () => {
      const mod = await import(/* @vite-ignore */ '/wasm/orca_slice.js');
      return mod.default({ noInitialRun: true });
    };

startWorker(factory);
```

- [ ] **Step 5: Verify the tests pass (with the protocol round-trip)**

Run: `pnpm --filter slicer-wasm test`
Expected: 14 PASS (10 client + 4 worker). The `nope()` rejection test asserts unknown ops surface as errors, not silent ignores.

- [ ] **Step 6: Commit**

```bash
git add packages/slicer-wasm/src/client/worker.ts packages/slicer-wasm/src/client/worker.test.ts apps/desktop/src/renderer/src/slicer/slicer.worker.ts
git commit -m "feat: worker glue — request/response protocol + progress messages, app worker entry"
```

---

### Task 4: Electron shell — IPC, native dialogs, COOP/COEP

The M0 shell (main/preload/renderer) gets its M2 surface: native open/save
dialogs, file read/write, window controls, and COOP/COEP session headers
(SharedArrayBuffer headroom for later threading). The preload exposes
`window.orca`; a shared types file keeps main/preload/renderer in sync.

**Files:**
- Create: `apps/desktop/src/shared/ipc.ts` (shared IPC channel names + payload types)
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/src/env.d.ts`, `apps/desktop/electron.vite.config.ts` (aliases), `apps/desktop/tsconfig.node.json` (include `src/shared`), `apps/desktop/tsconfig.web.json` (include `src/shared`)

**Interfaces:**
- Consumes: M0 shell files (Task 3 of the M0/M1 plan).
- Produces: `window.orca` API: `openFileDialog(filters): Promise<string | null>`, `saveFileDialog(defaultName, filters): Promise<string | null>`, `readFile(path): Promise<ArrayBuffer>`, `writeFile(path, bytes: ArrayBuffer): Promise<void>`, `minimize()/toggleMaximize()/close()`, `version`. IPC channel names in `src/shared/ipc.ts` used by main + preload. COOP/COEP headers on `session.defaultSession`.

- [ ] **Step 1: Write `src/shared/ipc.ts`**

```ts
// apps/desktop/src/shared/ipc.ts
// ----------------------------------------------------------------
// IPC surface shared by main, preload, and renderer. Channel names
// must stay in sync across all three; the preload exposes these as
// window.orca.* (see src/preload/index.ts).
// ----------------------------------------------------------------

export const Ipc = {
  openFileDialog: 'dialog:openFile',
  saveFileDialog: 'dialog:saveFile',
  readFile: 'file:read',
  writeFile: 'file:write',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
} as const;

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileResult {
  canceled: boolean;
  path: string | null;
}

export interface SaveFileResult {
  canceled: boolean;
  path: string | null;
}
```

- [ ] **Step 2: Rewrite `src/main/index.ts`**

```ts
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { Ipc, type FileDialogFilter } from '../shared/ipc';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses node builtins for file IO
    },
  });

  win.on('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(Ipc.openFileDialog, async (event, filters: FileDialogFilter[]) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters,
    });
    return { canceled, path: canceled ? null : (filePaths[0] ?? null) };
  });

  ipcMain.handle(Ipc.saveFileDialog, async (event, defaultName: string, filters: FileDialogFilter[]) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      defaultPath: defaultName,
      filters,
    });
    return { canceled, path: canceled ? null : (filePath ?? null) };
  });

  ipcMain.handle(Ipc.readFile, async (_event, path: string) => {
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  });

  ipcMain.handle(Ipc.writeFile, async (_event, path: string, bytes: ArrayBuffer) => {
    await writeFile(path, Buffer.from(bytes));
  });

  ipcMain.on(Ipc.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on(Ipc.windowToggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(Ipc.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

function setupSessionHeaders(): void {
  // COOP/COEP: same-origin isolation (SharedArrayBuffer headroom for
  // Milestone 4 threading). Applies to the renderer session; the
  // worker (module worker) inherits the page's headers.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });
}

app.whenReady().then(() => {
  setupSessionHeaders();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 3: Rewrite `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { Ipc, type FileDialogFilter } from '../shared/ipc';

// The renderer's only window to native features (design §Electron App).
// All IO goes through main; no node builtins leak into the renderer.
contextBridge.exposeInMainWorld('orca', {
  version: '0.0.0-m2-shell',

  openFileDialog: (filters: FileDialogFilter[]) =>
    ipcRenderer.invoke(Ipc.openFileDialog, filters) as Promise<{ canceled: boolean; path: string | null }>,

  saveFileDialog: (defaultName: string, filters: FileDialogFilter[]) =>
    ipcRenderer.invoke(Ipc.saveFileDialog, defaultName, filters) as Promise<{ canceled: boolean; path: string | null }>,

  readFile: (path: string) =>
    ipcRenderer.invoke(Ipc.readFile, path) as Promise<ArrayBuffer>,

  writeFile: (path: string, bytes: ArrayBuffer) =>
    ipcRenderer.invoke(Ipc.writeFile, path, bytes) as Promise<void>,

  minimize: () => ipcRenderer.send(Ipc.windowMinimize),
  toggleMaximize: () => ipcRenderer.send(Ipc.windowToggleMaximize),
  close: () => ipcRenderer.send(Ipc.windowClose),
});
```

- [ ] **Step 4: Update `src/renderer/src/env.d.ts`**

```ts
/// <reference types="vite/client" />

// An import makes this file a module — the global augmentation needs
// `declare global` to reach the real Window (classic env.d.ts gotcha).
import type { FileDialogFilter } from '../../shared/ipc';

declare global {
  interface Window {
    orca: {
      version: string;
      openFileDialog(filters: FileDialogFilter[]): Promise<{ canceled: boolean; path: string | null }>;
      saveFileDialog(defaultName: string, filters: FileDialogFilter[]): Promise<{ canceled: boolean; path: string | null }>;
      readFile(path: string): Promise<ArrayBuffer>;
      writeFile(path: string, bytes: ArrayBuffer): Promise<void>;
      minimize(): void;
      toggleMaximize(): void;
      close(): void;
    };
  }
}

export {};
```

- [ ] **Step 5: Update `electron.vite.config.ts` (aliases for the client package)**

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = fileURLToPath(new URL('../../packages/slicer-wasm/src/client', import.meta.url));

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@slicer/client': resolve(clientRoot, 'index.ts'),
        '@slicer/testing': resolve(clientRoot, 'testing/mock-module.ts'),
      },
    },
  },
});
```

- [ ] **Step 6: Update tsconfigs**

`tsconfig.node.json` include: `["electron.vite.config.ts", "src/main/**/*", "src/preload/**/*", "src/shared/**/*"]`.
`tsconfig.web.json` include: `["src/renderer/**/*", "src/shared/**/*"]`.

- [ ] **Step 7: Verify typecheck + build**

Run: `pnpm --filter desktop typecheck && pnpm --filter desktop build`
Expected: exit 0; `out/main/index.js` + `out/preload/index.js` exist.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/shared apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/renderer/src/env.d.ts apps/desktop/electron.vite.config.ts apps/desktop/tsconfig.node.json apps/desktop/tsconfig.web.json
git commit -m "feat: electron shell IPC (dialogs/file IO/window controls) + COOP/COEP session headers"
```

---

### Task 5: Renderer base — Tailwind + shadcn/ui + zustand + app layout

The renderer gets its styling/component foundation and the app chrome
(toolbar, panels, status bar). Layout is a 3-pane OrcaSlicer-like shell:
left settings panel, center viewport, right (later) — v1 puts the slice
button + progress in the toolbar.

**Files:**
- Create: `apps/desktop/tailwind.config.js`, `apps/desktop/postcss.config.js`, `apps/desktop/components.json`, `apps/desktop/src/renderer/src/index.css`, `apps/desktop/src/renderer/src/lib/utils.ts`, `apps/desktop/src/renderer/src/components/ui/button.tsx`, `.../components/ui/select.tsx`, `.../components/ui/slider.tsx`, `.../components/ui/checkbox.tsx`, `.../components/ui/input.tsx`, `.../components/ui/label.tsx`, `.../components/ui/progress.tsx`, `apps/desktop/src/renderer/src/components/layout/TitleBar.tsx`, `packages/slicer-app/src/components/layout/AppShell.tsx`, `apps/desktop/src/renderer/src/stores/useSettingsStore.ts`, `apps/desktop/src/renderer/src/stores/useSlicerStore.ts`
- Modify: `apps/desktop/package.json` (deps), `apps/desktop/src/renderer/src/main.tsx`, `apps/desktop/src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `window.orca` (Task 4).
- Produces: `cn(...classes)` util; `Button`, `Select`, `Slider`, `Checkbox`, `Input`, `Label`, `Progress` UI primitives (shadcn-style, radix-backed); `AppShell` with `titleBar` + `toolbar` + `workspace` + `status` slots (the sidebar/scene split, including the resizable divider, lives in `packages/slicer-app/src/components/workspace/Workspace.tsx`); `useSettingsStore` (`metadata: OptionMetadata | null`, `presets: {printers, prints, filaments}`, `values: Record<string, string>`, actions `loadAll()`, `setValue(key, value)`); `useSlicerStore` (`status: 'idle'|'slicing'|'done'|'error'`, `progress: number`, `layers: number`, `error: string | null`, actions `setStatus/setProgress/...`). Task 6 wires real data; Task 8+ consumes the stores.

- [ ] **Step 1: Add dependencies to `apps/desktop/package.json`**

```json
"dependencies": {
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "three": "^0.160.0",
  "@react-three/fiber": "^8.15.19",
  "@react-three/drei": "^9.99.0",
  "zustand": "^4.5.4",
  "class-variance-authority": "^0.7.0",
  "clsx": "^2.1.1",
  "tailwind-merge": "^2.5.2",
  "lucide-react": "^0.427.0",
  "@radix-ui/react-select": "^2.1.1",
  "@radix-ui/react-slider": "^1.2.0",
  "@radix-ui/react-dialog": "^1.1.1",
  "@radix-ui/react-label": "^2.1.0"
},
"devDependencies": {
  "@types/three": "^0.160.0",
  "tailwindcss": "^3.4.10",
  "postcss": "^8.4.45",
  "autoprefixer": "^10.4.20",
  "tailwindcss-animate": "^1.0.7"
}
```

- [ ] **Step 2: Write `tailwind.config.js` + `postcss.config.js` + `components.json`**

```js
// apps/desktop/tailwind.config.js
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
```

```js
// apps/desktop/postcss.config.js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

```json
// apps/desktop/components.json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.js",
    "css": "src/renderer/src/index.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib"
  }
}
```

- [ ] **Step 3: Write `index.css` (shadcn theme variables) + `lib/utils.ts`**

```css
/* apps/desktop/src/renderer/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 7%;
    --foreground: 0 0% 93%;
    --card: 0 0% 10%;
    --card-foreground: 0 0% 93%;
    --primary: 217 91% 60%;
    --primary-foreground: 0 0% 100%;
    --secondary: 0 0% 16%;
    --secondary-foreground: 0 0% 93%;
    --muted: 0 0% 16%;
    --muted-foreground: 0 0% 60%;
    --accent: 217 91% 60%;
    --accent-foreground: 0 0% 100%;
    --destructive: 0 84% 60%;
    --destructive-foreground: 0 0% 100%;
    --border: 0 0% 20%;
    --input: 0 0% 20%;
    --ring: 217 91% 60%;
    --radius: 0.5rem;
  }
  * { @apply border-border; }
  body { @apply bg-background text-foreground; }
  html, body, #root { height: 100%; margin: 0; overflow: hidden; }
}
```

```ts
// apps/desktop/src/renderer/src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 4: Write the shadcn UI primitives (compact, radix-backed)**

`button.tsx`:

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'border border-input bg-transparent hover:bg-accent/10 hover:text-accent-foreground',
        ghost: 'hover:bg-secondary/60',
      },
      size: { default: 'h-9 px-4 py-2', sm: 'h-8 px-3 text-xs', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  ),
);
Button.displayName = 'Button';
export { buttonVariants };
```

`select.tsx` (shadcn standard, radix Select primitives):

```tsx
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-card text-card-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out',
        position === 'popper' && 'data-[side=bottom]:translate-y-1',
        className,
      )}
      position={position}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;
```

`slider.tsx`:

```tsx
import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '../../lib/utils';

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary">
      <SliderPrimitive.Range className="absolute h-full bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
  </SliderPrimitive.Root>
));
Slider.displayName = SliderPrimitive.Root.displayName;
```

`checkbox.tsx`:

```tsx
import * as React from 'react';
import { cn } from '../../lib/utils';

export const Checkbox = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn('h-4 w-4 rounded border-input bg-transparent accent-primary', className)}
      {...props}
    />
  ),
);
Checkbox.displayName = 'Checkbox';
```

`input.tsx`:

```tsx
import * as React from 'react';
import { cn } from '../../lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
```

`label.tsx`:

```tsx
import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../../lib/utils';

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;
```

`progress.tsx` (plain, no radix):

```tsx
import { cn } from '../../lib/utils';

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}>
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
```

- [ ] **Step 5: Write the stores**

```ts
// apps/desktop/src/renderer/src/stores/useSettingsStore.ts
import { create } from 'zustand';
import type { OptionMetadata } from '@slicer/client';

interface SettingsState {
  metadata: OptionMetadata | null;
  printers: string[];
  prints: string[];
  filaments: string[];
  values: Record<string, string>;
  setMetadata: (m: OptionMetadata) => void;
  setPresets: (printers: string[], prints: string[], filaments: string[]) => void;
  setValue: (key: string, value: string) => void;
  setValues: (values: Record<string, string>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  metadata: null,
  printers: [],
  prints: [],
  filaments: [],
  values: {},
  setMetadata: (metadata) => set({ metadata }),
  setPresets: (printers, prints, filaments) => set({ printers, prints, filaments }),
  setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  setValues: (values) => set({ values }),
}));
```

```ts
// apps/desktop/src/renderer/src/stores/useSlicerStore.ts
import { create } from 'zustand';

export type SliceStatus = 'idle' | 'slicing' | 'done' | 'error';

interface SlicerState {
  status: SliceStatus;
  progress: number;
  layers: number;
  error: string | null;
  setStatus: (s: SliceStatus) => void;
  setProgress: (p: number) => void;
  setLayers: (n: number) => void;
  setError: (e: string | null) => void;
}

export const useSlicerStore = create<SlicerState>((set) => ({
  status: 'idle',
  progress: 0,
  layers: 0,
  error: null,
  setStatus: (status) => set({ status }),
  setProgress: (progress) => set({ progress }),
  setLayers: (layers) => set({ layers }),
  setError: (error) => set({ error }),
}));
```

- [ ] **Step 6: Write `TitleBar.tsx` + `AppShell.tsx` + `Workspace.tsx`**

```tsx
// apps/desktop/src/renderer/src/components/layout/TitleBar.tsx
import { Minus, Square, X } from 'lucide-react';
import { Button } from '../ui/button';

export function TitleBar() {
  return (
    <header className="flex h-9 items-center justify-between border-b bg-card px-3 select-none">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">OrcaSlicerNeo</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => window.orca.minimize()} aria-label="Minimize">
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => window.orca.toggleMaximize()} aria-label="Maximize">
          <Square className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 hover:bg-destructive hover:text-destructive-foreground" onClick={() => window.orca.close()} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );
}
```

```tsx
// packages/slicer-app/src/components/layout/AppShell.tsx
import { type ReactNode } from 'react';

export function AppShell({ titleBar, workspace, toolbar, status }: {
  titleBar: ReactNode;
  toolbar: ReactNode;
  // Fills the row between the toolbar and the status bar, so it has to
  // stretch itself (`flex-1 min-h-0`) — see Workspace.
  workspace: ReactNode;
  status: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      {titleBar}
      <div className="flex h-6 items-center gap-2 px-1 mb-0.5">{toolbar}</div>
      {workspace}
      <footer className="h-6 flex items-center px-1 text-xs text-muted-foreground">{status}</footer>
    </div>
  );
}
```

`AppShell` is a pure vertical stack. The sidebar↔scene row — the `<aside>`
(`ObjectList` + `SettingsPanel`), the resizable separator, and the `<main>`
holding the `Viewport` — lives in
`packages/slicer-app/src/components/workspace/Workspace.tsx`, which also owns
the sidebar width (clamped `220px`–`560px`, persisted as `ui.sidebarWidth`) and
the shared `SceneInteractionController` state.

- [ ] **Step 7: Rewrite `App.tsx` + `main.tsx`**

```tsx
// apps/desktop/src/renderer/src/App.tsx
import { AppShell } from './components/layout/AppShell';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { Workspace } from './components/workspace/Workspace';
import { StatusBar } from './components/layout/StatusBar';

export default function App() {
  return (
    <AppShell
      titleBar={<TitleBar />}
      toolbar={<Toolbar />}
      workspace={<Workspace />}
      status={<StatusBar />}
    />
  );
}
```

(Placeholders `Toolbar`, `StatusBar`, and the `SettingsPanel`/`Viewport` that
`Workspace` composes — the next tasks implement them; create minimal stubs now
so the app compiles: each renders a `div` with its name.)

```tsx
// apps/desktop/src/renderer/src/main.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 8: Verify typecheck + build**

Run: `pnpm install && pnpm --filter desktop typecheck && pnpm --filter desktop build`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/tailwind.config.js apps/desktop/postcss.config.js apps/desktop/components.json apps/desktop/src/renderer/src/index.css apps/desktop/src/renderer/src/lib apps/desktop/src/renderer/src/components apps/desktop/src/renderer/src/stores apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/main.tsx apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: renderer base — tailwind/shadcn primitives, zustand stores, app shell layout"
```

---

### Task 6: App boot wiring + settings UI from metadata

The app boots the worker, loads presets + option metadata, and renders the
settings panel generically from the metadata — same data `Tab.cpp` renders
today, no duplicated schema (design §Electron App). Also: the "Open" flow
(native dialog → read bytes → `loadModel`) and the toolbar/status bar.

**Files:**
- Create: `apps/desktop/src/renderer/src/slicer/slicerClient.ts` (worker client singleton), `packages/slicer-app/src/components/layout/Toolbar.tsx`, `packages/slicer-app/src/components/layout/StatusBar.tsx`, `packages/slicer-app/src/components/workspace/settings/SettingsPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx` (boot effect)

**Interfaces:**
- Consumes: `createWorkerClient` (Task 3), `window.orca` (Task 4), stores (Task 5).
- Produces: `slicerClient` singleton (the one `SlicerClient` instance the app drives); `App` boot effect: `slicerClient.init()` → `getPresets` ×3 → `getOptionMetadata` → fill `useSettingsStore`. The current `SettingsPanel` delegates Project/Scoped option editing to `ScopedConfigurationPanel`; `spec/Project and Scoped Configuration.md` defines the delivered behavior. `Toolbar`: Open / Slice / Export buttons (actions wired in Tasks 8–10; Slice/Export disabled until a model loads — a `modelLoaded` flag on `useSettingsStore` for now, replaced by real state in Task 8). `StatusBar`: slicer store status + progress bar.

- [ ] **Step 1: Write `slicerClient.ts`**

```ts
// apps/desktop/src/renderer/src/slicer/slicerClient.ts
// The app's one worker-backed SlicerClient. Worker created once,
// transport = postMessage pair.
import { createWorkerClient } from '@slicer/client';
import type { SlicerClient } from '@slicer/client';

function makeTransport() {
  const worker = new Worker(new URL('./slicer.worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (msg: unknown) => worker.postMessage(msg),
    onMessage: (fn: (msg: unknown) => void) => {
      worker.addEventListener('message', (e) => fn(e.data));
    },
  };
}

export const slicerClient: SlicerClient = createWorkerClient(makeTransport());
```

- [ ] **Step 2: Write the failing store test (metadata drives defaults)**

```ts
// apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts
import { describe, it, expect } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

describe('useSettingsStore', () => {
  it('setValue merges into values', () => {
    const s = useSettingsStore.getState();
    s.setValues({ layer_height: '0.2' });
    s.setValue('wall_loops', '3');
    expect(useSettingsStore.getState().values).toEqual({ layer_height: '0.2', wall_loops: '3' });
  });
});
```

- [ ] **Step 3: Run it to verify it fails, then passes**

Run: `pnpm --filter desktop test`
First run: FAIL (module missing). After the store file exists (Task 5 Step 5 already created it), PASS. (The test is written now so the rig is exercised before Task 8 work depends on it.)

- [ ] **Step 4: Use the current Project/Scoped field catalogue**

The delivered settings surface derives eligible options from native metadata and
scope rules. See `spec/Project and Scoped Configuration.md` for the accepted
behavior.

- [ ] **Step 5: Wire `SettingsPanel.tsx` to the current settings surface**

`SettingsPanel` owns the preset selectors and renders
`ScopedConfigurationPanel` for Project/Scoped option editing.


- [ ] **Step 6: Write `Toolbar.tsx` + `StatusBar.tsx`**

```tsx
// packages/slicer-app/src/components/layout/Toolbar.tsx
import { FolderOpen, Slice, Download } from 'lucide-react';
import { Button } from '../ui/button';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';

export function Toolbar() {
  const status = useSlicerStore((s) => s.status);
  const setSlicerStatus = useSlicerStore((s) => s.setStatus);
  const setError = useSlicerStore((s) => s.setError);
  const busy = status === 'slicing';

  async function openModel() {
    const { path } = await window.orca.openFileDialog([
      { name: 'Models', extensions: ['stl', '3mf'] },
      { name: 'All files', extensions: ['*'] },
    ]);
    if (!path) return;
    try {
      const buf = await window.orca.readFile(path);
      const ext = path.split('.').pop() ?? 'stl';
      const r = await slicerClient.loadModel(new Uint8Array(buf), ext);
      if (!r.ok) throw new Error(r.error ?? 'load failed');
      useSettingsStore.getState().setValues((s) => ({ ...s, modelPath: path }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function slice() {
    if (busy) return;
    // Only send keys the metadata declares — UI-only keys (printer, print,
    // filament, modelPath) are not print options and would land in the
    // bridge's unrecognized_keys warning.
    const state = useSettingsStore.getState();
    const meta = state.metadata ?? {};
    const values = Object.fromEntries(
      Object.entries(state.values).filter(([k]) => meta[k] !== undefined),
    );
    setSlicerStatus('slicing');
    try {
      const r = await slicerClient.slice(values, (pct) => useSlicerStore.getState().setProgress(pct));
      if (!r.ok) throw new Error(r.error ?? 'slice failed');
      if (r.unrecognized_keys.length) {
        console.warn('unrecognized keys dropped by libslic3r:', r.unrecognized_keys);
      }
      setSlicerStatus('done');
    } catch (err) {
      setSlicerStatus('error');
      setError(String(err));
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={openModel}>
        <FolderOpen className="h-4 w-4" /> Open
      </Button>
      <Button size="sm" variant="secondary" onClick={slice} disabled={busy}>
        <Slice className="h-4 w-4" /> {busy ? 'Slicing…' : 'Slice'}
      </Button>
      <Button size="sm" variant="default" disabled={busy} title="Export G-code">
        <Download className="h-4 w-4" /> Export
      </Button>
    </>
  );
}
```

```tsx
// packages/slicer-app/src/components/layout/StatusBar.tsx
import { useSlicerStore } from '../../stores/useSlicerStore';
import { Progress } from '../ui/progress';

export function StatusBar() {
  const status = useSlicerStore((s) => s.status);
  const progress = useSlicerStore((s) => s.progress);
  const layers = useSlicerStore((s) => s.layers);
  const error = useSlicerStore((s) => s.error);

  return (
    <div className="flex w-full items-center gap-3">
      <span className="shrink-0">{statusText(status)}</span>
      {status === 'slicing' && (
        <Progress value={progress} className="w-40" />
      )}
      {status === 'done' && layers > 0 && (
        <span>{layers} layers</span>
      )}
      {error && <span className="text-destructive truncate">{error}</span>}
    </div>
  );
}

function statusText(s: string): string {
  switch (s) {
    case 'idle': return 'Ready';
    case 'slicing': return 'Slicing…';
    case 'done': return 'Sliced';
    case 'error': return 'Error';
    default: return s;
  }
}
```

- [ ] **Step 7: Boot wiring in `App.tsx`**

```tsx
// apps/desktop/src/renderer/src/App.tsx (add a boot effect)
import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { TitleBar } from './components/layout/TitleBar';
import { Toolbar } from './components/layout/Toolbar';
import { Workspace } from './components/workspace/Workspace';
import { StatusBar } from './components/layout/StatusBar';
import { slicerClient } from './slicer/slicerClient';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';

export default function App() {
  const setMetadata = useSettingsStore((s) => s.setMetadata);
  const setPresets = useSettingsStore((s) => s.setPresets);
  const setError = useSlicerStore((s) => s.setError);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const init = await slicerClient.init();
        if (!init.ok) throw new Error(init.error ?? 'orc_init failed');
        const [printers, prints, filaments] = await Promise.all([
          slicerClient.getPresets('printer'),
          slicerClient.getPresets('print'),
          slicerClient.getPresets('filament'),
        ]);
        const metadata = await slicerClient.getOptionMetadata();
        if (cancelled) return;
        setPresets(
          printers.presets.map((p) => p.name),
          prints.presets.map((p) => p.name),
          filaments.presets.map((p) => p.name),
        );
        setMetadata(metadata);
      } catch (err) {
        if (!cancelled) setError(`boot: ${String(err)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [setMetadata, setPresets, setError]);

  return (
    <AppShell
      titleBar={<TitleBar />}
      toolbar={<Toolbar />}
      workspace={<Workspace />}
      status={<StatusBar />}
    />
  );
}
```

- [ ] **Step 8: Stage script + gitignore**

Create `scripts/stage-wasm.mjs` (root `scripts/`):

```js
// scripts/stage-wasm.mjs — copy the built WASM module into the renderer's
// public dir so the worker can load it. Run after `bash packages/slicer-wasm/build.sh`.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/slicer-wasm/out');
const dst = join(root, 'apps/desktop/src/renderer/public/wasm');

if (!existsSync(src)) {
  console.error('no WASM build found — run: bash packages/slicer-wasm/build.sh');
  process.exit(1);
}
await mkdir(dst, { recursive: true });
for (const f of ['orca_slice.js', 'orca_slice.wasm']) {
  if (!existsSync(join(src, f))) {
    console.error(`missing ${f} in ${src}`);
    process.exit(1);
  }
  await copyFile(join(src, f), join(dst, f));
  console.log(`staged ${f}`);
}
```

Root `package.json` scripts: add `"stage:wasm": "node scripts/stage-wasm.mjs"`.
Root `.gitignore` add: `apps/desktop/src/renderer/public/wasm/`.

- [ ] **Step 9: Verify**

Run: `pnpm install && pnpm --filter desktop typecheck && pnpm --filter desktop test && pnpm --filter slicer-wasm test`
Expected: exit 0; desktop store test PASS; slicer-wasm 14 PASS.

- [ ] **Step 10: Manual dev smoke (optional — needs no emsdk with VITE_USE_MOCK=1)**

Run: `VITE_USE_MOCK=1 pnpm --filter desktop dev`
Expected: window opens; settings panel populates with the mock presets +
metadata; Open loads a file into the mock; Slice shows progress then "Sliced".

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/renderer/src/slicer apps/desktop/src/renderer/src/components/toolbar apps/desktop/src/renderer/src/components/status packages/slicer-app/src/components/workspace/settings apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts scripts/stage-wasm.mjs package.json .gitignore
git commit -m "feat: app boot (worker client + presets + metadata) and metadata-driven settings panel"
```

---

### Task 7: Bridge binary buffers (model mesh + slice result) — `bridge.cpp`

The M2 contract (Task 1 mock) implemented in C++: `orc_get_model_mesh`,
`orc_set_instance_offset`, and the binary `orc_get_slice_result` (toolpath +
stats). Toolpath comes from `GCodeProcessor` post-processing
the exported gcode. **Pinned-SHA drift surface** — each API below is
verified against the submodule before use (AGENTS.md iterate loop); the
smoke test + client tests are the test.

**Files:**
- Modify: `packages/slicer-wasm/src/bridge.cpp` (add the three functions; extend `orc_get_slice_result`)
- Modify: `packages/slicer-wasm/harness/bridge-smoke.mjs` (cover the new functions)
- Create: `packages/slicer-wasm/src/bridge_buffers.cpp` + `bridge_buffers.hpp` (binary marshaling helpers, included in `bridge.cpp`)
- Modify: `packages/slicer-wasm/CMakeLists.txt` (add `bridge_buffers.cpp` to the `orca_slice` target)

**Interfaces:**
- Consumes: existing bridge state (`state().model`, `state().print`), `nlohmann/json`, libslic3r (pinned SHA).
- Produces (contract identical to Task 1's mock):
  - `orc_get_model_mesh()` → `{ok, objects: [{object_idx, vertex_ptr, vertex_count, index_ptr, index_count, offset:[x,y,z]}]}` — `Float32` xyz + `Uint32` index triples on the heap; JS frees both ptrs.
  - `orc_set_instance_offset(object_idx, instance_idx, x, y, z)` → `{ok}` — sets `ModelInstance::set_offset`.
  - `orc_get_slice_result()` → `{ok, objects, layers, toolpath: {vertex_ptr, vertex_count, layer_ptr, layer_count, feature_ptr, feature_count, features: [{id, name, color}]}}` — toolpath per-vertex `Float32 xyz` + `Uint32 layer_id` + `Uint32 feature`. All ptrs malloc'd; JS frees.
- Produces: `bridge_buffers.hpp` — `MallocBuffer` RAII (ptr + size, freed at scope end or handed off), `appendF32/appendU32/appendBytes`, `feature_palette()`, `build_toolpath(result)`.

- [ ] **Step 1: Verify the pinned-SHA APIs (read the submodule headers)**

Run (inside `packages/slicer-wasm/cpp`):

```bash
grep -n "process_file\|get_result\|struct MoveVertex\|layer_id" src/libslic3r/GCodeProcessor.hpp | head -20
grep -n "struct SlicesToTriangleMeshParams" -A 12 src/libslic3r/TriangleMeshSlicer.hpp
grep -rn "triangulate_self\|struct IndexedTriangle" src/libslic3r/ExPolygon.hpp src/libslic3r/PolygonTriangulation.hpp | head -10
grep -n "set_offset\|get_offset" src/libslic3r/Model.hpp | head -10
grep -rn "enum class ExtrusionRole" src/libslic3r/ExtrusionEntity.hpp
```

Expected (adjust code below to the actual signatures): `GCodeProcessor::process_file(path)` + `get_result()`, `GCodeProcessorResult::moves` with `MoveVertex{position, type, layer_id}`, `SlicesToTriangleMeshParams{v_vertices, v_vertices_count_per_layer, v_triangles, v_triangles_count_per_layer, v_vertices_out, v_triangles_out, v_triangles_vertex_color}` + `SlicesToTriangleMesh(params)` from `TriangleMeshSlicer.hpp`, `ExPolygon::triangles` (IndexedTriangle `{a,b,c}` indices into contour+holes flattened points) + `triangulate_self()`, `ModelInstance::set_offset(Vec3d)`. If a name differs, adapt — the bridge is the drift surface.

- [ ] **Step 2: Write `bridge_buffers.hpp`**

```cpp
// packages/slicer-wasm/src/bridge_buffers.hpp
// ----------------------------------------------------------------
// Binary buffer marshaling for the bridge: growable malloc'd buffers
// whose storage is handed to the JS side (which _free()s it). Kept
// separate from bridge.cpp so the layout is easy to audit against
// the client contract (doc/2026-08-13-m2-implementation-plan.md).
// ----------------------------------------------------------------
#pragma once

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>

// A buffer that owns malloc'd memory. By default the storage lives
// until release() or destruction; the bridge transfers ownership to
// JS via release() (the caller records the pointer in the JSON).
struct MallocBuffer {
    std::uint8_t* data = nullptr;
    size_t        size = 0;

    ~MallocBuffer() { std::free(data); }
    MallocBuffer() = default;
    MallocBuffer(const MallocBuffer&) = delete;
    MallocBuffer& operator=(const MallocBuffer&) = delete;
    MallocBuffer(MallocBuffer&& other) noexcept : data(other.data), size(other.size) {
        other.data = nullptr;
        other.size = 0;
    }
    MallocBuffer& operator=(MallocBuffer&& other) noexcept {
        if (this != &other) {
            std::free(data);
            data = other.data;
            size = other.size;
            other.data = nullptr;
            other.size = 0;
        }
        return *this;
    }

    void reserve(size_t extra) {
        data = static_cast<std::uint8_t*>(std::realloc(data, size + extra));
        if (!data) std::abort();
    }
    void append(const void* src, size_t n) {
        reserve(n);
        std::memcpy(data + size, src, n);
        size += n;
    }
    void appendF32(float v)  { append(&v, sizeof(v)); }
    void appendU32(std::uint32_t v) { append(&v, sizeof(v)); }

    // Hand the storage to JS (bridge fills the pointer/size fields).
    void release() { data = nullptr; size = 0; }
};
```

- [ ] **Step 3: Write `bridge_buffers.cpp` (toolpath assembly)**

```cpp
// packages/slicer-wasm/src/bridge_buffers.cpp
// ----------------------------------------------------------------
// Assembles the binary slice-result buffers from libslic3r data.
// Toolpath: GCodeProcessorResult moves (post-processed gcode).
// The layout is the M2 bridge contract (Task 1 mock mirror).
// ----------------------------------------------------------------
#include "bridge_buffers.hpp"

// Drift at the pinned SHA: GCodeProcessor.hpp lives under GCode/.
#include "libslic3r/GCode/GCodeProcessor.hpp"

#include <map>
#include <string>

namespace bridge {

using Slic3r::ExtrusionRole;
using Slic3r::GCodeProcessorResult;

// Feature palette (id = ExtrusionRole value, name/color for the client).
struct FeatureInfo { std::string name; unsigned char color[3]; };

const std::map<ExtrusionRole, FeatureInfo>& feature_palette() {
    static const std::map<ExtrusionRole, FeatureInfo> palette = {
        {ExtrusionRole::erPerimeter,             {"ExternalPerimeter", {255, 140, 0}}},
        {ExtrusionRole::erExternalPerimeter,     {"ExternalPerimeter", {255, 140, 0}}},
        {ExtrusionRole::erOverhangPerimeter,     {"OverhangPerimeter", {255, 0, 0}}},
        {ExtrusionRole::erInternalInfill,        {"InternalInfill",    {0, 160, 255}}},
        {ExtrusionRole::erSolidInfill,           {"SolidInfill",       {255, 255, 0}}},
        {ExtrusionRole::erTopSolidInfill,        {"TopSolidInfill",    {255, 0, 255}}},
        {ExtrusionRole::erIroning,               {"Ironing",           {128, 128, 128}}},
        {ExtrusionRole::erBridges,               {"Bridge",            {0, 255, 255}}},
        {ExtrusionRole::erSkirt,                 {"Skirt",             {0, 255, 128}}},
        {ExtrusionRole::erSupportMaterial,       {"Support",           {255, 128, 0}}},
        {ExtrusionRole::erSupportMaterialInterface, {"SupportInterface", {200, 100, 50}}},
    };
    return palette;
}

struct ToolpathBuffers {
    MallocBuffer positions;   // Float32 xyz per vertex
    MallocBuffer layers;      // Uint32 layer_id per vertex
    MallocBuffer features;    // Uint32 palette index per vertex
    // Local palette: index into this vector == the id recorded in
    // `features`. Kept local (0..N-1) so the JSON feature list in
    // orc_get_slice_result lines up with the buffer values 1:1.
    std::vector<std::pair<ExtrusionRole, FeatureInfo>> palette_used;
};

ToolpathBuffers build_toolpath(const GCodeProcessorResult& result) {
    ToolpathBuffers out;
    const auto& palette = feature_palette();
    std::map<ExtrusionRole, std::uint32_t> feature_ids;
    for (const auto& mv : result.moves) {
        const auto it = palette.find(mv.type);
        if (it == palette.end()) continue; // travel/unmapped: not drawn in v1
        out.positions.appendF32(static_cast<float>(mv.position.x()));
        out.positions.appendF32(static_cast<float>(mv.position.y()));
        out.positions.appendF32(static_cast<float>(mv.position.z()));
        out.layers.appendU32(static_cast<std::uint32_t>(mv.layer_id < 0 ? 0 : mv.layer_id));
        auto fid = feature_ids.find(mv.type);
        if (fid == feature_ids.end()) {
            fid = feature_ids.emplace(mv.type, static_cast<std::uint32_t>(out.palette_used.size())).first;
            out.palette_used.emplace_back(mv.type, it->second);
        }
        out.features.appendU32(fid->second);
    }
    return out;
}

}  // namespace bridge
```

- [ ] **Step 4: Extend `bridge.cpp` — new + updated exports**

Add includes: `"bridge_buffers.hpp"`, `"libslic3r/GCodeProcessor.hpp"`,
`"libslic3r/Model.hpp"` (already), `"libslic3r/PrintObject.hpp"`.

```cpp
// ---- new: model triangle mesh + instance offset ----

EMSCRIPTEN_KEEPALIVE const char* orc_set_instance_offset(int object_idx, int instance_idx, double x, double y, double z) {
    try {
        auto& model = state().model;
        if (object_idx < 0 || object_idx >= static_cast<int>(model.objects.size()))
            return error_json("object index out of range");
        auto& obj = model.objects[static_cast<size_t>(object_idx)];
        if (instance_idx < 0 || instance_idx >= static_cast<int>(obj->instances.size()))
            return error_json("instance index out of range");
        // Drift surface: ModelInstance::set_offset(Vec3d) — confirm at SHA.
        obj->instances[static_cast<size_t>(instance_idx)]->set_offset(Slic3r::Vec3d(x, y, z));
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_model_mesh() {
    try {
        auto& model = state().model;
        json arr = json::array();
        for (size_t oi = 0; oi < model.objects.size(); ++oi) {
            const auto& obj = model.objects[oi];
            const auto& its = obj->mesh().its;
            MallocBuffer vbuf;
            MallocBuffer ibuf;
            for (const auto& v : its.vertices) {
                vbuf.appendF32(v.x());
                vbuf.appendF32(v.y());
                vbuf.appendF32(v.z());
            }
            for (const auto& tri : its.indices) {
                ibuf.appendU32(static_cast<std::uint32_t>(tri[0]));
                ibuf.appendU32(static_cast<std::uint32_t>(tri[1]));
                ibuf.appendU32(static_cast<std::uint32_t>(tri[2]));
            }
            // Instance 0's offset (v1: one instance per object).
            Slic3r::Vec3d off(0, 0, 0);
            if (!obj->instances.empty()) off = obj->instances.front()->get_offset();
            const std::uint32_t vptr = reinterpret_cast<std::uint32_t>(vbuf.data);
            const std::uint32_t iptr = reinterpret_cast<std::uint32_t>(ibuf.data);
            vbuf.release();
            ibuf.release();
            arr.push_back(json{
                {"object_idx", oi},
                {"vertex_ptr", vptr},
                {"vertex_count", its.vertices.size()},
                {"index_ptr", iptr},
                {"index_count", its.indices.size() * 3},
                {"offset", {off.x(), off.y(), off.z()}},
            });
        }
        return dup_json(json{{"ok", true}, {"objects", std::move(arr)}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}
```

Replace `orc_get_slice_result` with:

```cpp
// Binary toolpath + stats. Contract mirrors the Task 1
// mock; JS reads the heap buffers and _free()s the pointers.
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    try {
        auto& print = state().print;
        if (print.objects().empty())
            return dup_json(json{{"ok", true}, {"objects", 0}, {"layers", 0},
                                 {"toolpath", json{{"vertex_ptr", 0}, {"vertex_count", 0},
                                                   {"layer_ptr", 0}, {"layer_count", 0},
                                                   {"feature_ptr", 0}, {"feature_count", 0},
                                                   {"features", json::array()}}}}.dump());

        // The toolpath comes from post-processing the exported gcode
        // (GCodeProcessor::process_file — the GUI's own mechanism). Export
        // happens here so getSliceResult is self-contained; the client's
        // exportGcode() later reads the same /out.gcode via FS. Drift
        // surface: process_file/get_result signatures (Step 1).
        print.export_gcode("/out.gcode", nullptr, nullptr);

        const size_t layers = print.objects().front()->layers().size();
        Slic3r::GCodeProcessorResult gcode_result;
        {
            Slic3r::GCodeProcessor processor;
            processor.process_file("/out.gcode");
            gcode_result = processor.get_result();
        }
        auto tp = bridge::build_toolpath(gcode_result);

        // Feature palette (local id → name/color). build_toolpath assigns
        // ids 0..N-1 in order of first use; the features buffer holds those
        // ids, so this list lines up 1:1.
        json features = json::array();
        for (const auto& [role, info] : tp.palette_used) {
            (void)role;
            features.push_back({{"id", static_cast<int>(features.size())},
                                {"name", info.name},
                                {"color", {info.color[0], info.color[1], info.color[2]}}});
        }

        const std::uint32_t tvptr = reinterpret_cast<std::uint32_t>(tp.positions.data);
        const std::uint32_t tlptr = reinterpret_cast<std::uint32_t>(tp.layers.data);
        const std::uint32_t tfptr = reinterpret_cast<std::uint32_t>(tp.features.data);
        const size_t n_verts = tp.positions.size / 12;
        tp.positions.release(); tp.layers.release(); tp.features.release();

        json out{{"ok", true}, {"objects", print.objects().size()}, {"layers", layers}};
        out["toolpath"] = {
            {"vertex_ptr", tvptr}, {"vertex_count", n_verts},
            {"layer_ptr", tlptr}, {"layer_count", n_verts},
            {"feature_ptr", tfptr}, {"feature_count", n_verts},
            {"features", std::move(features)},
        };
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}
```

> **Note:** `orc_export_gcode` still writes `/out.gcode` — the slice-result
> path re-exports it (cheap post-slice) and post-processes with
> `GCodeProcessor` so toolpath moves are available; the client's
> `exportGcode()` reads the same file via FS.

- [ ] **Step 5: Update `CMakeLists.txt`**

Add `"${CMAKE_CURRENT_SOURCE_DIR}/src/bridge_buffers.cpp"` to the
`orca_slice` target sources.

- [ ] **Step 6: Update `harness/bridge-smoke.mjs`** — extend after check 7 (slice result):

```js
// 7b. binary slice-result buffers (M2 contract)
const res2 = callJson('orc_get_slice_result', [], []);
check('slice result has toolpath buffers', res2.ok === true
      && res2.toolpath && res2.toolpath.vertex_count > 0,
      JSON.stringify(res2).slice(0, 200));
if (res2.toolpath && res2.toolpath.vertex_count > 0) {
  const n = res2.toolpath.vertex_count;
  const pos = Module.HEAPF32.slice(Number(res2.toolpath.vertex_ptr) / 4, Number(res2.toolpath.vertex_ptr) / 4 + n * 3);
  const layers = Module.HEAPU32.slice(Number(res2.toolpath.layer_ptr) / 4, Number(res2.toolpath.layer_ptr) / 4 + n);
  const feats = Module.HEAPU32.slice(Number(res2.toolpath.feature_ptr) / 4, Number(res2.toolpath.feature_ptr) / 4 + n);
  check('toolpath positions finite', pos.every((v) => Number.isFinite(v)));
  check('toolpath layers ascending within range', layers.every((l) => l >= 0 && l < res2.layers));
  check('toolpath features in palette', feats.every((f) => Number.isInteger(f) && f >= 0));
  Module._free(Number(res2.toolpath.vertex_ptr));
  Module._free(Number(res2.toolpath.layer_ptr));
  Module._free(Number(res2.toolpath.feature_ptr));
}
if (res2.mesh && res2.mesh.vertex_count > 0) {
  const mi = Module.HEAPU32.slice(Number(res2.mesh.index_ptr) / 4, Number(res2.mesh.index_ptr) / 4 + res2.mesh.index_count);
  check('mesh indices < vertex_count', mi.every((i) => i < res2.mesh.vertex_count));
  Module._free(Number(res2.mesh.vertex_ptr));
  Module._free(Number(res2.mesh.index_ptr));
  Module._free(Number(res2.mesh.layer_ptr));
}

// 7c. model mesh buffers (M2 contract)
const mm = callJson('orc_get_model_mesh', [], []);
check('orc_get_model_mesh ok', mm.ok === true && mm.objects?.length === 1, JSON.stringify(mm).slice(0, 200));
if (mm.objects?.length === 1) {
  const o = mm.objects[0];
  check('model mesh has cube geometry', o.vertex_count === 8 && o.index_count === 36,
        `verts=${o.vertex_count} idx=${o.index_count}`);
  Module._free(Number(o.vertex_ptr));
  Module._free(Number(o.index_ptr));
}

// 7d. instance offset round-trip
const off = callJson('orc_set_instance_offset', ['number', 'number', 'number', 'number', 'number'],
                     [0, 0, 10, 20, 0]);
check('orc_set_instance_offset ok', off.ok === true, JSON.stringify(off));
const mm2 = callJson('orc_get_model_mesh', [], []);
check('offset applied', mm2.ok === true && mm2.objects[0].offset[0] === 10, JSON.stringify(mm2.objects[0]?.offset));
Module._free(Number(mm2.objects[0].vertex_ptr));
Module._free(Number(mm2.objects[0].index_ptr));
```

- [ ] **Step 7: Rebuild + run both tests**

Run: `bash packages/slicer-wasm/build.sh` then
`node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`
Expected: all checks PASS, exit 0. Iterate per AGENTS.md on any compile/link
failure (TBB_HEADERS / DROP_PATTERNS / stubs — the dropped set doesn't change,
but new includes may surface new headers).

- [ ] **Step 8: Commit**

```bash
git add packages/slicer-wasm/src/bridge.cpp packages/slicer-wasm/src/bridge_buffers.cpp packages/slicer-wasm/src/bridge_buffers.hpp packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/CMakeLists.txt
git commit -m "feat: bridge binary buffers — model mesh, instance offset, toolpath in orc_get_slice_result"
```

---

### Task 8: 3D viewport (react-three-fiber) — bed, model, orbit, select, move

The R3F viewport: bed plate + grid, model meshes from `getModelMesh()`
(WASM triangle buffers), orbit/zoom/pan, click-select, drag-move on the bed
plane (design §Electron App "basic move-on-plate").

**Files:**
- Create: `packages/slicer-app/src/components/workspace/viewport/Viewport.tsx`, `.../viewport/Scene.tsx`, `.../viewport/BedPlate.tsx`, `.../viewport/ModelMesh.tsx`, `.../viewport/useModelLoader.ts`, `.../viewport/useSelection.ts`
- Modify: `apps/desktop/src/renderer/src/stores/useSettingsStore.ts` (add `modelLoaded` + `selectedObject` + `instanceOffset` state), `packages/slicer-app/src/components/layout/Toolbar.tsx` (enable Slice/Export when `modelLoaded`)

**Interfaces:**
- Consumes: `slicerClient.getModelMesh()` + `setInstanceOffset` (Tasks 2/7), stores (Task 5).
- Produces: `Viewport` (Canvas: camera `[200, 160, 200]`, `fov 45`; `<OrbitControls makeDefault enableDamping />` with `mouseButtons` — LEFT orbit, RIGHT pan, MIDDLE zoom so drag-select and orbit coexist); `useModelLoader` — on `modelLoaded` fetch mesh buffers, build `BufferGeometry` (positions + indices), dispose on change; `ModelMesh` — `<mesh>` with `onClick` (stopPropagation, select) + drag via pointer-plane intersection (move along the bed plane, writes `setInstanceOffset` to the wasm client + store); `BedPlate` — 220×220 plane with drei `<Grid>` (or manual grid lines); selection ring (box3 outline via drei `Edges` or a simple highlight mesh).

- [ ] **Step 1: Write the failing store test (selection state)**

```ts
// apps/desktop/src/renderer/src/stores/useSettingsStore.test.ts (extend)
import { describe, it, expect } from 'vitest';
import { useSettingsStore } from './useSettingsStore';

describe('useSettingsStore viewport state', () => {
  it('marks a loaded model and tracks selection + offset', () => {
    const s = useSettingsStore.getState();
    s.setModelLoaded(true);
    s.setSelectedObject(0);
    s.setInstanceOffset([10, 20, 0]);
    expect(useSettingsStore.getState().modelLoaded).toBe(true);
    expect(useSettingsStore.getState().selectedObject).toBe(0);
    expect(useSettingsStore.getState().instanceOffset).toEqual([10, 20, 0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails (store lacks the actions), then extend the store**

```ts
// add to useSettingsStore.ts
modelLoaded: false,
selectedObject: number | null,
instanceOffset: [number, number, number],
setModelLoaded: (v: boolean) => void;
setSelectedObject: (v: number | null) => void;
setInstanceOffset: (v: [number, number, number]) => void;
// default state + actions:
setModelLoaded: (modelLoaded) => set({ modelLoaded }),
setSelectedObject: (selectedObject) => set({ selectedObject }),
setInstanceOffset: (instanceOffset) => set({ instanceOffset }),
```

Run: `pnpm --filter desktop test` → PASS.

- [ ] **Step 3: Write `useModelLoader.ts` + `ModelMesh.tsx`**

```ts
// packages/slicer-app/src/components/workspace/viewport/useModelLoader.ts
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { slicerClient } from '../../slicer/slicerClient';
import { useSettingsStore } from '../../stores/useSettingsStore';
import type { ModelObjectBuffer } from '@slicer/client';

export interface LoadedObject {
  buffer: ModelObjectBuffer;
  geometry: THREE.BufferGeometry;
}

export function useModelLoader(): LoadedObject[] {
  const modelLoaded = useSettingsStore((s) => s.modelLoaded);
  const [objects, setObjects] = useState<LoadedObject[]>([]);

  useEffect(() => {
    let disposed = false;
    if (!modelLoaded) {
      setObjects([]);
      return;
    }
    (async () => {
      try {
        const res = await slicerClient.getModelMesh();
        if (!res.ok) throw new Error(res.error ?? 'getModelMesh failed');
        const loaded: LoadedObject[] = res.objects.map((buf) => {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
          geometry.setIndex(new THREE.BufferAttribute(buf.indices, 1));
          geometry.computeVertexNormals();
          return { buffer: buf, geometry };
        });
        if (!disposed) setObjects(loaded);
      } catch (err) {
        console.error('model load failed:', err);
      }
    })();
    return () => {
      disposed = true;
      // dispose geometries on unmount
      setObjects((prev) => {
        prev.forEach((o) => o.geometry.dispose());
        return [];
      });
    };
  }, [modelLoaded]);

  return objects;
}
```

```tsx
// packages/slicer-app/src/components/workspace/viewport/ModelMesh.tsx
import { useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { slicerClient } from '../../slicer/slicerClient';
import type { LoadedObject } from './useModelLoader';

const BED_Y = 0;

export function ModelMesh({ data }: { data: LoadedObject }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const selected = useSettingsStore((s) => s.selectedObject === data.buffer.objectIdx);
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  const setInstanceOffset = useSettingsStore((s) => s.setInstanceOffset);
  const dragRef = useRef<{ plane: THREE.Plane; offset: THREE.Vector3; moved: boolean } | null>(null);

  function select(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    setSelected(data.buffer.objectIdx);
  }

  // Drag-move on the bed plane (left pointer on the selected object).
  // OrbitControls: LEFT = orbit — so drag starts only on the object itself
  // (click-to-select then drag on it); OrbitControls keeps right-drag pan.
  function onPointerDown(e: ThreeEvent<PointerEvent>) {
    if (!selected) return;
    e.stopPropagation();
    const pos = meshRef.current!.position;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BED_Y);
    const hit = new THREE.Vector3();
    const ray = e.ray as THREE.Ray;
    if (!ray.intersectPlane(plane, hit)) return;
    dragRef.current = { plane, offset: pos.clone().sub(hit), moved: false };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ThreeEvent<PointerEvent>) {
    const drag = dragRef.current;
    if (!drag) return;
    const hit = new THREE.Vector3();
    if (!(e.ray as THREE.Ray).intersectPlane(drag.plane, hit)) return;
    const next = hit.add(drag.offset);
    next.y = BED_Y;
    drag.moved = true;
    meshRef.current!.position.copy(next);
  }

  async function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.moved) return;
    const pos = meshRef.current!.position;
    const res = await slicerClient.setInstanceOffset(data.buffer.objectIdx, 0, pos.x, pos.y, pos.z);
    if (res.ok) setInstanceOffset([pos.x, pos.y, pos.z]);
  }

  return (
    <group position={[data.buffer.offset[0], data.buffer.offset[1], data.buffer.offset[2]]}>
      <mesh
        ref={meshRef}
        geometry={data.geometry}
        onClick={select}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <meshStandardMaterial
          color={selected ? '#3b82f6' : '#cbd5e1'}
          roughness={0.6}
          metalness={0.1}
        />
      </mesh>
    </group>
  );
}
```

- [ ] **Step 4: Write `BedPlate.tsx` + `Scene.tsx` + `Viewport.tsx`**

```tsx
// packages/slicer-app/src/components/workspace/viewport/BedPlate.tsx
import * as THREE from 'three';
import { Grid } from '@react-three/drei';

export const BED_SIZE = 220;

export function BedPlate() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[BED_SIZE / 2, 0, BED_SIZE / 2]}>
        <planeGeometry args={[BED_SIZE, BED_SIZE]} />
        <meshStandardMaterial color="#1e293b" roughness={0.9} />
      </mesh>
      <Grid
        position={[BED_SIZE / 2, 0.01, BED_SIZE / 2]}
        args={[BED_SIZE, BED_SIZE]}
        cellSize={10}
        cellThickness={0.5}
        cellColor="#334155"
        sectionSize={50}
        sectionThickness={1}
        sectionColor="#475569"
        fadeDistance={500}
        fadeStrength={1}
        infiniteGrid={false}
      />
      <axesHelper args={[30]} />
    </group>
  );
}
```

```tsx
// packages/slicer-app/src/components/workspace/viewport/Scene.tsx
import { useModelLoader } from './useModelLoader';
import { BedPlate } from './BedPlate';
import { ModelMesh } from './ModelMesh';

export function Scene() {
  const objects = useModelLoader();
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 200, 150]} intensity={1.2} />
      <BedPlate />
      {objects.map((o) => (
        <ModelMesh key={o.buffer.objectIdx} data={o} />
      ))}
    </>
  );
}
```

```tsx
// packages/slicer-app/src/components/workspace/viewport/Viewport.tsx
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Scene } from './Scene';
import { useSettingsStore } from '../../stores/useSettingsStore';

export function Viewport() {
  const setSelected = useSettingsStore((s) => s.setSelectedObject);
  return (
    <Canvas
      camera={{ position: [200, 160, 200], fov: 45 }}
      dpr={[1, 2]}
      onPointerMissed={() => setSelected(null)}
    >
      <color attach="background" args={['#0f172a']} />
      <Scene />
      <OrbitControls
        makeDefault
        enableDamping
        // LEFT = orbit, RIGHT = pan, MIDDLE = zoom: select-drag is handled
        // on the mesh (ModelMesh onPointerDown), so orbit stays on left
        // only when NOT starting on a selected object.
      />
    </Canvas>
  );
}
```

> **Drag vs orbit note:** with LEFT orbit + drag-on-object, moving the mouse
> on a selected object drags it; clicking empty space orbits. `OrbitControls`
> stops propagating when the pointer is captured by the mesh handler. If
> fights occur in manual testing, switch `OrbitControls` to `mouseButtons={{LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN}}` and rely on `e.stopPropagation()` + pointer capture; the store's `selectedObject` stays the source of truth either way.

- [ ] **Step 5: Wire `modelLoaded` in the Open flow (Toolbar.tsx)**

After a successful `loadModel`, call `useSettingsStore.getState().setModelLoaded(true)`; before the dialog, `setModelLoaded(false)` + `setSelectedObject(null)`.

- [ ] **Step 6: Verify**

Run: `pnpm install && pnpm --filter desktop typecheck && pnpm --filter desktop test`
Expected: exit 0 (2 store tests PASS). Manual: `VITE_USE_MOCK=1 pnpm --filter desktop dev` — open a file, see the cube on the bed, orbit/select/drag.

- [ ] **Step 7: Commit**

```bash
git add packages/slicer-app/src/components/workspace/viewport apps/desktop/src/renderer/src/stores apps/desktop/src/renderer/src/components/toolbar
git commit -m "feat: R3F viewport — bed grid, model mesh from wasm buffers, orbit/select, drag-move on plate"
```

---

### Task 9: Slice orchestration + preview (toolpath lines, layer scrubber)

After a slice, the store holds `layers`; the preview fetches
`getSliceResult()` and renders per-feature toolpath `LineSegments`, with a
layer scrubber (slider) driving per-layer draw ranges (design §Electron App
"preview: toolpath + layer slider").

**Files:**
- Create: `packages/slicer-app/src/components/workspace/viewport/ToolpathLines.tsx`, `.../viewport/LayerScrubber.tsx`, `.../viewport/PreviewLayer.tsx` (scrubber state + draw-range computation), `.../viewport/useSliceResult.ts`
- Modify: `packages/slicer-app/src/components/workspace/viewport/Scene.tsx` (render preview when done), `packages/slicer-app/src/components/layout/StatusBar.tsx` (layer info), `packages/slicer-app/src/components/layout/Toolbar.tsx` (slice → fetch result on done)

**Interfaces:**
- Consumes: `ClientSliceResult` (Task 2), stores (Task 5), `getSliceResult()` (Task 7).
- Produces: `useSliceResult` — fetch on `status === 'done'`, build a `BufferGeometry` (toolpath positions + per-feature colors via vertex colors), cache by `layers`; `ToolpathLines` — `<lineSegments>` with vertex colors (feature palette) + `setDrawRange` per layer; `LayerScrubber` — slider `[0, maxLayer]` stored in `useSlicerStore.layer` (new), default `maxLayer`.

- [ ] **Step 1: Extend `useSlicerStore` (layer + range state) + test**

```ts
// useSlicerStore.ts additions
layer: number,           // scrubber position (0-based, default = max)
maxLayer: number,
setLayer: (n: number) => void,
setMaxLayer: (n: number) => void,
// state defaults: layer: 0, maxLayer: 0
```

```ts
// useSlicerStore.test.ts (new)
import { describe, it, expect } from 'vitest';
import { useSlicerStore } from './useSlicerStore';

describe('useSlicerStore', () => {
  it('tracks slice status and scrubber range', () => {
    const s = useSlicerStore.getState();
    s.setStatus('slicing');
    s.setProgress(42);
    s.setLayers(80);
    s.setMaxLayer(79);
    s.setLayer(40);
    expect(useSlicerStore.getState().status).toBe('slicing');
    expect(useSlicerStore.getState().progress).toBe(42);
    expect(useSlicerStore.getState().layer).toBe(40);
  });
});
```

- [ ] **Step 2: Write `useSliceResult.ts`**

```ts
// packages/slicer-app/src/components/workspace/viewport/useSliceResult.ts
import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { slicerClient } from '../../slicer/slicerClient';
import { useSlicerStore } from '../../stores/useSlicerStore';
import type { ClientSliceResult } from '@slicer/client';

export interface ToolpathGeometry {
  geometry: THREE.BufferGeometry;
  /** per-layer [start, count] index ranges into the geometry */
  layerRanges: Array<[number, number]>;
}

export function useSliceResult() {
  const status = useSlicerStore((s) => s.status);
  const layers = useSlicerStore((s) => s.layers);
  const setLayers = useSlicerStore((s) => s.setLayers);
  const setMaxLayer = useSlicerStore((s) => s.setMaxLayer);
  const [result, setResult] = useState<ClientSliceResult | null>(null);

  useEffect(() => {
    if (status !== 'done') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await slicerClient.getSliceResult();
        if (!r.ok) throw new Error(r.error ?? 'getSliceResult failed');
        if (cancelled) return;
        setResult(r);
        setLayers(r.layers);
        setMaxLayer(Math.max(0, r.layers - 1));
      } catch (err) {
        console.error('slice result fetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [status, setLayers, setMaxLayer]);

  const toolpath = useMemo<ToolpathGeometry | null>(() => {
    if (!result) return null;
    const t = result.toolpath;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    geometry.setDrawRange(0, 0); // scrubber controls visibility

    // vertex colors from the feature palette
    const colors = new Float32Array(t.vertexCount * 3);
    for (let i = 0; i < t.vertexCount; i++) {
      const c = t.palette[t.features[i] % t.palette.length]?.color ?? [255, 255, 255];
      colors[i * 3] = c[0] / 255;
      colors[i * 3 + 1] = c[1] / 255;
      colors[i * 3 + 2] = c[2] / 255;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Toolpath vertices are emitted in gcode order — layer-ascending and
    // contiguous per layer (GCodeProcessorResult.moves). One pass builds
    // per-layer [start, count] draw ranges (drawRange counts vertices);
    // O(n), safe for million-vertex toolpaths (no spread/scan-per-layer).
    const layerRanges: Array<[number, number]> = [];
    if (t.vertexCount > 0) {
      let start = 0;
      let cur = t.layers[0];
      for (let i = 1; i < t.vertexCount; i++) {
        if (t.layers[i] !== cur) {
          layerRanges[cur] = [start, i - start];
          start = i;
          cur = t.layers[i];
        }
      }
      layerRanges[cur] = [start, t.vertexCount - start];
    }
    return { geometry, layerRanges };
  }, [result]);

  return { result, toolpath };
}
```

- [ ] **Step 3: Write `ToolpathLines.tsx`**

```tsx
// packages/slicer-app/src/components/workspace/viewport/ToolpathLines.tsx
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useSlicerStore } from '../../stores/useSlicerStore';
import type { ToolpathGeometry } from './useSliceResult';

export function ToolpathLines({ data }: { data: ToolpathGeometry }) {
  const ref = useRef<THREE.LineSegments>(null);
  const layer = useSlicerStore((s) => s.layer);

  useEffect(() => {
    const range = data.layerRanges[layer] ?? [0, 0];
    data.geometry.setDrawRange(range[0], range[1]);
  }, [data, layer]);

  return (
    <lineSegments ref={ref} geometry={data.geometry} frustumCulled={false}>
      <lineBasicMaterial vertexColors depthTest={false} transparent opacity={0.95} />
    </lineSegments>
  );
}
```

- [ ] **Step 4: Write `LayerScrubber.tsx` + wire into the viewport**

```tsx
// packages/slicer-app/src/components/workspace/viewport/LayerScrubber.tsx
import { useSlicerStore } from '../../stores/useSlicerStore';
import { Slider } from '../ui/slider';
import { Label } from '../ui/label';

export function LayerScrubber() {
  const layer = useSlicerStore((s) => s.layer);
  const maxLayer = useSlicerStore((s) => s.maxLayer);
  const setLayer = useSlicerStore((s) => s.setLayer);

  if (maxLayer <= 0) return null;

  return (
    <div className="absolute bottom-3 left-1/2 w-96 -translate-x-1/2 rounded-md border bg-card/90 p-3 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Layer</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {layer + 1} / {maxLayer + 1}
        </span>
      </div>
      <Slider
        min={0}
        max={maxLayer}
        step={1}
        value={[layer]}
        onValueChange={(v) => setLayer(v[0])}
      />
    </div>
  );
}
```

Wire into `Viewport.tsx` (absolute overlay) + `Scene.tsx`:

```tsx
// Scene.tsx additions
import { useSliceResult } from './useSliceResult';
import { ToolpathLines } from './ToolpathLines';

export function Scene() {
  const objects = useModelLoader();
  const { toolpath } = useSliceResult();
  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[100, 200, 150]} intensity={1.2} />
      <BedPlate />
      {objects.map((o) => (
        <ModelMesh key={o.buffer.objectIdx} data={o} />
      ))}
      {toolpath && <ToolpathLines data={toolpath} />}
    </>
  );
}
```

```tsx
// Viewport.tsx — add <LayerScrubber /> as an absolute overlay inside the container
<div className="absolute inset-0">
  <Canvas ...>...</Canvas>
  <LayerScrubber />
</div>
```

- [ ] **Step 5: Toolbar slice() → also fetch result when done (keep store-driven)**

The slice button already sets `status('done')`; `useSliceResult` reacts. Verify the flow end to end: slice → progress → done → preview visible.

- [ ] **Step 6: Verify**

Run: `pnpm --filter desktop typecheck && pnpm --filter desktop test && pnpm --filter slicer-wasm test`
Expected: exit 0 (3 store tests PASS, slicer-wasm 14 PASS). Manual: `VITE_USE_MOCK=1 pnpm --filter desktop dev` — open file, Slice, scrub layers, see toolpath clip by layer.

- [ ] **Step 7: Commit**

```bash
git add packages/slicer-app/src/components/workspace/viewport apps/desktop/src/renderer/src/stores apps/desktop/src/renderer/src/components/status apps/desktop/src/renderer/src/components/toolbar
git commit -m "feat: slice preview — toolpath LineSegments with layer scrubber draw ranges"
```

---

### Task 10: Export G-code through native save dialog

The v1 flow's last step: `exportGcode()` → MEMFS bytes → native save dialog →
file on disk (design §Electron App "export gcode through native save dialog").

**Files:**
- Modify: `packages/slicer-app/src/components/layout/Toolbar.tsx` (wire the Export button)

**Interfaces:**
- Consumes: `slicerClient.exportGcode()` (Task 2/7), `window.orca.saveFileDialog/writeFile` (Task 4), `useSlicerStore` (Task 5).

- [ ] **Step 1: Wire the Export button**

```tsx
// Toolbar.tsx — replace the Export button with a handler
const [exporting, setExporting] = useState(false);
const setError = useSlicerStore((s) => s.setError);

async function exportGcode() {
  if (exporting) return;
  setExporting(true);
  try {
    const res = await slicerClient.exportGcode();
    if (!res.ok) throw new Error(res.error ?? 'export failed');
    const { path } = await window.orca.saveFileDialog('output.gcode', [
      { name: 'G-code', extensions: ['gcode'] },
    ]);
    if (!path) return; // canceled — nothing to do
    await window.orca.writeFile(path, res.bytes.buffer.slice(
      res.bytes.byteOffset,
      res.bytes.byteOffset + res.bytes.byteLength,
    ) as ArrayBuffer);
  } catch (err) {
    setError(`export: ${String(err)}`);
  } finally {
    setExporting(false);
  }
}

// Button:
<Button size="sm" variant="default" disabled={busy || exporting} onClick={exportGcode}>
  <Download className="h-4 w-4" /> {exporting ? 'Exporting…' : 'Export'}
</Button>
```

- [ ] **Step 2: Verify**

Run: `pnpm --filter desktop typecheck && pnpm --filter desktop build`
Expected: exit 0. Manual (mock or real module): slice → Export → save dialog → file appears with the gcode header line.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/toolbar
git commit -m "feat: export gcode through native save dialog (MEMFS bytes -> writeFile)"
```

---

### Task 11: Roadmap sync + M2 notes

**Files:**
- Modify: `spec/Grand Plan.md` (M2 checkboxes as delivered), `doc/high_level_dev_plan.md` (Milestone 2 status line)
- Create: `doc/2026-08-13-m2-implementation-notes.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the record a fresh engineer needs (docs-first practice).

- [ ] **Step 1: Update `spec/Grand Plan.md`**

Check off the seven M2 boxes actually delivered. If any item was only partially
delivered (e.g. a field wired but not verified against the real module), leave
its box unchecked and note it.

- [ ] **Step 2: Update `doc/high_level_dev_plan.md`**

Add a status line to Milestone 2 ("Delivered 2026-08-13: … — see
`doc/2026-08-13-m2-implementation-notes.md`") or mark the remaining work if
partial.

- [ ] **Step 3: Write `doc/2026-08-13-m2-implementation-notes.md`**

Header block (title/date/status/scope); the binary-buffer contracts (model
mesh, toolpath — pointer to the Task 1 mock as the spec);
worker protocol (request/response/progress); the `stage:wasm` + `VITE_USE_MOCK`
dev workflow; every drift fix actually hit at the pinned SHA (bridge function
signatures, option keys); known M3 work
(packaging, e2e, full preset bundle, cross-check).

- [ ] **Step 4: Verify the acceptance criteria once more**

Run:
```bash
pnpm test
pnpm --filter desktop typecheck && pnpm --filter desktop build
node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
```
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add spec/Grand\ Plan.md doc/high_level_dev_plan.md doc/2026-08-13-m2-implementation-notes.md
git commit -m "docs: mark M2 delivered, add M2 implementation notes"
```

---

## Self-Review

- **Spec coverage (Grand Plan M2):** JS client + worker glue + mock-module
  unit tests → Tasks 1–3; Electron shell (main/preload/renderer, native
  dialogs, COOP/COEP) → Task 4; settings UI from option metadata → Tasks 5–6;
  3D viewport (R3F bed/models/orbit/select/move) → Task 8; slice orchestration
  (config JSON → progress → result buffers) → Tasks 6–7 (slice) + Task 9
  (result); preview (toolpath + layer scrubber) → Task 9;
  export through native save dialog → Task 10. Design-doc specifics covered:
  promise-based client API with transferables (Tasks 2–3), public-dir wasm
  staging + mock fallback for emsdk-less dev (Tasks 3, 6), metadata-driven settings
  (Task 6), `GCodeProcessorResult` toolpath with
  per-layer draw ranges (Task 7/9), COOP/COEP session headers (Task 4), i18n
  English-only (no task, by design).
- **Placeholder scan:** the one genuinely uncertain piece — the
  `GCodeProcessor`/`MoveVertex` field names — is a named iterate surface with
  a verify step (Task 7 Step 1). No "TODO" or "similar to Task N" remains.
- **Type consistency:** `ClientSliceResult`/`ClientToolpath`
  (Task 2 types.ts) match the mock's JSON keys (Task 1) and the C++ JSON keys
  (Task 7) — `vertex_ptr/vertex_count`, `layer_ptr/layer_count`,
  `feature_ptr/feature_count`; the worker protocol
  types (`WorkerMessage`) match `createWorkerClient`'s transport in Task 3 and
  the app's `makeTransport` in Task 6; store action names
  (`setModelLoaded/setSelectedObject/setInstanceOffset/setLayer/setMaxLayer`)
  are consistent across Tasks 5/8/9.
- **Known residual risk (by design):** the real-module verification depends on
  the M1 build environment (emsdk + ~50 GB) — everything is testable without
  it via the mock; the binary-buffer bridge work is the biggest drift surface
  and carries the explicit verify step + fallback.
