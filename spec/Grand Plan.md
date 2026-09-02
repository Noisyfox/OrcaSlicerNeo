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
      `orc_get_option_metadata` / `orc_add_model` / `orc_clear_model` / `orc_slice` /
      `orc_get_slice_result` / `orc_export_gcode` / `orc_cancel`
- [x] Node smoke green: `cube.stl` → valid G-code (spike GO criterion)

## Milestone 2: Electron Vertical Slice (design Phases C–E)

> [!info] Target: **2026-08-13** (delivered)

The v1 user flow works end to end: load STL/3MF → configure → slice →
3D preview (toolpath + layer slider) → export G-code.

- [x] `slicer-wasm` JS client + Web Worker glue + mock-module unit tests
- [x] Electron shell: main/preload/renderer, native dialogs, COOP/COEP session
- [x] Settings UI rendered from option metadata (no duplicated schema)
- [x] 3D viewport (react-three-fiber): bed, models, orbit/select, basic move
- [x] Slice orchestration: config JSON → progress → result buffers
- [x] Preview: toolpath lines + layer scrubber
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

## Milestone 8: Add Model and Clear Scene

- [x] Toolbar model import is labeled **Add Model** and appends files to the
      current scene.
- [x] Native `.drc` import follows the same Add Model flow in Electron and
      Web, using upstream Draco 1.5.7 decoding in both wasm64 variants; see
      [`2026-09-01-drc-import-support.md`](2026-09-01-drc-import-support.md).
- [x] **Clear Scene** explicitly resets the WASM model, slicer result,
      renderer collection, and selection.

## Viewport Interaction Performance Follow-up

- [x] The React Three Fiber event layer skips raycasting during camera, body,
      and gizmo drags, keeping orbit performance independent of dense model
      geometry under the cursor. See
      `doc/2026-08-18-disable-raycasting-during-drag.md`.

## Milestone 9: Shared Web–Electron Application Architecture

> [!info] Status: **delivered 2026-08-20** — migration steps 0–11 per the
> [implementation plan](../doc/2026-08-19-web-electron-shared-implementation-plan.md).
> Normative design:
> [`Web–Electron Shared Application Architecture.md`](Web-Electron%20Shared%20Application%20Architecture.md).
> Release-gate evidence (96 tests, typecheck, both real wasm64 artifacts, web
> threaded/serial e2e, non-root deployment, desktop e2e):
> `doc/2026-08-20-m9-step11-release-regression-audit.md`.

Refactor the Electron renderer into a shared React application with thin
Electron and static-Web hosts. The core flow remains local wasm64 slicing; the
Web target is desktop Chrome 133+ with WebGL 2, threaded WASM where
cross-origin isolation is available, and serial WASM otherwise.

- [x] Step 0 — migration baseline captured (`doc/2026-08-20-m9-step0-migration-baseline.md`)
- [x] Step 1 — dependency-free platform contracts (`packages/platform-contract`)
- [x] Step 2 — Electron adapter replacing direct `window.orca` use
- [x] Step 3 — shared React app extracted into `packages/slicer-app`
      (import-direction guard included)
- [x] Step 4 — reusable runtime bootstrap (`packages/slicer-runtime`)
- [x] Step 5 — deterministic profile packages built independently of WASM
      (`packages/profile-resources`: manifest + core/vendor ZIPs)
- [x] Step 6 — profile packages installed into MEMFS before `orc_init()`
      (failed vendor skipped, failed `core` fails startup)
- [x] Step 7 — AppConfig replaced by shared preferences (Electron file /
      Web localStorage, in-memory fallback)
- [x] Step 8 — Electron fully on the shared runtime; legacy AppConfig bridge
      API removed (`selectPreset` is the only selection path)
- [x] Step 9 — static `apps/web` host: browser file/download adapters,
      capability gating, `beforeunload` guarding, relative asset URLs
