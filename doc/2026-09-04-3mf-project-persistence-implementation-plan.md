# 3MF Project Persistence — Implementation Plan

**Date:** 2026-09-04  
**Status:** Approved execution plan  
**Scope:** Execute `spec/3MF Project Persistence.md` on
`dev/3mf-project-persistence`, without modifying the upstream `libslic3r`
submodule.

## Delivery protocol

The work is strictly serial. Each numbered step is assigned to a fresh
`gpt-5.6-luna` agent at `high` reasoning effort. The agent may change only the
step's declared surface, must run the listed self-verification, and must commit
the completed step. The primary agent then independently reviews the diff and
runs the acceptance checks. The next step starts only after that acceptance
passes.

The existing dirty `packages/slicer-wasm/cpp` submodule is user work and is out
of scope for every step.

## Step 1 — Project platform contract and preference schema

**Functional boundary:** Introduce a host-neutral project-file capability
without exposing desktop paths to shared React code. Extend the persistent
preference model with `projectLoadBehaviour`, normalized to **Ask When
Relevant** when missing or invalid. Electron retains any opened-file path only
behind an opaque in-memory host token; Web retains none. The project open picker
accepts `.3mf` only, while the existing model picker remains unchanged.

**Primary files:** `packages/platform-contract/src/contracts.ts`, preferences
normalizers/tests, `apps/desktop/src/{main,preload,renderer}/`,
`apps/web/src/browserAdapter.ts`, and their focused tests.

**Implementation requirements:**

- Define typed project input, opaque host location, open, Save, and Save As
  results. Cancellation must be distinguishable from failure.
- Make Electron's project open/save adapter own the private location and use
  native dialogs; Web returns bytes from a `.3mf` file and downloads a `.3mf`
  for every save.
- Preserve the current model-import and G-code-export contracts and tests.
- Add no project data or filesystem paths to shared preferences.

**Agent self-verification:** focused contract, Electron-adapter, and
browser-adapter Vitest suites; relevant workspace typecheck.

**Primary-agent acceptance:** inspect that shared packages cannot access host
paths, confirm normalization defaults correctly, and rerun the focused tests
plus `pnpm typecheck`.

## Step 2 — Native BBS 3MF load/save bridge and typed client

**Functional boundary:** Make the stateful WASM session load geometry-only or
full BBS 3MF projects and export the active single-plate session as a secure
BBS 3MF. The bridge is the sole native seam; all JS calls remain in
`packages/slicer-wasm/src/client`.

**Primary files:** `packages/slicer-wasm/src/bridge.cpp`,
`packages/slicer-wasm/src/client/{types.ts,client.ts,worker.ts,testing/mock-module.ts}`,
and `packages/slicer-wasm/harness/`.

**Implementation requirements:**

- Correct the existing 3MF add-model path to include `LoadStrategy::LoadModel`.
- Stage project bytes in unique MEMFS paths. Full project load uses the
  upstream BBS reader with model and eligible configuration restoration;
  geometry-only load restores only model/layout and clears imported object/part
  settings other than extruder assignment.
- Parse before mutating the active session so an invalid/cancelled load leaves
  it intact. Return structured compatibility, multi-plate, and embedded-preset
  warning metadata needed by the shared layer.
- Export through a temporary MEMFS output using upstream `store_bbs_3mf` and a
  secure composed configuration; no G-code, result, thumbnail, or credentials
  enter the archive. Copy exported bytes through the typed client and Worker
  as transferables.
- Extend the mock module and client tests with the same public operations.

**Agent self-verification:** client/worker mock tests; `scripts\\build-windows.bat
quick`; serial and threaded bridge smoke; new real round-trip harness proving a
self-saved BBS 3MF can be reopened and retains model structure/layout.

**Primary-agent acceptance:** inspect bridge flags and temporary-file cleanup,
run the relevant pnpm tests and both real-variant smoke/round-trip commands,
and verify no submodule file changed.

## Step 3 — Shared project session and transactional runtime actions

**Functional boundary:** Add a shared project-session state machine and action
layer. It owns project name, dirty baseline, project-vs-system preset scope,
flattened-multi-plate state, compatibility notices, and operation phase; the
host owns only the opaque save location. It provides atomic New, Open,
geometry-only import, Save, and Save As operations to UI callers.

**Primary files:** `packages/slicer-runtime/src/`,
`packages/slicer-app/src/stores/`, `packages/slicer-app/src/preferences.ts`,
and focused action/store tests.

**Implementation requirements:**

- Apply the four Orca load behaviours and their exact prompt prerequisite;
  generic, incompatible, and missing-setting files use the documented
  geometry fallback.
- Save/Don't Save/Cancel gates only project replacement. A successful Web save
  download may continue an internal New/Open action; cancellation and failure
  do not mutate the session.
- Track all model, structure, transform, supported-setting, and preset
  selection mutations as dirty; generated slice output is never dirty state.
