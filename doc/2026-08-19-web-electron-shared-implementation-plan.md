# Web–Electron Shared Application: Executable Implementation Plan

**Date:** 2026-08-19
**Status:** Proposed execution plan — no product implementation in this document
**Normative architecture:**
[`spec/Web-Electron Shared Application Architecture.md`](../spec/Web-Electron%20Shared%20Application%20Architecture.md)

## 1. Purpose and Completion Definition

This plan turns the approved shared Web–Electron architecture into independently
deliverable implementation units. It deliberately preserves the working
Electron application while extracting it; no phase authorizes a broad UI, store,
or slicer-workflow rewrite.

The work is complete only when both hosts run the same core flow:

1. Load STL/3MF from the host.
2. Start the local wasm64 runtime and install all bundled upstream-organized
   system profile packages into MEMFS.
3. Restore/select printer, print, and filament profiles by profile `name`.
4. Edit session-only settings, slice, inspect model/toolpath/layers, and export
   G-code.
5. Persist only selected profile names and shared UI preferences.

Electron remains a supported host throughout. Desktop Chrome 133+ is the Web
baseline; WebGL 2 and wasm64 are mandatory. The Web host chooses threaded WASM
under cross-origin isolation and the separate serial artifact otherwise.

## 2. Non-Goals and Invariants

The following are not introduced by this implementation sequence:

- A remote slicing abstraction, telemetry, or runtime network API beyond
  static first-party asset requests.
- Project/model/result/G-code persistence, user-created profile persistence,
  cloud accounts, or profile downloads/updates.
- Drag-and-drop, PWA/Service Worker behavior, mobile product support, or an
  in-progress slice cancel control.
- WebGL 1, wasm32, or a non-Chrome production support path.
- A sliced-mesh result preview. The current product result is toolpath and
  layers; model meshes remain visible.

Preserve these invariants in every implementation change:

- `packages/slicer-wasm/src/client` remains the only JS layer calling C++.
- The renderer/common UI never accesses `window.orca`, Electron, Node.js, or
  an OS path directly.
- The shared UI only receives display names and byte data. Electron retains an
  import path privately in memory for future reload support; the path is not
  persisted or displayed in the shared UI.
- Profile content changes do not rebuild WASM. Rebuild WASM only for profile
  package format or runtime/bridge interpretation changes.
- Every result-invalidating input change immediately clears toolpath/layer
  preview and disables export.

## 3. Working Method

Each numbered step below is a separate, reviewable commit after its acceptance
checks pass. A step may be split further if a check cannot be made focused. Do
not start its successor until its Electron regression gate is green.

For every code-bearing step:

1. Add or update the focused unit/integration/E2E coverage first or in the
   same commit.
2. Run the step's listed checks.
3. Commit only the completed unit.
4. Record deviations, skipped environment-only checks, and actual results in a
   dated implementation note.

The standard final gate for a milestone is:

```powershell
pnpm test
pnpm typecheck
pnpm --filter desktop test:e2e
```

When C++ bridge, WASM build settings, or generated artifacts change, additionally
run the Windows incremental build path and the relevant real-module smoke:

```powershell
scripts\build-windows.bat quick
node packages/slicer-wasm/harness/run-slice.mjs --module <real-module> --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
```

Electron E2E runs outside the sandbox when required. Do not claim real-WASM,
browser isolation, or packaging verification from mock-only tests.

## 4. Step 0 — Establish the Migration Baseline

**Goal:** freeze measurable current behavior before extraction.

**Changes**

- Add a short migration-baseline note containing the current Electron test
  commands, expected core user flow, current public IPC surface, current
  AppConfig behavior, and the current static renderer/Worker/WASM URL layout.
- Make the existing Electron E2E explicitly cover: boot, model add, profile
  selection, model transform, slice, toolpath/layer preview, export, and clear
  scene. Reuse existing coverage where it is already explicit; do not duplicate
  tests merely for a checklist.
- Save screenshots or stable test IDs only for the behavior needed to detect a
  platform-boundary regression. Do not snapshot the entire UI.

**Acceptance**

