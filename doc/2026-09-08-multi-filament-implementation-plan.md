# Multi-Filament Support Implementation Plan

**Date:** 2026-09-08
**Status:** Complete and accepted; Steps 0–10 passed; documentation closeout
recorded at `07f276d`
**Scope:** The multi-filament behaviour accepted by [`spec/Multi-Filament Support.md`](../spec/Multi-Filament%20Support.md), for the shared Electron/Web application.
**Execution rule:** Every step below is implemented by a new, fresh Luna High subagent. The subagent must implement the complete step and perform its self-verification. The root agent independently verifies the step and records evidence before dispatching the next subagent. Steps are strictly serial; a failed or incomplete gate stops the sequence.

## 0. Non-negotiable execution boundaries

- The eight normative sequences in §12 of the approved specification are preserved and mapped to Steps 1–8 below. Steps 0, 9, and 10 are preparation, integration hardening, and the separate Level 4 release gate; they do not change product behaviour.
- The first implementation change is the typed contract and deterministic fixtures. No application consumer may be implemented before the contract/fixture gate passes.
- `packages/slicer-wasm/cpp/` is a pinned, read-only submodule. At plan creation the only pre-existing dirty state is its working-tree dirtiness at the pinned commit `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`. No step may edit, reset, checkout, stage, commit, or move this submodule. Any future proof that an upstream change is unavoidable is a separately approved patch/submodule task and is outside this plan.
- The bridge remains `extern "C"`, JSON-in/JSON-out, synchronous on the Worker thread. JS module access remains confined to `packages/slicer-wasm/src/client/`; application code uses `packages/slicer-runtime/` and never imports Emscripten globals or module URLs.
- Every atomic mutation is staged and validated in the Worker before commit. A rejected/cancelled/failed command must leave the live project, history cursor, remembered rack, and result validity unchanged.
- Every implementation step is one independently testable unit and one separate commit. The commit may contain only the files in that step's allowlist plus its tests/fixtures and the living plan's accepted status updates if required; it must not absorb pre-existing changes.
- The root agent must check `git status --short`, `git diff --name-only`, and the submodule dirtiness before and after every gate. A changed path outside the step allowlist, or any change to the submodule state, fails the gate.
- Use `pnpm` for workspace tests, typechecks, and E2E. On Windows use `scripts\build-windows.bat`; do not substitute npm/yarn or Git Bash.

## 1. Baseline and dispatch protocol

The root agent starts from a dedicated development branch and preserves the baseline. Before each step it starts a new Luna High subagent with the step text, the current accepted spec, the step allowlist, and the requirement to self-verify. The subagent must not start another implementation step.

For each numbered step 0–10, the root agent dispatches exactly one fresh Luna High subagent. That subagent performs the complete step, runs all required self-verification, and reports: files changed, implementation summary, exact commands run, pass/fail output, intentionally unavailable checks, and the proposed commit or audit record. The root agent then independently runs the root acceptance commands, checks the diff and submodule boundary, and only then allows the next fresh subagent. A self-verification result is not root acceptance evidence. Root retains ownership of final acceptance, commits/status updates, and any roadmap/spec promotion.

The repository structure used by this plan is the one described in [`project_structure_and_guidelines.md`](../project_structure_and_guidelines.md). Existing graph exploration identifies these boundaries: the WASM bridge in `packages/slicer-wasm/src/bridge.cpp`; typed client and mock module in `packages/slicer-wasm/src/client/`; Worker/runtime orchestration in `packages/slicer-runtime/src/`; shared stores, object list, history, and viewport/preview in `packages/slicer-app/src/`; and host E2E under `apps/desktop/e2e/` and `apps/web/e2e/`.

## 2. Step-by-step implementation and gates

### Step 0 — Baseline, fixture inventory, and task harness

**Dispatch:** Root starts a fresh Luna High subagent for Step 0. It performs the inventory and fixture work and its complete self-verification; root independently accepts or blocks the step.

**Self-verification record (2026-09-08):** Added the 13-entry deterministic
fixture inventory/schema and a dependency-free low-level 3MF reader fixture
builder. The executable fixture is independently assembled (not exporter- or
bridge-generated), carries native BBS project/model/filament records and a
closed cube, and has SHA-256
`d15f956c50e70d1368033528e49e835330e74cd007196f66a094277a09a91785`;
future writer/round-trip and behavioural cases are matrix-only until their
owning steps add executable assertions. The fixture self-test, optional serial
native-reader smoke (`objects=1`), `@orca/slicer-wasm` test suite (112 tests),
and typecheck pass. Root independently reviewed the native archive entries and
fixture provenance, reran all four checks with the same results, and accepted
Step 0. Slot-count and assignment observation remain correctly gated on Step
1's new read-only projection contract.

**Normative mapping:** preparation only; establishes the evidence needed before Sequence 1.

**Functional boundary:** Record the clean implementation baseline, enumerate current bridge/client/runtime/app/history/project/preview seams, and define deterministic fixture names and schemas. This step does not add a user-visible feature or alter product code.

**Dependencies:** The approved architecture and multi-filament specs; the repository's current branch; the existing dirty-submodule state stated above.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp`, `packages/slicer-wasm/src/client/{types.ts,client.ts,testing/mock-module.ts}`, `packages/slicer-runtime/src/{slicer/slicerClient.ts,projectSession.ts}`, `packages/slicer-app/src/{stores,useProjectStore.ts,history,components/workspace,components/workspace/viewport}`, existing `packages/slicer-wasm/harness/` and `fixtures/`.

**Implementation tasks:**

1. Create or extend deterministic fixture manifests for one-slot baseline, two-material single-nozzle, fixed multi-nozzle, assignments/routing, 64-slot boundary, imported painting/tool changes, imported flushing matrix, embedded presets/fallbacks, mixed-temperature validation, injected failure, and multi-plate invalidation.
2. Define fixture provenance: at least one independently assembled 3MF reader fixture and one bridge-generated writer/round-trip path; no fixture may be only “export then reopen through the same code path.”
3. Write the contract test matrix and stable IDs/fields that later steps must satisfy; do not implement the production contract yet.

**Explicit prohibitions:** No bridge/API change, no React/store change, no edit, stage, reset, checkout, or pointer change in `packages/slicer-wasm/cpp/`; read-only source inspection of that submodule is allowed; no external project download; no test that asserts only byte-identical G-code; no pending or expected-failing executable test may be committed.

**Subagent self-verification:**

- `git diff --check`
- fixture manifest/schema/builder validation using the repository's existing fixture/harness command, or a focused deterministic executable test added in this step;
- `pnpm --filter @orca/slicer-wasm test`;
- `pnpm --filter @orca/slicer-wasm typecheck`.

Pass means every executable manifest/schema/builder test passes, every fixture is deterministic, independently assembled reader coverage exists, and no product code or submodule changed. Future contract cases that need production APIs are recorded as data/matrix entries only; their executable assertions are added and must pass in their owning later step. Step 0 never commits an expected failure.

**Root independent acceptance:** Re-run the focused fixture test and typecheck; inspect every fixture's content and provenance; run `git diff --check`; verify `git diff --name-only` is inside the Step 0 allowlist; verify `git status --short` still reports only the original dirty submodule plus the intended plan/fixture files. Evidence is the command output, fixture manifest, and path allowlist review.

**Commit boundary:** One fixture/inventory commit only. Do not commit the dirty submodule. Failure blocks Step 1.

### Step 1 — Filament session projection contract

**Dispatch:** Root starts a fresh Luna High subagent for Step 1 only after Step 0 is accepted. It performs the contract/projection implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 1, “Filament session projection.”

**Functional boundary:** Add the typed, authoritative session snapshot for ordered slots, preset identity, effective/user colour, native maps, flushing state, capabilities, effective/inherited assignments, revisions, and failure/status metadata. This step is read-only projection plus contract plumbing; no mutation command and no UI consumer.

**Dependencies:** Step 0 fixtures and contract matrix pass.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp`; `packages/slicer-wasm/src/client/{types.ts,client.ts,index.ts,testing/mock-module.ts}`; `packages/slicer-runtime/src/slicer/slicerClient.ts`; focused client/runtime tests and the Step 0 fixture files.

**Implementation tasks:**

1. Define versioned JSON schemas and TypeScript types for slot identity, colour provenance, native mapping arrays, flushing matrix, capabilities, assignments, revisions, and atomic command result/error envelopes.
2. Add the bridge read operation and complete snapshot serialization with deterministic ordering and explicit one-based/zero-default semantics.
3. Normalize and reject malformed payloads at the client boundary; expose a typed runtime method without leaking module pointers or URLs.
4. Extend the mock Emscripten module and contract fixtures so tests exercise success, malformed snapshot, and unsupported-version paths.

**Explicit prohibitions:** No slot Add/Delete/Merge, preset or colour mutation, assignment mutation, UI or preference integration, native core edits, or TypeScript-side compatibility/fallback logic.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-wasm test`
- `pnpm --filter @orca/slicer-wasm typecheck`
- `pnpm --filter @orca/slicer-runtime test`
- `pnpm --filter @orca/slicer-runtime typecheck`
- `scripts\build-windows.bat quick --variant serial`
- `scripts\build-windows.bat smoke --variant serial`

Pass requires snapshot schema/normalization tests, mock-module coverage, and serial bridge quick/smoke green. A missing Emscripten environment is “not run,” never passed.

**Root independent acceptance:** Re-run both package suites/typechecks; inspect the bridge JSON and TS types against the fixture schema; run `scripts\build-windows.bat quick --variant serial` and `scripts\build-windows.bat smoke --variant serial`; use `git diff --check`, path allowlist, and submodule checks. Evidence must show no mutation endpoint was introduced and no app import crosses the client boundary. Failure blocks Step 2.

**Commit boundary:** One contract/projection commit. The dirty submodule remains uncommitted and untouched.

**Step 1 self-verification record (2026-09-08):** The read-only version-1
projection is implemented at the native bridge/client/runtime boundary. Native
capabilities now derive flexible-slot support from
`single_extruder_multi_material || is_bbl_vendor()`; fixed multi-extruder
devices expose their nozzle minimum and no Add/Delete/Merge capability. Each
mapping uses its native default (`filament_map`/`filament_map_2` = 1,
`filament_volume_map` = 0, `filament_nozzle_map` = 1,
`physical_extruder_map` = 0), fills only missing trailing entries, and rejects
overlong native arrays. Slot order is validated without sorting. Native
flushing matrices preserve all valid nozzle planes, require exactly one square
plane per native nozzle, identify default versus native data, and return
explicit versioned error/status metadata for malformed state. Native colour
provenance compares effective colour with the selected preset's effective
native colour (including the documented `#26A69A` fallback); equal effective
colour is preset-equivalent because a read-only projection cannot recover
explicit-edit history, while imported differing colours remain user overrides.
The client rejects unsupported versions, malformed/versionless failure
envelopes, reversed/duplicate/gapped
slots, inconsistent capabilities, out-of-range assignments, and invalid
inheritance. Versioned snapshot and reusable atomic command envelope schemas
are checked in under `packages/slicer-wasm/fixtures/multi-filament/`.

