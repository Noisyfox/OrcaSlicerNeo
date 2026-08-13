# Electron GUI Rewrite Design

Date: 2026-08-12
Status: Approved (brainstorming session, 2026-08-12)
Scope: v1 vertical slice of a rebuilt OrcaSlicer desktop GUI on Electron + React

## Executive Summary

Rebuild the OrcaSlicer desktop GUI on Electron + React + TypeScript + Vite + shadcn/ui.
The existing wxWidgets GUI (371k LOC) is **not** ported. The C++ slicing core
(`libslic3r`) is reused as-is, compiled to **WebAssembly via Emscripten**, and called
from JS. v1 delivers the vertical slice: load STL/3MF → configure basic print settings →
slice → 3D preview (sliced mesh + G-code toolpath) → export G-code.

Feasibility is proven by a phase-0 compile spike (external reference
implementation; GO verdict, 2026-07-24: Emscripten 6.0.4, OrcaSlicer v2.4.2):
154/192 libslic3r objects compile clean with a serial TBB shim and header-only
deps; remaining blockers are itemized, mechanical, and bounded. This design
adopts the spike's machinery wholesale where it fits.

A single `.wasm` serves all six target platforms (Windows x64/arm64, Linux x64/arm64,
macOS x64/arm64) — one of the reasons for the WASM choice.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| C++↔JS bridge | **Emscripten WASM**, extern "C" JSON-in/JSON-out API | User directive; one artifact for 6 platforms |
| WASM runtime location | **Renderer Web Worker** | UI never blocks; binary data transfers directly to Three.js via transferable ArrayBuffers, no IPC hops |
| Threading in WASM | **Serial-first** — the spike's serial TBB shim (`shim/_serial.hpp`), no TBB, no pthreads in v1 | oneTBB has no maintained Emscripten port; the shim runs `tbb::parallel_*` inline, correct for order-independent slice work. Parallelism (wasmtbb + pthreads + COOP/COEP) is a later phase |
| Memory model | **wasm64 (`-sMEMORY64`)**, per spike FINDINGS | Fixes the whole size_t-narrowing class (e.g. `GCode.hpp:179`) in one flag; >4 GB heap headroom. Fallback: wasm32 + one-line `std::numeric_limits<size_t>::max()` fix |
| Dependency scope (v1) | **Trim to FDM MVP core**: Eigen 5.0.1, Boost 1.84 (headers + 12 static archives, wasm64-built), cereal, + vendored `deps_src/` (clipper2, admesh, qhull, libigl, expat, minilzo, nlohmann, …). **Dropped**: CGAL (MeshBoolean/CutSurface), OpenVDB (SLA), OCCT (STEP), OpenCV, networking (OpenSSL/CURL), thumbnails (png/jpeg), GUI | Spike-proven; hardest-to-port deps are all outside the FDM slice path |
| Formats (v1) | **STL + 3MF** (spike dropped `/Format/3mf`; we re-add it — expat/minilzo are in-tree) | 3MF is OrcaSlicer's native project format; STEP deferred with OCCT |
| Repo layout | Monorepo: `doc/`, `spec/`, `apps/desktop`, `packages/slicer-wasm`, `tools/`, `scripts/`, `tests/`, pnpm workspaces | Mirrors the reference repo's conventions (see References) |
| C++ source | **git submodule** `packages/slicer-wasm/cpp/` → `Noisyfox/OrcaSlicer`, pinned to a commit SHA (initially the fork's current master HEAD; spike pinned v2.4.2 — bridge signatures may need drift fixes, the spike's "expected place to iterate") | User directive: submodule so it can be modified if necessary; only a tiny patch set (`.patch` files) touches it |
| Settings UI | Rendered generically from `ConfigOptionDef` metadata exported as JSON by the bridge (`orc_get_option_metadata`) | Reuses the exact metadata `Tab.cpp` uses today (type/label/enum/min/max/mode/category); no duplicated schema |
| Preview (v1) | Sliced-result per-feature mesh + G-code toolpath lines (`GCodeProcessorResult` moves) with layer slider, rendered in Three.js | User chose the fuller preview; libvgcode port deferred |
| i18n | English-only for v1; i18next + `.po`→JSON conversion later | YAGNI; the gettext catalog exists at `localization/i18n/` |
| Packaging | electron-builder: win x64/arm64 (NSIS), linux x64/arm64 (AppImage), mac x64/arm64 (DMG); unsigned v1; same `.wasm` in all six | CI matrix later |