- [x] Step 10 — dual wasm64 artifacts (threaded + serial) staged; real-artifact
      Chrome e2e for both variants
      (`doc/2026-08-20-m9-step10-dual-wasm-web-e2e.md`)
- [x] Step 11 — release/regression audit
      (`doc/2026-08-20-m9-step11-release-regression-audit.md`)

## Milestone 10: Gizmo Toolbar

> [!info] Target: **2026-08-21** (delivered)
>
> Design: `doc/2026-08-21-gizmo-toolbar-design.md`. Gizmo activation moves
> from auto-open-on-selection to an explicit toolbar toggle: a horizontal
> toolbar overlaid on top of the viewport carries a single **Move** button
> that arms/disarms the move gizmo. An emptied selection still auto-closes
> the gizmo.

- [x] Horizontal gizmo toolbar overlaid on top of the viewport
- [x] Move toggle arms/disarms the gizmo; selection never auto-opens it, and
      arming requires a non-empty selection (button disabled otherwise)
- [x] Auto-close on empty selection (deselect / Clear Scene / model reset)
- [x] The move panel renders with the gizmo — it is part of the gizmo UI and
      hides with it (amended 2026-08-21; M5 showed it on any selection)
- [x] Unit + Electron e2e coverage: no auto-activation on select, toolbar
      arming, existing move-gizmo mechanics unchanged

## Milestone 11: Rotate & Scale Gizmos

> [!info] Target: **2026-08-21** (delivered)
>
> Design: `doc/2026-08-21-rotate-scale-gizmos-design.md`. Rotate and scale
> tools join the move gizmo: exclusive Move/Rotate/Scale toolbar toggles, a
> shared `TransformGizmo` (drei `TransformControls` modes) on the aggregate
> pivot, sidebar rotate/scale panels, and a scale world/local coordinate
> toggle. The renderer's Euler order is aligned to the C++ slicer (`ZYX` =
> `Rz·Ry·Rx`) so rotated objects render exactly as they slice.

- [x] Rotate gizmo (world rings) — selection rotates rigidly around the
      selection-center pivot; offsets orbit and rotations recompose (Euler
      ZYX)
- [x] Scale gizmo with world/local coordinate toggle (multi-selection forces
      world and disables the toggle); per-axis + uniform center handles;
      factors clamped to a positive floor
- [x] Rotate panel: X/Y/Z degrees + Reset; multi-selection shows 0 and edits
      are relative deltas
- [x] Scale panel: World/Local toggle, factor % inputs, size mm inputs (the
      dimensions the selection is scaled to), Reset; multi-selection shows
      100% factors and the aggregate size
- [x] Panel scale edits scale rigidly about the aggregate pivot (offsets
      orbit), matching the gizmo and keeping the selection centered
- [x] Euler-convention fix: `applyTransform`/`transformMatrix` compose
      rotation with three.js order `ZYX`, matching `assemble_transform`
- [x] Unit + Electron e2e coverage: rotate ring drag, scale shaft drag,
      coord toggle, panels, resets, multi-selection display rules
- [x] Gizmo keyboard shortcuts (OrcaSlicer bindings): M/R/S toggle
      move/rotate/scale, Esc deselects all (closing the gizmo) — input fields
      and modifier combos are ignored

## Milestone 12: Scene Toolbar Actions

> [!info] Target: **2026-08-22** (delivered)
>
> Design/note: `doc/2026-08-22-scene-toolbar-and-context-menu.md`. The scene
> actions move to OrcaSlicer's scene-surface placement: **Add Model** becomes
> the first button of the top-of-viewport gizmo toolbar (it stays enabled on
> an empty selection — importing onto an empty plate is the point), and
> **Clear Scene** moves into a right-click context menu on the empty 3D scene
> (opened by a clean right-click without drag, so right-drag panning still
> works). The app toolbar row is left with Slice + Export.

- [x] Add Model in the gizmo toolbar at the first position (icon-only with a
      title/aria-label; test id `btn-add-model` unchanged); shared action
      extracted to `workspace/actions/sceneActions.ts`
