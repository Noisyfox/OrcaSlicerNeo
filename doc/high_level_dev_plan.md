# High Level Development Plan (updated 2026-08-20)

## Context

- Scope: next-generation OrcaSlicer application on Electron and a conventional
  static Web host, sharing React + TypeScript + Vite + shadcn/ui features and
  a local WASM slicing core (`libslic3r`). Electron continues to target Windows
  x64/arm64, Linux x64/arm64, and macOS x64/arm64; the Web target is desktop
  Chrome 133+ with WebGL 2 and wasm64. See the approved
  `spec/Web-Electron Shared Application Architecture.md` for the normative
  cross-host design, `doc/2026-08-12-electron-gui-rewrite-design.md` for the
  delivered desktop vertical slice, and `spec/Grand Plan.md` for milestones.
- Guardrails: `libslic3r` changes are minimal (patches/stubs/shim only, never
  ad-hoc edits to the submodule); all C++↔JS traffic goes through the extern "C"
  bridge; docs-first (dated notes in `doc/`).
- Testing: every milestone ships with its smoke/unit/e2e layer — Node smoke for
  the WASM module, vitest with a mock Emscripten module for the shared
  packages/client, Playwright Electron for the desktop app and Playwright
  Chrome for the Web host (real threaded + serial artifacts).

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
  `orc_init`, `orc_get_presets`, `orc_get_option_metadata`, `orc_add_model`,
  `orc_clear_model`,
  `orc_slice` (progress via registered JS callback from `set_status_callback`),
  `orc_get_slice_result` (toolpath + stats), `orc_export_gcode`
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
> binary result buffers (toolpath); layer scrubber;
> G-code export through the native save dialog. Real-module verification
> (WASM rebuild + `bridge-smoke.mjs` + `run-slice.mjs`) is deferred — the
> delivery machine has no emsdk; the binary-buffer bridge is unit-tested
> against the mock and carries an explicit verify step on an emsdk machine.
> See `doc/2026-08-13-m2-implementation-notes.md`.