No TypeScript fallback or mutation endpoint was added. `@orca/slicer-wasm`
tests (122) and typecheck, `@orca/slicer-runtime` tests (32) and typecheck,
the independent fixture/schema self-test, serial quick build, serial bridge
smoke, and the updated independent-reader smoke all pass. The reader smoke
proves two ordered slots, per-key mapping/default projection, preserved flush
matrix plane data, and object/model-part effective assignment to slot 2.
Final remediation rerun on 2026-09-08: `pnpm --filter @orca/slicer-wasm test`
(122 passed), WASM typecheck, runtime tests (32 passed), runtime typecheck,
fixture self-test, serial quick build, serial smoke, reader smoke, and
`git diff --check` all exited 0; the serial reader additionally proves the
default Generic PLA colour is `preset` while imported red/green overrides are
`user`.

**Root acceptance record (2026-09-08):** Accepted after two remediation
rounds. Root independently reviewed native Orca capability and flush-matrix
semantics, the C ABI, TypeScript normalization, schemas, mocks, and runtime
boundary. Root reran `@orca/slicer-wasm` tests (122 passed) and typecheck,
`@orca/slicer-runtime` tests (32 passed) and typecheck, the 13-entry fixture
self-test with the unchanged deterministic SHA-256, serial quick build, serial
smoke, the independent serial reader smoke, and `git diff --check`; every
command exited 0. The checked-in paths match the Step 1 allowlist, no mutation
endpoint or application-side Emscripten access was introduced, and the pinned
submodule remains at `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with only the
same seven pre-existing user-owned dirty paths.

### Step 2 — Atomic slot commands

**Dispatch:** Root starts a fresh Luna High subagent for Step 2 only after Step 1 is accepted. It performs the atomic command implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 2, “Atomic slot commands.”

**Functional boundary:** Implement slot preset selection, effective colour edit, Add, Delete, and Merge with as explicit Worker commands. Each command stages and validates the complete native session and remaps all known references atomically, then returns the full snapshot and mutation result.

**Dependencies:** Step 1 passes; fixture set includes Add through 64, slot-65 rejection, first/middle/last Delete and Merge, colour retention, unsupported-reference rejection, and injected failure.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp`; native history/project helpers in `packages/slicer-wasm/src/{history,bridge_buffers.*}` as needed; `packages/slicer-wasm/src/client/{types.ts,client.ts,testing/mock-module.ts}`; `packages/slicer-wasm/harness/` multi-filament bridge tests and fixtures.

**Implementation tasks:**

1. Add explicit JSON command shapes and stable error codes/details for stale revisions, capability rejection, unsupported references, and native validation failure.
2. Stage the mutable filament session, model, plate state, custom G-code,
   painting/tool changes, support references, routing values, maps, arrays, and
   flushing state; validate all references and capacity before commit. Do not
   copy the complete `PresetBundle` on a history-producing mutation.
3. Implement native-compatible Add semantics (copy final preset, native next colour, extend maps/arrays, recalculate flushing); Delete fallback-to-slot-1 semantics; Merge destination remapping; and decrement references above the removed slot.
4. Preserve valid user colour across preset changes, mark the project dirty, invalidate all plate results, and return one complete revisioned snapshot.
5. Extend mock/client tests for atomic success and byte-for-byte pre-command state preservation on failure (without requiring G-code byte equality).

**Explicit prohibitions:** No React optimistic updates, no independent renumbering in TypeScript, no partial matrix edits, no direct C++ submodule edits, and no relaxing the native 64-slot limit.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-wasm test`
- `pnpm --filter @orca/slicer-wasm typecheck`
- `scripts\build-windows.bat quick --variant serial`
- `scripts\build-windows.bat smoke --variant serial`
- focused deterministic harness for Step 0/2 fixtures, including Add 1→64, reject 65, Delete/Merge first/middle/last, and injected rollback.

Pass requires all command-result and rollback assertions plus serial quick/smoke green.

**Step 2 self-verification record (2026-09-09, final):** Implemented and locally verified the five Worker/client commands with complete staged native-session validation, explicit reference allowlists, model/plate/overlay/custom-G-code/painting remapping, the native 16-colour Add sequence, per-nozzle native flushing calculation, user-colour retention, strict kind-specific versioned envelopes, all-plate invalidation, and atomic rollback. History stores and restores the complete filament state and plate session; first-command baseline plus mutation is published as one history operation. `pnpm --filter @orca/slicer-wasm test` passed (125/125); typecheck, fixture self-test, serial quick/smoke, existing history smoke, focused atomic-command smoke, harness syntax, and `git diff --check` all passed. The focused harness covers Add 1→64/reject 65, first/middle/last Delete and Merge, the complete native colour sequence, exact cutter/retraction minimum-flush semantics, multiplier-independent base matrices, fixed multi-nozzle planes, object/plate/custom-G-code/painting remapping, unrelated-setting retention, preset/colour retention, unsupported references, early/late/history-stage rollback invariance, and Undo/Redo for all five command families. No UI files or native submodule content changed; the pinned submodule remained at `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with its seven pre-existing dirty paths.

**Root independent acceptance:** Re-run the full WASM package test/typecheck and the complete Step 2 fixture harness; inspect a failing command before/after snapshot, history cursor, and result revision; run serial quick/smoke; verify no app/UI files changed. Failure blocks Step 3.

**Root acceptance record (2026-09-09):** Accepted. Root independently reviewed the native algorithm against Orca's `Plater.cpp` and required remediation for PresetBundle history lifetime, complete per-plate/reference remapping, native colour sequencing, per-nozzle cutter/retraction truncation, multiplier-independent base flushing matrices, exception-safe history publication, and strict client revision/dirty validation. Root then reran `pnpm --filter @orca/slicer-wasm test` (125/125), typecheck, the 13-entry fixture self-test, harness syntax, serial quick, serial smoke, existing history smoke, the complete atomic-command smoke, and `git diff --check`; all passed. Failure injection preserved the filament snapshot, plate snapshot and revisions, preset snapshot, project overlay, result availability, and history status/cursor. The changed-path allowlist contains only this living plan and `packages/slicer-wasm` bridge/client/history/harness files; no app/UI path changed. The pinned submodule HEAD and its seven pre-existing user-owned dirty paths were unchanged. Step 3 is unblocked.

**Commit boundary:** One bridge/client atomic-command commit.

### Step 3 — Assignment and feature-routing commands

**Dispatch:** Root starts a fresh Luna High subagent for Step 3 only after Step 2 is accepted. It performs the assignment/routing implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 3, “Assignment and routing commands.”

**Functional boundary:** Add atomic commands and projections for object/instance-as-object, `MODEL_PART`, and `PARAMETER_MODIFIER` assignment, plus support base/interface and six feature-path selectors. The Worker returns effective and inherited values; React does not recreate inheritance.

**Dependencies:** Step 2 passes; Step 0 assignment/routing fixtures exist.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp`; client `types.ts/client.ts/mock-module.ts`; existing model/object projection helpers; WASM harness fixtures/tests.

**Implementation tasks:**

1. Normalize eligible targets, deduplicate instances to owning objects, reject ineligible volumes, and return the accepted target set explicitly.
2. Implement object assignment clearing model-part overrides while preserving parameter-modifier assignments; implement part inherit by removing explicit `extruder`.
3. Expose support/raft base/interface `Default` (native zero) and all six advanced routing selectors with distinct default/inherit semantics.
4. Return effective slot, explicit/inherited marker, affected plates, and revision/invalidation metadata in one result; preserve atomic rollback on injected failure.

**Explicit prohibitions:** No assignment UI, no per-instance state, no React-side fallback/inheritance, no unsupported-target mutation, and no changes to native painting editors.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-wasm test`
- `pnpm --filter @orca/slicer-wasm typecheck`
- focused assignment/routing fixture harness;
- `scripts\build-windows.bat quick --variant serial`
- `scripts\build-windows.bat smoke --variant serial`.

Pass requires inherited-vs-explicit assertions, instance deduplication, ineligible rejection, all six routing selectors, and rollback green.

**Step 3 self-verification record (2026-09-09, remediation green):** The
Worker/client assignment and routing contract now normalizes instance targets
to owning objects before mutation, makes an owning object dominate descendant
model-part targets in either request order while preserving parameter modifiers,
rejects malformed IDs with stable command/ineligible errors, and reports the
accepted target set. The projection exposes only project/object support routes,
object/model-part feature routes, no parameter-modifier rows, and distinguishes
inherited object support from effective native-zero Default. Project support
routing invalidates and revises every plate; object/part routing reports only
member plates. The focused real serial harness
`multi-filament-assignment-routing-smoke.mjs` passed both target orders,
inherited-vs-explicit/default semantics, all six feature selectors, every
allowed/disallowed routing scope, three-plate invalidation and revisions,
ineligible rejection, modifier preservation, and injected-failure rollback of
the session, plate revisions, and history status.
`pnpm --filter slicer-wasm test` passed (125/125),
`pnpm --filter slicer-wasm typecheck` passed,
`scripts\build-windows.bat quick --variant serial` passed, and
`scripts\build-windows.bat smoke --variant serial` passed with exit code 0;
`git diff --check` passed. Client tests cover strict per-kind fields, accepted
target normalization, slot ranges, routing scope, and invalidation metadata.
No UI, runtime, painting-editor, or pinned C++ submodule files were changed.

