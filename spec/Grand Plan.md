# Grand Plan

This document states the implementation plan for OrcaSlicerNeo — the Electron
GUI rewrite of OrcaSlicer. The approved design is
[`doc/2026-08-12-electron-gui-rewrite-design.md`](../doc/2026-08-12-electron-gui-rewrite-design.md);
details and status live in [`doc/high_level_dev_plan.md`](../doc/high_level_dev_plan.md).

## Milestone 0: Foundation

- [x] Design doc approved and committed (`doc/2026-08-12-electron-gui-rewrite-design.md`)
- [x] Root docs (README / AGENTS / CLAUDE / project_structure_and_guidelines)
- [x] Grand plan + high-level dev plan
- [ ] Repo scaffold: pnpm workspaces, `packages/slicer-wasm/` + `apps/desktop/`
      skeletons, C++ submodule pinned to a SHA

## Milestone 1: WASM Core (design Phase B)

> [!info] Target: **TBD**

The C++ slicing core compiles to WASM and slices a fixture end to end. This
retires the last remaining risk before any UI work.

- [ ] Submodule pinned; patches applied (`Model.hpp` STEP guard, clang tweaks,
      `distance_to_squared`) maintained as `.patch` files
- [ ] Serial TBB shim incl. `parallel_pipeline` stand-in
- [ ] Boost 1.84 wasm64 build (`build-boost-wasm64.sh`)
- [ ] Scaffold CMake: `GLOB_RECURSE` + `DROP_PATTERNS` + `stubs/`, 3MF re-added
- [ ] `bridge.cpp` extern "C" API: `orc_init` / `orc_get_presets` /
      `orc_get_option_metadata` / `orc_load_model` / `orc_slice` /
      `orc_get_slice_result` / `orc_export_gcode` / `orc_cancel`
- [ ] Node smoke green: `cube.stl` → valid G-code (spike GO criterion)

## Milestone 2: Electron Vertical Slice (design Phases C–E)

> [!info] Target: **TBD**

The v1 user flow works end to end: load STL/3MF → configure → slice →
3D preview (sliced mesh + toolpath + layer slider) → export G-code.

- [ ] `slicer-wasm` JS client + Web Worker glue + mock-module unit tests
- [ ] Electron shell: main/preload/renderer, native dialogs, COOP/COEP session
- [ ] Settings UI rendered from option metadata (no duplicated schema)
- [ ] 3D viewport (react-three-fiber): bed, models, orbit/select, basic move
- [ ] Slice orchestration: config JSON → progress → result buffers
- [ ] Preview: per-feature sliced mesh + toolpath lines + layer scrubber
- [ ] Export G-code through native save dialog

## Milestone 3: Packaging & Hardening (design Phase F)

> [!info] Target: **TBD**

- [ ] electron-builder: Windows x64/arm64 (NSIS), Linux x64/arm64 (AppImage),
      macOS x64/arm64 (DMG) — all six ship the same `.wasm`
- [ ] Playwright Electron e2e covering the full v1 flow
- [ ] GitHub Actions CI matrix (build WASM + app, run smoke/unit/e2e)
- [ ] Full `resources/profiles` bundle (`--preload-file`) replacing the
      curated subset
- [ ] Slice-output cross-check vs desktop OrcaSlicer (same model + profile)
- [ ] Root `LICENSE` (AGPL-3.0) and source-offer notes

## Milestone 4+: Post-v1 Expansion (queued, not yet scheduled)

- [ ] Multi-plate support; project save/load (`.3mf` / `bbs_3mf`)
- [ ] Full settings surface + search (from metadata); preset management
- [ ] Gizmos: rotate/scale/cut/measure/arrange/orient
- [ ] Parallelism: wasmtbb + pthreads + COOP/EP (SharedArrayBuffer already
      provisioned); perf tuning for large plates
- [ ] STEP import (OCCT Emscripten port decision)
- [ ] CGAL features: mesh boolean, hollowing, advanced cut
- [ ] Device panel & printer connectivity (Bambu LAN/cloud, Moonraker, …)
- [ ] Calibration wizards
- [ ] i18n (i18next + `.po` → JSON conversion)
- [ ] Auto-update + code signing (macOS notarization)
- [ ] WebView panels (guide/homepage) replaced by in-app React pages