- [x] Clear Scene in the scene right-click menu on empty space (bed plate or
      background, not a model body); right-drag pan preserved; the native
      host/browser context menu is suppressed in the scene
- [x] Scene right-click menu layout: **Clear Scene** first, separator, then
      **Add Cube** and **Add Model** (the latter reuses the host picker
      import; `btn-ctx-add-model` in e2e)
- [x] Add Cube in the scene right-click menu (after Clear Scene +
      separator): appends OrcaSlicer's 20 mm cube primitive through the
      standard model pipeline (`doc/2026-08-22-scene-context-menu-add-cube.md`);
      no bridge changes
- [x] Add Handy models submenu in the scene context menu: ships all ten of
      OrcaSlicer's bundled benchmark/calibration entries through the standard
      model-import pipeline (`doc/2026-09-01-handy-models-context-menu.md`),
      including multi-file Orca Cube and OrcaSliced Combo; the shared-app
      resource manifest stages pinned upstream files without duplicating them
- [x] Electron e2e: the full flow clears via the context menu; an emptied
      plate shows the disabled menu item after Delete; Add Cube and the
      context-menu Add Model entry unlock Slice and (mock mode) report a
      20 mm selectable box

## Milestone 13: Object List and Object Parts

> [!info] Status: **delivered**
>
> Design: [`ObjectList-and-Parts.md`](ObjectList-and-Parts.md)
> Behaviour notes: `doc/2026-08-23-orca-selection-mode.md`,
> `doc/2026-08-23-object-list-highlight-orca.md`,
> `doc/2026-08-23-object-reorder-selection-sync.md`

Add the shared Object List and object-part management to both Electron and Web.
The C++/WASM bridge owns all model-structure semantics; React renders the tree
and drives structural operations through the typed client.

- [x] `orc_get_model_structure()` plus object/part/instance mutation bridge
      operations
- [x] Stable `ObjectID` identity and post-mutation structure/mesh refresh
- [x] Object/part/instance tree with rename, delete, clone, split, assemble,
      change type, reorder, add/remove instance, and printable state
- [x] Viewport `object` / `volume` / `instance` selection modes and two-way
      ObjectList selection sync
- [x] Unit, mock-module, WASM smoke, Electron e2e, and Web e2e coverage

## Milestone 14: Printer Console and Control

> [!info] Status: **delivered 2026-08-28**. The final user experience is
> recorded in [`2026-08-30-printer-console-and-control-ux.md`](../doc/2026-08-30-printer-console-and-control-ux.md).

- [x] Manage multiple saved printers from the top-level Device page, with an
      embedded console, add/edit/delete actions, and explicit console selection
- [x] View a printer's console in Electron with automatic API-key reuse when
      configured, and in Web through best-effort iframe embedding
- [x] Send G-code or Send & Print through the selected printer's Moonraker API,
      with progress, cancellation, start-only retry, and optional keyless use
- [x] After success, count down before closing and optionally switch to Device;
      this preference is persisted and enabled by default

## Filament Library Selector Completeness

> [!info] Implemented 2026-08-30. Details:
> `doc/2026-08-30-filament-library-selector.md`.

- [x] Every FFF filament successfully loaded from the bundled profile packages
      is available to the selector.
- [x] Compatibility and generic-profile supersession remain in OrcaSlicer's
      `PresetBundle`; the shared UI does not reproduce them.

## Cross-cutting titlebar/native menu implementation

> [!info] Implemented 2026-08-25; real macOS manual verification remains open.
>
> Implementation note: `doc/2026-08-25-titlebar-native-menu-implementation.md`.
> This is a cross-cutting host-integration item, not a new product milestone.

- [x] Shared File/Help model and complete startup/model/result/slicing state
      projection