**Root acceptance record (2026-09-09):** Accepted after independent review of
the normalized target ownership, routing-scope matrix, effective/default and
inherited projection, native transaction rollback, and per-plate versus
project-wide invalidation paths. Root reran `pnpm --filter @orca/slicer-wasm
test` (125/125), `pnpm --filter @orca/slicer-wasm typecheck`, harness syntax,
the focused real-serial assignment/routing harness, serial quick, serial smoke,
the existing history smoke, and `git diff --check`; all passed. The focused
harness proved both object/part request orders, instance-to-object
deduplication, model-part inherit, modifier preservation, all six feature
selectors, support Default/inheritance, allowed and rejected scopes,
three-plate global revision invalidation, member-plate invalidation, and
failure rollback. The changed-path allowlist contains only this living plan and
the Step 3 bridge/client/mock/test/harness files. The pinned submodule remains
at `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with exactly its seven
pre-existing user-owned dirty paths unchanged. Step 4 is unblocked.

**Root independent acceptance:** Re-run package checks and fixture harness; manually inspect JSON for explicit/inherited and Default distinctions; verify bridge/client-only boundary and serial quick/smoke. Failure blocks Step 4.

**Commit boundary:** One assignment/routing command commit.

### Step 4 — Shared Prepare UI and Prepare colouring

**Dispatch:** Root starts a fresh Luna High subagent for Step 4 only after Step 3 is accepted. It performs the shared Prepare implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 4, “Shared Prepare UI.”

**Functional boundary:** Build the host-neutral rack, object-list filament column/context action, impact confirmation, compatible-preset/colour selectors, capability-driven command state, and Prepare viewport colour projection in `packages/slicer-app`. Both hosts use the same commands and projections.

**Dependencies:** Steps 1–3 pass; client/runtime exposes stable projection and command APIs; existing Prepare/object-list/viewport tests are green.

**Primary files/interfaces:** `packages/slicer-app/src/components/workspace/{settings,ObjectList,objectList,viewport,Workspace}.tsx/ts`; `packages/slicer-app/src/stores/`; `packages/slicer-app/src/components/workspace/viewport/{ModelMesh,GLVolume,Scene,previewSceneProjection}.ts/tsx` only where Prepare projection belongs; `packages/slicer-app/src/index.css`; shared runtime contract imports.

**Implementation tasks:**

1. Add a store projection that mirrors Worker snapshots and command status without becoming a second source of truth.
2. Render the responsive Filament area, one/two-column behaviour, one-based number, effective colour, preset picker, pending/rejected state, and capability-driven Delete/Merge/Add controls.
3. Add impact summary/cancel confirmation; ensure cancellation produces no mutation, history entry, or preference write.
4. Add object/part filament column and shared Change Filament context command; show inherited parts distinctly and deduplicate instance selections.
5. Apply Prepare slot colours to printable volumes while retaining selection/disabled/transparent/out-of-bounds overlays; do not colour modifiers or wipe tower as ordinary volumes.

**Explicit prohibitions:** No host-specific imports, `window.orca`, Electron/Node APIs, optimistic partial slot arrays, UI-inferred device limits, Preview palette synthesis from Prepare colours, or advanced native Edit/painter UI.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-app test`
- `pnpm --filter @orca/slicer-app typecheck`
- focused component tests for rack, confirmation, object-list assignment, inherited marker, and Prepare colouring;
- `pnpm --filter @orca/desktop test` (host seam guard only if renderer imports changed).

Pass requires semantic assertions for command dispatch/result rendering and import-direction tests; CSS-only or pixel-change assertions are insufficient.

**Step 4 subagent self-verification record (2026-09-09, remediation):** Implemented the
host-neutral `useFilamentSessionStore` snapshot mirror, responsive container-
based rack, native compatible-preset/colour selectors, capability-driven
Add/Delete/Merge commands, impact confirmation with cancel-before-dispatch,
Object List effective/inherited assignment cells and context command, and
Prepare-only printable-volume colour projection. The store publishes only
complete Worker snapshots and never edits slot arrays optimistically. The
remediation also refreshes the complete projection after new/clear/import/open
model operations, preset transitions, and history restoration with a history
revision fence; object contexts now expose Change Filament, part contexts
expose Default/inherit, and object controls never expose Default. Added real
component/store interaction tests for rack dispatch/returned snapshot,
cancelled destructive confirmation, pending/rejected/capability state, object
and part context dispatch with instance de-duplication, inherited/default
legality, and material overlay precedence. Green checks:

- `pnpm --filter @orca/slicer-app test` — 68 files, 440 tests passed;
- `pnpm --filter @orca/slicer-app typecheck` — passed;
- focused `vitest` run for import-direction plus eight Step 4 interaction/helper
  test files — 8 files, 21 tests passed;
- `pnpm --filter @orca/slicer-wasm typecheck` — passed after public client type
  exports were completed;
- `pnpm --filter @orca/desktop test` — 10 files, 67 tests passed;
- `git diff --check` — passed.

Serial WASM quick/smoke is owned by the native command steps and was not
required for this shared-app-only step. The pinned `packages/slicer-wasm/cpp`
submodule remains untouched, including its seven pre-existing dirty paths.

The follow-up lifecycle remediation moved open-project filament refresh after
native history reset, added a regression proving the stored session revision
comes from the post-reset snapshot, and made thrown or rejected external
refreshes clear the prior-project mirror while exposing a rejected rack state.
Rack loading and history restoration now absorb refresh failures after the
native mutation has committed; atomic filament command rejection still keeps
the last valid snapshot. Focused store/rack/project tests cover these paths.

**Root acceptance record (2026-09-09):** Accepted after two remediation rounds.
Root independently rejected the initial result for a missing object context
command, missing part Default action, illegal object Default option, stale
project/history projections, and projection-only tests; a second review caught
the open-project refresh occurring before native history reset. The final diff
uses the complete Worker snapshot as the only filament truth, refreshes it after
the post-reset revision fence, clears stale cross-project state on read failure,
and proves the rack, object/part commands, instance de-duplication, inherited
display, cancellation, and Prepare material-overlay precedence through semantic
component/store tests. Root reran `pnpm --filter @orca/slicer-app test` (68
files, 440/440), slicer-app and slicer-wasm typechecks, `pnpm --filter
@orca/desktop test` (10 files, 67/67), an explicit eight-file focused run (35
tests), host-import scans, and `git diff --check`; all passed. Native quick/smoke
was intentionally not repeated because this step changes only shared React and
client type exports. The pinned submodule remains at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with exactly its seven pre-existing
user-owned dirty paths unchanged. Step 5 is unblocked.

**Root independent acceptance:** Re-run the full slicer-app suite/typecheck and selected desktop seam tests; inspect shared-app imports for host leakage; run focused Electron E2E if rendered interaction cannot be proved by component tests; verify unchanged dirty submodule and allowlist. Failure blocks Step 5.

**Commit boundary:** One shared Prepare UI commit; no Web/Electron-specific duplicate component.

### Step 5 — Flushing and prime tower

**Dispatch:** Root starts a fresh Luna High subagent for Step 5 only after Step 4 is accepted. It performs the flushing/prime-tower implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 5, “Flushing and prime tower.”

**Functional boundary:** Wire native flushing recalculation after every accepted flushing input, preserve imported matrices until the first such edit, expose the three basic prime-tower controls, and project native validation/corrections/errors through the existing status path.

**Dependencies:** Steps 1–4 pass; native slot/session commands and shared settings metadata are available.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp` and client types/client; `packages/slicer-runtime/src/`; `packages/slicer-app/src/components/workspace/settings/`, stores, slice lifecycle; deterministic imported-matrix and prime-tower fixtures.

**Implementation tasks:**

1. Mark preset/material/colour/slot/support-filament changes as flushing inputs and recalculate the complete native matrix atomically.
2. Preserve an imported matrix exactly on load until the first flushing-input edit; persist the effective matrix.
3. Add `enable_prime_tower`, per-plate X/Y, and `prime_tower_width` controls through existing metadata/command flow; surface native correction/warning/error values.
4. Test support base/interface Default and explicit slot semantics, including Delete/Merge remapping to Default or selected survivor.

**Explicit prohibitions:** No matrix editor, no All/Colour/None preference, no React-derived flushing values, no forcing prime tower merely because slot count > 1, no separate validation parser or modal.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-wasm test` and typecheck;
- `pnpm --filter @orca/slicer-runtime test` and typecheck;
- `pnpm --filter @orca/slicer-app test` and typecheck;
- focused native fixture for imported-matrix preservation/replacement, support routing, prime tower, and native error projection;
- serial WASM quick/smoke.

**Step 5 self-verification record (2026-09-09):** Implemented the native
flushing-input recalc path and atomic full-matrix publication, imported-matrix
preservation until the first accepted edit, native prime-tower controls/status,
plate-local X/Y invalidation, and support Default/explicit Delete/Merge remap.
The focused real-WASM harness
`packages/slicer-wasm/harness/multi-filament-flushing-prime-tower-smoke.mjs`
passed its production export/reload matrix-preservation check, replacement
checks for preset/colour/Add/Delete/Merge/support-base/support-interface,
failure rollback, prime-tower status/invalidation, and three-slot project/
object Default/decrement/survivor remapping across all six feature routes.
`pnpm --filter @orca/slicer-wasm test` (126/126),
`pnpm --filter @orca/slicer-runtime test` (32/32), and
`pnpm --filter @orca/slicer-app test` (68 files, 443/443) passed; all three
package typechecks passed; `scripts\\build-windows.bat quick --variant serial`
and `scripts\\build-windows.bat smoke --variant serial` passed; and
`git diff --check` passed. No separate DOM/E2E run was needed because this
step's settings seam is covered by the new prime-tower SettingsPanel and
configuration-action semantic tests plus the real-WASM harness. The client
strictly normalizes native corrections and error envelopes, and the app keeps
the native effective serialized value rather than the requested raw value.
Non-empty native warnings remain visible with a `[Warning]` prefix after
successful invalidation, while empty warnings do not clear unrelated status.
The pinned C++ submodule was not edited and retains its pre-existing dirty
state.

**Root acceptance record (2026-09-09):** Accepted after two remediation rounds.
Root first rejected the result because the native `configuration_status` was
not normalized or consumed, corrected values were overwritten by raw input,
and the focused harness covered only one flushing-input class; a final narrow
remediation surfaced successful native warnings without failing the command.
The accepted bridge parses into native candidates before publication, persists
serialized effective values, returns strict correction/warning/error status,
keeps rejected config state and revisions unchanged, and applies project-wide
versus plate-local prime-tower invalidation. Root reran the WASM suite/typecheck
(126/126), runtime suite/typecheck (32/32), app suite/typecheck (68 files,
443/443), harness syntax, serial quick, the expanded real-WASM harness, serial
smoke, and `git diff --check`; all passed. The harness proved production
export/reload matrix preservation; full-matrix replacement for preset, colour,
Add, Delete, Merge, support-base and support-interface; injected rollback;
three-slot Default/decrement/survivor remapping; and prime-tower status and
invalidation boundaries. The pinned submodule remains at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with exactly its seven pre-existing
user-owned dirty paths unchanged. Step 6 is unblocked.

Pass requires matrix replacement timing, full-matrix atomicity, per-plate prime-tower invalidation, and Default semantics.

**Root independent acceptance:** Re-run all three affected package gates and the native fixture; inspect imported matrix before/after the first flushing edit; run serial quick/smoke; perform a focused host E2E only if settings metadata/DOM integration is not covered by component tests. Failure blocks Step 6.

**Commit boundary:** One flushing/prime-tower commit.

### Step 6 — History and project persistence

**Dispatch:** Root starts a fresh Luna High subagent for Step 6 only after Step 5 is accepted. It performs the history/persistence implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 6, “History and persistence.”

**Functional boundary:** Extend native history, project save/open, two-phase restore, dirty checkpoints, per-printer remembered rack, embedded presets, compatible fallback reporting, and lossless unsupported-state round-trip to include the complete filament session.

