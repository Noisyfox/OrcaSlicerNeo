# Grand Plan

This document states the implementation plan for OrcaSlicerNeo — the Electron
GUI rewrite of OrcaSlicer. The approved design is
[`doc/2026-08-12-electron-gui-rewrite-design.md`](../doc/2026-08-12-electron-gui-rewrite-design.md);
details and status live in [`doc/high_level_dev_plan.md`](../doc/high_level_dev_plan.md).

Verification frequency follows the accepted
[`testing guidelines`](../doc/testing_guidelines.md):
focused, risk-based checks during implementation; root regression and affected
host/runtime checks before code handoff; and the complete cross-host,
threaded/serial, packaging, and compatibility matrix for release or milestone
acceptance. Historical milestone command lists below are release evidence, not
the default edit-loop gate.

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

- [x] Submodule pinned; the remaining clang/WASM compatibility tweaks are
      maintained as `.patch` files (the old `Model.hpp` STEP guard was removed
      after the OCCT/XCAF STEP path was restored; `distance_to_squared` was
      fixed upstream between the spike's SHA and the b97ca3c0ac pin)
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

## Milestone 4: Preset Management with AppConfig Fidelity (historical)

> [!info] Historical delivery: **2026-08-15**. The AppConfig bridge and
> single-filament selection surface were removed by the later shared-runtime
> and multi-filament work; the current bridge has no compatibility path.
>
> Design: `doc/2026-08-15-m4-preset-management-design.md`; implementation
> notes: `doc/2026-08-15-m4-preset-management-implementation-notes.md`.
> The historical implementation used the real native visibility and selection
> paths. It is retained here only as provenance; current profile selection is
> Printer/Process and the multi-filament rack consumes `filament_catalog`.
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
- [x] Step 7 — AppConfig replaced by shared Printer/Process preferences and
      remembered-rack state (Electron file / Web localStorage, in-memory
      fallback)
- [x] Step 8 — Electron fully on the shared runtime; all legacy AppConfig and
      single-filament selection APIs removed (`selectProfile` is limited to
      Printer/Process)
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

## Milestone 17: Multi-Filament Support

> [!success] Implemented and accepted 2026-09-11 (Steps 11–15). Normative specification:
> [`Multi-Filament Support.md`](Multi-Filament%20Support.md). Execution and
> final user experience: [`2026-09-13-multi-filament-user-experience.md`](../doc/2026-09-13-multi-filament-user-experience.md).

- [x] Worker-owned multi-filament rack/session/slot state with native
      compatibility, atomic mutations, assignment/routing, flushing, prime
      tower, Preview, project persistence, and history
- [x] Zero-legacy boundary: no single-filament UI/API/preference/project
      state/history/sidecar/mock/wire selection flag, compatibility special
      case, or migration code; `filament_catalog` is catalogue-only and
      `orc_select_preset` accepts Printer/Process only
- [x] History no-bundle invariant guarded by `fullPresetBundleCopyCount`; only
      project-import staging copies the complete bundle; slot history Undo/Redo
      remains approximately 1–3 ms and context-only history leaves the fence
      unchanged
- [x] Dual-variant real-WASM acceptance completed in 95.018 s under the hard
      120 s limit. Developer runs may use `--threaded-only`; release runs both
      serial and threaded variants, with Electron target regression evidence
- [x] Threaded real Electron acceptance opened the approved 11-plate project,
      proved plate-1-only slicing, current-plate interaction, one-entry drag
      history, clamping, Prepare-only lifetime, and non-blocking warnings; the
      threaded checklist completed in 50.300 s and the licensed project flow
      completed in 2m06s

## Milestone 18: Per-Plate Print Architecture

> [!success] Delivered and qualified 2026-09-16. Normative specification:
> [`Per-Plate Print Architecture.md`](Per-Plate%20Print%20Architecture.md).
> Implementation and exact-u1 profile record:
> [`2026-09-14-complex-project-interaction-performance.md`](../doc/2026-09-14-complex-project-interaction-performance.md).

- [x] Runtime-only stable plate registry with one independent Print,
      GCodeProcessorResult, result generation, immutable G-code source, input
      and presentation stamps, and tombstone/job lifetime per plate
- [x] Complete receipt-scoped Slice/result/text/Export/Send boundary, distinct
      native Slice and renderer-projection terminals, and stale payload
      rejection by plate, stamp, generation, and presentation epoch
- [x] Registry reconciliation for plate mutations, history, project load,
      geometry-only 3MF import, configuration scope, reorder, and active-job
      deletion; derived output remains runtime-only and internal APIs have no
      compatibility fallback
- [x] Fresh serial/threaded WASM and real harness qualification, all affected
      package tests/typechecks, visible serial/threaded Web Playwright, visible
      Electron regression, and exact non-mock u1 Electron performance coverage
- [x] New profile/test execution branches are absent from production runtime:
      native probes are compile-time gated, renderer hooks are build-time
      gated, and restored production WASM/Electron artifacts pass exclusion
      scans

## Milestone 19: Project and Scoped Configuration

> [!success] Delivered 2026-09-23. The final user-visible behavior is defined in
> [`Project and Scoped Configuration.md`](Project%20and%20Scoped%20Configuration.md).

Users can switch between project-wide and selection-scoped editing for plates,
objects, parts, and modifiers, with inherited-value visibility, reset, standard
3MF persistence, and Undo/Redo behavior.

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

## Milestone 15: 3MF Project Persistence

> [!success] **Delivered 2026-09-04.** The independent cross-host
> project-open, project-save, compatibility, dirty-state, and verification
> contract is [`3MF Project Persistence.md`](3MF%20Project%20Persistence.md).
> The controlled external fixture manifest, both real WASM variants, desktop
> E2E, and threaded/serial Web E2E release gates all pass. See the release-gate
> evidence in the approved spec and the Step 9 execution record in
> `doc/2026-09-04-3mf-project-persistence-implementation-plan.md`.

- [x] Implement the BBS 3MF project reader/writer bridge and typed Worker client
- [x] Implement shared project session, load/save commands, preference modal,
      confirmation/progress UI, and Electron/Web host adapters
- [x] Release verification — cross-host drag-and-drop and compatibility fallback
      implementation, serial/threaded WASM, desktop, and real Web E2E gates
      all pass

Release-gate commands (all passed on 2026-09-04):
`node packages/slicer-wasm/harness/acquire-project-fixtures.mjs --check`, both
`project-roundtrip.mjs` and `project-compatibility.mjs` invocations for
`out/serial` and `out/threaded`, `pnpm --filter @orca/desktop test:e2e`,
`pnpm --filter @orca/web test:e2e:threaded`, and
`pnpm --filter @orca/web test:e2e:serial`.

## Milestone 16: Undo and Redo

> [!success] Status: **implemented and accepted** (2026-09-08). Major specification:
> [`Undo and Redo.md`](Undo%20and%20Redo.md).
> Sequential execution plan:
> [`2026-09-07-undo-redo-implementation-plan.md`](../doc/2026-09-07-undo-redo-implementation-plan.md).

Add project-scoped, incremental Undo/Redo across the shared Electron/Web app.
The history restores model/project changes and editing context (selection,
active plate, and gizmo) without recording global preset selection or system
preferences. Complete 3MF archives and derived slice/preview output are not
history entries.

- [x] Extract/adapt Orca's wx-free `ObjectID`-version history core with the
      approved 256 MiB cross-host budget and eviction policy
- [x] Add the Worker/WASM project-history contract and shared restore flow
- [x] Make the Worker authoritative for history context, committed transforms,
      and native scoped configuration
- [x] Integrate semantic command, gesture, selection, and active-plate
      transactions with the saved-checkpoint dirty-state model; every exposed
      project mutation must use that transaction boundary
- [x] Add directional history menus, direct jump, focus-aware keyboard
      bindings, and cross-host verification
- [x] Add unit, Worker/WASM, large-model budget/eviction, and three-host
      end-to-end coverage; keep timing and peak memory as diagnostics initially

## G-code preview GPU streaming renderer

> [!info] Native libvgcode SegmentTemplate GPU path accepted 2026-09-02. The
> shared template has 8 logical vertices and 24 invocations per segment; the
> camera-aware vertex shader retains `POINTY_CAPS` and `FIX_TWISTING`. Static
> position/shape/colour data use RGBA32F textures and selected IDs use R32UI
> textures. The material is opaque (`NoBlending`, depth test/write); DoubleSide
> matches native `GL_CULL_FACE` disable, with depth buffering providing
> occlusion.
> The native SegmentTemplate renderer is now the default and sole toolpath
> backend. WebGL2/capability/context failures leave the preview unavailable and
> expose a diagnostic. Large GPU timing
> measurements are manual diagnostics and are not part of normal startup/e2e.
> Travel segments are coloured by their move type rather than any preserved
> extrusion role, using libvgcode's `Travels` colour `RGB(56, 72, 155)`;
> extrusion feature filters do not hide travel, and the global travel toggle
> remains authoritative.
> The current-move marker is OrcaSlicer's translucent hotend STL model,
> preferring the selected printer's vendor model and falling back to the
> shared `hotend.stl`; it uses Orca's endpoint anchor, 0.5 mm Z offset,
> 180-degree X rotation, and depth-tested rendering. It hides at the final
> enabled endpoint.
>
> Major renderer/performance specification:
> [`G-code Preview GPU Streaming Renderer`](G-code%20Preview%20GPU%20Streaming%20Renderer.md)

> Cross-host adapter policy: the shared WebGL/R3F canvas requests
> `powerPreference: 'high-performance'`, and Electron uses Chromium's
> `force_high_performance_gpu` startup preference. These are hints only; no
> named/discrete GPU is required, and browser/Electron software/integrated-GPU
> fallbacks remain available.

- [x] Step 1 — accept the source-neutral planner contract (no bridge change)
- [x] Step 2 — source adapter/page planner
- [x] Step 3 — WebGL2 native libvgcode SegmentTemplate backend and
      capability/lifetime fallback (8 logical vertices / 24 invocations,
      camera-aware POINTY_CAPS + FIX_TWISTING shader, RGBA32F static textures,
      page-local R32UI selected-index textures; no alpha blend)
- [x] Cross-page source addressing fix — page-local selected IDs are translated
      with each page's `firstSegment` before global static-texture fetches
- [x] Step 4 — real preview integration with native renderer diagnostics and
      dual-host smoke coverage
- [x] Step 5 — native renderer made default and sole toolpath backend;
      unsupported native initialization is explicitly unavailable

### G-code preview Phase C — read-only analysis

The Phase-C foundation extends the accepted preview data contract without
changing the Phase-B renderer or controls. External G-code and source-text
loading remain future increments.

- [x] Step C1 — typed source-neutral preview analysis contract, bridge-side
      standard-time/filament summary and per-feature statistics, and Worker-side
      optional metric ranges
- [x] Step C2 — read-only analysis scheme selection, palettes, and legend
      (Feature/Tool, five core native metric ramps, scheme-scoped filtering)
- [x] Step C3 — summary/per-feature statistics and current-move inspection
      card; summary values remain bridge-precomputed and the indexed card
      preserves the right-slider gutter
- [x] Step C4 — lazy G-code text window with bidirectional line navigation;
      64 KiB UTF-8-safe result-bound chunks, result-ID lifecycle binding,
      virtualized read-only rows, and exact/nearest-preceding source-line
      navigation through the typed Worker client

## Post-v1 Expansion (queued, not yet scheduled)

- [x] [Multi-plate support](Multi-Plate%20Support.md) — Steps 1–9 accepted
- [ ] Project save/load (`.3mf` / `bbs_3mf`) — tracked in Milestone 15;
      release verification remains pending
- [ ] Full settings surface + search (from metadata)
- [ ] Gizmos: cut/measure/arrange/orient (move/rotate/scale delivered in
      Milestones 5 + 11)
- [x] Parallelism: upstream oneTBB + pthreads + COOP/COEP (design:
      `doc/2026-08-18-wasm-parallelism-design.md`) — delivered with M9
      step 10 as the default `threaded` artifact
- [ ] Perf tuning for large plates
- [x] STEP import through the OCCT/XCAF Emscripten port — delivered 2026-09-13;
      see [`doc/2026-09-13-step-import-support.md`](../doc/2026-09-13-step-import-support.md)
- [ ] CGAL features: mesh boolean, hollowing, advanced cut
- [x] Device panel & printer connectivity foundation (Moonraker; additional
      drivers remain future work)
- [ ] Calibration wizards
- [ ] i18n (i18next + `.po` → JSON conversion)
- [ ] Auto-update + code signing (macOS notarization)
- [ ] WebView panels (guide/homepage) replaced by in-app React pages