## Licensing

OrcaSlicerNeo is a fork of AGPL-3.0 OrcaSlicer. The entire repo — Electron app, WASM
module, and the submodule's `libslic3r` — is AGPL-3.0. No boundary is needed (unlike
the reference plan's slicer module, isolated as its own AGPL package). The repo
should carry a root `LICENSE` (AGPL-3.0) and keep source-offer obligations in mind
when distributing.

## Architecture

```
┌────────────────────────── Electron (apps/desktop) ──────────────────────────┐
│ main process                preload (contextBridge)      renderer (React)    │
│ • window mgmt                • dialog/file APIs           • shadcn/ui UI      │
│ • native dialogs             • window controls            • zustand stores    │
│ • COOP/COEP headers                                      │ • R3F 3D viewport │
│                                                          │                    │
│                              Web Worker ─────────────────► WASM module        │
│                              (slicer client)             (packages/slicer-   │
│                              promise-based API            wasm: libslic3r +  │
│                              transferable buffers         bridge)            │
└──────────────────────────────────────────────────────────────────────────────┘
```

Data path: WASM heap ↔ typed-array views ↔ transferable ArrayBuffers → Three.js
`BufferGeometry`. All slice work happens on the worker thread; the UI thread never
blocks.

## Repository Structure

```
OrcaSlicerNeo/
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── project_structure_and_guidelines.md
├── doc/                               # dated engineering docs (YYYY-MM-DD-topic.md)
├── spec/
├── apps/
│   └── desktop/                       # Electron app (main / preload / renderer)
├── packages/
│   └── slicer-wasm/                   # WASM module: build scaffold + bridge + JS client
│       ├── cpp/                       # git submodule → Noisyfox/OrcaSlicer @ pinned SHA
│       ├── CMakeLists.txt             # spike-style scaffold (GLOB + DROP_PATTERNS + stubs/)
│       ├── stubs/                     # dropped-feature symbol stubs
│       ├── shim/_serial.hpp           # serial TBB shim (+ parallel_pipeline stand-in)
│       ├── patches/                   # Model.hpp STEP guard, clang tweaks, distance_to_squared
│       ├── src/                       # bridge.cpp (extern "C" API) + slice_main.cpp CLI
│       ├── src/client/                # typed JS client + worker glue
│       ├── build.sh                   # emsdk → patches → shim gen → emcmake → artifacts
│       └── build-boost-wasm64.sh      # from the spike
├── tools/
├── scripts/
├── tests/                             # e2e (Playwright Electron) + fixtures
├── package.json                       # root scripts
└── pnpm-workspace.yaml
```

## C++/WASM Build (packages/slicer-wasm)

Adapted from the spike; do not reinvent. Inherited wholesale:

- **Scaffold CMake** (`cmake/CMakeLists.txt` equivalent): `file(GLOB_RECURSE)` over
  `cpp/src/libslic3r/*.cpp`, `DROP_PATTERNS` denylist, `stubs/*.cpp` glob. Configured
  via `emcmake`; the upstream build system is untouched.
- **Serial TBB shim** (`shim/_serial.hpp` + generated `tbb/*.h` forwarding headers,
  include-path-first). Gap to close: a serial `parallel_pipeline` stand-in (used only
  by `GCode.cpp`).
- **`build-boost-wasm64.sh`** — b2 + Emscripten toolset, 12 static archives (system,
  filesystem, thread, atomic, chrono, date_time, iostreams, log, log_setup, locale,
  program_options, regex, nowide).
- **Patches** applied by script, maintained as `.patch` files: `Model.hpp` STEP include
  guard (`SLIC3R_WASM_NO_OCCT`), `distance_to_squared` overload fix
  (`AABBTreeLines.hpp`), ~10 clang-strictness tweaks, `GCode.hpp` size_t fix (only if
  wasm32 fallback).