**Dependencies:** Steps 1–5 pass; existing `ProjectHistory`, `orc_load_project`, `orc_export_project`, `restoreCoordinator`, and preference contracts remain available.

**Primary files/interfaces:** `packages/slicer-wasm/src/{bridge.cpp,history/ProjectHistory.*}`; `packages/slicer-wasm/src/client/{history.ts,types.ts,client.ts}`; `packages/slicer-runtime/src/projectSession.ts`; `packages/slicer-app/src/{history,preferences.ts,stores,useProjectStore.ts,components/project}`; independent 3MF fixtures and harnesses.

**Implementation tasks:**

1. Extend the native history frame to restore the mutable filament session,
   ordered slots, colours/metadata, maps, matrices, model/plate assignments,
   painting, custom G-code, support, routing, and revisions atomically. The
   immutable profile catalogue remains in the live `PresetBundle`; history
   restores its validated mutable state without copying the complete bundle.
2. Implement two-phase project restore: stage native project and embedded presets, run compatibility evaluation, report every changed slot, then commit or leave prior project/history/rack unchanged.
3. Persist all effective slot state and matrix/map data required for native Neo round-trip while excluding derived G-code/preview buffers.
4. Implement printer-namespaced remembered rack priority and publication after successful explicit edits and successful Undo/Redo/history jumps only; preference failures are non-fatal.
5. Add Undo/Redo coverage for every exposed mutation and imported painting/tool-change/matrix preservation/remap.

**Explicit prohibitions:** No global installation of embedded presets, no preference snapshot inside history, no lossless-state normalization on open/save, no partial restore, no second persistence source for slot 1.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-wasm test`; typecheck; native history/3MF fixture harness;
- `pnpm --filter @orca/slicer-runtime test`; typecheck;
- `pnpm --filter @orca/slicer-app test`; typecheck;
- focused project round-trip, compatibility, history smoke, and remembered-rack tests;
- serial WASM quick/smoke.

Pass requires independent reader fixture, bridge writer/round-trip fixture, complete mutation Undo/Redo, rejected restore invariance, embedded preset lifetime, and remembered-rack priority evidence.

**Step 6 remediation self-verification record (2026-09-09, final):** Added a
bound two-phase native project restore. Preflight retains a revision/cursor
fence plus model, overlay, and complete filament-state provenance; intervening
native edits reject the token before publication. The commit path stages all
inputs, including the imported plate session and overlay/Neo plate settings,
and uses a move-based rollback covering model, PresetBundle, plate session,
history cursor/revision, overlays, membership maps, derived preview/result
validity, and session revisions; an injected post-publication failure proves
the active project remains unchanged. Final sidecar validation now requires
every present slot vector and every flush-matrix plane to have complete,
finite, slot-consistent dimensions (including empty-vector rejection). Sidecar
state is validated losslessly before native compatibility selection, so native
fallback remains authoritative and requested-vs-effective slot changes carry a
truthful provenance reason. Non-sidecar BBS/Orca provenance is read from the
raw project-settings entry before native config normalization. Malformed
sidecar vectors/matrices and out-of-range staged plate references reject
atomically.
Clean compatible projects auto-commit; only embedded-preset warnings or slot
changes open confirmation. Confirmation throws, aborts, cancellation, commit
failure, and UI cleanup consume the pending token. Remembered-rack seeding
remains one native all-or-nothing command, and history restore preference
publication remains best effort without turning a successful restore into a
failure. Geometry-only imports and project-session embedded-preset lifetime are
unchanged.

Passed checks: `pnpm --filter @orca/platform-contract test` (14 tests) and
typecheck; `pnpm --filter @orca/slicer-wasm test` (126 tests) and typecheck;
`pnpm --filter @orca/slicer-runtime test` (32 tests) and typecheck;
`pnpm --filter @orca/slicer-app test` (68 files, 450 tests) and typecheck;
focused client history tests (12 tests); serial quick and serial smoke;
`git diff --check`; `history-smoke.mjs`; `project-roundtrip.mjs`; independent
`multi-filament-reader-smoke.mjs`; assignment/routing and flushing/prime-tower
smokes; `multi-filament-command-smoke.mjs`; and
`project-preflight-smoke.mjs`. The preflight harness covers malformed and
unavailable sidecar rejection/invariance, malformed matrix/vector rejection,
staged plate-reference rejection, cancel and stale-token invariance,
raw-project compatibility delta with exact before/after/reason and accepted
effective state (`AliZ PA-CF @P1-X1` → `AliZ PA-CF @System`), post-publication
commit rollback including derived result and all session revisions, accepted
commit, incompatible/valid/injected rack restore, and history preservation. The app
tests cover clean auto-commit, warning accept/cancel invariance, confirmation
throw cleanup, commit-failure cleanup, and no React mutation before acceptance.
Electron/Web E2E and the full release matrix were not run at this step. The
pinned `packages/slicer-wasm/cpp` submodule remained at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with its seven pre-existing dirty
paths; no commit was created.

**Root acceptance record (2026-09-09):** Accepted after three remediation
rounds. Root rejected the initial implementation for a non-atomic remembered
rack seed, an unapplied Neo sidecar, and project warnings produced only after
live-state replacement; the second review rejected an unbound preflight,
post-publication partial-failure exposure, compatibility ordering, and disabled
slot-array validation; the final narrow review required staged plate validation
and exact raw-project fallback evidence. Root independently reran all four
affected package suites and typechecks (platform contract 14/14, WASM 126/126,
runtime 32/32, app 68 files and 450/450), focused history tests (12/12), harness
syntax, the native project-preflight/rack harness, history smoke, bridge writer
round-trip, independent multi-filament reader, serial quick, serial smoke, and
`git diff --check`; all passed. The native preflight evidence proves malformed
vector/matrix and plate-reference rejection, cancel/stale-token invariance,
exact `AliZ PA-CF @P1-X1` to `AliZ PA-CF @System` fallback reporting, accepted
effective state, complete rollback after injected post-publication failure,
derived-result preservation, and atomic remembered-rack restore. The changed
paths are limited to the Step 6 history/persistence bridge, typed client/worker,
shared application confirmation and preference integration, contracts, tests,
harnesses, and this living plan. The pinned submodule remains at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with exactly its seven pre-existing
user-owned dirty paths unchanged. Step 7 is unblocked.

**Step 6 corrective acceptance (2026-09-09):** Step 8's complete fixture audit
exposed that a valid exported empty-scene project carrying a 64-slot Neo
filament sidecar could not be reopened. The native reader had succeeded, but
the bridge incorrectly treated every empty imported model as a load failure.
The correction permits an empty model only for project replacement, where the
PresetBundle, plate session, and validated sidecar remain meaningful;
geometry-only import still rejects an archive with no geometry. The fresh Step
6 remediation agent and root independently proved serial and threaded writer
and reader round-trip of all 64 ordered slots and the complete 64x64 flushing
matrix, while retaining the geometry-only rejection. Root reran WASM 128/128,
runtime 33/33, app 455/455 and their typechecks; history, project-preflight,
writer round-trip, and independent-reader native harnesses; both-variant quick
and smoke; and `git diff --check`. All passed. Atomic project rollback and
strict vector/matrix validation remain covered. The pinned submodule HEAD and
its seven pre-existing dirty paths were unchanged. Step 6 is re-accepted and
Step 8 may be re-dispatched.

**Root independent acceptance:** Re-run all affected package checks and both independent 3MF reader/writer fixture paths; run `pnpm --filter @orca/slicer-wasm exec vitest run src/client/history.test.ts src/client/history.protocol.test.ts` plus relevant harnesses; inspect history cursor/rack/project state across failure and undo; run serial quick/smoke. Failure blocks Step 7.

**Commit boundary:** One history/persistence commit.

### Step 7 — Slice lifecycle and Preview integration

**Dispatch:** Root starts a fresh Luna High subagent for Step 7 only after Step 6 is accepted. It performs the slice/Preview implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 7, “Slice and Preview integration.”

**Functional boundary:** Bind multi-filament mutations to configuration-scope invalidation, make plate/result revisions safe, preserve unaffected plate results, and project actual generated tool/extruder attribution and the completed result palette into Preview.

**Dependencies:** Steps 1–6 pass; persistence and history can restore a complete session.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp` slice/result APIs; `packages/slicer-wasm/src/client/client.ts`; `packages/slicer-runtime/src/slicer/`; `packages/slicer-app/src/{components/workspace/sliceCoordinator.ts,stores/plateResultLifecycle.ts,components/workspace/viewport/{previewSceneProjection.ts,previewSemantics.ts,toolpathColors.ts,PreviewInspectionPanel.tsx}}`; G-code/Preview fixtures.

**Implementation tasks:**

1. Implement global invalidation for slot/preset/colour/Add/Delete/Merge, process support/routing/prime-tower changes, and affected-plate-only invalidation for object/volume changes and prime-tower X/Y.
2. Cancel in-flight slices only for affected plates; reject stale result revisions and retain unaffected results.
3. Ensure native `Print::validate()` blocks used mixed-temperature incompatibilities while unused rack slots do not block slicing; surface the existing slice error status unchanged.
4. Parse generated G-code/result semantics for tool-change order, used slots, temperature, flushing, prime tower, and palette. Preview must use actual generated tool/extruder IDs and result palette, never fabricated Prepare colour.
5. Add one-slot regression and multi-filament slice/Preview tests without byte-for-byte G-code comparisons.

**Explicit prohibitions:** No eager auto-slicing, no Preview layer/tool-change editor, no synthetic palette fallback, no stale result rendering, no invalidation of unrelated plates, and no new cancellation protocol.

**Subagent self-verification:**

- `pnpm --filter @orca/slicer-wasm test` and typecheck;
- `pnpm --filter @orca/slicer-runtime test` and typecheck;
- `pnpm --filter @orca/slicer-app test` and typecheck;
- deterministic native slice/G-code/Preview fixture harness;
- `scripts\build-windows.bat quick --variant serial` and `scripts\build-windows.bat smoke --variant serial`;
- focused Electron E2E for slice/preview only if component/runtime tests cannot prove the host seam.

Pass requires one-slot regression, two-material assignment/tool-change/flush/prime-tower semantics, mixed-temperature used-vs-unused checks, plate revision rejection, and Preview palette evidence.

**Root independent acceptance:** Re-run all affected package suites/typechecks, native fixture parser, serial quick/smoke, and the focused primary-host E2E; inspect a stale-result rejection and unaffected plate retention. Failure blocks Step 8.

**Commit boundary:** One slice/Preview integration commit.

