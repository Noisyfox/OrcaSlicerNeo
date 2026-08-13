# M2 Implementation Notes

Date: 2026-08-13
Status: Delivered — Milestone 2 (Electron Vertical Slice) acceptance verified
2026-08-13 (real-module smoke deferred — see Verification)
Scope: The record a fresh engineer needs for the M2 vertical slice: what was
delivered (Tasks 1–10 of `doc/2026-08-13-m2-implementation-plan.md`), the
binary-buffer bridge contracts, the worker protocol, the
`stage:wasm` + `VITE_USE_MOCK` dev workflow, every drift fix actually hit at
the pinned SHA (`b97ca3c0ac`), and the known M3 work. Companion to the
approved design (`doc/2026-08-12-electron-gui-rewrite-design.md`), the
milestone checklist (`spec/Grand Plan.md`), and `doc/high_level_dev_plan.md`.

## Overview

Milestone 2 delivers the v1 user flow end to end in the Electron app: load
STL/3MF → configure → slice → 3D preview (sliced mesh + toolpath + layer
slider) → export G-code. The renderer never touches the WASM module: it talks
to `packages/slicer-wasm/src/client` (promise-based, typed), which runs inside
a Web Worker; binary buffers cross the wasm heap (`_malloc`/`_free` +
`HEAPU8`) as transferable-copied typed arrays, never JSON.

Everything in this milestone is testable without emsdk: the client's contract
tests run against `src/client/testing/mock-module.ts` (bridge-shaped, no
node_modules wasm), and the same mock drives the app's dev fallback
(`VITE_USE_MOCK=1`). The binary-buffer bridge (`src/bridge_buffers.cpp`) is
the biggest drift surface and carries an explicit verify step against the
real module on an emsdk machine (see Verification).

## What was delivered (Tasks 1–10)

| Task | Deliverable |
|---|---|
| 1 | Bridge-shaped mock module + vitest rig (contract spec for every binary buffer) |
| 2 | Typed JS client: `loadModel` / `getPresets` / `getOptionMetadata` / `setInstanceOffset` / `getModelMesh` / `slice(config, onProgress)` / `getSliceResult` / `exportGcode` / `cancel`, heap marshaling (`_malloc`/`_free` + `HEAPU8`), typed-array copies out |
| 3 | Web Worker glue: `request`/`response`/`progress` protocol, `createWorkerClient` transport proxy, `startWorker` entry |
| 4 | Electron shell: main/preload/renderer (electron-vite), zustand stores, `contextIsolation` + preload `contextBridge` API (open/save dialogs, file IO, window controls), COOP/COEP session headers |
| 5 | Renderer base: tailwind + shadcn/ui primitives, app shell layout |
| 6 | App boot + metadata-driven settings: worker client wiring, presets + option metadata load, settings panel rendered from `orc_get_option_metadata()` (no duplicated schema), config round-trip as JSON |
| 7 | C++ binary-buffer bridge: model mesh, instance offset, toolpath + sliced mesh in `orc_get_slice_result` (`bridge.cpp` + `bridge_buffers.{hpp,cpp}`) |
| 8 | R3F viewport: bed plate + grid, model meshes from WASM triangle buffers, orbit/select, drag-move on plate (world-space offset commit) |
| 9 | Slice preview: toolpath `LineSegments` + per-feature colored sliced mesh + layer scrubber (`setDrawRange`) |
| 10 | G-code export: `exportGcode()` → MEMFS bytes → native save dialog |

Plus one follow-up fix commit: slice status reset on model load (stale-export
gate) so an export cannot reuse a previous slice's result.

## Binary-buffer contracts (the M2 bridge surface)

The layout of every buffer is specified by the Task 1 mock —
`packages/slicer-wasm/src/client/testing/mock-module.ts` — and mirrored by the
C++ producer `packages/slicer-wasm/src/bridge_buffers.cpp` and the client
reader `src/client/client.ts`. JSON keys are the post-rename names at the
pinned SHA. All binary arrays cross as `{ptr, count}` heap pointer pairs;
the JS side copies the bytes out (`HEAPU8.slice`) into fresh typed arrays and
`_free()`s the block (heap.ts `readBytes`).