- **Drop set**: `/SLA/`, `OpenVDBUtils`, `Hollowing`, `CutSurface`, `MeshBoolean`,
  `/Format/STEP`, windows-only files, `draco`. Re-add `/Format/3mf` + `bbs_3mf`
  (needed for 3MF; expat/minilzo are vendored in-tree).
- **Emscripten link flags**: `-O3 -fexceptions -sMEMORY64 -sMODULARIZE=1 -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB
  -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall,cwrap,_malloc,_free
  -sDISABLE_EXCEPTION_CATCHING=0`. No `-pthread` in v1 (serial).
- **Resources**: v1 embeds a curated preset subset (default printer + a few popular
  presets) via `--embed-file` into the WASM filesystem; the full `resources/profiles`
  bundle via `--preload-file` later.

### Bridge API (new `src/bridge.cpp`, extern "C")

All calls synchronous on the worker thread; JSON strings and binary buffers cross via
the WASM heap (`_malloc`/`_free` + `HEAPU8` views, standard Emscripten marshaling):

| Function | Purpose | libslic3r reuse |
|---|---|---|
| `orc_init()` | mount embedded presets, load preset collections | `PresetBundle::load_presets` |
| `orc_get_presets(kind)` | JSON list of print/filament/machine presets | `PresetBundle` / `PresetCollection` |
| `orc_get_option_metadata()` | JSON of `ConfigOptionDef` for all options | `PrintConfigDef` (`PrintConfig.cpp`) |
| `orc_load_model(ptr, len, ext)` | model JSON + binary triangle buffers (instance transforms in JSON) | `Model::read_from_file` / 3mf loaders |
| `orc_slice(config_json)` | apply config + run slice; progress via registered JS callback | `Print::apply`, `Print::process`, `set_status_callback` (`SlicingStatus`) |
| `orc_get_slice_result()` | toolpath buffer (per-vertex position/color/layer) + sliced mesh buffer + JSON stats | `GCodeProcessorResult`, `SlicesToTriangleMesh` |
| `orc_export_gcode()` | write gcode to MEMFS; JS reads bytes back | `Print::export_gcode` (thumbnail cb = nullptr) |
| `orc_cancel()` | set cancel flag checked at step boundaries | `PrintBase::cancel()` |

Toolpath buffer layout: interleaved `Float32 xyz` × N vertices + `Uint8 rgb` (palette
indexed) + `Uint32 layer_id`, one flat buffer per feature enum value; layer slider uses
per-layer draw ranges in Three.js.

### slice_main.cpp (retained)

The spike's one-shot CLI driver stays for harness parity (node smoke tests, fixtures).

## Electron App (apps/desktop)

- **Scaffold**: electron-vite (main/preload/renderer), React + TypeScript + Tailwind +
  shadcn/ui, zustand for state, pnpm workspace; runtime pinned (Volta / `.nvmrc`),
  mirroring the reference repo's conventions.
- **Security**: `contextIsolation: true`, `nodeIntegration: false`, preload-only
  `contextBridge` API (`openFileDialog`, `saveFileDialog`, `readFile`, `writeFile`,
  window controls). COOP/COEP response headers set on the session for
  SharedArrayBuffer headroom (threads land later).
- **WASM worker**: `packages/slicer-wasm/src/client` exposes a promise-based typed API
  (`loadModel(bytes, ext)`, `getPresets()`, `getOptionMetadata()`, `slice(configJson,
  onProgress)`, `getSliceResult()`, `exportGcode()`, `cancel()`), bundled by Vite as a
  worker module. Wasm/js/data assets loaded via a custom `app://` scheme or bundled
  assets (worker-compatible).
- **Settings UI**: option groups rendered from `getOptionMetadata()` JSON — same
  metadata `Tab.cpp` renders today. Printer preset dropdown + filament + process
  groups for v1.
- **3D viewport**: react-three-fiber + drei. Bed plate with grid, model meshes from
  WASM triangle buffers, orbit/zoom/pan, object select, basic move-on-plate; gizmos
  (rotate/scale/cut) are v2. Sliced result: per-feature-type colored mesh; toolpath:
  `LineSegments` + per-layer `setDrawRange` scrubber.