**Step 7 self-verification record (2026-09-09, remediation):** The shared app
now consumes the Worker-provided affected-plate set for filament mutations.
Shared rack changes clear every cached result, object/part/plate-scoped
configuration changes retain unrelated plate results, and an affected
in-flight slice is cancelled without cancelling an unaffected plate. An
explicit empty native affected set is now a no-op rather than the global
fallback. Slice result publication re-reads the native plate revision
immediately before caching preview/G-code, so a late result cannot revive
stale output; when that late job was already invalidated, the unaffected
active preview remains `done` at 100% with no stale publish. The real
serial-WASM fixture `packages/slicer-wasm/harness/multi-filament-slice-preview-
smoke.mjs` covers a one-slot regression plus a two-slot assigned-object slice,
actual generated tool/extruder IDs and palette, tool-change order, temperature
commands, and flushing/prime-tower G-code semantics. It also proves with the
native bridge and `Print::validate()` that a disjoint-temperature unused rack
slot does not block slicing, while assigning that slot returns the existing
mixed-temperature error unchanged. No byte-for-byte G-code comparison is
used.

Passed checks: `pnpm --filter @orca/slicer-app test -- --run` (69 files,
455 tests) and typecheck; `pnpm --filter @orca/slicer-runtime test -- --run`
(5 files, 32 tests) and typecheck; `pnpm --filter @orca/slicer-wasm test
-- --run` (126 tests) and typecheck; `node --check
packages/slicer-wasm/harness/multi-filament-slice-preview-smoke.mjs`; the
real serial-WASM slice/Preview harness; `node
packages/slicer-wasm/harness/plate-local-slice-smoke.mjs
packages/slicer-wasm/out/serial/orca_slice.js`; `scripts\\build-windows.bat
quick --variant serial`; `scripts\\build-windows.bat smoke --variant serial`;
and `git diff --check`. Primary-host Electron/Web E2E infrastructure is
available (`apps/desktop` has `test:e2e`/`test:e2e:real`, and `apps/web` has
threaded/serial E2E scripts), but no dedicated multi-filament slice/Preview
scenario exists and these host E2E commands were intentionally not run: the
changed lifecycle is host-neutral, no host adapter changed, and the shared
app/runtime tests plus real Worker/WASM harness prove the affected seam.
The prior supplementary command/flush harness attempt was intentionally
skipped after exceeding the local memory/time budget; it is not counted as a
pass. The pinned `packages/slicer-wasm/cpp` submodule remains at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with exactly its seven pre-existing
dirty paths unchanged; no commit was created by the Step 7 agent.

**Root acceptance record (2026-09-09):** Accepted after one remediation round.
Root independently verified the undefined-versus-empty affected-plate contract,
late native-revision rejection, cancellation of only the affected in-flight
slice, and retention of an unaffected cached preview. Root reran the slicer-app
suite and typecheck (69 files, 455 tests), slicer-runtime suite and typecheck (5
files, 32 tests), and slicer-wasm suite and typecheck (126 tests); all passed.
The new real serial-WASM harness passed its one-slot regression, two-material
tool/order/palette/temperature/flushing/prime-tower assertions, and the native
mixed-temperature used-versus-unused validation. The existing plate-local
native smoke passed, including stale-slice rejection. The focused primary-host
Electron E2E `full v1 flow: add models -> slice -> preview -> export gcode`
passed (1/1), including its renderer CSS smoke. Root then reran serial quick,
serial smoke, and `git diff --check`; all passed. The accepted paths contain
only the living plan, shared app lifecycle/configuration/tests, and the
multi-filament fixture README/harness. The pinned submodule HEAD and its seven
pre-existing user-owned dirty paths remain unchanged. Step 8 is unblocked.

### Step 8 — Acceptance closure preparation

**Dispatch:** Root starts a fresh Luna High subagent for Step 8 only after Step 7 is accepted. It performs only the allowlisted fixture/guard/checklist work and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 8, “Acceptance closure,” excluding the final Level 4 gate.

**Functional boundary:** Consolidate the complete deterministic multi-filament fixture suite, boundary guards, command documentation, and focused cross-layer checks after all seven implementation sequences. This step is verification and acceptance-evidence work only; it may not fix product defects or introduce product scope.

**Dependencies:** Steps 0–7 all passed and each commit is present separately.

**Precise change allowlist:** `packages/slicer-wasm/harness/**`, `packages/slicer-wasm/fixtures/**`, test-only files matching `packages/slicer-wasm/src/client/**/*.test.*`, `packages/slicer-runtime/src/**/*.test.ts`, `packages/slicer-app/src/**/*.test.*`, `apps/desktop/e2e/**`, and `apps/web/e2e/**`. No production implementation file, package manifest, build script, host adapter, bridge source, or submodule may be changed in Step 8. The command/result checklist may be emitted as the Step 8 agent's evidence, but it is not a product-code change.

**Implementation tasks:**

1. Run the full deterministic suite listed in spec §13.2, including the 64-slot boundary separately from representative slicing.
2. Add missing boundary tests for memory/ownership, malformed JSON/version, unsupported references, preference failure, host parity, and imported unsupported state.
3. Run Level 2-style affected package suites/typechecks and Level 3-style root/affected-host checks; ensure no ambiguous pixel-only E2E assertions are used.
4. Produce a machine-readable command/result checklist for the later release gate. Do not mark the roadmap delivered in this step.

**Explicit prohibitions:** No product defect fix, no new feature, no broad refactor, no changes to accepted spec semantics, no production-file edits, no submodule mutation, and no replacing real-WASM evidence with mocks. If any check exposes a product defect, the Step 8 gate fails; the defect is returned to its owning earlier step and fresh agent for remediation and repeat root acceptance. Step 8 resumes only after that earlier step passes again; it may not absorb the fix opportunistically.

**Subagent self-verification:**

- `pnpm test`
- `pnpm typecheck`
- full deterministic multi-filament fixture/harness suite, with every newly added executable assertion passing;
- `scripts\build-windows.bat quick --variant both`
- `scripts\build-windows.bat smoke --variant both`
- focused Electron and Web E2E for every affected seam.

Pass requires all required deterministic checks and all reported intentional skips to be explicit, with every changed path inside the precise allowlist. Any product defect or failing assertion returns to its owning step; it does not get hidden in the release gate or committed as an expected failure.

**Root independent acceptance:** Re-run the complete Step 8 checklist, inspect the command/result checklist, run graph change/affected-flow review for the accumulated implementation, verify each prior commit boundary and the unchanged dirty submodule, and confirm no roadmap/spec status was changed prematurely. Failure blocks Step 9.

**Commit boundary:** One acceptance-fixture/boundary-guard/checklist commit containing only the precise allowlist. Product corrective commits are not Step 8 commits: they return to the owning earlier step, use a fresh Luna High subagent, and require that step's full self-verification and root acceptance before Step 8 is re-dispatched.