**Model mesh** (`orc_get_model_mesh` → `ModelMeshResult`), one entry per object:

| Key | Type | Meaning |
|---|---|---|
| `object_idx` | number | object index |
| `vertex_ptr` / `vertex_count` | number | Float32Array xyz per vertex |
| `index_ptr` / `index_count` | number | Uint32Array triangle index triples |
| `offset` | [x,y,z] | instance offset on the plate |

**Toolpath** (`orc_get_slice_result` → `ClientToolpath`):

| Key | Type | Meaning |
|---|---|---|
| `vertex_ptr` / `vertex_count` | number | Float32Array xyz per toolpath vertex |
| `layer_ptr` / `layer_count` | number | Uint32Array layer_id per vertex |
| `feature_ptr` / `feature_count` | number | Uint32Array palette index per vertex |
| `features` | JSON array | palette: `[{id, name, color:[r,g,b]}]` (client clamps out-of-range palette indexes) |

**Sliced mesh** (`orc_get_slice_result` → `ClientSlicedMesh`):

| Key | Type | Meaning |
|---|---|---|
| `vertex_ptr` / `vertex_count` | number | Float32Array xyz per mesh vertex |
| `index_ptr` / `index_count` | number | Uint32Array triangle index triples |
| `layer_ptr` / `layer_count` | number | Uint32Array layer_id per TRIANGLE (count = triangle count) |

The slice-result JSON also carries `{"ok", "objects", "layers",
"unrecognized_keys"}` stats and the `palette` array. Contract tests:
`src/client/client.test.ts` (10 tests) + `src/client/worker.test.ts` (4).

## Worker protocol

`packages/slicer-wasm/src/client/worker.ts` — all bridge work happens on the
worker thread; the UI thread never blocks:

- main → worker: `{type:'request', id, op, args}`
- worker → main: `{type:'response', id, ok, result}` (or `ok:false, error`)
- worker → main: `{type:'progress', percent, text}` (no id)