- **i18n**: English only in v1.

## v1 User Flow (definition of done)

1. Launch → worker loads WASM → `orc_init()` mounts presets.
2. File → Open → native dialog → bytes → `loadModel` → model on bed in 3D view.
3. Settings panel: pick printer preset, tweak a few options (metadata-driven).
4. **Slice** → `slice(configJson)` with progress bar → sliced mesh + toolpath shown.
5. **Export** → `exportGcode()` → MEMFS bytes → native save dialog → file on disk.
6. Re-slice after setting changes (config diffing via `Print::apply` status).

## Testing & Verification

- **Node smoke** (no Electron): spike harness pattern — stage `fixtures/cube.stl` +
  `config.json` into MEMFS, run `slice_main` via `callMain`, assert exit 0 + `G1` moves;
  the module's `ENVIRONMENT=web,worker,node` makes this work unchanged.
- **Unit** (`vitest`): bridge client + stores against a mock Emscripten module (spike's
  `harness/mock-module.mjs` pattern — runs without emsdk).
- **e2e** (`Playwright` Electron): launch the packaged/dev app, drive the full v1 flow,
  assert gcode file contents.
- **Cross-check**: slice output for `fixtures/cube.stl` consistent with desktop
  OrcaSlicer output for the same profile (spike's GO criterion).

## Packaging

electron-builder config for win x64/arm64 (NSIS), linux x64/arm64 (AppImage), mac
x64/arm64 (DMG). All six bundles ship the same `.wasm` + `.data`. CI (GitHub Actions
matrix) later; macOS signing deferred.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Single-threaded slice perf (no TBB) | Worker keeps UI responsive; small models fine; wasmtbb/pthreads is a later phase |
| wasm64 experimental status | Spike ran it on Emscripten 6.0.4; wasm32 + one-line fix is the fallback |
| API drift vs spike's v2.4.2 (submodule is 2.5.0-dev) | Bridge signatures are the documented iteration surface; pin SHA for reproducibility |
| 3MF re-add (spike dropped it) | expat/minilzo vendored in-tree; `Model.cpp` 3mf paths were on the spike's known-failure list — mechanical |
| `GCodeProcessorResult` memory for huge plates | wasm64 4 GB+ heap; acceptable for v1 |
| Preset subset too small for real users | Full `resources/profiles` preload-file lands before public release |
| Boost 1.84 wasm64 build machine cost (~50 GB disk) | Spike scripted it; warm cache + parallelism |

## Phased Sequencing

- **A** — Repo scaffold (structure above, pnpm workspaces, submodule pinned, docs).
- **B** — WASM build pipeline: scaffold CMake + shim + patches + Boost build + bridge
  API + 3MF re-add; slice the fixture via `slice_main` (Node smoke green).
- **C** — `slicer-wasm` JS client + worker glue + mock-module unit tests.
- **D** — Electron shell: windows, preload API, session headers, settings UI from
  metadata.
- **E** — 3D viewport (R3F), model loading, slice orchestration, progress, preview
  (sliced mesh + toolpath + layer slider).
- **F** — Export, electron-builder packaging for 6 targets, Playwright e2e.

## References

- Phase-0 compile spike (external reference implementation): README.md
  (layout/iterate loop), FINDINGS.md (GO verdict, per-file recipe, remaining
  blockers), build.sh (orchestration + TBB_HEADERS), cmake/CMakeLists.txt
  (denylist + flags), shim/_serial.hpp,
  patches/0001-model-hpp-guard-step-include.patch, src/slice_main.cpp,
  harness/run-slice.mjs + selftest.mjs + mock-module.mjs, smoke/, fixtures/,
  build-boost-wasm64.sh.
- Companion browser-slicing plan from the same reference repo:
  `doc/cloud_slicing_wasm_plan_2026-07-19.md` (AGPL gate, dependency triage,
  phased architecture — independently converges with this design).
- Reference repo structure conventions: `project_structure_and_guidelines.md`
  in the same reference repo.