- [x] Web browser menu without Quit/Exit; fixed external source boundary
- [x] Windows/Linux Electron custom titlebar menu with Exit and no-drag zones
- [x] macOS Electron native File/Help boundary and typed IPC validation
- [x] Focused shared, Electron mock, and Web E2E menu coverage
- [ ] Real macOS packaged-app manual check: traffic lights, exactly-one native
      menu, Quit/source behavior, drag interaction, and reopen-state reset

## Post-v1 Expansion (queued, not yet scheduled)

### G-code preview GPU streaming renderer

> [!info] Opaque solid-entity design accepted 2026-09-02. The earlier
> atlas/texel-fetch shader design is superseded; browser/dual-host verification
> remains opt-in and representative integrated-GPU performance evidence is
> pending, so the default stays off with automatic B2 fallback. Browser
> hardware limits and measurements are recorded in the living implementation
> entry. The accepted depth policy is transparent-queue ordering only
> (`transparent: true`, `NoBlending`) with `depthTest: true`, `depthWrite: true`,
> and `FrontSide` in the Three adaptation: preview shells do not write depth,
> while solid toolpaths self-occlude and cull their back faces. Native
> libvgcode disables `GL_CULL_FACE`; this culling flag is an intentional
> difference required by the physical diamond-profile adaptation.
> Toolpath materials use flat-shaded `MeshStandardMaterial` with the existing
> scene lights. A shared four-point diamond-profile prism follows native
> libvgcode's cardinal `line_right`/`line_up` cross-section; no square/chamfer,
> gap, alpha outline, or blend pass is introduced.
> Travel segments are coloured by their move type rather than any preserved
> extrusion role, using libvgcode's `Travels` colour `RGB(56, 72, 155)`;
> extrusion feature filters do not hide travel, and the global travel toggle
> remains authoritative.
> The current-move marker is a native-style 32-sided cone-and-cylinder hotend,
> anchored at the last mapped endpoint plus 0.5 mm Z, using white 0.5 alpha,
> normal source-alpha blending, depth testing, disabled depth writes, and
> double-sided rendering. It hides at the final enabled endpoint.
>
> Major renderer/performance specification:
> [`G-code Preview GPU Streaming Renderer`](G-code%20Preview%20GPU%20Streaming%20Renderer.md)

- [x] Step 1 — accept the source-neutral planner and deterministic 250k/1m
      metadata fixture contract (no bridge change)
- [x] Step 2 — source adapter/page planner behind the current B2 backend
- [x] Step 3 — WebGL2 opaque solid-entity backend and capability/lifetime
      fallback (shared diamond-profile prism + page-local InstancedMesh; no custom
      thickness shader or alpha blend)
- [x] Step 4 — real preview integration behind an explicit default-off gate,
      fallback diagnostics, and opt-in dual-host smoke coverage
- [ ] Step 5 — dual-host verification and browser performance evidence landed;
      prefer-enabled default remains blocked pending representative 2020
      integrated-GPU 250k/1m evidence (current evidence uses Web SwiftShader
      and Electron RTX 3080; later B2 cleanup remains separate)

- [ ] Multi-plate support; project save/load (`.3mf` / `bbs_3mf`)
- [ ] Full settings surface + search (from metadata)
- [ ] Gizmos: cut/measure/arrange/orient (move/rotate/scale delivered in
      Milestones 5 + 11)
- [x] Parallelism: upstream oneTBB + pthreads + COOP/COEP (design:
      `doc/2026-08-18-wasm-parallelism-design.md`) — delivered with M9
      step 10 as the default `threaded` artifact
- [ ] Perf tuning for large plates
- [ ] STEP import (OCCT Emscripten port decision)
- [ ] CGAL features: mesh boolean, hollowing, advanced cut
- [x] Device panel & printer connectivity foundation (Moonraker; additional
      drivers remain future work)
- [ ] Calibration wizards
- [ ] i18n (i18next + `.po` → JSON conversion)
- [ ] Auto-update + code signing (macOS notarization)
- [ ] WebView panels (guide/homepage) replaced by in-app React pages
