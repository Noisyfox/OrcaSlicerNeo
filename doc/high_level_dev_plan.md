# High Level Development Plan (updated 2026-08-12)

## Context

- Scope: next-generation OrcaSlicer desktop GUI on Electron + React + TypeScript +
  Vite + shadcn/ui, with the C++ slicing core (`libslic3r`) reused as-is and
  compiled to WASM via Emscripten. One `.wasm` serves Windows x64/arm64, Linux
  x64/arm64, macOS x64/arm64. See `doc/2026-08-12-electron-gui-rewrite-design.md`
  for the approved design; `spec/Grand Plan.md` for the milestone checklist.
- Guardrails: `libslic3r` changes are minimal (patches/stubs/shim only, never
  ad-hoc edits to the submodule); all C++↔JS traffic goes through the extern "C"
  bridge; docs-first (dated notes in `doc/`).
- Testing: every milestone ships with its smoke/unit/e2e layer — Node smoke for
  the WASM module, vitest with a mock Emscripten module for the client, Playwright
  Electron for the app.

## Milestones & Epics

### Milestone 1 — WASM Core (design Phase B)

> **Status: delivered 2026-08-13.** Submodule pinned b97ca3c0ac (patches 0001,
> 0003–0007 applied — 0002 skipped: `distance_to_squared` fixed upstream);
> serial TBB shim incl. `parallel_pipeline` stand-in; Boost 1.84 wasm64 (12
> static archives); scaffold CMake with 3MF re-added; 8-function extern "C"
> bridge API; Node smoke green — see
> `doc/2026-08-12-wasm-build-notes.md`.

**Epic 1.1: C++ submodule + patches**
- Add `packages/slicer-wasm/cpp/` as a submodule → `Noisyfox/OrcaSlicer`, pinned
  to a commit SHA (initially the fork's current master HEAD; spike-proven
  reference is v2.4.2 — bridge signatures are the expected drift surface).
- Maintain `.patch` files: `Model.hpp` STEP include guard (`SLIC3R_WASM_NO_OCCT`),
  clang-strictness tweaks, `AABBTreeLines.hpp` `distance_to_squared` overload.
  Applied by `build.sh`, idempotent.

**Epic 1.2: Serial TBB shim**
- Copy the spike's `shim/_serial.hpp` + generated forwarding headers; add the
  missing serial `parallel_pipeline` stand-in (used only by `GCode.cpp`).
- `TBB_HEADERS` list in `build.sh` stays the iteration surface for new includes.

**Epic 1.3: Boost 1.84 wasm64**
- `build-boost-wasm64.sh` (from the spike): b2 + Emscripten toolset, 12 static
  archives. Must be built consistently wasm64 with all objects.

**Epic 1.4: Scaffold CMake + drop set**
- `GLOB_RECURSE` over `cpp/src/libslic3r/*.cpp`, `DROP_PATTERNS` (SLA/OpenVDB,
  CGAL, STEP/OCCT, OpenCV, windows-only, draco), `stubs/*.cpp` glob.
- Re-add `/Format/3mf` + `bbs_3mf` (expat/minilzo are vendored in-tree).
- Link flags per design: `-O3 -fexceptions -sMEMORY64 -sMODULARIZE=1
  -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,_malloc,_free
  -sDISABLE_EXCEPTION_CATCHING=0`. No `-pthread` in v1.

**Epic 1.5: Bridge API (`src/bridge.cpp`)**
- extern "C", JSON-in/JSON-out, synchronous on the worker thread. Functions:
  `orc_init`, `orc_get_presets`, `orc_get_option_metadata`, `orc_load_model`,
  `orc_slice` (progress via registered JS callback from `set_status_callback`),
  `orc_get_slice_result` (toolpath + sliced mesh + stats), `orc_export_gcode`
  (MEMFS), `orc_cancel`.
- Retain `slice_main.cpp` (spike CLI driver) for harness parity.
- Resources: curated preset subset via `--embed-file`.

**Epic 1.6: Node smoke harness**
- Spike's `harness/` pattern: stage `fixtures/cube.stl` + `config.json` into MEMFS,
  `callMain`, assert exit 0 + `G1` moves. GO criterion: output consistent with
  desktop OrcaSlicer for the same model/profile.

### Milestone 2 — Electron Vertical Slice (design Phases C–E)

