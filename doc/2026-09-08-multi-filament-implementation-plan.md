# Multi-Filament Support Implementation Plan

**Date:** 2026-09-08
**Status:** Accepted execution plan; implementation not started
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

### Step 2 — Atomic slot commands

**Dispatch:** Root starts a fresh Luna High subagent for Step 2 only after Step 1 is accepted. It performs the atomic command implementation and complete self-verification; root independently accepts or blocks the step.

**Normative mapping:** Sequence 2, “Atomic slot commands.”

**Functional boundary:** Implement slot preset selection, effective colour edit, Add, Delete, and Merge with as explicit Worker commands. Each command stages and validates the complete native session and remaps all known references atomically, then returns the full snapshot and mutation result.

**Dependencies:** Step 1 passes; fixture set includes Add through 64, slot-65 rejection, first/middle/last Delete and Merge, colour retention, unsupported-reference rejection, and injected failure.

**Primary files/interfaces:** `packages/slicer-wasm/src/bridge.cpp`; native history/project helpers in `packages/slicer-wasm/src/{history,bridge_buffers.*}` as needed; `packages/slicer-wasm/src/client/{types.ts,client.ts,testing/mock-module.ts}`; `packages/slicer-wasm/harness/` multi-filament bridge tests and fixtures.

**Implementation tasks:**

1. Add explicit JSON command shapes and stable error codes/details for stale revisions, capability rejection, unsupported references, and native validation failure.
2. Stage a copy of `PresetBundle`, model, plate state, custom G-code, painting/tool changes, support references, routing values, maps, arrays, and flushing state; validate all references and capacity before commit.
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

**Root independent acceptance:** Re-run the full WASM package test/typecheck and the complete Step 2 fixture harness; inspect a failing command before/after snapshot, history cursor, and result revision; run serial quick/smoke; verify no app/UI files changed. Failure blocks Step 3.

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

1. Extend the native history frame to restore PresetBundle, ordered slots, colours/metadata, maps, matrices, model/plate assignments, painting, custom G-code, support, routing, and revisions atomically.
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

### Step 10 — Separate Level 4 release gate

**Dispatch:** Root starts a fresh Luna High subagent for Step 10 only after Step 9 is accepted. The subagent performs the complete Level 4 release matrix and self-verification record; root independently performs final acceptance. This is the final serial step; no later implementation step may be dispatched.

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

## 3. Cross-step evidence and failure policy

Every accepted step must leave evidence sufficient for a new agent to reproduce it: exact commands, package/variant/host, test result, and changed-path review. The root agent must not infer success from a subagent's summary, a prior run, or a generated artifact without the command output.

The following are always blockers until resolved at the owning step: contract/schema drift; partial mutation; a changed history cursor/rack/project after rejection; stale or cross-plate result acceptance; host import leakage; missing real-WASM evidence; ambiguous E2E assertions; any changed path outside the step allowlist; or any submodule content/index/pointer change.

The plan follows [`doc/testing_guidelines.md`](testing_guidelines.md) for Level 1–4 scope and [`spec/Web-Electron Shared Application Architecture.md`](../spec/Web-Electron%20Shared%20Application%20Architecture.md) for host/runtime boundaries. Product behaviour is not reopened by an implementation subagent; any genuinely new requirement requires a separately approved spec change before a new plan step.