`createWorkerClient` dispatches through a Proxy: any string property access
returns a `call(op, args)`-bound function (unknown ops reject from the
worker's `{ok:false}` response), `then`/symbols return undefined so the client
is never a thenable, and `slice` is special-cased to subscribe the caller's
progress callback locally (a function arg would `DataCloneError` in a real
worker). The app's entry is `apps/desktop/src/renderer/src/slicer/slicer.worker.ts`
— the only app file that imports the WASM module — with the transport in
`slicerClient.ts` (`makeTransport` → `createWorkerClient`).

## `stage:wasm` + `VITE_USE_MOCK` dev workflow (no emsdk needed)

- The real module builds via `bash packages/slicer-wasm/build.sh` (emsdk +
  ~50 GB, see `doc/2026-08-12-wasm-build-notes.md`); artifacts land in
  `packages/slicer-wasm/out/orca_slice.{js,wasm}`.
- `pnpm stage:wasm` runs `scripts/stage-wasm.mjs`: copies
  `out/orca_slice.{js,wasm}` into `apps/desktop/src/renderer/public/wasm/`.
  The worker dynamic-imports `/wasm/orca_slice.js` with `noInitialRun: true`.
- Without a staged build, dev runs the bridge-shaped mock instead:
  `VITE_USE_MOCK=1 pnpm --filter desktop dev` (worker swaps in
  `createMockModule`). UI work proceeds with zero emsdk.

## Bridge function set at the pinned SHA (`b97ca3c0ac`)

11 extern "C" exports, all synchronous on the worker thread, JSON-in/JSON-out
(malloc'd C strings the JS side `_free()`s); binary buffers via the heap.
M2 added `orc_set_instance_offset` and `orc_get_model_mesh`; the others carry
over from M1 (M1 doc's `orc_get_slice_result` "JSON stats only" note is now
superseded — it returns the toolpath + sliced-mesh buffers).

| Function | Input | Success JSON |
|---|---|---|
| `orc_init()` | — | `{"ok", "prints", "filaments", "printers"}` |
| `orc_get_presets(kind)` | kind ∈ `print`\|`filament`\|`printer` | `{"presets": [{"name"}]}` |
| `orc_get_option_metadata()` | — | option-name → `{type, label?, full_label?, tooltip?, category?, mode, enum_values?, enum_labels?, min?, max?, default?}` |
| `orc_load_model(data, len, ext)` | heap bytes + length + extension | `{"ok", "objects", "instances"}` |
| `orc_set_progress_callback(cb)` | wasm-table fn `void(*)(int,const char*)` | void |
| `orc_slice(config_json)` | config JSON | `{"ok", "unrecognized_keys"}` (progress via callback) |
| `orc_set_instance_offset(obj, inst, x, y, z)` | ints + doubles | `{"ok"}` |
| `orc_get_model_mesh()` | — | `{"ok", "objects":[{object_idx, vertex_ptr, vertex_count, index_ptr, index_count, offset}]}` |
| `orc_get_slice_result()` | — | `{"ok", "objects", "layers", "toolpath":{...}, "mesh":{...}, "features": palette}` |
| `orc_export_gcode()` | — | `{"ok", "path": "/out.gcode"}` (bytes via `FS.readFile`) |
| `orc_cancel()` | — | `{"ok"}` (state reset: `cancel()` + `restart()`) |

## Drift fixes actually hit at the pinned SHA

All fixed in the scaffold (`bridge.cpp` / `bridge_buffers.cpp` / client) —
the submodule was never edited ad-hoc. Every `Drift at the pinned SHA`
comment in the code marks one of these.

Bridge (`src/bridge.cpp`):

1. `GCodeProcessor.hpp` lives under `GCode/`; there is no `PrintObject.hpp`
   (class `PrintObject` is in `Print.hpp`).
2. Module-scope statics construct **before** `print_config_def` (link order),
   and `PresetBundle`'s constructor chain reads it — observed as "memory
   access out of bounds" when eager. State lives in a lazily-constructed
   `BridgeState` holder (created on the first `orc_*` call).
3. `ConfigOptionType` has no `coVec3d` (enum ends at `coPointsGroups`) —
   such options map to `"unknown"`.
4. `PresetCollection::m_presets` is private — iterate the public
   `begin()/end()` range (skips the generated "- default -").
5. `PrintConfigDef::defs()` doesn't exist — use `print_config_def.options`.
6. `Model` has no instance accessor — sum per `ModelObject::instances`.
7. `validate()` returns `StringObjectException` — use its `.string` member.
8. `SlicingStatus` is nested as `PrintBase::SlicingStatus` (and
   `status_callback_type` is `PrintBase`'s typedef) — qualify it.
9. `Print::objects()` is an accessor, not a member.
10. **Option keys are the post-rename names.** Ground truth is
    `orc_get_option_metadata()` — never hard-code a key without checking it
    there. `orc_slice` starts from `DynamicPrintConfig::full_print_config()`
    and applies JSON keys per-key with one shared
    `ConfigSubstitutionContext{Disable}`: `handle_legacy()` drops keys
    unknown at the pin but records them, and they surface in the additive
    `unrecognized_keys` field instead of silently vanishing (the old strict
    path threw the context away — the smoke's pre-rename keys
    `temperature`/`perimeters`/`bed_shape` sliced on defaults while reporting
    `{"ok": true}`). Multi-line JSON values (`"\\n"` escapes) are restored to
    real newlines. The app warns on dropped keys (`Toolbar.tsx`,
    `console.warn`).

Buffers (`src/bridge_buffers.cpp`):

11. `SlicesToTriangleMeshParams`/`SlicesToTriangleMesh`
    (`TriangleMeshSlicer.hpp`) do **not** exist at the pin — the per-layer
    sliced mesh uses the documented raw-soup fallback:
    `triangulate_expolygons_3d(lslices, z, NORMALS_UP)` (Tesselate.hpp), the
    same cap tesselation the missing Prusa API used; its Vec3d triangle soup
    feeds the emit loop 1:1.
12. `Layer` has no `slices` member (that is per-region,
    `LayerRegion::slices`) — `Layer::lslices` is the layer's merged
    ExPolygons, the direct input for the triangulator.
13. `ExPolygon::triangulate_self()` / `triangles` don't exist at the pin.
14. `MoveVertex::extrusion_role` is the extrusion-role field
    (`MoveVertex::type` is the `EMoveType` move classification); the palette
    is keyed by `ExtrusionRole`.
15. `MoveVertex::layer_id` is unsigned at the pin — no `< 0` case.
16. No `erBridges` enumerator — the bridge role is `erBridgeInfill`
    (Bridge palette entry as briefed).

wasm64 marshaling (client + harness):

17. Heap pointers cross the `ccall` boundary as BigInt — the client uses
    `'pointer'` arg types and `Number()`-casts on the way back, and the
    progress `text` arrives as BigInt → `UTF8ToString(Number(text))`.
    Documented in `harness/bridge-smoke.mjs`; do not "fix".

## Progress-callback (stale-slot) discipline

`g_progress` in the bridge is a raw fn ptr with no `orc_*` clear path. The
client registers the progress callback **once** at module init and never
calls `removeFunction` on it — a stale index into a nulled table slot makes
the next `process()` trap (uncatchable, module dies). Where any code does
remove a callback (the bridge smoke), it clears the slot first via
`orc_set_progress_callback(0)`. The bridge registers the sink at init, so
every slice reports progress even with no listener attached.

## Known M3 work

- **Packaging** (electron-builder): Windows x64/arm64 (NSIS), Linux
  x64/arm64 (AppImage), macOS x64/arm64 (DMG) — all six ship the same
  `.wasm`; `stage:wasm` must run in the pipeline.
- **Playwright Electron e2e** covering the full v1 flow, in CI.
- **Full preset bundle**: replace the curated subset with the full
  `resources/profiles` via `--preload-file` (+ `nozzle_info.json` embed;
  the M1 note's benign `get_hrc_by_nozzle_type` parse error goes away).
- **Slice-output cross-check** vs desktop OrcaSlicer (same model + profile).
- **Root `LICENSE`** (AGPL-3.0) + source-offer notes.
- **Multi-object preview** is v1-sliced-mesh-first-object-only (full
  multi-object is M4).

## Verification (acceptance, delivery machine 2026-08-13)

Ran and green (exit 0):

- `pnpm test` — slicer-wasm: 2 test files, **14 tests passed**
  (`worker.test.ts` 4, `client.test.ts` 10); desktop: 3 test files,
  **5 tests passed** (`useSettingsStore.test.ts` 2, `useSlicerStore.test.ts`
  1, `stores.test.ts` 2).
- `pnpm --filter desktop typecheck` — `tsc --noEmit` on
  `tsconfig.node.json` + `tsconfig.web.json`, exit 0.
- `pnpm --filter desktop build` — electron-vite build, exit 0 (main
  `index.js` 3.23 kB, preload `index.js` 0.96 kB, renderer 2247 modules,
  worker chunk `slicer.worker-*.js` 5.99 kB).

Deferred (no emsdk on the delivery machine — no `emcc`, no
`packages/slicer-wasm/out/`, no ~/emsdk; the real `.wasm` requires the ~50 GB
M1 build environment per `doc/2026-08-12-wasm-build-notes.md`):

- WASM rebuild (`bash packages/slicer-wasm/build.sh`)
- `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`
- `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json`
- Manual GUI pass (human-run; Playwright e2e is M3)

The binary-buffer bridge is unit-tested against the mock (14 client/worker
contract tests) and carries the explicit verify step above — run it on an
emsdk machine before declaring M3.