**Step 8 root acceptance record (2026-09-09):** Accepted at commit
`d5ea4c0` (`test(filament): close multi-filament acceptance coverage`). Root
verified that the commit contains only the Step 8 allowlist: fixture inventory
and acceptance checklist assets, real-WASM command/imported-state harnesses,
and client/runtime boundary tests; no production implementation, manifest,
build script, host adapter, roadmap, approved spec, or submodule change was
introduced. The checklist schema pins native core
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`, enumerates serial/threaded fixture
coverage, and reports no failed entries. Root independently accepted the
fixture/boundary evidence and left Step 9 unblocked. The Step 9 audit below
re-runs the current root suites, both host flows, both variant build/smoke
paths, and the required handoff checks against this exact HEAD.

### Step 9 — Level 3 handoff audit

**Dispatch:** Root starts a fresh Luna High subagent for Step 9 only after Step 8 is accepted. The subagent performs the complete Level 3 audit and self-verification record; root independently accepts or blocks the audit. This is not a root-only step.

**Functional boundary:** A reproducible Level 3 handoff audit of the completed implementation, performed by the fresh Luna High subagent and independently verified by root. It adds no product implementation and confirms that evidence is ready for the separate Level 4 release gate.

**Dependencies:** Step 8 accepted.

**Primary files/interfaces:** All accumulated changed files; `doc/testing_guidelines.md`; graph review tools; Git history/status.

**Implementation tasks:**

1. Run `pnpm test` and `pnpm typecheck`, affected-host E2E, primary shared-app E2E, both WASM quick builds, one comprehensive bridge smoke, and the other variant's focused fallback/import/slice/export smoke as required by the testing guide.
2. Run `git diff --check`, inspect local links/commands in the living plan, and verify every command claimed as passed has current output.
3. Use graph change detection, affected-flow analysis, and tests-for review on bridge/client/runtime/app/history/preview changes; record any missing coverage as a release-gate blocker.

**Explicit prohibitions:** No implementation scope expansion, no silently skipping a failed check, no submodule cleanup, and no roadmap milestone update.

**Subagent self-verification:** The Luna High subagent must return the complete Level 3 command matrix with exact host/variant, exit status, captured pass/fail output, graph-review findings, local-link/command review, changed-path review, and every unavailable or intentionally skipped check. It must report failure rather than convert a missing environment or artifact into a pass. A failed audit is not accepted and does not dispatch Step 10.

**Root independent acceptance:** Root independently re-runs the applicable Level 3 commands, verifies the subagent's outputs against current files and Git state, checks graph evidence, `git diff --check`, local links/commands, commit boundaries, and unchanged dirty submodule. Root accepts Step 9 only when all applicable gates pass and every unavailable check is explicitly reported. Failure blocks Step 10 and requires remediation by a fresh subagent at the owning earlier step, followed by repeat acceptance and a new Step 9 dispatch.

**Commit boundary:** No product commit is required; if an audit fix is needed, return it to the relevant prior step and use a fresh Luna High subagent.

**Step 9 Luna High self-verification audit record (2026-09-09):** The fresh
handoff audit ran on branch `dev/multi-filament-spec` at HEAD `d5ea4c0` and
passed every applicable Level 3 gate. Exact results:

- `pnpm test` — exit 0; all eight workspace test projects passed, including
  slicer-wasm 4 files/128 tests, slicer-runtime 5 files/33 tests,
  slicer-app 69 files/455 tests, desktop 10 files/67 tests, and Web 6
  files/27 tests.
- `pnpm typecheck` — exit 0 for all eight workspace projects.
- Primary shared-app Electron flow
  `pnpm --filter @orca/desktop test:e2e -- --grep "full v1 flow: add models.*slice.*preview.*export gcode"`
  — exit 0, renderer CSS smoke passed, 1/1 test passed.
- Affected Web host seams —
  `pnpm --filter @orca/web test:e2e:serial` exit 0 (5/5, serial fallback,
  import/slice/preview/download) and
  `pnpm --filter @orca/web test:e2e:threaded` exit 0 (5/5, threaded
  import/slice/preview/download).
- `scripts\build-windows.bat quick --variant both` — exit 0; threaded and
  serial artifacts were incrementally verified and staged.
- `scripts\build-windows.bat smoke --variant both` — exit 0; both variants
  completed the configured run-slice, bridge, and DRC smoke paths.
- Comprehensive bridge smoke on threaded WASM:
  `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`
  — exit 0; `orc_init`, profile/preset, model, slice/progress, result,
  export, cancel, and threaded shared-memory/TBB checks all reported PASS.
- Focused serial fallback/import/slice/export evidence —
  `node packages/slicer-wasm/harness/multi-filament-slice-preview-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js`
  and `node packages/slicer-wasm/harness/drc-smoke.mjs
  packages/slicer-wasm/out/serial/orca_slice.js
  packages/slicer-wasm/fixtures/drc` — combined exit 0; the former proved
  one-slot and two-tool Preview palette/tool-order/temperature/flushing or
  prime-tower and used-vs-unused-temperature semantics, and the latter proved
  real DRC import, slice, and non-empty G-code export.
- `node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs`
  — exit 0; the machine-readable checklist parsed all entries with no failed
  plan rows. This is a checklist/schema audit, not a claim that the complete
  Level 4 matrix was run here.
- `git diff --check` — exit 0. Four living-plan local links resolve:
  `spec/Multi-Filament Support.md`, `project_structure_and_guidelines.md`,
  `doc/testing_guidelines.md`, and
  `spec/Web-Electron Shared Application Architecture.md`. The plan's command
  forms were cross-checked against the package scripts, the build driver's
  `--variant` contract, and the acceptance checklist; every command claimed
  as passed in this audit has current output above.

Graph review was run against the current graph at `d5ea4c0` (3,580 nodes and
46,197 edges). Change detection against the implementation baseline reported
76 changed files, 233 structural test-gap candidates, and no automatically
connected affected flows; focused review of bridge/client/runtime/app/history/
preview reported high risk for 8 selected files (500 impacted nodes and 342
raw gap candidates). Function-level `tests_for` queries found 61 client tests
for `createClient`, 8 runtime bootstrap tests, 10 `sliceModel` tests including
native-revision stale-result rejection, and the plate-result retention test.
The graph has no direct test edge for the C++ `orc_init` node, private client
normalizers, or the store's private snapshot/mutation helpers, and its flow
detector does not connect native MJS harnesses to C++ nodes. These are recorded
as graph mapping gaps, not release blockers: the required behavior is covered
by the real threaded bridge smoke, serial multi-filament/DRC harnesses, the
full client/runtime/app suites, and both real Web host flows. No required
multi-filament acceptance item remains without executable evidence.

Changed-path and commit audit passed. The implementation commits remain
separate and ordered from `fcd7963` through `d5ea4c0`; Step 9 changed no
product file and created no product commit. Apart from this living-plan
documentation record, the only pre-existing working-tree change is the dirty
`packages/slicer-wasm/cpp` submodule: its pointer and HEAD
remain `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`, with exactly these seven
unchanged files: `src/libslic3r/EdgeGrid.cpp`,
`src/libslic3r/ExPolygonCollection.cpp`,
`src/libslic3r/Format/bbs_3mf.cpp`, `src/libslic3r/LocalesUtils.cpp`,
`src/libslic3r/Model.hpp`, `src/libslic3r/Platform.cpp`, and
`src/libslic3r/utils.cpp`. No roadmap, approved spec semantics, or release
status was updated.

At that earlier audit point, the complete Level 4 matrix (full Electron,
packaged/runtime probes, non-root Web deployment, and licensed/profile probes)
was intentionally reserved for Step 10. No applicable Level 3 check was
unavailable or silently converted to a pass. The subsequent Step 10 acceptance
record below supersedes that pending status.

**Step 9 root acceptance record (2026-09-09):** Accepted. Root independently
reran the full workspace test and typecheck gates; the focused Electron flow
(1/1); real Web threaded (5/5) and serial (5/5); both-variant quick and smoke;
the threaded comprehensive bridge smoke; and serial multi-filament Preview and
DRC import/slice/export harnesses. Root also reran the final 30-row acceptance
runner earlier in this acceptance chain with all 21 selected real-WASM commands
passing and `failed=[]`. Graph change/affected-flow review of the accumulated
implementation reported medium risk and no connected affected flow; focused
`tests_for` review found 61 client boundary tests and 10 `sliceModel` tests,
while the native C++ mapping gap is directly covered by the real bridge and
project harnesses. All four living-plan local links resolve, `git diff --check`
passes, commits remain separately ordered, and no roadmap or approved spec was
changed. The pinned submodule remains at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde` with exactly its seven pre-existing
dirty paths. Step 10 was unblocked at that point; the later Step 10 acceptance
record below is the final release-gate decision.

**Step 9 Luna High re-audit self-verification record (2026-09-09):** A fresh
Level 3 re-audit was run after corrective commits `343f5ac` (`fix(app): restore
Prepare selection with filament controls`) and `1905a59` (`fix(wasm): preserve
receiver for project preflight`) at HEAD `1905a59`. The current results are:

- `pnpm test` — exit 0; all eight workspace projects passed: slicer-wasm 4
  files/129 tests, slicer-runtime 5/33, slicer-app 69/455, desktop 10/67,
  Web 6/27, with printer-control 12, profile-resources 3, and
  platform-contract 14 tests also passing.
- `pnpm typecheck` — exit 0 for all eight workspace projects.
- `scripts\\build-windows.bat quick --variant both` — exit 0; both staged
  wasm64 artifacts validated. `scripts\\build-windows.bat smoke --variant
  both` — exit 0; both configured slice/bridge/DRC smoke paths passed.
- Primary Electron flow
  `pnpm --filter @orca/desktop test:e2e -- --grep "full v1 flow: add models.*slice.*preview.*export gcode"`
  — exit 0, 1/1 passed, renderer CSS smoke passed. The five previously
  failing affected Electron paths (object/part selection guard; clone,
  assemble, delete; Add Primitive; model-body context menu; project Save As)
  were rerun together and passed 5/5.
- `pnpm --filter @orca/web test:e2e:threaded` and
  `pnpm --filter @orca/web test:e2e:serial` — exit 0, 5/5 each; real threaded
  and serial fallback import/slice/preview/download flows passed.
- Comprehensive real-WASM `node
  packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs
  --run-real` — exit 0 for `serial` and `threaded`, with `failed: []`.
  This covered the command/rollback, assignments/routing, independent reader,
  imported painting/tool changes, flushing/prime tower, plate-local result,
  history, project preflight/rack, project round-trip, and preset restoration
  rows on both artifacts.
- Additional current-HEAD probes passed: `project-preflight-smoke.mjs` on
  serial and threaded (atomic sidecar/rack/preflight rollback),
  `bridge-smoke.mjs` on threaded, and
  `multi-filament-slice-preview-smoke.mjs` plus `drc-smoke.mjs` on serial. The
  acceptance checklist plan parser also exited 0 with no failed rows.

Graph review at this HEAD reports 3,581 nodes and 46,236 edges. Change
detection against `fcd7963` reports 77 changed files, 367 changed
functions/classes, 232 structural test-gap candidates, risk 0.60, and no
automatically connected affected flows. Focused `tests_for` queries report 61
client tests for `createClient`, 10 `sliceModel` tests, and two direct runtime
artifact-selection tests; the graph still does not map native C++ harnesses to
bridge nodes, so the real-WASM matrix above remains the authoritative bridge
evidence. All four local plan links resolve and the command forms match the
current package scripts/build-driver contracts. `git diff --check` passes.