- Keep loaded project configurations/preset selections project-scoped, restore
  the global selection on exit, and keep opaque native settings available for
  slicing/re-save.
- Surface progress/cancellation state and invalidate any current slice result
  whenever project input changes.

**Agent self-verification:** new isolated store/action tests covering every
load behaviour, fallback, dirty gate, project-scoped selection restoration,
and failed/cancelled atomicity; `pnpm --filter @orca/slicer-app test` and
`pnpm --filter @orca/slicer-runtime test`; applicable typechecks.

**Primary-agent acceptance:** independently inspect the state transitions and
rerun the focused tests. In particular, prove a geometry-only import never
replaces settings and a compatibility fallback after explicit project-open
does replace the project but omits unavailable settings.

## Step 4 — Shared command surface, dialogs, and preferences UI

**Functional boundary:** Expose the project actions through the shared File
menu, keyboard shortcuts, Preferences modal, dirty confirmation, load-choice,
compatibility/warning, progress/cancel, and multi-plate flatten notices. The
native macOS and custom/browser menu surfaces consume the same complete menu
state projection.

**Primary files:** `packages/platform-contract/src/menu.ts`,
`packages/slicer-app/src/{menu,components,App.tsx}`, and shared menu/component
tests.

**Implementation requirements:**

- Add New Project, Open Project, Save Project, Save Project As, and
  Preferences while retaining Add Model's append-only meaning.
- Implement Ctrl/Cmd+N/O/S/Shift+S and prevent browser defaults on Web.
- Enforce documented readiness/dirty/slicing/project-operation enablement;
  Save As stays available for clean project content.
- Implement the Open-as-project versus Import-geometry choice with the
  specified default, warning preference, and the required dialog order.
- Show multi-plate flatten warning at load and again before save. Unsupported
  G-code/sliced-result 3MF leaves the session unchanged.

**Agent self-verification:** shared menu command/unit/component tests and
`pnpm --filter @orca/slicer-app test`; focused Electron mock menu tests;
workspace typecheck.

**Primary-agent acceptance:** independently run those suites and inspect the
menu snapshot/dispatcher so stale host commands cannot bypass the new guards.

## Step 5 — Cross-host drag/drop and lifecycle integration

**Functional boundary:** Wire File-menu project actions and project session
state into both desktop and Web hosts. `.3mf` drag/drop is an Open Project
entry point; multi-file inputs use deterministic filename order, first project
semantics, subsequent geometry imports, and whole-batch cancellation. Electron
close receives Save/Don't Save/Cancel; Web internal actions do too, while
browser unload remains native leave/cancel only.

**Primary files:** `apps/desktop/src/{main,preload,renderer}/`,
`apps/web/src/`, host adapters, and desktop/Web E2E specs.

**Implementation requirements:**

- Ensure a desktop project opened by picker or drop can later Save through its
  private opaque location; Web always downloads and never claims overwrite.
- Reuse exactly the shared project action path for drag/drop; do not create a
  host-only importer.
- Reject unsupported mixed G-code/sliced-result inputs without partial model
  mutation. Cancelled first project choice leaves the entire batch unchanged.
- Keep operating-system association/double-click and mobile support out of
  scope.

**Agent self-verification:** focused adapter tests and mock Electron/Web E2E
for picker, drag/drop, dirty confirmation, Save/Save As, and Web download.

**Primary-agent acceptance:** independently run the new focused E2E suites and
inspect that no host path crosses into `slicer-app` or preferences.

## Step 6 — Compatibility fixtures, release regression, and documentation

**Functional boundary:** Close the milestone with real-artifact compatibility
coverage and update the accepted spec/roadmap from pending to delivered only
for evidence that actually passes. No new user-facing behavior is introduced.

**Primary files:** fixture/harness and E2E tests, `spec/3MF Project
Persistence.md`, `spec/Grand Plan.md`, `doc/high_level_dev_plan.md`, and the
living implementation record as appropriate.

**Implementation requirements:**

- Add fixed upstream Orca, BambuStudio, and generic/Prusa 3MF fixtures with
  documented provenance and license-safe storage; cover generic fallback.
- Run self-save/reopen round trips in both WASM variants, then cross-host
  Electron and Web end-to-end flows against real artifacts where available.
- Do not claim a check that the current machine cannot run; leave an explicit
  CI/release-gate command instead.

**Agent self-verification:** `pnpm test`, `pnpm typecheck`, required quick
WASM build/smoke, desktop E2E, and threaded/serial Web E2E; report exact
skips/failures.

**Primary-agent acceptance:** independently rerun the release gate within the
available environment, review fixture provenance and all documentation status,
then make the final in-scope commit only if the evidence supports it.

### Step 6 execution record (2026-09-04)