- Existing desktop unit/type/E2E checks are green on the baseline commit.
- The baseline states that the current AppConfig model is temporary and will be
  retired in steps 8–9; it is not treated as a Web requirement.

**Commit:** `test: capture shared-app migration baseline`

## 5. Step 1 — Add Dependency-Free Platform Contracts

**Goal:** create the shared boundary without moving UI or changing Electron
behavior.

**New package:** `packages/platform-contract/`

**Changes**

- Define type-only/value-free contracts for:
  - `ModelImporter`: returns `{ displayName, bytes }` or cancellation.
  - `GcodeExporter`: saves supplied bytes under a default filename.
  - `UserPreferencesRepository`: `load()`/`save()` with a versioned
    `UserPreferences` model and in-memory failure fallback.
  - `PlatformChrome`: host kind plus the macOS safe-inset/drag-region variant
    needed by the common `BrandBar`.
  - `ProfileSource`: supplies a manifest and package bytes/streams by relative
    runtime URL; it contains no Node or Electron types.
  - `SlicerRuntime` lifecycle/status contract, initially wrapping the existing
    typed client rather than introducing a second engine abstraction.
- Add a provider/context factory so common React code has one injected
  `PlatformCapabilities` object.
- Keep these contracts free of React components, Electron imports, Node builtins,
  `File`, absolute paths, and Emscripten module globals.
- Add contract tests using fake import/export/preferences/profile sources.

**Acceptance**

- The package typechecks and its tests execute in Node/Vitest with no Electron
  runtime.
- A compile-only guard proves `packages/platform-contract` does not import
  `electron`, `node:*`, or `apps/desktop`.
- No existing renderer file consumes the contracts yet; Electron behavior is
  unchanged.

**Commit:** `feat(platform-contract): define shared host interfaces`

## 6. Step 2 — Introduce an Electron Adapter, Without Extracting UI

**Goal:** eliminate direct host reads from feature components while retaining
the current Electron renderer directory and all current behavior.

**Changes**

- Add `apps/desktop/src/renderer/src/platform/createDesktopPlatform.ts` (or
  equivalent host-only location). It is the sole renderer-side consumer of
  `window.orca`.
- Wrap existing preload operations in `ModelImporter` and `GcodeExporter`.
  Keep absolute selected paths only in a desktop-private in-memory map keyed by
  import; pass the common UI just `displayName` and bytes.
- Add an Electron preferences adapter, but initially allow the legacy AppConfig
  adapter to remain internal so the current boot path continues to work.
- Refactor `TitleBar` into common visual `BrandBar` plus Electron-supplied
  drag-region/macOS-inset styling. It must look and act unchanged in Electron.
- Refactor sidebar-width reads/writes behind the preference interface. Preserve
  current values during this temporary migration if practical; do not build a
  general migration framework.
- Replace all feature-level `window.orca` use (currently boot, settings save,
  toolbar file operations, and title bar platform detection) with injected
  services. Leave only the desktop adapter's narrow bridge access.

**Acceptance**

- Repository search finds no `window.orca` in common feature components or
  stores; it occurs only in the Electron adapter/bootstrap boundary.
- Desktop unit tests cover import cancellation, a successful import, export
  handoff, preference read/write fallback, and macOS/non-macOS brand-bar props.
- Existing Electron E2E baseline passes unchanged.

**Commit:** `refactor(desktop): adapt renderer to platform contracts`

## 7. Step 3 — Extract the Shared React Application Incrementally

**Goal:** move platform-neutral code without changing its domain behavior.

**New package:** `packages/slicer-app/`

**Changes**

- Configure workspace TypeScript/Vite aliases so `slicer-app` source can be
  consumed by Electron before introducing a separate packaged library build.
- Move in small slices, retaining imports/tests with each slice:
  1. shared UI primitives, theme/global styles, and `BrandBar`;
  2. layout shell and status components;
  3. settings/preset UI and stores;
  4. toolbar orchestration and result invalidation;
  5. viewport, model loading, selection, move gizmo, toolpath, and layer
     scrubber.
- Keep Electron-only bootstrap/entry files as thin composition roots that
  inject the desktop platform and render the shared app.
- Preserve current toolpath-only slice result behavior; do not restore the
  removed SlicedMesh feature as part of extraction.