The five previously failing Electron paths now pass in this focused rerun;
the complete Level 4 Electron/package/non-root-Web/profile and licensed-fixture
matrix was subsequently closed by Step 10. No implementation or submodule
files were changed by this audit. The only dirty path remains the pre-existing
`packages/slicer-wasm/cpp` submodule at
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`, with the same seven user-owned
dirty files. This record is historical self-verification; the Step 10
acceptance record below is authoritative.

**Step 9 root re-acceptance record (2026-09-09):** Root independently reviewed
corrective commits `343f5ac` and `1905a59`, including the restored ObjectList
DOM/selection contract, additive-mesh selection timing, Worker receiver
preservation, and clean-project mock preflight semantics. Root then reran
`pnpm test`, `pnpm typecheck`, both-variant quick and smoke builds, and the
complete real-WASM multi-filament acceptance checklist; all exited 0 and the
checklist reported `failed: []` for serial and threaded. The primary Electron
flow plus the five corrected paths passed 6/6, and the real Web threaded and
serial-fallback suites passed 5/5 each. Graph review at `1905a59` reported no
mapped affected flows; its native-harness mapping gap is covered by the
successful real-WASM matrix. `git diff --check` passed, and the pinned native
submodule remained at `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`
with the same seven user-owned dirty files. Step 9 is re-accepted; the later
Step 10 acceptance record below closes the release gate.

### Step 10 — Separate Level 4 release gate (accepted)

**Dispatch:** The fresh Step 10 subagent performed the complete Level 4
release matrix after Step 9; root independently accepted the result. This was
the final serial step.

**Functional boundary:** Final release/milestone acceptance only. This is the first and only step that runs the complete approved cross-host, dual-variant matrix regardless of recent changes. The Luna High subagent executes and reports the matrix; root owns the final release decision and any subsequent commit/status/roadmap update.

**Dependencies:** Steps 0–9 accepted; all independently testable commits exist; release artifacts and both real WASM variants are available.

**Required release evidence:**

1. `pnpm test` and `pnpm typecheck`.
2. `scripts\build-windows.bat quick --variant both` and `scripts\build-windows.bat smoke --variant both` (threaded and serial).
3. Complete deterministic multi-filament bridge/3MF/G-code/Preview fixture suite, including the independent reader fixture, bridge-generated writer round-trip, 64-slot boundary, unsupported-reference rollback, mixed-temperature used/unused checks, and all history/remembered-rack cases.
4. Full Electron E2E, including project lifecycle, profile compatibility, slice/preview, persistence, and packaged/runtime probes where applicable.
5. Real Web threaded E2E with COOP/COEP, real Web serial E2E with fallback, non-root deployment smoke, and browser import/download assertions.
6. Applicable profile-package, project-compatibility, cross-check, and licensed-fixture probes named by the specifications.

**Explicit prohibitions:** A mock module cannot substitute for real WASM; a missing artifact/environment is not a pass; no release status or roadmap update before every required result is green or an explicitly approved release exception exists; never repair failures by touching `packages/slicer-wasm/cpp/`.

**Subagent self-verification:** The Luna High subagent must return the complete Level 4 matrix with exact command, host, variant, artifact, exit status, and captured result for every required row; include deterministic fixture evidence, Electron/Web E2E evidence, profile/compatibility/cross-check/licensed-fixture probes, and explicit unavailable/intentional skip/failure entries. It must verify `git diff --check`, local links/commands, changed-path allowlists, commit boundaries, AGPL scope, and unchanged submodule state. Any missing artifact or environment is reported as not run and fails the release gate.

**Root independent acceptance:** Root independently re-runs or verifies every Level 4 result, compares the evidence with the approved checklist, checks exact host/variant coverage, `git diff --check`, local links, commit boundaries, AGPL scope, and that the only unrelated pre-existing change remains the same dirty submodule. Root accepts the release gate only when every required result is green or an explicitly approved release exception exists. Only root may then mark the milestone delivered, create release/status commits, or update roadmap/spec documents. Failure ends the serial sequence and requires remediation at the owning earlier step by a fresh Luna High subagent, repeat root acceptance through Step 9, and a new Step 10 dispatch.

**Commit boundary:** No automatic release commit. Release/roadmap status updates are a separate, explicitly authorized documentation change after this gate.

**Step 10 root acceptance record (2026-09-09):** Accepted at implementation
HEAD `07f276d`. The complete dual-variant real-WASM acceptance runner covered
the command/rollback, assignments/routing, independent reader, imported
painting/tool changes, flushing/prime tower, plate-local result, history,
project preflight/rack, project round-trip, and preset-restoration rows on both
`serial` and `threaded`. It completed in 95.018 seconds with `failed: []`; the
runner's hard wall-clock limit is 120 seconds. The release matrix retains its
host/build/profile/project checks, while developer iteration may use the
`--threaded-only` mode. The Electron target regression set is present in the
accepted evidence; no implementation or submodule path changed during the
gate.

### Step 9 documentation closeout — zero-legacy boundary

**Closeout date:** 2026-09-09
**Implementation HEAD:** `07f276d`
**Result:** accepted; no production gap remains

The final audit confirms that the implementation is fully multi-filament:

- The old single-filament UI, public API, preference field, project selection
  tuple, native history state, project sidecar member, mock field, wire
  `selected` flag, compatibility special case, and migration test are absent.
- `filament_catalog` is the only filament catalogue wire projection. The
  public profile-selection path accepts only Printer and Process; rack/session/
  slot commands own all filament state.
- History stores the minimal mutable filament frame. The exact no-bundle
  invariant is guarded by `fullPresetBundleCopyCount`: the project-import
  candidate is the sole full `PresetBundle` copy. Warmed slot history Undo/Redo
  is approximately 1–3 ms in the acceptance smoke.
- Context-only history records do not advance the filament session fence.
  Project mutations remain revision-fenced; stale commands leave project,
  rack, history, and result state unchanged.

The most recent complete real-WASM dual-variant acceptance run finished in
95.018 s with `failed: []`. The runner hard-fails at 120 s. Developer
iteration may run the fast threaded-only subset; release acceptance runs both
`serial` and `threaded`.

The closeout evidence and commands are:

```text
pnpm test
pnpm typecheck
node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs --run-real
node packages/slicer-wasm/harness/multi-filament-command-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js
node packages/slicer-wasm/harness/multi-filament-command-benchmark.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --assert-under-ms 20
node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs --run-real --threaded-only
git diff --check
```

The full host/build matrix, graph review, and commit/path audit are retained
in the preceding Step 9 acceptance records. This closeout updates only the
normative documentation and removes the superseded selector task note; it
does not add a compatibility shim, migration, production API, or submodule
change.

## 3. Cross-step evidence and failure policy

Every accepted step must leave evidence sufficient for a new agent to reproduce it: exact commands, package/variant/host, test result, and changed-path review. The root agent must not infer success from a subagent's summary, a prior run, or a generated artifact without the command output.

The following are always blockers until resolved at the owning step: contract/schema drift; partial mutation; a changed history cursor/rack/project after rejection; stale or cross-plate result acceptance; host import leakage; missing real-WASM evidence; ambiguous E2E assertions; any changed path outside the step allowlist; or any submodule content/index/pointer change.

The plan follows [`doc/testing_guidelines.md`](testing_guidelines.md) for Level 1–4 scope and [`spec/Web-Electron Shared Application Architecture.md`](../spec/Web-Electron%20Shared%20Application%20Architecture.md) for host/runtime boundaries. Product behaviour is not reopened by an implementation subagent; any genuinely new requirement requires a separately approved spec change before a new plan step.

## 4. Bridge modularization follow-up (2026-09-09)

The next bridge-maintenance phase is an internal decomposition only; it does
not change the accepted C ABI, JSON schemas, or multi-filament behaviour. The
planned sequence is: (1) move the Worker-owned state aggregate and lazy
construction into a Neo-owned module; (2) isolate history serialization and
transaction adapters; (3) separate plate/session and profile/model operation
helpers; (4) leave `bridge.cpp` as the narrow extern-C business facade; and
(5) rerun the bridge contract, both-variant build, and focused history and
multi-filament evidence after each independently testable step. Later stages
remain planned work and are not complete in this document.

This step's boundary is limited to the first item: `BridgeState`, its nested
state records, lazy `state()` lifetime, and the required serial/threaded state
initialization now live in `packages/slicer-wasm/src/bridge_state.hpp/.cpp`,
with an explicit CMake source entry. `bridge.cpp` retains every extern-C
export, business helper, ABI, JSON field, error string, and operation. No
history/filament/project/profile/model/slice ABI or compatibility/fallback
logic is moved or changed, and the pinned `packages/slicer-wasm/cpp`
submodule remains outside this phase's write set.

### 4.1 Pure history model codec narrow step (2026-09-10)

The second modularization step is complete at the pure codec boundary only.
`NeoHistoryArchiveContext`, its cereal adapters, mesh serialization/hash,
`ModelState` capture, retained-state model staging, and model-state equality
now live in `packages/slicer-wasm/src/bridge_history_codec.{hpp,cpp}`. The
codec receives its `const Model&` and restore data explicitly and has no
`state()`, `BridgeState`, or `PresetBundle` dependency. `bridge.cpp` retains
history transactions, direct filament frames, plate/session coordination, and
all extern-C exports; no broader history split is claimed by this step.

### 4.2 History metadata/context/status narrow step (2026-09-10)

This independently testable bridge-maintenance step extracts the history
metadata layer into `packages/slicer-wasm/src/bridge_history_metadata.{hpp,cpp}`.
History entry-id and direction parsing, context validation, default/canonical
context construction, context-only recording (including active-plate context),
public history status JSON, and restore diagnostics JSON now accept explicit
`BridgeState&`/`const BridgeState&` and required snapshots/model state. Context
records continue to use `History::Category::Context` and do not advance the
filament history/session revision fence. `bridge.cpp` retains only narrow
adapters and all model restore, direct filament-frame, mutation, and C ABI
operation code.

The CMake source list explicitly includes the new module. No ABI, JSON/error
contract, typed client path, compatibility logic, or pinned submodule content
changed. This record covers only the metadata/context/status extraction;
subsequent bridge modularization stages remain planned and are not marked
complete.

### 4.3 Multi-filament state/snapshot/sidecar narrow step (2026-09-10)

This independently testable bridge-maintenance step extracts the cohesive
multi-filament state boundary into
`packages/slicer-wasm/src/bridge_filament_state.{hpp,cpp}`. The module owns
field-level filament history serialization, direct-frame capture and retained
resource accounting, project filament sidecar decoding, and staged mutable
filament capture/apply. It receives explicit `BridgeState&`/preset arguments
and never copies the complete `BridgeState` or `PresetBundle` catalogue.
Filament command transactions, history cursor fencing, restore coordination,
and all extern-C wrappers remain in `bridge.cpp`.

The CMake source list explicitly includes the module. This step preserves the
ABI, JSON/error schema, typed client contract, compatibility rules, and the
pinned dirty submodule; no legacy single-filament fields or compatibility
paths are introduced. Rack/session projection and later plate/model helper
decomposition remain planned follow-up work and are not marked complete here.

### 4.4 Profile/config projection narrow step (2026-09-10)

This independently testable bridge-maintenance step extracts the native
profile/config domain into `packages/slicer-wasm/src/bridge_profiles.{hpp,cpp}`.
The module owns internal AppConfig reset/loading, native profile visibility and
initial selection, Printer/Process compatibility selection, atomic preset
snapshot projection (including `filament_catalog` and printable-area data),
and option metadata projection. The three existing profile C exports remain
unchanged in ABI, JSON, and error behavior; `orc_init` keeps its existing
Worker-owned reset/history/session sequence and delegates only profile loading
to the module.

The CMake source list explicitly includes the module. The module does not add
single-filament selectors, selected flags, preferences, project state, or
compatibility shims, and does not copy `BridgeState` or `PresetBundle`; the
existing project-import staging boundary remains in `bridge.cpp`. This step
preserves rack/session revalidation and revision behavior; later plate/model
helper decomposition remains planned follow-up work.

### 4.5 Plate/session identity and membership narrow step (2026-09-10)

This independently testable bridge-maintenance step is accepted. Runtime
multi-plate identity and sequencing, grid/parking origins, membership
recomputation, plate snapshots, per-plate revision fences, transform
translation/reflow, bounds validation, and mutation-result assembly now live
in `packages/slicer-wasm/src/bridge_plate_session.{hpp,cpp}`. Project
persistence parsing and archive writing, model mutation orchestration, slicing,
history transactions, and all extern-C exports remain in `bridge.cpp`.

The CMake source list explicitly includes the module. The split is structural:
the 77-export ABI, canonical `plate_session` mutation schema, JSON/error
contracts, stale-revision behavior, history minimal-state boundary, slot
latency, and native multi-plate behavior are unchanged. A follow-up fix removed
the former outer mutation-field aliases and duplicate `transform` field; test
and mock callers now read only `plate_session` and `world_transform`. Direct
plate-session snapshots retain their canonical top-level snapshot schema. No
compatibility or legacy single-filament paths were introduced, and the pinned
submodule remains outside the write set. The bridge source decreased from 6649
to 6107 lines; the remaining bridge modularization stages remain planned and
are not marked complete here.

### 4.6 Model operations bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts the model editing
domain into packages/slicer-wasm/src/bridge_model_operations.{hpp,cpp}.
Model byte loading, primitive creation, clear-scene, object/volume/instance
delete/clone/reorder/split/merge/separation/add/remove, transform updates,
stable-ID resolution, model structure projection, and mesh projection now
compile in the dedicated module. Geometry-only model staging helpers used by
project import are exposed through its narrow C++ interface.

The C ABI exports remain unchanged and are kept in an extern "C" block in the
new translation unit; JSON schemas, canonical plate_session mutation
envelopes, world_transform records, error semantics, stale revision fences,
history minimal-state boundaries, and native model behavior are unchanged.
The module directly consumes BridgeState and the approved PlateSession
helpers; it does not own project persistence, history transactions, filament
state, profiles, or slicing. No legacy compatibility aliases or
single-filament behavior was introduced. CMake explicitly compiles the new
source, and the pinned native submodule remains outside the write set. The
bridge source is reduced from 6107 to 5291 lines; later project/history and
slicing decomposition remains planned work.

### 4.7 Slicing pipeline bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts the slicing and
result pipeline into `packages/slicer-wasm/src/bridge_slicing_pipeline.{hpp,cpp}`.
The module owns the progress mailbox/callback transport, current-plate slice
and result projection, bounded preview source paging, G-code export, cancel
reset, and threading diagnostics. It consumes the existing Worker-owned state,
plate-session helpers, and binary-buffer builder through includes; it does not
own project persistence, history, filament commands, plate identity, model
editing, profiles, or initialization.

The CMake source list explicitly compiles the new translation unit. The full
77-export C ABI, canonical JSON, stale plate-revision fence, buffer ownership,
progress semantics, and synchronous Worker ABI are unchanged. No compatibility
or legacy single-filament code was added, and the pinned native submodule is
outside the write set. At this step `bridge.cpp` is reduced from 5291 to 4515
physical lines; project loading continues to use the module's narrow progress
interface. Later project/history decomposition remains planned work.

#### Slicing pipeline v2-only wire cleanup (2026-09-10)

The slicing pipeline follow-up removed the unfinished preview wire aliases
and their duplicate allocations. `orc_get_slice_result` now publishes only
the canonical v2 segment arrays: `starts_ptr`, `ends_ptr`, `layer_id_ptr`,
move/source/type arrays, `extrusion_role_ptr`, tool/colour arrays, geometry
width/height arrays, and optional metric descriptors. The former
`vertex_ptr`/`vertex_count`, `layer_ptr`/`layer_count`, `feature_ptr`/
`feature_count`, and `toolpath.features` fields are gone, as are the matching
`ToolpathBuffers::positions`/`features` buffers and releases. The model-mesh
`vertex_ptr` ABI is unrelated and remains unchanged.

The typed client requires a v2 envelope, required counts/pointers, and a
complete `metadata.feature_palette` whose entries contain canonical `id` and
`role` values. It derives the renderer's local per-segment feature IDs from
`extrusion_role_ptr` through that palette; missing fields or roles fail
explicitly rather than falling back. `ClientToolpath` and all app consumers,
mock data, tests, and real-WASM harnesses now use the v2-only shape. The
bridge smoke harness also supplies the current four-argument model-load API
directly instead of adapting an older call shape.

This is a separate follow-up fix commit after `9255274`; the pinned native submodule remains
untouched. Required slice-result heap buffers are each read/freed once by the
client, and the real serial/threaded preview and bridge smokes validate the
canonical pointer set.

### 4.8 Project persistence bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts project
persistence into `packages/slicer-wasm/src/bridge_project_persistence.{hpp,cpp}`.
The module owns project archive staging/read/rewrite helpers, native plate
metadata parsing, Neo plate/config-overlay/filament sidecar coordination,
project preflight/commit/cancel, geometry-only import, project export, and
the project-related metadata projections. `bridge.cpp` retains only narrow
adapters for shared validation/config projection and no project archive
implementation.

Project replacement remains staged and failure-atomic: model, presets,
history baseline, plate identity/membership/revisions, overlay, and sidecar
state are published only after validation, with move-based rollback covering
late commit failures. The explicit `PresetBundle` candidate copy is confined
to project load/preflight; history begin/commit/abort/undo/redo/jump/direct
and eviction paths remain outside this module and do not copy the complete
bundle. Native Orca/Bambu 3MF parsing/export and the current Neo sidecars
remain supported; no old Neo/legacy single-filament compatibility path,
field, alias, migration, or API was added.

The CMake source list explicitly compiles the new translation unit. The
77-export C ABI, JSON/error contracts, preflight token fence, and current
multi-filament/plate persistence schemas remain unchanged. `bridge.cpp` is
reduced from 4515 to 3366 physical lines. Serial and threaded quick WASM
builds, 130 WASM tests, package typecheck, project-preflight atomic smoke,
threaded project-roundtrip, bridge smoke, history smoke, and threaded
multi-filament command smoke pass. The pinned native fixture parser and
bridge-open checks pass. Its canonical layout records the selected native
printer printable area (`207 x 255`), the grid gap ratio (`0.2`), and the
resulting stride (`207 * 1.2 = 248.4`). The fixture's native world offsets
(`103.5` and `351.9`) therefore produce the canonical local offsets
`103.5` on both plates after subtracting the plate origins (`0` and
`248.4`). The harness asserts this derivation and validates the selected
printable area, origins, and world offsets rather than relying on a default
profile. Native interoperability and controlled checksum tests pass in both
serial and threaded variants.

### 4.9 Multi-filament command bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts the
multi-filament command layer into
`packages/slicer-wasm/src/bridge_filament_commands.{hpp,cpp}`. The module owns
command parsing, slot validation, preset/colour selection, slot add/delete/
merge, assignment and routing, reference remapping, flush recalculation,
candidate validation, fault-injection rollback, direct history-frame
coordination, and command result assembly. The existing bridge keeps only
thin extern-C adapters and supplies the canonical filament-session projection
through a narrow runtime callback.

The command module consumes `BridgeState` and the existing filament-state,
plate-session, history, project-persistence, and slicing interfaces. It does
not add a second wire shape or a compatibility path. History-producing
mutations retain only the field-level filament state and direct model frame;
they never copy the complete `PresetBundle`. Revision checks remain at the
command boundary, all affected plate revisions are invalidated atomically,
and add/delete/merge rollback remains fieldwise.

The CMake source list explicitly compiles the new translation unit. The
existing `orc_*` export name/signature set and JSON/error contracts remain
unchanged, stale filament-session revision fencing remains active, and the
pinned native submodule remains outside the write set. `bridge.cpp` is
reduced from 3366 to 1940 physical lines. Full package tests/typechecks,
dual quick builds, dual history/command smoke, and the acceptance checklist
remain required before this step is marked complete.

### 4.10 History transaction/runtime bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts the history
transaction and restore runtime into
`packages/slicer-wasm/src/bridge_history_runtime.{hpp,cpp}`. The module owns
the history transaction ABI, context canonicalization/recording adapters,
status and restore diagnostics, model/plate/mutable-filament restore staging,
direct filament history-frame restoration, cursor fencing, rollback, and
history reset/save/undo/redo/jump operations. A narrow runtime callback
supplies the field-level filament state and preview invalidation without
coupling the module to bridge-private projections.

History restore continues to stage only the mutable filament state and native
model/direct frame data. No history path copies a complete `PresetBundle`; the
project-import candidate remains the sole full-bundle staging boundary. The
77-export ABI, history JSON/error contracts, stale revision fence, and slot
history performance remain unchanged. The CMake source list explicitly
compiles the module and the pinned native submodule remains outside the write
set. The facade is reduced from 1940 to 1240 lines; all history restore helpers
and history ABI definitions now live in the dedicated module. No product
behaviour is changed by this structural step.

### 4.11 Plate lifecycle command bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts the plate
lifecycle command ABI into
`packages/slicer-wasm/src/bridge_plate_commands.{hpp,cpp}`. The module owns
plate-session reset, selection, add/delete, membership recomputation, shared
configuration mutation marking, and the plate-local configuration mutation
snapshot helper. Runtime plate identity, membership, geometry, and canonical
mutation projections remain in `bridge_plate_session.{hpp,cpp}`; project
configuration overlay commands remain in the facade.

The CMake source list explicitly compiles the new translation unit. The six
exported command names and signatures are unchanged, the canonical
`plate_session` response and history/context behavior are unchanged, and no
legacy or single-filament path was added. The module reuses the existing
plate-session and history-runtime interfaces; history-producing plate
operations continue to use field-level state and never copy a complete
`PresetBundle`. The pinned native submodule remains outside the write set.

### 4.12 Project configuration overlay bridge module (2026-09-10)

This independently testable bridge-maintenance step extracts project
configuration overlay handling into
`packages/slicer-wasm/src/bridge_project_overlay.{hpp,cpp}`. The module owns
the canonical project/object/part/plate overlay shape, empty/valid overlay
validation, native option application and status/error projections, plate
metadata/overlay application, and the three project-configuration C ABI
exports. Project persistence consumes these behaviours through the narrow
overlay header instead of retaining adapter implementations in `bridge.cpp`.

The CMake source list explicitly compiles the new translation unit. All 77
`orc_*` export names and signatures remain unchanged, native configuration
validation still uses the pinned Orca parser with substitution disabled, and
plate-local versus shared revision invalidation remains unchanged. The module
does not own initialization, filament fixtures or command wrappers, project
archive staging, or history transactions; history paths continue to avoid
copying the complete `PresetBundle`. No compatibility or old single-filament
API was added, and the pinned native submodule remains outside the write set.
`bridge.cpp` is reduced from 1041 to 804 physical lines.

### 4.13 Multi-filament session projection and ABI facade (2026-09-10)

This independently testable bridge-maintenance step extracts the native
multi-filament session projection and its thin ABI facade into
`packages/slicer-wasm/src/bridge_filament_session.{hpp,cpp}`. The module owns
the canonical rack snapshot, effective slot maps, flushing projection,
capabilities, assignment/routing projection, command runtime adapter, and the
multi-filament command and fixture exports. Mutation implementation remains
in `bridge_filament_commands.cpp`; field-level state and history data remain
in `bridge_filament_state.cpp`. Plate snapshot and initialization stay in the
facade.

The CMake source list explicitly compiles the new translation unit. All 77
`orc_*` exports retain their names and complete signatures, JSON/error
contracts and stale revision fence are unchanged, and history operations
continue to use field-level state without copying a complete `PresetBundle`.
No compatibility or old single-filament API was added. The pinned native
submodule remains outside the write set. The parent `bridge.cpp` was 804
physical lines and is now 248 physical lines; the new session module is 561
physical lines.

### 4.14 Bridge composition-root cleanup (2026-09-10)

This final bridge-maintenance step moves the read-only
`orc_get_plate_session_snapshot` ABI adapter into
`packages/slicer-wasm/src/bridge_plate_commands.cpp`, alongside the other
plate command exports. The parent `bridge.cpp` now contains only `orc_init`,
the HistoryRuntime adapter, the ProjectPersistence filament-validation
adapter, and the required global `RGB2HSV` link symbol. Unreferenced
`sanitized_model_basename` and `error_json_from_exception` helpers, stale
feature usings/includes, and duplicate JSON allocation code were removed;
`Profiles::duplicate_json`/`error_json` is reused for the initialization
error path.

The 77 exported ABI names and complete signatures, JSON/error contracts,
stale revision fence, millisecond slot history, and no-full-bundle history
boundary are unchanged. No compatibility or old single-filament path was
added, and the pinned native submodule remains outside the write set.
`bridge.cpp` is reduced from 248 to 137 physical lines.