The controlled fixture set is `packages/slicer-wasm/fixtures/project-compatibility/`.
`acquire-project-fixtures.mjs --download` fetched the fixed OrcaSlicer,
BambuStudio, and PrusaSlicer archives from the manifest URLs and verified all
three byte counts and SHA-256 digests; the archives remain git-ignored. Since
the two vendor calibration samples contain geometry but no embedded project
preset settings, `project-compatibility.mjs` records their observed `generic`
classification and successful geometry-only fallback. `project-roundtrip.mjs`
records the generated self-saved BBS archive as `bambu` and checks model
structure retention.

Observed verification on Windows:

- `pnpm test` passed (572 tests) and `pnpm typecheck` passed.
- `scripts\\build-windows.bat quick` rebuilt/staged both variants; the existing
  `scripts\\build-windows.bat smoke` suite passed.
- Serial self-save/reopen and all three fixture compatibility/fallback checks
  passed.
- Desktop E2E passed (28 passed, 3 intentional skips).
- Threaded project round-trip/compatibility aborts during geometry-only load;
  this remains a CI/release gate.
- Threaded and serial Web E2E each have 1 pass and 1 failure at the existing
  strict `web.e2e.ts:95` layer-scrubber locator (two range inputs). These are
  reported as failures, not delivered evidence.

The spec and roadmap intentionally remain non-delivered until the retained
threaded and Web gates pass. No new user-visible behavior was introduced by
Step 6.

## Release-blocker remediation (2026-09-04)

The user requested that the two retained release blockers be fixed on this
branch.  The remediation remains strictly serial: a fresh `gpt-5.6-luna`
agent at `high` reasoning effort implements each step, self-verifies it, and
commits it.  The primary agent independently reproduces and accepts that step
before starting the next one.

### Step 7 — Threaded 3MF geometry-only load stability

**Functional boundary:** Reproduce the threaded artifact's abort during the
geometry-only stage of the project round-trip/compatibility harness, identify
the native/bridge lifetime or concurrency defect, and fix it without changing
serial behavior or the public project contract.

**Acceptance boundary:** Both `project-roundtrip.mjs` and
`project-compatibility.mjs` complete successfully against the current threaded
artifact after a dual-variant quick build.  Serial project harnesses and typed
client tests remain green.  Any C++ change follows the WASM patch/bridge rules
and does not modify the upstream submodule.

**Step 7 running record (2026-09-04):** The abort was reproduced after the
geometry-only `load_bbs_3mf` call returned.  The temporary candidate `Model`
had lazily created a backup path; its destructor then entered upstream
`_BBS_Backup_Manager::remove_backup`, which constructs a process-lifetime
`boost::thread`.  That native manager is outside the synchronous WASM bridge
contract and leaves the threaded Node harness stuck during candidate cleanup.
The accepted WASM boundary for this step is that backup/restore functionality
is not provided by either WASM variant.  Patch `0008` conditionally excludes
the complete upstream manager and its backup entry points from the build, and
`stubs/backup-manager-stub.cpp` supplies ABI-compatible no-op functions while
retaining direct temporary-path cleanup in `remove_backup`.  No upstream
submodule source was edited by hand; serial and threaded builds use the same
stub boundary.  The full build path applies the patch during configure, and
the incremental `scripts/build-windows.bat quick` / `scripts/build.sh quick`
paths now re-apply it before Ninja so neither variant can silently compile the
upstream manager.  The round-trip harness now follows geometry-only import with
`orc_get_model_structure` to cover post-destruction bridge liveness.  This is a
Step 7 implementation record only; the overall milestone is not declared
released here.

### Step 8 — Real Web project release E2E completion

**Functional boundary:** Repair the layer-scrubber Playwright assertion so it
selects the intended control unambiguously, then run threaded and serial real
Web E2E.  This step changes no 3MF product behavior unless testing exposes a
real host defect, in which case the smallest tested fix is applied.

**Acceptance boundary:** `pnpm --filter @orca/web test:e2e:threaded` and
`pnpm --filter @orca/web test:e2e:serial` both pass against their intended
real artifacts.  The locator must be scoped by a stable user-facing or test
identifier rather than positional coincidence.

### Step 9 — Release-gate closure and documentation

**Functional boundary:** Rerun the complete release matrix only after Steps
7 and 8 have passed, then update the approved spec and roadmaps to delivered
only with the exact passing evidence.

**Acceptance boundary:** All retained commands in the Step 6 release-gate
record pass; fixture provenance remains verified; `pnpm test`, `pnpm
typecheck`, dual-variant smoke, desktop E2E, and both Web E2E commands pass.
If a command cannot pass, its documented gate remains pending and the
milestone is not marked delivered.

## Completion criteria

The milestone is complete only when each step's primary-agent acceptance has
passed, the shared app remains host-independent, both real WASM variants share
the new contract, and the compatibility verification matrix in the approved
spec has evidence or an explicitly retained CI gate.
