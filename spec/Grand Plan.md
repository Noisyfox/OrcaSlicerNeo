# Grand Plan

This document states the implementation plan for OrcaSlicerNeo — the Electron
GUI rewrite of OrcaSlicer. The approved design is
[`doc/2026-08-12-electron-gui-rewrite-design.md`](../doc/2026-08-12-electron-gui-rewrite-design.md);
details and status live in [`doc/high_level_dev_plan.md`](../doc/high_level_dev_plan.md).

## Milestone 0: Foundation

- [x] Design doc approved and committed (`doc/2026-08-12-electron-gui-rewrite-design.md`)
- [x] Root docs (README / AGENTS / CLAUDE / project_structure_and_guidelines)
- [x] Grand plan + high-level dev plan
- [x] Repo scaffold: pnpm workspaces, `packages/slicer-wasm/` + `apps/desktop/`
      skeletons, C++ submodule pinned to a SHA

## Milestone 1: WASM Core (design Phase B)

> [!info] Target: **2026-08-13** (delivered)

The C++ slicing core compiles to WASM and slices a fixture end to end. This
retires the last remaining risk before any UI work.

- [x] Submodule pinned; patches applied (`Model.hpp` STEP guard, clang tweaks,
      `distance_to_squared`) maintained as `.patch` files — 0001, 0003–0007
      shipped (0002 skipped: `distance_to_squared` was fixed upstream between
      the spike's SHA and the b97ca3c0ac pin)
- [x] Serial TBB shim incl. `parallel_pipeline` stand-in
- [x] Boost 1.84 wasm64 build (`build-boost-wasm64.sh`)
- [x] Scaffold CMake: `GLOB_RECURSE` + `DROP_PATTERNS` + `stubs/`, 3MF re-added
- [x] `bridge.cpp` extern "C" API: `orc_init` / `orc_get_presets` /
      `orc_get_option_metadata` / `orc_load_model` / `orc_slice` /
      `orc_get_slice_result` / `orc_export_gcode` / `orc_cancel`
- [x] Node smoke green: `cube.stl` → valid G-code (spike GO criterion)

## Milestone 2: Electron Vertical Slice (design Phases C–E)

> [!info] Target: **2026-08-13** (delivered)

The v1 user flow works end to end: load STL/3MF → configure → slice →
3D preview (sliced mesh + toolpath + layer slider) → export G-code.

- [x] `slicer-wasm` JS client + Web Worker glue + mock-module unit tests
- [x] Electron shell: main/preload/renderer, native dialogs, COOP/COEP session
- [x] Settings UI rendered from option metadata (no duplicated schema)
- [x] 3D viewport (react-three-fiber): bed, models, orbit/select, basic move
- [x] Slice orchestration: config JSON → progress → result buffers
- [x] Preview: per-feature sliced mesh + toolpath lines + layer scrubber
- [x] Export G-code through native save dialog

## Milestone 3: Packaging & Hardening (design Phase F)

> [!info] Target: **2026-08-14** (delivered)

- [x] electron-builder: Windows x64/arm64 (NSIS), Linux x64/arm64 (AppImage),
      macOS x64/arm64 (DMG) — all six ship the same `.wasm`
- [x] Playwright Electron e2e covering the full v1 flow
- [x] GitHub Actions CI matrix (build WASM + app, run smoke/unit/e2e)
- [x] Full `resources/profiles` bundle (`--preload-file`) replacing the
      curated subset
- [x] Slice-output cross-check vs desktop OrcaSlicer (same model + profile)
- [x] Root `LICENSE` (AGPL-3.0) and source-offer notes

> [!warning] Deferred verification (emsdk / cross-check)
> The WASM build, both harnesses, e2e-real, and the six-target package matrix
> execute in GitHub Actions on the first push after this milestone (no emsdk on
> the delivery machine — M2 precedent). The slice cross-check needs desktop
> OrcaSlicer on an emsdk machine; the procedure + script shipped
> (`scripts/crosscheck-slice.mjs`). See
> `doc/2026-08-14-m3-implementation-notes.md`.

## Milestone 4: Preset Management with AppConfig Fidelity

> [!info] Target: **2026-08-15** (delivered)
>
> Design: `doc/2026-08-15-m4-preset-management-design.md`; implementation
> notes: `doc/2026-08-15-m4-preset-management-implementation-notes.md`.
> Carry-forward from M3: the preset picker now drives installed-state via the
> real `AppConfig`/variant mechanism instead of `is_visible` cosmetics.

- [x] Bridge: `orc_init(app_config_json)` (nullable; no-arg backward
      compatible), `orc_set_app_config`, `orc_get_app_config`,
      `orc_select_preset(kind, name)` (real `select_preset_by_name` path with
      the `load_selections` compat tail + all-three write-back)
- [x] `orc_get_presets(kind)` enriched: `is_visible` (real
      `set_visible_from_appconfig` result), `is_default`, `selected`,
      `vendor_id`, `model`, `variant`
- [x] Fresh-config default: installs every shipped printer via the real
      `set_variant` mechanism; partial `models` configs → only the listed
      variants visible
- [x] Electron: `appConfig:load`/`appConfig:save` IPC → `userData/
      appconfig.json`; boot loads config → `init(json)` → enriched presets
- [x] Picker (SettingsPanel): visible presets first, hidden ones in a dimmed
      "Not installed" group; selection change → `selectPreset` → store sync →
      `appConfig.save` (the UI choice reaches the slice)
- [x] Hardening: `catch (...)` fallback on every bridge op **plus** the
      bridge TUs compiled with `-fexceptions` — emcc's default
      `-fignore-exceptions` compiles `try`/`catch` out entirely, so a throw
      unwound into JS as an uncatchable `CppException` (the M4 probe's
      section-4 crash; the flag was only in `target_link_options`, i.e.
      link-time, never in the bridge TUs' compile commands); CSP headers
      (prod + dev) silencing Electron's Insecure-CSP warning;
      `nozzle_info.json` parse error eliminated (`/info` preload mount)
- [x] Verified: probe matrix (9 sections), client + stores vitest, harnesses
      re-run, typecheck — see implementation notes §Verification

> [!note] Deferred to the "Full settings surface" slice
> Install/uninstall UI (the picker's "Not installed" group is disabled in
> v1 — `orc_set_app_config` is the ready path), per-vendor install APIs,
> project save/load remains queued below.

## Milestone 5: Move Gizmo

> [!info] Target: **2026-08-16** (delivered)
>
> Design: `doc/2026-08-16-move-gizmo-design.md`; implementation notes:
> `doc/2026-08-16-move-gizmo-implementation-notes.md`. The first of the
> gizmo family (design phase E's "basic move-on-plate" is replaced by the
> full move tool).

- [x] TransformControls move gizmo on selection (axis arrows + plane
      handles, Z-up verified, world space)
- [x] Body drag via drei DragControls replacing the M2 hand-rolled pointer
      drag (free — camera-facing plane, no axis lock; amended 2026-08-17)
- [x] Mutual exclusion between gizmo and body drags (gesture ref + state)
- [x] Move panel: numeric X/Y/Z inputs, Drop to bed, Reset (local GLVolume
      state; synchronization happens before slice)
- [x] Transform state seeded from loaded model geometry
- [x] e2e: gizmo axis drag, panel inputs, drop to bed, reset; existing
      v1-flow e2e still green

## Milestone 6: Composite GLVolume Project State

- [x] Renderer GLVolume identity is `(objectIdx, volumeIdx, instanceIdx)`.
- [x] Bridge exports one model mesh entry per CompositeID, including instance
      and volume transforms.
- [x] Renderer transforms synchronize to the C++ `Model` immediately before
      slice, never during pointer interaction.

## Milestone 7: Scene-owned Multi-volume Selection

> [!success] Status: **implemented and verified** (2026-08-18; amended:
> pointer-down body selection).
>
> Design: `doc/2026-08-18-scene-selection-design.md`. The scene will own a
> multi-volume `Selection`, the sole open gizmo, and gesture state. The
> default mode selects complete instances; a later modifier will provide
> part/volume selection. Gizmo grabbers strictly take pointer priority over
> body dragging.

- [x] `Selection` holds multiple CompositeID GL volumes and expands normal
      hits to a complete `(objectIdx, instanceIdx)`.
- [x] Scene owns selection, one open gizmo, and mutual-exclusive body/gizmo
      gesture state.
- [x] Drag, gizmo, move-panel, drop-to-bed, and reset operate on the complete
      selection through its aggregate pivot.
- [x] A gizmo-grabber hit cannot begin or mutate a DragControls body drag.
- [x] A non-gizmo press remains a body-drag gesture even if its first movement
      reaches a gizmo grabber before DragControls crosses its threshold.
- [x] Unit and Electron e2e coverage verify multi-instance movement, one
      gizmo, pointer arbitration, and pre-slice transform synchronization.

## Milestone 5+: Post-v1 Expansion (queued, not yet scheduled)

- [ ] Multi-plate support; project save/load (`.3mf` / `bbs_3mf`)
- [ ] Full settings surface + search (from metadata)
- [ ] Gizmos: rotate/scale/cut/measure/arrange/orient (move delivered in
      Milestone 5)
- [ ] Parallelism: wasmtbb + pthreads + COOP/EP (SharedArrayBuffer already
      provisioned); perf tuning for large plates
- [ ] STEP import (OCCT Emscripten port decision)
- [ ] CGAL features: mesh boolean, hollowing, advanced cut
- [ ] Device panel & printer connectivity (Bambu LAN/cloud, Moonraker, …)
- [ ] Calibration wizards
- [ ] i18n (i18next + `.po` → JSON conversion)
- [ ] Auto-update + code signing (macOS notarization)
- [ ] WebView panels (guide/homepage) replaced by in-app React pages