**Acceptance per extraction slice**

- The moved module's existing tests move with it and remain green.
- The Electron entry builds and all baseline E2E checks pass after every slice.
- Import-direction lint/test: `slicer-app` may depend on
  `platform-contract`, `slicer-runtime`, and `slicer-wasm` client types, but
  never on `apps/desktop`, Electron, Node, preload, or absolute filesystem
  paths.

**Commit sequence:** one commit per listed extraction slice, e.g.
`refactor(slicer-app): move shared layout shell`.

## 8. Step 4 — Extract a Reusable Runtime Bootstrap

**Goal:** make Worker creation, capability evaluation, and lifecycle state
portable while keeping the existing `SlicerClient` as the stateful bridge API.

**New package:** `packages/slicer-runtime/`

**Changes**

- Move the app-specific Worker entry and client setup out of
  `apps/desktop/src/renderer/src/slicer/`.
- Define a host-supplied runtime-asset resolver based on `new URL(...,
  import.meta.url)` or a supplied module base. Never hard-code `/wasm`, a host,
  or an origin.
- Implement capability detection before runtime creation:
  - require WebGL 2 and wasm64;
  - select the threaded artifact only when `crossOriginIsolated` and required
    thread primitives are usable;
  - otherwise select serial wasm64 and report a non-blocking status;
  - return an unsupported state instead of attempting a partial launch when
    WebGL 2 or wasm64 is unavailable.
- Initially point both artifact choices at clearly staged test artifacts as
  needed; wire real dual build outputs only in step 10.
- Define runtime phases: `checking-capabilities`, `loading-runtime`,
  `installing-profiles`, `ready`, `unsupported`, and `failed`.

**Acceptance**

- Unit tests cover each capability branch and URL construction under root,
  subpath, and Electron loopback-style bases.
- Worker protocol tests continue to exercise transferable model/result buffers
  and toolpath/layer retrieval.
- Electron defaults to the existing working path and passes E2E.

**Commit:** `refactor(slicer-runtime): extract portable worker bootstrap`

## 9. Step 5 — Build Versioned Profile Packages Independently of WASM

**Goal:** replace profile preloading with reproducible static resources without
changing C++ profile-path expectations.

**Changes**

- Add a profile-pack build tool under `packages/slicer-wasm` or `tools/` that:
  - reads the upstream OrcaSlicer profile tree;
  - derives `core` versus vendor ownership deterministically from that tree;
  - writes a versioned `profiles/manifest.json`, one core ZIP, and one ZIP per
    vendor, preserving relative paths inside each archive;
  - emits immutable content/versioned filenames suitable for static hosting.
- Do not maintain a manual vendor-file manifest.
- Add a package-layout fixture with a small upstream-shaped tree to test
  ownership, archive paths, manifest generation, empty/vendor-error cases, and
  deterministic output.
- Remove the profile `--preload-file` behavior only after the installer in step
  6 is verified; until then retain it as a temporary desktop compatibility path.

**Acceptance**

- Changing only fixture profile content changes package/manifest output and
  does not invoke the WASM build.
- A deterministic build test reproduces the same manifest/package paths from
  identical input.
- CI has an explicit profile-pack target separate from the WASM target.

**Commit:** `feat(profiles): build upstream-organized static packages`

## 10. Step 6 — Install Profile Packages into MEMFS

**Goal:** install the complete bundled profile set into the existing virtual
filesystem before `orc_init()`.

**Changes**

- Implement a Worker-only archive installer using a browser-compatible ZIP
  dependency selected with license and bundle-size review.
- Fetch the manifest and all package URLs through `ProfileSource`, unpack
  `core` and every vendor package into the existing paths expected by C++
  (including `/system` and `/info`), then call `orc_init()`.
- Emit package-level bootstrap progress for the common startup screen.
- Apply approved failure semantics:
  - a failed vendor package is skipped and logged to the console;
  - a failed core package or WASM initialization produces `failed` and does
    not enter the main UI;
  - no retry UI, package validation, hash/signature check, or update system.
- Add a Node `ProfileSource` for the existing smoke harness. The harness stages
  the same package artifacts into MEMFS; it must not reintroduce preload files.