> **Status: delivered 2026-08-13.** Typed JS client + heap marshaling + Web
> Worker protocol (request/response/progress) with mock-module unit tests
> (14 slicer-wasm + 5 desktop, all green); Electron shell with native
> dialogs/file IO and COOP/COEP session headers; settings UI rendered from
> `orc_get_option_metadata()`; R3F viewport (bed, model mesh from WASM
> buffers, orbit/select, drag-move); slice orchestration with progress and
> binary result buffers (toolpath + per-feature sliced mesh); layer scrubber;
> G-code export through the native save dialog. Real-module verification
> (WASM rebuild + `bridge-smoke.mjs` + `run-slice.mjs`) is deferred — the
> delivery machine has no emsdk; the binary-buffer bridge is unit-tested
> against the mock and carries an explicit verify step on an emsdk machine.
> See `doc/2026-08-13-m2-implementation-notes.md`.

**Epic 2.1: `slicer-wasm` JS client**
- `packages/slicer-wasm/src/client/`: promise-based typed API (`loadModel`,
  `getPresets`, `getOptionMetadata`, `slice(config, onProgress)`,
  `getSliceResult`, `exportGcode`, `cancel`), heap marshaling helpers
  (`_malloc`/`_free` + `HEAPU8`), transferable ArrayBuffer output.
- Web Worker glue (Vite worker module); unit tests against a mock Emscripten
  module (spike's `mock-module.mjs` pattern — no emsdk).

**Epic 2.2: Electron shell (`apps/desktop`)**
- electron-vite scaffold: main / preload / renderer; zustand stores;
  `contextIsolation: true`, `nodeIntegration: false`, preload `contextBridge`
  API (open/save dialogs, file read/write, window controls).
- COOP/COEP headers on the session (SharedArrayBuffer headroom for later
  threading).

**Epic 2.3: Settings UI from metadata**
- Render option groups from `orc_get_option_metadata()` JSON (type/label/enum/
  min/max/mode/category) — same metadata `Tab.cpp` renders today. Printer preset
  dropdown + filament + process groups for v1. Config round-trips as JSON.

**Epic 2.4: 3D viewport + slice orchestration**
- react-three-fiber + drei: bed plate with grid, model meshes from WASM triangle
  buffers, orbit/zoom/pan, object select, basic move-on-plate.
- Slice flow: `slice(configJson)` → progress bar → `getSliceResult()` →
  per-feature colored mesh (`SlicesToTriangleMesh`) + toolpath `LineSegments`
  with per-layer `setDrawRange` scrubber.

**Epic 2.5: Export**
- `exportGcode()` → MEMFS bytes → native save dialog.

### Milestone 3 — Packaging & Hardening (design Phase F)

**Epic 3.1: electron-builder**
- Config for win x64/arm64 (NSIS), linux x64/arm64 (AppImage), mac x64/arm64
  (DMG); all six bundle the same `.wasm` + embedded resources.

**Epic 3.2: e2e + CI**
- Playwright Electron: launch app, drive the full v1 flow, assert gcode contents.
- GitHub Actions matrix: WASM build + smoke, app build, unit, e2e.

**Epic 3.3: Full preset bundle**
- Replace curated subset with full `resources/profiles` via `--preload-file`;
  verify preset loading paths (`PresetBundle::load_presets`).
- Root `LICENSE` (AGPL-3.0) + source-offer notes.

## Cross-Cutting Practices

- **Bridge is the only seam:** renderer code never imports the WASM module
  directly; it goes through `packages/slicer-wasm/src/client`. Binary buffers
  cross via the heap and transferables — never JSON.
- **WASM build is iterative:** `TBB_HEADERS` / `DROP_PATTERNS` / `stubs/` /
  bridge-signature drift are the documented fix loops (see AGENTS.md).
- **wasm64 consistency:** all objects, Boost archives, and link must agree on
  `-sMEMORY64`; fall back to wasm32 + `GCode.hpp` size_t fix only if blocked.
- **Serial-first:** no pthreads in v1; parallelism (wasmtbb + COOP/COEP) is
  Milestone 4.
- **Docs-first:** each epic creates/updates a short sub-doc in `doc/` capturing
  decisions and testing notes; keep this plan and `spec/Grand Plan.md` in sync
  with delivered work.
- **Slice cross-check:** fixture output must match desktop OrcaSlicer for the
  same model/profile before any release.