**Epic 2.1: `slicer-wasm` JS client**
- `packages/slicer-wasm/src/client/`: promise-based typed API (`addModel`,
  `clearModel`,
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

> **Status: delivered 2026-08-14.** electron-builder config for all six
> targets (win NSIS x64/arm64, linux AppImage x64/arm64, mac DMG x64/arm64)
> sharing one staged WASM artifact; Playwright Electron e2e driving the full
> v1 flow (mock module locally, real module in CI — asserts exported gcode
> contents) plus a packaged-app probe of the packaged app:// wasm URL path;
> GitHub Actions matrix (wasm+smoke, unit/typecheck, e2e-mock, e2e-real,
> package); full `resources/profiles` bundle via `--preload-file` (replaces
> the M1 curated subset); root `LICENSE` (AGPL-3.0) + `SOURCE_OFFER.md`;
> slice cross-check procedure + script. Deferred to first CI push: the WASM
> rebuild + harnesses + e2e-real + six-target packaging (no emsdk on the
> delivery machine — M2 precedent; the CI wasm job is the first real
> execution of the M2-deferred bridge verification). Slice cross-check
> additionally needs desktop OrcaSlicer (emsdk machine).
> See `doc/2026-08-14-m3-implementation-notes.md`.

**Epic 3.1: electron-builder**
- Config (electron-builder.yml): win x64/arm64 (NSIS), linux x64/arm64
  (AppImage), mac x64/arm64 (DMG); unsigned v1; `asarUnpack` for
  `out/renderer/wasm/**` (fetch() cannot read inside asar); NSIS license
  page shows AGPL-3.0. One `stage:wasm` artifact feeds all six bundles.

**Epic 3.2: e2e + CI**
- Playwright Electron (`@playwright/test`, `_electron.launch`): full v1 flow
  spec (open → slice → preview → export, asserts gcode file contents) —
  mock build locally, real module in CI (`ORCA_E2E_REAL=1`); `ORCA_E2E`
  env-gated native-dialog stub in main (Playwright cannot drive native
  dialogs). Packaged-app probe spec (stub module, `package:dir`).
- GitHub Actions: wasm job (emsdk 6.0.4, dep cache, both harnesses,
  artifact = orca_slice.{js,wasm,data}), unit, e2e-mock, e2e-real, package
  matrix (win/ubuntu/macos-13/macos-14 → six targets, no arm runners).

**Epic 3.3: Full preset bundle**
- `--preload-file` of the full `resources/profiles` (72 MB) mounted at
  `/system` replaces the curated `--embed-file` subset
  (`WASM_PROFILES_DIR` override for lighter local builds); `orca_slice.data`
  staged alongside the module; heap grows at startup (ALLOW_MEMORY_GROWTH).
- Root `LICENSE` (AGPL-3.0 canonical text) + `SOURCE_OFFER.md`; installer
  license page; `license` fields in package.jsons.

### Milestone 4 — Preset Management with AppConfig Fidelity

> **Status: delivered 2026-08-15.** The preset picker drives installed-state
> via the real `AppConfig`/variant mechanism (not `is_visible` cosmetics).
> Bridge: `orc_init(app_config_json)` (nullable; no-arg backward
> compatible), `orc_set_app_config`, `orc_get_app_config`,
> `orc_select_preset(kind, name)` (real `select_preset_by_name` path with the
> `load_selections` compat tail + all-three write-back); `orc_get_presets`
> enriched (`is_visible` = real `set_visible_from_appconfig` result,
> `is_default`, `selected`, `vendor_id`, `model`, `variant`); fresh-config
> default installs every shipped printer via `set_variant`, partial `models`
> configs leave only the listed variants visible. Electron: `appConfig:load`/
> `appConfig:save` IPC → `userData/appconfig.json`, boot loads config →
> `init(json)`, picker groups visible-first with a dimmed "Not installed"
> group; selection change → `selectPreset` → store sync → `appConfig.save`.
> Hardening: `catch (...)` on every bridge op + the bridge TUs compiled with
> `-fexceptions` (emcc's default `-fignore-exceptions` compiles try/catch out
> — the flag was link-time only, so the M4 probe's section-4 nlohmann throw
> unwound into JS as an uncatchable `CppException` despite the handlers;
> now caught → JSON error, module alive), CSP headers (prod + dev),
> `nozzle_info.json` parse error eliminated (`/info` preload mount). Fresh
> installs persist default filaments via the real `load_selections` path.
> Verified: 9-section probe matrix (all green), client + stores vitest,
> harnesses, typecheck. Install/uninstall UI (picker's hidden group disabled
> in v1) + the full settings surface + search remain queued.
> See `doc/2026-08-15-m4-preset-management-{design,implementation-notes}.md`.

### Milestone 5 — Move Gizmo

> **Status: delivered 2026-08-16** (amended 2026-08-17: body drag no
> longer locks Z — free drag in the camera-facing plane, see the notes
> doc). Full move tool in the 3D viewport: drei TransformControls gizmo
> (translate, world space) on selection — axis arrows + plane handles, Z
> lift; body drag via drei DragControls (free — no axis lock) replacing
> the M2 hand-rolled pointer drag; sidebar move panel (numeric X/Y/Z,
> Drop to bed, Reset). Since Milestone 6, the controls update local
> CompositeID GLVolume state and synchronize it only before slicing. Flip
> buttons, snap and multi-select remain deferred. See
> `doc/2026-08-16-move-gizmo-{design,implementation-notes}.md`.

### Milestone 6 — Composite GLVolume Project State

> **Status: delivered 2026-08-17.** The renderer now models the native canvas
> identity `(objectIdx, volumeIdx, instanceIdx)` and retains transforms locally
> until a pre-slice synchronization applies them to the WASM `Model`. See
> `doc/2026-08-17-multi-object-glvolume-design.md`.

### Milestone 7 — Scene-owned Multi-volume Selection

> **Status: implemented and verified (2026-08-18; amended: pointer-down body
> selection).** Refactor selection,
> drag state, and gizmo state out of individual GLVolume meshes and into the
> scene. A scene-owned `Selection` will contain multiple composite GL volumes;
> body drag and the single open gizmo will act on the whole selection. The
> proposed default follows native OrcaSlicer's instance selection semantics:
> a hit GL volume expands to all volumes of its `(objectIdx, instanceIdx)` and
> preserves their shared instance transform. Ctrl/Cmd toggles instances, Shift
> remains reserved for box selection, and gizmo grabbers strictly take pointer
> priority over body drags. See
> `doc/2026-08-18-scene-selection-design.md`. Pointer origin is latched at
> mouse-down, so moving quickly from a model body to a grabber cannot turn the
> body gesture into a gizmo operation; see
> `doc/2026-08-18-pointer-origin-gizmo-regression.md`.

### Milestone 8 — Add Model and Clear Scene

> **Status: delivered 2026-08-18.** The toolbar's former replacement-style
> **Open** action is now **Add Model**. Files are appended to the bridge's
> current `Model`, while **Clear Scene** explicitly resets the model, print
> result, renderer collection, and selection. See
> `doc/2026-08-18-add-model-and-clear-scene.md`.

### Viewport Interaction Performance Follow-up

> **Status: delivered 2026-08-18.** The React Three Fiber event layer now
> disables raycasting for active camera, body, and gizmo drags. This prevents
> dense model geometry from lowering orbit frame rate only while the pointer
> is over the model. See `doc/2026-08-18-disable-raycasting-during-drag.md`.

### Milestone 9 — Shared Web–Electron Application Architecture

> **Status: delivered 2026-08-20** (migration steps 0–11 per
> `doc/2026-08-19-web-electron-shared-implementation-plan.md`). The norm is
> `spec/Web-Electron Shared Application Architecture.md`. This was an
> incremental extraction, not a renderer rewrite: Electron remained usable at
> every step, with one commit per independently verifiable step. Release-gate
> evidence (96 tests, typecheck, both real wasm64 artifacts, web threaded/
> serial e2e, non-root deployment, desktop e2e):
> `doc/2026-08-20-m9-step11-release-regression-audit.md`.

**Epic 9.1: platform contracts and Electron adapter**
- Define injected file-import/export, preferences, platform-chrome, runtime,
  and profile-source contracts.
- **Step 1 delivered:** `packages/platform-contract` — dependency-free
  contracts + provider context; the shared app no longer touches
  `window.orca` directly (docs: `doc/2026-08-19-m9-step1-platform-contracts.md`).
- **Step 2 delivered:** Electron adapter replacing renderer `window.orca`
  calls, retaining existing Electron behavior as the verification target;
  **steps 3–4 delivered:** platform-neutral UI/stores/viewport extracted into
  `packages/slicer-app` (import-direction guard test included) and
  Worker/runtime orchestration into `packages/slicer-runtime` (portable
  worker bootstrap); Electron retains only its entry and adapter (docs:
  `doc/2026-08-19-m9-step2-shared-extraction.md`).

**Epic 9.2: extract shared application/runtime**
- Move platform-neutral React components, stores, viewport, styles, Worker
  orchestration, and typed client use into the shared workspace packages with
  minimal unrelated behavior change.
- Keep the shared `BrandBar`; Electron contributes frameless drag/macOS inset
  styling and Web supplies the visually matching non-window-control variant.
- **Step 8 delivered:** Electron fully consumes the shared runtime startup
  gate and worker bootstrap; the legacy AppConfig bridge API was removed
  (commit `2c08b8b` — `refactor(wasm): remove legacy AppConfig bridge API`),
  leaving `selectPreset(kind, name)` as the only selection path. Docs:
  `doc/2026-08-20-m9-step8-electron-shared-runtime.md`.

**Epic 9.3: portable profile resources and preferences**
- Build upstream-organized core/vendor profile archives separately from WASM;
  install all shipped packages into MEMFS before `orc_init()`.
- Replace AppConfig persistence with the shared selected-profile/UI-preference
  repository. Profiles, projects, models, overrides, results, and G-code stay
  ephemeral in the first release.
- **Steps 5–6 delivered:** deterministic profile pack generation
  (`packages/profile-resources`: versioned manifest + core/vendor ZIPs from
  upstream organization) and a Worker-side installer into MEMFS with
  per-package console progress; a failed vendor package is skipped, a failed
  `core` package or WASM init fails startup. Docs:
  `doc/2026-08-20-m9-step3-profile-resources.md`.
- **Step 7 delivered:** AppConfig replaced by shared preferences
  (Electron file in user data / Web localStorage, in-memory fallback on
  read/write failure); restoration order printer → print → filament through
  the bridge, resolved combination written back.

**Epic 9.4: static Web host and verification**
- Add `apps/web`, use browser file selection/Blob download, local static
  resources, supported-environment/startup screens, and native `beforeunload`
  protection for ephemeral work.
- Build and verify threaded and serial wasm64 artifacts with Chrome Web E2E;
  retain Electron E2E and compact fixture/full-package release smoke coverage.
- **Step 9 delivered:** static Web host with capability gating (WebGL 2 +
  wasm64 → `threaded` when cross-origin isolated, else `serial` with a
  non-blocking fallback status), runtime asset URLs relative to the
  deployment base (site root / subpath / preview), and `beforeunload`
  guarding. Docs: `doc/2026-08-20-m9-step4-web-host.md`,
  `doc/2026-08-20-fix-dev-wasm-url-shared-runtime.md`.
- **Step 10 delivered:** dual-variant build/staging (separate CMake/output
  trees per variant via `scripts/build-wasm-dual.*` + `stage-wasm.mjs`) and
  real-artifact Chrome e2e for both variants —
  `doc/2026-08-20-m9-step10-dual-wasm-web-e2e.md`.
- **Step 11 delivered:** release/regression audit — see the M9 status block
  above for the evidence list (`doc/2026-08-20-m9-step11-release-regression-audit.md`).

### Milestone 10 — Gizmo Toolbar

> **Status: delivered 2026-08-21.** Gizmo activation is now explicit: a
> horizontal toolbar overlaid on top of the 3D viewport carries a single
> **Move** toggle; selecting an object no longer auto-opens the move gizmo,
> and an emptied selection still auto-closes it. Arming requires a non-empty
> selection — the toggle no-ops and the button is disabled otherwise. See
> `doc/2026-08-21-gizmo-toolbar-design.md`.

- Top-of-viewport overlay toolbar with a Move button (`aria-pressed` toggle).
- The scene controller's `openGizmo` is toggle-only: selection never opens
  it; clear / prune-to-empty / model reset still close it.
- Arming is gated on a non-empty selection (`toggleGizmo` refuses, the button
  is disabled) — amended 2026-08-21.
- Rotate/scale gizmos, a Select button, and G/R/S/Esc shortcuts remain queued
  in Post-v1 Expansion.

## Cross-Cutting Practices

- **Bridge is the only seam:** renderer code never imports the WASM module
  directly; it goes through `packages/slicer-wasm/src/client`. Binary buffers
  cross via the heap and transferables — never JSON.
- **WASM build is iterative:** `TBB_HEADERS` / `DROP_PATTERNS` / `stubs/` /
  bridge-signature drift are the documented fix loops (see AGENTS.md).
- **wasm64 consistency:** all objects, Boost archives, and link must agree on
  `-sMEMORY64`; fall back to wasm32 + `GCode.hpp` size_t fix only if blocked.
- **Parallel WASM slice:** delivered with M9 step 10 — the default `threaded`
  artifact uses upstream oneTBB (pinned commit `3cdc6f6`) over Emscripten
  pthreads, built in its own CMake tree (`doc/2026-08-18-wasm-parallelism-design.md`);
  the serial shim remains the explicit `serial` fallback artifact. Both ship
  and are verified; only perf tuning for large plates stays queued.
- **Docs-first:** each epic creates/updates a short sub-doc in `doc/` capturing
  decisions and testing notes; keep this plan and `spec/Grand Plan.md` in sync
  with delivered work.
- **Slice cross-check:** fixture output must match desktop OrcaSlicer for the
  same model/profile before any release.