**Acceptance**

- Installer tests assert the exact expected MEMFS file tree for fixture packs.
- Tests prove a broken vendor is skipped and a broken core rejects startup.
- Node smoke slices a fixture through the package installer.
- Electron uses the installer against static renderer-served resources and
  completes the existing E2E core flow.

**Commit:** `feat(slicer-runtime): install profile packages into memfs`

## 11. Step 7 — Replace AppConfig With Shared Preferences

**Goal:** align Electron and Web persistence to the approved minimal model.

**Changes**

- Add the shared `UserPreferences` schema:

  ```ts
  { version: 1, selectedProfiles: { printer?, print?, filament? }, ui: { sidebarWidth? } }
  ```

- Implement Electron file-backed and Web localStorage repositories. Both must
  discard malformed/unknown data, log unavailable read/write storage, and use
  in-memory defaults for the current session.
- After package installation, restore profile selections through the C++ bridge
  in printer → print → filament order. Accept bridge-selected compatibility;
  do not duplicate it in TypeScript. Fall back to bridge default, then first
  available profile, logging a missing stored name.
- Immediately write the resolved combination to preferences.
- Make a system profile selection clear temporary slicer-setting overrides and
  invalidate the current slice result.
- Remove AppConfig from common boot, renderer calls, IPC/preload types, client
  contracts, and eventually the C++ bridge API. A short-lived adapter may exist
  only while a prior sub-step still has callers; delete it in this step's final
  commit.

**Acceptance**

- Repository contract tests cover valid values, corrupt values, unavailable
  storage, missing selections, bridge fallback order, and immediate corrected
  persistence.
- Electron E2E verifies selected names and sidebar width survive a relaunch;
  it also verifies model/settings/result data do not survive.
- Search confirms final shared/application code has no AppConfig boot or save
  usage. WASM quick build and Node smoke pass when bridge symbols change.

**Commit sequence:** schema/adapters, restoration behavior, then final legacy
AppConfig removal as separate commits.

## 12. Step 8 — Switch Electron Fully to the Shared Runtime

**Goal:** make Electron the first complete consumer of the shared app/runtime
with no behavior regression.

**Changes**

- Serve profile packages alongside renderer/WASM assets from the existing
  restricted loopback HTTP server; add correct MIME handling where needed.
- Bundle and unpack all first-release packages at startup. The common startup
  screen prevents interaction until runtime/profile installation completes.
- Compose the shared `BrandBar` with Electron drag region and macOS traffic
  light inset. Retain the existing frameless window behavior.
- Ensure Electron import keeps a private current-session absolute-path mapping
  while shared UI displays file names only.
- Delete transitional desktop renderer-specific runtime/profile boot code that
  duplicates `slicer-runtime`.

**Acceptance**

- Packaged-app probe proves Worker, threaded WASM, and profile packages load
  from the Electron loopback origin.
- Electron E2E passes the full core flow and tests startup failure behavior
  with a deliberately missing/corrupt core fixture.
- Existing native dialogs remain the import/export mechanism.

**Commit:** `refactor(desktop): consume shared runtime and profile packages`

## 13. Step 9 — Add the Static Web Host and Browser Adapter

**Goal:** bring up `apps/web` as a thin host around the already working shared
application.

**Changes**

- Create `apps/web` with Vite, the shared aliases/configuration, a browser
  platform adapter, and static copies/references for runtime/profile assets.
- Implement browser model selection with `<input type=file>` and bytes read in
  the adapter; use selected file name as `displayName`.
- Implement G-code export with a Blob/object URL and normal browser download.
- Use localStorage preferences with the approved failure fallback.
- Render the common `BrandBar` without Electron-only drag/window behavior.
- Render a shared startup screen, an unsupported-environment screen, and the
  desktop minimum viewport behavior (1024 × 700 CSS pixels with overflow below
  it).
- Add a first-release visible AGPL source link.
- Register `beforeunload` only when ephemeral model/override/unexported-result
  state is dirty. Do not promise custom browser prompt content or restoration.

**Acceptance**

- Web unit tests run without Electron imports or globals.
- A dev-server smoke test confirms loading under a non-root base path.
- Browser E2E covers file import, profile selection, settings change, slice,
  toolpath/layer inspection, Blob download, result invalidation, and the
  native-leave-warning registration state.
- Static build contains no dependency on Electron/Node APIs and no third-party
  runtime CDN URLs.

**Commit sequence:** Web shell/adapters, startup/errors, then complete core
flow E2E as separate commits.

## 14. Step 10 — Produce and Verify Both Real wasm64 Artifacts

**Goal:** make threaded and serial fallback behavior real release artifacts,
not a UI-only switch.

**Changes**

- Parameterize the Emscripten/CMake build for separate, identically contracted
  threaded and serial wasm64 outputs, including their Worker-compatible loader
  assets.
- Threaded output uses the approved full
  `navigator.hardwareConcurrency` pool policy. Serial output does not request
  pthread/SharedArrayBuffer prerequisites.
- Stage both artifacts into Electron and Web asset layouts with relative URLs.
- Configure normal Web development/E2E with COOP/COEP. Add separate explicit
  serial-mode dev/E2E commands that omit those headers; do not make reduced
  mode the default.
- Confirm production static-host documentation requires HTTPS, same-origin
  first-party assets, COOP/COEP for threaded operation, and a correct WASM MIME
  type. No service worker or deployment-consistency safeguard is added.

**Acceptance**

- Real Chrome 133+ E2E under COOP/COEP selects and slices with the threaded
  artifact.
- Real Chrome 133+ E2E without isolation selects and slices with serial wasm64
  and exposes the non-blocking status.
- Unsupported WebGL 2 and wasm64 test shims render the refusal screen rather
  than starting a degraded application.
- Electron packaged E2E still selects the threaded artifact under its loopback
  origin. Run the relevant quick build and Node smoke for both artifacts.

**Commit:** split build/staging, selection, and real-browser E2E into separate
commits; do not combine an artifact build rewrite with UI extraction.

## 15. Step 11 — Release and Regression Gates

**Goal:** prove the two hosts are shipping the approved first-release scope.

**Required automated matrix**

| Layer | Required evidence |
| --- | --- |
| Contracts/shared UI | Vitest without Electron; import-direction guard |
| Profile packaging | Deterministic fixture-pack test; full-manifest integration test |
| Runtime | Worker protocol + capability/asset-resolution unit tests |
| Node | Serial and threaded package-installer smoke where artifacts are available |
| Electron | Unit/typecheck, core E2E, packaged loopback/asset probe |
| Web | Chrome 133+ threaded COOP/COEP E2E and explicit serial fallback E2E |
| Release smoke | Full vendor-package boot followed by a representative slice/export |

**Manual release checks**

- Verify Chrome's unsupported screen with WebGL 2 or wasm64 deliberately absent.
- Verify Electron macOS title-bar safe inset and Windows/Linux drag/overlay
  behavior retain the current design.
- Verify browser download name, Electron native save dialog, model file-name
  display, and absence of persisted models/settings/results.
- Confirm the Web build serves all first-party assets from the same origin and
  offers the AGPL source link.

**Release exit criteria**

- No unapproved `window.orca`/Electron/Node dependency has entered shared
  packages.
- Both real artifacts pass their actual target-host E2E path.
- Full profile packages are included in both hosts and startup behavior matches
  the approved core/vendor failure policy.
- All planned deferred features remain absent or explicitly guarded; no partial
  project persistence, user-profile saving, cloud access, drag-and-drop, or
  cancel control is silently introduced.

## 16. Rollback and Sequencing Rules

- If a step breaks Electron E2E, revert that step rather than carrying a broken
  desktop host into the next extraction phase.
- Keep profile preload and AppConfig only for the explicitly bounded transition
  described above; remove each after its replacement passes its dedicated
  package-installer/preference tests.
- A Web host may land behind its own build target before real WASM is ready, but
  it must not be presented as supported until the real artifact and Chrome E2E
  gates pass.
- Do not merge unrelated viewport, slicer-core, or UI redesign work into these
  commits. Rebase or merge upstream regularly and update this plan/spec if an
  upstream change alters a stated current behavior (as the SlicedMesh removal
  did).
