# Undo/Redo Implementation Plan

**Date:** 2026-09-07
**Status:** Timestamped history redesign implemented; independent acceptance completed 2026-09-19
**Branch:** `dev/per-plate-print-architecture`
**Normative design:** [`spec/Undo and Redo.md`](../spec/Undo%20and%20Redo.md)

## 1. Execution Protocol

This plan is intentionally sequential. No implementation step may start until
the preceding step has passed both its implementation agent's self-verification
and the root agent's independent acceptance.

For every numbered step:

1. The root agent starts one **new** `gpt-6-astra` agent at `low` reasoning
   effort, with only that step's scoped task. This is the user's current model
   requirement; earlier implementation records retain their original models.
   The agent does not delegate the step further.
2. The agent reads the normative Undo/Redo specification and relevant existing
   code, implements only the step, runs its required self-verification, and
   creates one in-scope commit.
3. The agent reports the commit, changed contract/behaviour, and actual command
   results. A failed check is fixed by the same agent before handoff.
4. The root agent independently reviews the diff and invariants, runs the
   acceptance checks listed for that step, and records the result in this
   document.
5. Only a passing root acceptance authorizes a fresh agent for the
   next step. If acceptance fails, the same step is returned to its existing
   agent; no later step begins.

All steps use pnpm for workspace checks. Every agent runs the focused tests
listed in its step plus `pnpm test`, `pnpm typecheck`, and
`pnpm --filter @orca/desktop test:e2e` before handoff. A step touching
`packages/slicer-wasm` also runs the applicable dual-variant quick build and
smoke tests through `scripts/build-windows.bat`; a step changing shared Web UI
or runtime also runs threaded and serial Web E2E. The root acceptance reruns at
least the focused checks from a clean command invocation; the final gate reruns
the full cross-host matrix.

No step may alter `packages/slicer-wasm/cpp` directly. The adapted native
history core belongs in Neo-owned `packages/slicer-wasm/src/history/`.

## 2. Step 0 — Baseline and Contract Scaffolding

**Delegated implementation scope**

- Capture a reproducible baseline for the existing project/session, Worker,
  transform, settings, ObjectList, multi-plate, and E2E suites.
- Add dependency-free TypeScript contract types for `HistoryContext`, stable
  selection/plate IDs, history labels/project category, `HistoryStatus`, transaction
  IDs, restore results, and history errors.
- Extend mock-runtime types only enough to compile future callers; do not expose
  an enabled Undo/Redo UI or change production mutation behaviour yet.

**Functional boundary**

This step creates typed seams and test fixtures only. The shipped app behaves
exactly as before; no project mutation is yet routed through history.

**Agent self-verification**

- Contract and mock-unit tests prove stable IDs, the project-only category,
  and serialization-safe context shapes.
- Existing store/project/action tests remain unchanged in behaviour.
- Full required pnpm/typecheck/Desktop E2E baseline passes.

**Root acceptance**

- Review that the contract contains no Electron/Node import and no geometry
  duplicate.
- Independently run the new contract tests, import-direction test, typecheck,
  and one existing desktop E2E flow.
- Accept only one focused commit with no visible feature behaviour.

## 3. Step 1 — Headless WASM ProjectHistory Core

**Delegated implementation scope**

- Implement `packages/slicer-wasm/src/history/ProjectHistory.{hpp,cpp}` by
  adapting Orca's wx-free `ObjectID` version intervals, mutable serialization,
  immutable mesh sharing/deferred serialization, redo truncation, and byte
  accounting.
- Keep all wxWidgets, `GLGizmosManager`, `Selection`, and `PartPlateList`
  types outside this core. The core accepts/returns neutral serialized context
  bytes only.
- Implement the 256 MiB default budget, optional-data release, oldest-first
  eviction, retained oversized atomic entry, and saved-checkpoint eviction
  state.

**Functional boundary**

The core is compiled and directly testable in the Worker/WASM build, but no
public bridge or UI calls it. It can record/restore a `Model` plus opaque
context without wx dependencies.

**Agent self-verification**

- Core tests cover model version restore, redo truncation, shared-mesh reuse,
  256 MiB eviction, oversized entry retention, and lost saved-checkpoint state.
- Both serial and threaded WASM quick builds and focused smoke harnesses pass.
- Full required baseline passes.

**Root acceptance**

- Verify CMake includes only Neo-owned history sources and the submodule is
  unchanged.
- Independently run both-variant quick build plus the core test/harness.
- Inspect memory accounting against the approved budget semantics.

## 4. Step 2 — Bridge, Typed Client, and Worker Transaction Protocol

**Delegated implementation scope**

- Expose explicit `begin`, `commit`, `abort`, `undo`, `redo`, `jump`, and
  `status` bridge operations backed by `ProjectHistory`.
- Carry `transactionId`, labels, the project category, before/after
  `HistoryContext`, cursor, saved-checkpoint relation, byte usage, and disabled
  state through the typed client and Worker RPC.
- Enforce one active history transaction in the Worker and reject malformed,
  stale, or cross-transaction calls.
- Add a `runProjectHistoryTransaction()` helper; do not migrate existing UI
  mutations yet.

**Functional boundary**

A test client can create a transaction around a controlled bridge mutation and
then Undo/Redo it. Existing product actions continue on their existing paths.

**Agent self-verification**

- Mock and real Worker tests cover begin/commit/no-op/abort, single-writer
  exclusion, history status, direct jump, and error propagation.
- Real serial/threaded bridge harness demonstrates a round trip without a 3MF
  export.
- Required WASM build, pnpm, typecheck, and host checks pass.

**Root acceptance**

- Independently exercise the typed API against a real WASM artifact in both
  variants.
- Verify React cannot construct model patches or bypass the Worker history
  owner.
- Verify an aborted transaction leaves model and cursor unchanged.

## 5. Step 3 — Session Lifecycle, Checkpoints, and Context Ownership

**Delegated implementation scope**

- Make Worker history metadata the only persisted history owner; React retains
  only the currently projected context and uncommitted draft/gesture state.
- Replace accumulated project dirty reasons with saved-checkpoint evaluation for
  project-modifying history entries.
- Integrate Save/Save As checkpoint marking without clearing history.
- Integrate New/Open/Reload hard boundaries that clear history and establish a
  clean baseline. Keep Add Model and Clear Scene out of this boundary.
- Keep selection and active-plate changes outside history. The next genuine
  project mutation samples the current context for its predecessor and
  successor frames; UI-only context changes after Undo preserve Redo.

**Functional boundary**

History correctly represents one project session and its save lifecycle even
before ordinary model-editing actions are migrated.

**Agent self-verification**

- Tests cover save → Undo → clean/dirty transitions, Save As, checkpoint
  eviction, New/Open/Reload reset, UI-context Redo preservation, and genuine
  mutation Redo truncation.
- Existing 3MF persistence tests prove history itself is not serialized.
- Required full host checks pass.

**Root acceptance**

- Independently run project persistence tests and lifecycle-focused desktop/Web
  scenarios.
- Verify no global preset preference is written by Undo/Redo.
- Verify the Worker, not Zustand, is authoritative for cursor/checkpoint state.

## 6. Step 4 — Atomic Restore Coordinator and Revision Isolation

**Delegated implementation scope**

- Implement Worker prepare/commit restoration, returning the target
  `HistoryContext` only after a valid staged model restore.
- Preserve the current session on prepare/validation failure; surface a
  retryable error without advancing cursor or UI state.
- Add the shared restoring/cancelling-slice state machine, snapshot suppression,
  slice invalidation, model structure/mesh refresh, and final context projection.
- Add revision tokens so stale structure/mesh reads and renderer objects are
  discarded after restore.
- During an active drag, a first Undo/Redo cancels the draft gesture and is
  consumed. During slicing, cancel and await the slice before restoring.

**Functional boundary**

Restore is atomic from the shared UI's perspective and cannot race a gesture,
slice, stale Worker response, or new history snapshot.

**Agent self-verification**

- Tests inject restore parse/validation failure and prove the old model, cursor,
  selection, plate, and gizmo remain intact.
- Tests cover mid-drag shortcut cancellation, slice cancellation before restore,
  stale-result rejection, and disabled controls while restoring.
- Required full host checks pass.

**Root acceptance**

- Independently force each failure/race scenario using Worker mocks and one real
  artifact restore.
- Review that no restore synchronisation can create a history entry.
- Confirm slice output is invalidated but never included in history.

## 7. Step 5 — Transform History Migration

**Delegated implementation scope**

- Route body drag, Move/Rotate/Scale gizmos, numeric panels, Drop to Bed, and
  Reset through `runProjectHistoryTransaction()`.
- At gesture start capture the pre-change Worker model; retain only local
  three.js transforms while dragging; send final transforms once at commit.
- Abort restores local pre-gesture transforms without a Worker mutation.
- Retain pre-slice transform synchronization solely as a defensive check.

**Functional boundary**

Every exposed transform becomes one atomic Undo/Redo action, with no per-frame
WASM traffic and no per-frame history growth.

**Agent self-verification**

- Unit and real-WASM tests cover each transform path, cancellation, no-op drag,
  multi-selection pivot behaviour, Undo/Redo restoration, and Redo truncation.
- Electron and both Web E2E modes cover pointer drag, panel edit, Drop to Bed,
  and Reset.
- Required full checks pass.

**Root acceptance**

- Independently inspect bridge traffic to ensure one committed transform write
  per gesture.
- Run focused transform E2E in all three hosts and verify dirty/save behaviour.

## 8. Step 6 — Structural, Import, Clear, and Multi-plate Migration

**Delegated implementation scope**

- Route Add Model/Cube/Handy Model, Clear Scene, and every ObjectList mutation
  through the transaction helper.
- Route the currently exposed multi-plate add/delete and shared configuration
  actions through the same path; active-plate switching remains UI context
  only. Plate reorder and lock APIs/UI call sites do not
  exist in this milestone and are not part of this migration.
- Ensure restored model entities keep stable IDs and that ObjectList/viewport
  projections refresh from the restored structure instead of stale indices.

**Functional boundary**

All currently exposed structural project edits are reversible; Clear Scene is
undoable, while New/Open/Reload remain hard boundaries.

**Execution record (2026-09-07)**

- Added the shared transaction/context helper and routed model imports, handy
  models, Clear Scene, ObjectList mutations, selection deletion, plate
  add/delete, and shared project configuration through Worker history.
- Added focused transaction/context coverage and stable-ID selection fallback
  coverage. Post-mutation contexts now filter deleted IDs and read the
  authoritative active plate identity. The original active-plate context entry
  described here was removed by the accepted §14 correction. Real dual-variant
  WASM smoke passed.
- `pnpm test`, `pnpm typecheck`, slicer-app tests (401 passed), Electron E2E
  (29 passed, 3 existing skips), threaded Web E2E (4 passed), and serial Web
  E2E (4 passed) all passed. The dual-variant quick WASM build also passed.
- A first threaded-Web run had one non-deterministic GPU-streaming failure
  while waiting for Slice to enable. The isolated test passed 1/1, then 5/5
  on both the Step 6 parent baseline (`56c4693`) and this implementation;
  a clean full threaded-Web rerun passed 4/4. The initial failure is retained
  as flaky test evidence, not reported as a product regression or a pass.

**Root acceptance**

- Cross-check the delivered coverage against the §5.3 operation list in the
  normative spec; no exposed mutation may be omitted.
- Independently run a representative destructive restore sequence on both WASM
  variants and all hosts.

## 9. Step 7 — Project Configuration Overlay and Input Transactions

**Delegated implementation scope**

- Move supported project/object/part/plate setting overrides into the
  Worker-owned `ProjectConfigOverlay`; return it to React as render state.
- Persist supported overrides in project save/load and restore them through
  history, while keeping system preset selection outside history.
- Replace per-character settings writes with local drafts: Enter/blur commits,
  Escape cancels, discrete controls commit immediately, and continuous controls
  use gesture transactions.
- Revalidate overlays after a base-preset change without unconditionally
  dropping them.

**Functional boundary**

One committed configuration edit is one history action and survives supported
project save/load; changing a system preset never becomes a project Undo item.

**Execution record (2026-09-07)**

- Added Worker-owned project/object/part/plate configuration overlays with
  typed client methods for read, write, and preset revalidation. Overlay state
  is included in history contexts and the Neo 3MF metadata entry
  `Metadata/orca_neo_config_overlay_v1.json`; load reapplies object, part, and
  plate overrides before returning the project projection.
- Settings text and numeric inputs now use local drafts: Enter or blur commits,
  Escape cancels, and bool/enum controls commit immediately. System preset
  selection advances plate revisions without creating project history, then
  revalidates retained overrides.
- Fixed failed override writes to validate the target and deserialize the value
  before mutating the overlay, keeping rejected calls atomic. The dirty
  submodule worktree under `packages/slicer-wasm/cpp` was not changed.
- Focused client/app tests, dual-variant WASM quick builds, dual-variant smoke,
  `pnpm test`, and `pnpm typecheck` passed. Final host gates passed after
  serializing the Web runs: Desktop E2E 29 passed with 3 existing skips,
  threaded Web E2E 4/4, and serial Web E2E 4/4. A parallel Web attempt was
  discarded because both variants raced while rebuilding the shared `dist`
  directory; the isolated reruns passed.

**Agent self-verification**

- Tests cover all input commit/cancel boundaries, project/object/part/plate
  scopes, preset revalidation, 3MF round trip, Undo/Redo, and dirty state.
- E2E covers numeric, text, enum, and boolean option edits plus save/reopen.
- Required full checks pass.

**Root acceptance**

- Independently verify no keystroke-level history growth and no global
  preference mutation through Undo/Redo.
- Run real project save/load verification with an override present.

## 10. Step 8 — Shared History Navigation UI

**Delegated implementation scope**

- Add shared primary-toolbar Undo/Redo buttons, accessible disabled state,
  next-operation labels, directional menus, and direct jump.
- Populate menus from Worker `HistoryStatus`; display only project-modifying
  entries. Selection/plate changes never create entries.
- Add focus-aware shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y; editable
  controls retain native text Undo/Redo.
- Respect restoring/cancelling-slice state and operation errors.

**Functional boundary**

Electron and Web expose the same navigation semantics, including direct jump,
without intercepting text-field Undo/Redo.

**Execution record (2026-09-08)**

- Added the shared primary-toolbar Undo/Redo controls and directional menus.
  Labels, disabled state, menu contents, and direct jumps are projected from
  the latest Worker `HistoryStatus`; selection/plate changes create no history
  entries and no frontend history list is retained.
- Routed one-step and menu navigation through the existing restore
  coordinator so drag cancellation, slice cancellation, atomic restore,
  revision fencing, and retryable errors remain shared by Electron and Web.
  Restore errors are announced in the toolbar and restoring/cancelling phases
  disable navigation.
- Added guarded Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y handling. Editable
  controls retain native text editing history, while unavailable, disabled, or
  active-transaction Worker history is left untouched.
- Focused navigation, toolbar, and restore-coordinator tests pass. Full
  workspace tests (409 slicer-app tests), typecheck, dual-variant quick build
  and smoke, Electron E2E (29 passed, 3 existing skips), and threaded/serial
  Web E2E (4/4 each) pass. The existing E2E skip set is unchanged.
- Added practical host coverage for the shared toolbar, shortcut/input
  precedence, directional menu direct jumps, and restore-time disabled state;
  the focused Electron scenario passes, as does the focused real threaded-Web
  scenario (the serial run uses the same shared test path).

**Agent self-verification**

- Component tests cover labels, accessibility, disabled state, menu direction,
  direct jump, and focus filtering.
- Electron/Web E2E cover shortcuts, buttons, menus, text input precedence, and
  disabled state during restore/slice cancellation.
- Required full checks pass.

**Root acceptance**

- Independently use every navigation route in both hosts and confirm it
  resolves through Worker status rather than a frontend history list.
- Verify selection/plate context is restored with a project action but not
  displayed as a normal step.

## 11. Step 9 — Resource Gates, Coalescing Foundation, and Release Audit

**Delegated implementation scope**

- Complete observable history-byte diagnostics and optional-data/oldest-entry
  eviction reporting without user-disruptive notifications.
- Add the dormant `coalesce`/nested transaction foundation with tests, without
  shipping a paint/support UI or secondary gizmo stack.
- Add large-model fixtures and deterministic assertions for no complete-3MF
  per edit, shared mesh retention, budget enforcement, oversized-entry
  retention, safe oldest-frame traversal, and saved-checkpoint eviction.
- Complete release-gate automation and update implementation evidence in this
  plan and the normative specification.

**Functional boundary**

The delivered feature has enforced resource behaviour, future-safe transaction
coalescing, and reproducible three-host release evidence.

**Agent self-verification**

- All functional, WASM, large-model, Electron, threaded Web, and serial Web
  gates pass with recorded command output and budget diagnostics.
- Timing and peak memory are recorded as diagnostics only; correctness and
  budget/eviction assertions are deterministic pass/fail gates.

**Root acceptance**

- Independently run the complete project-required handoff matrix: `pnpm test`,
  `pnpm typecheck`, both WASM variants' quick/smoke checks, Desktop E2E, and
  threaded/serial Web E2E.
- Review all commits against the normative design, inspect the final diff, and
  update `spec/Grand Plan.md` only when every gate has passed.

**Execution record (2026-09-08)**

- Added Worker-visible resource diagnostics for cumulative optional-byte
  release, whole-entry eviction, oldest retained entry, and the intentional
  oversized-entry exception. Diagnostics are status data only and never emit
  a disruptive notification.
- Added the opt-in `{coalesce, parentTransactionId}` nested transaction
  foundation in the bridge, Worker, typed client, and mock protocol. Nested
  commits publish no independent history entry; no paint/support UI uses it.
- Added `fixtures/history-large-model.json` and deterministic core assertions
  covering shared mesh retention, compact mutable deltas (no complete 3MF per
  edit), budget/oversized retention, safe oldest traversal, and saved
  checkpoint eviction. Added `pnpm verify:undo-redo`, which runs the required
  gates sequentially and records exact output/exit codes in a JSON report.
- Focused Worker/client tests passed (9/9), standalone native ProjectHistory
  fixture passed, `pnpm test` passed (workspace: 8 packages; slicer-app 409
  tests), and `pnpm typecheck` passed. `scripts\\build-windows.bat quick`
  rebuilt both threaded and serial wasm64 artifacts, and the dual smoke gate
  passed after the final bridge change (the redirected evidence is in the
  local `.work/step9-smoke.log`). Desktop E2E passed 30 with 3 existing
  skips; threaded Web E2E passed 5/5; serial Web E2E passed 5/5. Desktop's
  existing skips are the real DRC flow, native-menu slice wait, and rejecting
  model error scenario.

## 12. Root Acceptance Record

| Step | luna-high implementation commit | Agent self-verification | Root acceptance | Status |
| --- | --- | --- | --- | --- |
| 0 | `275e571` | Focused 3/3, workspace tests, typecheck, desktop E2E 29 passed/3 existing skips, threaded/serial Web E2E 4/4 each | Reviewed contract/import boundary; independently ran focused 3/3, import-direction 1/1, typecheck, desktop E2E 29 passed/3 existing skips | Accepted 2026-09-07 |
| 1 | `d21ba51`, `7e24245`, `9ea33bd` | Release-safe core test; configured wasm64 test; dual quick build; threaded/serial smoke; workspace tests, typecheck, desktop E2E 29 passed/3 existing skips | Found and returned two budget-eviction defects; reviewed corrected retention/checkpoint logic; independently ran Release core test, dual quick build, threaded/serial smoke | Accepted 2026-09-07 |
| 2 | `769b1cd`, `69e9ada`, `8fb3627` | Core/Worker protocol tests; dual quick build; real serial/threaded history + standard smoke; workspace tests, typecheck, desktop E2E 29 passed/3 existing skips | Returned unaccounted full-model frames and then non-incremental native frames; reviewed ObjectID archives/shared meshes; independently ran dual quick build, two-object real history smoke in both variants, protocol 3/3 | Accepted 2026-09-07 |
| 3 | `875df26`, `05cda8f` | Lifecycle/context regression tests; workspace tests, typecheck, dual quick build/smoke, desktop E2E 29 passed/3 existing skips | Returned renderer dirty authority and incomplete selection context; reviewed Worker-first lifecycle/context paths; independently ran lifecycle 16/16, protocol 5/5, dual quick build/history smoke, and dual 3MF round-trip clean-baseline regression | Accepted 2026-09-07 |
| 4 | `38b3bbf`, `1defda5` | Restore coordinator/projection-gate and native stale-plan regression tests; workspace tests, typecheck, dual quick build/smoke, desktop E2E 29 passed/3 existing skips | Returned premature projection onto stale GL meshes and lost empty-baseline context; reviewed revision fence and preflight cursor check; independently ran projection 5/5, protocol 5/5, typecheck, native Release history test, dual quick build, and dual real history smoke | Accepted 2026-09-07 |
| 5 | `f7dd8f2`, `0fe1ed6`, `b8ecb12` | Transform controller/coordinator, real-WASM transform and branch tests; full tests, typecheck, dual quick build/smoke, desktop E2E 29 passed/3 skips; Web E2E 3 passed/1 pre-existing beforeunload failure per variant | Returned local-draft cancellation and overlapping rapid-transform defects, then missing nonempty write-count/no-op/branch evidence; independently ran focused transform 65/65, protocol 5/5, typecheck, dual quick build, and dual real transform/history smoke | Accepted 2026-09-07 |
| 6 | `56c4693`, `13485e8`, `adbb697` | Structural/history context coverage 6/6; workspace tests/typecheck; Desktop E2E 29 passed/3 existing skips; threaded/serial Web E2E 4/4 each. The initial threaded GPU-streaming timeout was reproduced as non-deterministic and passed repeated current/baseline runs. | Reviewed all Step 6 diffs and stable-ID/context boundaries; independently ran focused 6/6, `pnpm test` (401 slicer-app tests), typecheck, Desktop E2E 29 passed/3 existing skips, and threaded/serial Web E2E 4/4 each. | Accepted 2026-09-07 |
| 7 | `e593323` | Client overlay test, slicer-app suite, full `pnpm test`, `pnpm typecheck`, dual quick, dual smoke, Desktop E2E 29 passed/3 existing skips, and threaded/serial Web E2E 4/4 each | Reviewed overlay persistence/history, draft commit boundaries, preset exclusion, atomic rejected writes, and final host gates; independently reran focused client/settings coverage | Accepted 2026-09-07 |
| 8 | `68fbb42`, `98afaaf` | Navigation/Toolbar component tests, full workspace checks, dual WASM smoke, Desktop E2E 29 passed/3 existing skips, threaded/serial Web E2E 4/4 each | Reviewed Worker-status navigation path, context-entry filtering, shortcut focus filtering, and direct jump; independently ran navigation/Toolbar 14/14 and desktop shared-history E2E 1/1 | Accepted 2026-09-08 |
| 9 | `171475f`, `eff1c15`, `c747854` | Focused protocol 9/9, standalone native ProjectHistory fixture, workspace tests (409 slicer-app tests), typecheck, dual quick/smoke, Desktop E2E 30 passed/3 existing skips, threaded Web E2E 5/5, serial Web E2E 5/5 | Reviewed resource/coalescing diff, Windows launcher, and temporary-report hygiene; independently ran `pnpm verify:undo-redo`: test, typecheck, dual quick/smoke, Desktop E2E, threaded Web E2E, and serial Web E2E all exited 0 | Accepted 2026-09-08 |

## 13. Post-review remediation sequence

The 2026-09-08 branch review found six deviations from the accepted design.
They are repaired sequentially under the same agent gate as the original
implementation: one fresh `gpt-5.6-luna` agent at `high` reasoning effort per
step, agent self-verification and an in-scope commit, followed by independent
root review and focused verification before the next step begins.

1. Restore the complete Worker-owned plate session in every history frame:
   plate collection, stable IDs, active plate, memberships, ordering, locks,
   revisions, and project-owned plate configuration.
2. Keep context-only UI changes completely outside history so one-step
   Undo/Redo traverses genuine project frames and UI navigation preserves Redo.
3. Project Worker history dirty state into the canonical project store after
   every restore so save-point navigation and close protection agree.
4. Keep restore fencing active until structure, mesh, selection, active plate,
   gizmo, dirty state, and slice invalidation have all completed projection.
5. Correct directional menu jump semantics: an Undo item restores the state
   before its named operation, while Redo restores the state after it.
6. Account for every history-exclusive native allocation represented by the
   adapted core, including dynamic container and string storage, and retain
   deterministic budget/eviction coverage.

The stale specification status line is corrected with the final remediation
step after all functional fixes pass, so documentation does not claim the
repair sequence is complete prematurely.

| Repair | luna-high implementation commit | Agent self-verification | Root acceptance | Status |
| --- | --- | --- | --- | --- |
| 1 | `e3978a0`, `f14cef9` | `history-smoke.mjs` passed in serial/threaded WASM; plate-session smoke passed in serial/threaded WASM; project round-trip passed in serial/threaded WASM; `pnpm test` (409 slicer-app tests), `pnpm typecheck`, Desktop E2E (30 passed, 3 existing skips), threaded Web E2E 5/5, serial Web E2E 5/5 | Returned the first submission for missing Delete/Reorder/Lock/membership history coverage; reviewed the complete plate-session capture/validation/restore path and supplemental matrix; independently ran serial/threaded real history smoke, serial/threaded plate-session smoke, protocol 6/6, and `pnpm typecheck` | Accepted 2026-09-08 |
| 2 | `907cef9` | Native ProjectHistory fixture, focused protocol 10/10, `pnpm test` (109 slicer-wasm and 409 slicer-app tests), `pnpm typecheck`, dual quick/smoke, and Desktop E2E 29 passed/3 skips with one transient Add Primitive failure | Reviewed project-frame traversal, labels, context return, checkpoint dirty behavior, and branch truncation; independently ran the native fixture, protocol 7/7, serial/threaded real history smoke, and Desktop E2E 30 passed/3 existing skips (the reported Add Primitive failure did not reproduce) | Accepted 2026-09-08 |
| 3 | `7bb48de` | Focused restore/history mutation 9/9, `pnpm test` (411 slicer-app tests), `pnpm typecheck`, Desktop E2E 30 passed/3 skips, threaded Web 5/5, and serial Web 5/5 | Reviewed canonical Worker-status projection for successful restore and abort plus failure preservation; independently ran focused 9/9, project lifecycle 16/16, and shared import-direction 1/1 | Accepted 2026-09-08 |
| 4 | `7a7826e` | Focused restore/GL barrier 9/9, `pnpm test` (414 slicer-app tests), `pnpm typecheck`, Desktop E2E 30 passed/3 existing skips, threaded Web 5/5, and serial Web 5/5 | Reviewed the Worker-success-to-renderer-ready barrier, revision fencing, empty-scene clear, mesh failure cleanup, plate/context projection ordering, and joined restore behavior; independently ran focused restore/GL barrier 9/9, Workspace 5/5, `pnpm typecheck`, and diff hygiene | Accepted 2026-09-08 |
| 5 | `a27a915`, `c79b56d`, `d87a3ac` | Native ProjectHistory fixture; focused protocol/Worker 19/19 and Toolbar/restore 17/17; `pnpm test` (112 slicer-wasm and 416 slicer-app tests); `pnpm typecheck`; dual WASM quick/smoke; Desktop E2E 30 passed/3 existing skips; threaded and serial Web E2E 5/5; real serial/threaded directional history smoke | Returned the first submission for a context-entry/default-direction bypass, then required actual evicted-ID and real-WASM bridge coverage; reviewed the explicit directional contract and project-frame resolution; independently ran native ProjectHistory, focused protocol/Worker 19/19, Toolbar/restore 17/17, serial/threaded real history smoke, `pnpm typecheck`, and diff hygiene | Accepted 2026-09-08 |
| 6 | `f655bb1`, `4eab2be` | Native ProjectHistory fixture, focused protocol, dual quick, serial/threaded history smoke, `pnpm test`, and `pnpm typecheck` passed; real-WASM smoke covers accounting diagnostics and retained restore, while native fixture covers deterministic eviction/oversized boundaries; Desktop E2E 29 passed/3 existing skips plus one transient Add Primitive failure that passed alone; threaded/serial Web E2E 5/5 | Returned the first submission for under-sized unproven canonical slots, host-dependent short-string classification, premature accepted status, and missing real-WASM accounting evidence; reviewed compile-time upper-bound assertions, allocation de-duplication, Orca comparison, and synchronized roadmap/spec status; independently ran native ProjectHistory, focused protocol 9/9, serial/threaded real history smoke, `pnpm typecheck`, and diff hygiene | Accepted 2026-09-08 |
| 7 | `ca82d36` | Focused Toolbar/app-tab tests 16/16, workspace tests (419 slicer-app tests), typecheck, Desktop E2E 30 passed/3 existing skips, threaded/serial Web E2E 5/5 | Reviewed both UI and global-shortcut gates; independently ran the same focused, workspace, and three-host checks | Accepted 2026-09-08 |

### Repair 1 execution record — complete plate session in history frames

- Added the authoritative plate session to every canonical Worker history
  context, including stable runtime plate IDs, ordered collection, current
  plate, origins, membership, parked/out-of-bounds state, lock state, opaque
  and future metadata, per-plate configuration metadata, and input revisions.
- Restore validates the session against the staged model before cursor commit,
  then replaces the Worker session atomically with the model. Because native
  `ModelInstance` history deserialization constructs invalid IDs, staged
  instances are materialized through `ModelObject::add_instance()` and the
  saved structural positions are used to rebind membership to their fresh
  runtime IDs. Transaction abort restores the same complete session.
- The real history harness now covers Add Plate Undo/Redo, stable IDs and
  revisions, plate-scoped configuration Undo/Redo, Delete Plate Undo/Redo,
  ordered plate compaction/reorder Undo/Redo, imported lock state across
  Undo/Redo, and membership/parked/out-of-bounds combinations. Every
  restored snapshot is checked against the live model's valid instance IDs,
  complete membership lists, current plate, order, and revisions in both
  serial and threaded WASM. The initial harness failure (Add Plate Undo left
  two plates live) was reproduced before the implementation and passes after
  the repair.
- The C++ submodule under `packages/slicer-wasm/cpp` remained untouched and
  retains its pre-existing dirty state. Root acceptance is intentionally not
  recorded here.

### Repair 1 supplemental verification — structural plate history matrix

- `history-smoke.mjs` passed in serial and threaded WASM after adding the
  structural matrix: Delete Plate Undo/Redo restores parked membership and
  the current plate; the intermediate-delete compaction path restores plate
  order; imported locked-plate state survives both directions; and the
  surviving out-of-bounds member remains a member with the same flag.
- The focused harness also passed `pnpm test` (all workspaces: 409
  slicer-app tests, 108 slicer-wasm tests) and `pnpm typecheck`.
- This supplemental harness-only commit does not change the C++ implementation
  or the root acceptance status.

### Repair 2 execution record — superseded context-only traversal

- The original context-record traversal described here was removed by the
  accepted §14 correction. `ProjectHistory`, the bridge ABI, and the typed
  client now retain only genuine project mutations; renderer context is
  sampled onto those frames.
- Focused Worker/client tests passed 10/10. Full `pnpm test` passed (workspace:
  8 packages; 109 slicer-wasm tests; 409 slicer-app tests), and `pnpm typecheck`
  passed. `scripts\\build-windows.bat quick --variant both` and the dual
  `scripts\\build-windows.bat smoke --variant both` passed.
- Desktop E2E completed with 29 passed and 3 existing skips, plus one failing
  Add Primitive geometry assertion. Re-running that single test failed at the
  same `selectionBoundsWorld()` wait; the failure is outside the Worker/core
  traversal changes and no unrelated E2E behavior was modified here.
- Root acceptance is intentionally not recorded in this execution record.

### Repair 7 execution record — Prepare-only history navigation

- Project Undo/Redo navigation is enabled only while the shared application is
  on the Prepare tab. Home, Preview, and Device retain visible toolbar
  controls but disable both buttons and directional history menus.
- The global project shortcut handler must not consume or dispatch
  `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, or `Ctrl+Y` outside Prepare. Native text
  editing precedence remains unchanged.
- Returning to Prepare reuses the current Worker `HistoryStatus`; changing
  tabs must not reset, truncate, or otherwise mutate project history.
- Implemented the gate in both command entry points: Toolbar buttons/menu
  triggers are disabled outside Prepare, stale mounted menu items cannot
  invoke a restore, and the global shortcut listener returns before consuming
  a project-history shortcut on non-Prepare tabs.
- Added component coverage for Home, Preview, and Device, plus real Desktop
  and Web flows proving a Preview-tab `Ctrl+Z` does not restore history and
  that returning to Prepare preserves and re-enables the Worker-owned entry.
- Focused tests passed 16/16; `pnpm test` passed (419 slicer-app tests) and
  `pnpm typecheck` passed. Desktop E2E passed 30 with 3 existing skips;
  threaded Web E2E passed 5/5; serial Web E2E passed 5/5. No WASM rebuild was
  required because the change is shared TypeScript only.

### Repair 4 execution record — asynchronous restore projection barrier

- Changed the restore coordinator contract so its projection callback returns a
  Promise and the shared `restoring` phase remains active until that Promise
  completes. Snapshot suppression and slice invalidation now cover the whole
  model/renderer projection window, and projection failures clear suppression,
  return to `idle`, and retain the surfaced error.
- Replaced the Workspace's effect-only pending context handoff with one
  revision-fenced projection path: it reads the restored structure, refreshes
  the model revision, awaits the actual `GLVolume` replacement/clear for that
  revision, updates the Object List and complete plate session, applies plate
  transforms, and only then projects selection and gizmo state.
- Added a GL mesh revision waiter resolved by the real `useModelLoader` replace
  or clear point and rejected on load failure or supersession. Deterministic
  coordinator tests cover the old early-idle failure, joined second restore,
  superseded revisions, and projection failure cleanup.
- Focused restore tests passed (7/7), full `pnpm test` passed (workspace:
  8 packages; 414 slicer-app tests), and `pnpm typecheck` passed. Desktop E2E
  passed 30 with 3 existing skips; threaded Web E2E passed 5/5; serial Web
  E2E passed 5/5. No WASM quick build was required because this repair changes
  only shared TypeScript restore/viewport projection code and leaves the C++
  submodule's pre-existing dirty state untouched.
- Root acceptance is intentionally not recorded in this execution record.

### Repair 5 execution record — directional menu jump targets

- Added an explicit `undo`/`redo` direction to the Worker jump contract. The
  renderer now passes the menu direction with the opaque entry ID; it no longer
  performs adjacent-entry arithmetic across stale evictions.
- Core Undo jumps resolve the selected project operation to the nearest prior
  project frame, while Redo jumps restore the selected operation's after-state.
  Both directions require a retained, non-baseline project operation and
  reject opposite-side and unknown/evicted IDs. The public
  Worker/client jump method requires its direction; the legacy headless
  exact-jump helper remains available only for native fixture diagnostics, and
  the bridge requires an explicit direction.
- Added native and Worker protocol regressions for top Undo changing the model,
  older Undo removing the selected and later operations, Redo across an
  interleaved context frame, context-ID rejection on both sides of the cursor,
  missing-direction rejection, and stale/opposite-direction rejection.
  Toolbar coverage verifies that Undo and Redo menu items send their matching
  direction.
- Focused protocol/UI tests passed, the standalone native ProjectHistory test
  passed, full `pnpm test` passed (416 slicer-app tests and 110 slicer-wasm
  tests), and `pnpm typecheck` passed. The dual `scripts\\build-windows.bat
  quick --variant both` build and dual `scripts\\build-windows.bat smoke
  --variant both` smoke suite passed. Desktop/Web E2E remains a root gate.
- Supplemental eviction coverage now captures a real retained project entry
  ID before a deterministic small-budget eviction, and proves both directional
  prepare/jump calls reject that evicted ID while a retained ID still jumps.
  The real bridge smoke now exercises the complete directional matrix in both
  serial and threaded WASM artifacts: top Undo changes the model, an older
  Undo reaches the preceding project state, Redo restores the selected
  after-state, and opposite-direction plus branched stale IDs are rejected.
- Root acceptance is intentionally not recorded in this execution record.

### Repair 6 execution record — exhaustive deterministic byte accounting

- Replaced the payload-size-only `ProjectHistory::bytes_used()` estimate with
  deterministic retained-allocation accounting. It now includes the active
  `Impl` allocation, `states` and interval vector capacities, per-state
  mutable/immutable container capacities, context vector capacity, long entry
  labels and mesh keys, shared payload vector capacity, and a fixed
  cross-native/WASM unit for each unique `shared_ptr` payload/control block.
  Shared payloads are deduplicated by retained `Bytes` identity, so repeated
  references do not double count. Canonical fixed upper-bound slots are
  compile-time asserted against the private retained record sizes; observed
  capacities remain the exact variable component, without allocator telemetry.
- Added exact native fixture assertions for payload deltas, empty/short and
  long label/key deltas, shared-payload de-duplication, mutable/interval slot
  deltas, context capacity, optional release, budget boundaries, oldest-first
  eviction, and oversized-operation predecessor retention. The same
  diagnostics are surfaced through the existing Worker status and therefore
  drive optional release and eviction with the identical estimate.
- Orca comparison: upstream `src/slic3r/Utils/UndoRedo.cpp` estimates each
  history object's native representation (`sizeof(*this)`, serialized bytes,
  interval storage) and only charges an immutable shared object while the
  history is its sole owner; it releases optional data and least-recently-used
  snapshots. Neo keeps that behavior boundary but is deliberately stricter
  for a cross-host contract by charging all history-retained capacities,
  context/labels/keys, and one fixed shared allocation/control-block unit per
  unique payload without allocator-dependent measurements.
- The real serial/threaded history smoke now compares short versus long
  context/label diagnostics, proves metadata overhead beyond the retained
  context payload, and performs Undo/Redo through that same status path.
  Deterministic budget eviction and oversized-entry predecessor coverage
  remains in the native fixture because forcing a 256 MiB boundary in a real
  smoke is impractical. Native ProjectHistory, focused protocol, dual WASM
  quick/history smoke, workspace tests, and typecheck were run after this
  correction; the pre-existing dirty C++ submodule was not modified. The
  already synchronized `doc/high_level_dev_plan.md` and `spec/Grand Plan.md`
  Undo/Redo entries remain marked implemented and accepted.
- Root acceptance is intentionally not recorded in this execution record.

### Repair 3 execution record — canonical dirty projection after restore

- Centralized Worker `HistoryStatus` projection in `projectHistoryStatus()` so
  successful Undo/Redo/jump restores update both history navigation and the
  canonical `useProjectStore.dirty` field, clearing legacy dirty reasons.
- Applied the same projection when a history transaction aborts and its Worker
  status is recovered, while restore failures retain the previous projection.
- Added regressions for save-checkpoint navigation (Undo to clean, Redo to
  dirty), aborted transactions, and failed restores preserving dirty state.
- Focused restore/history-mutation tests passed (9/9); full `pnpm test` passed
  (411 slicer-app tests), and `pnpm typecheck` passed. Desktop E2E passed 30
  with 3 existing skips; threaded Web E2E passed 5/5; serial Web E2E passed
  5/5. No WASM quick build was required because this repair changes only the
  shared TypeScript dirty projection and does not touch the bridge or WASM
  sources.
- Root acceptance is intentionally not recorded in this execution record.

## 14. 2026-09-16 correction — context without standalone revisions

The accepted context policy is stricter than the original Step 3 delivery:

- selecting another object, clearing selection, switching the current plate,
  and equivalent UI-only operations never enter the history coordinator or
  Worker mutation API;
- these operations do not create a revision, move the history cursor, affect
  dirty state, or truncate Redo;
- a genuine project transaction reads the current renderer context when it
  starts, atomically attaches that `beforeContext` to the retained predecessor,
  and stores its `afterContext` with the new project frame;
- Undo/Redo restores context only from genuine project frames, and a new
  project mutation after Undo remains the sole branch-truncation boundary.

The correction removes the Object List selection and plate-navigation context
writers, removes their restore-only snapshot-suppression choreography, and
extends the headless commit boundary so predecessor context refresh and branch
append succeed or roll back together. The public profile-selection boundary is
unchanged.

## 15. 2026-09-16 correction — multi-entry directional jumps

Directional menu navigation accepts any retained entry displayed on the
requested side of the cursor. Sparse Add Plate and Move frames remain
adjacent-only storage optimizations, but they no longer make an older retained
menu entry appear stale:

- the native history store resolves the selected opaque entry ID and direction
  to an ordered path of adjacent restore plans;
- each sparse receipt is applied against its retained predecessor model inside
  the same synchronous Worker command, so archive rematerialization cannot
  invalidate a later step's runtime instance IDs;
- React receives only the final context, status, and full model projection;
  intermediate steps are never published as independent history navigation;
- a failed internal step rolls back the completed path before returning the
  retryable failure, while a failed rollback disables history rather than
  continuing from a partially restored cursor;
- stale, evicted, baseline, and opposite-direction entry IDs remain rejected.

The regression boundary mixes Add Cube, sparse Move, and sparse Add Plate in
one timeline and verifies both an older Undo-menu target and the corresponding
multi-entry Redo target through the native bridge.

## 16. 2026-09-16 correction — empty model restore after a sparse frame

An empty `ModelState` is a complete, valid history target and must not double
as the sentinel for “reuse the live model.” Restore plans now carry that sparse
decision explicitly. In particular, after Add Plate on an empty project and
then Add Cube, Undo materializes the retained empty two-plate predecessor
before applying the Add Plate sidecar context. The plate-session validator
therefore sees the same zero-instance model represented by that context.

The explicit model-presence signal is also used when rebasing sparse steps in a
multi-entry jump, preserving the existing runtime-ID and rollback rules. Native
history coverage fixes the empty-state distinction, the typed client covers the
single-step contract, the real WASM harness covers the native bridge failure,
and the visible Electron flow covers the user-facing sequence.

## 17. 2026-09-16 correction — sparse Move after a full single-step restore

Ordinary Undo, Redo, and adjacent directional jumps preserve the sparse Move
fast path while its retained object, volume, and instance IDs still match the
live model. A preceding full-model restore may rematerialize instances with new
runtime IDs; before applying a model-less Transform receipt, the bridge now
checks those identities and rebases only a stale receipt on its authoritative
retained target model. This keeps normal adjacent Move navigation narrow while
making Add Cube → Move → Undo twice → Redo twice deterministic. The native
history fixture covers rebasing each single-step plan shape, the typed client
covers the sequence, the serial/threaded real-WASM harness reproduces the
runtime-ID boundary, and Electron exercises the visible controls.

## 18. 2026-09-16 accepted redesign — Orca-style stable-object history

The sparse receipts and temporary whole-model restore plan are superseded for
the next implementation. Neo will adapt Orca's timestamped object-version
history: the outer semantic transaction captures the predecessor before its
first write, leaves its current topmost state unarchived, and captures that
state lazily only when Undo first needs a Redo endpoint. Nested mutations join
the same outer entry, so one entry may atomically cover arbitrary multi-object
add, delete, and edit operations.

Restore is in place through reusable native objects. `ModelObject`,
`ModelVolume`, and `ModelInstance` must retain their native IDs on every
history traversal. Because upstream's `ModelInstance` archive does not include
its `ObjectBase`, Neo's bridge history record will retain the ordered instance
IDs and reapply them after `add_instance()` materialization; it will not patch
the pinned upstream submodule or invent a sidecar ID namespace. Same-session
history is not a persistence or compatibility format, so archive/identity
failure is an invariant violation without a legacy or full-model fallback.

The completed restore publishes one stable-ID scene patch rather than a full
React/Three projection. Only changed, added, and removed scene members update;
unchanged GPU resources remain live. Project load, Worker restart, and
graphics-context loss are the only full-rebuild boundaries. History contains
no slicing output. For the first version, every successful Undo or Redo
invalidates derived results for all plates while preserving this incremental
model-scene update path.

The restored `PlateSession` follows the restored model and binds memberships
directly by stable instance ID. It restores historical transforms without
reflow, auto-arrange, or prime-tower computation. Object timestamps and history
intervals prevent unchanged object, volume, instance, plate-session, and mesh
payloads from being serialized again; the existing 256 MiB cap adopts Orca's
optional-data-first then oldest-timestamp eviction ordering. Each entry keeps a
non-authoritative stable-ID scene delta, and a multi-entry jump unions deltas
before publishing one final renderer patch.

Undo/Redo adopts the same asynchronous stop protocol as ordinary model edits:
it immediately advances all plate input revisions, drops renderer-visible
outputs, and requests cancellation without awaiting job completion. A plate
`Print` owns the model copied by `Print::apply`, so a restore that retains the
plate does not modify that Print or race its slice thread. Only deletion of a
plate relies on the already accepted Print tombstone to preserve its Print
until the associated job reaches a terminal state.

Configuration has three non-overlapping history roots: native `Model` owns
object and part overrides, `PlateSession` owns plate overrides, and the
project-only portion of `ProjectConfigOverlay` is a Neo-specific root. The
last remains Undoable even though Orca leaves `PresetBundle::project_config`
outside its Undo stack; global preset selection remains outside Neo history.
Save only marks the current logical timestamp as its checkpoint and never
forces lazy topmost serialization. History menu entries carry explicit before
and after timestamps, so both directional menus load their selected target in
one restore rather than traversing sparse adjacent receipts.

### Stage 2 execution record — stable native identity in the full restore path

- The existing full `ModelState` capture now retains the ordered native
  `ModelInstance` IDs beside each object's native object and volume identities.
  Staging validates the archived `ModelObject` identity, rematerializes volumes,
  and then uses the Neo-owned `InstanceIdentityGraph` across the complete model
  graph so every `ModelInstance` regains its retained native ID after
  `add_instance()`.
- Mutable-object cache reuse, equality, object-version intervals, restore data,
  and deterministic accounting include the retained instance-ID vector. A
  change in any object, volume, or instance identity therefore cannot reuse or
  merge an incompatible object record.
- Plate-session validation now requires its complete stable instance-ID set to
  equal the staged model's set and requires each saved structural position to
  carry the same ID. Restore binds membership, parked, and out-of-bounds state
  directly by those retained IDs instead of mapping to freshly allocated
  identities.
- The serial and threaded real-WASM harnesses pass the exact Add Cube → Move →
  Undo twice → Redo twice sequence with object, volume, and instance IDs checked
  after both Redos. The same harness restores a two-object/three-instance model
  with exact plate membership and exports unchanged painted triangles after a
  full restore. The standalone C++ integration also checks support, seam, MMU,
  and fuzzy-skin facet data; the history/mesh/identity targets pass in both
  variants, as do all 158 slicer-wasm tests and the complete workspace unit
  suite.
- A real-WASM Electron production build passed the reported sequence in a
  visible headed Playwright run with no restore or stale-identity error. The
  affected slicer-wasm and desktop typechecks pass. The repository-wide
  typecheck remains blocked in the unchanged `@orca/platform-contract` package
  because its TypeScript configuration does not declare `ImportMeta.env`.
- This stage does not begin the timestamped history-core migration. The pinned
  C++ submodule remains untouched with its pre-existing dirty state, and root
  acceptance is intentionally not recorded here.

### Stage 3 execution record — timestamped object-version core

- Added the independent Neo-owned `TimestampedHistory` core without changing
  bridge RPC, restore coordination, or UI behavior. Named entries retain
  explicit before/after logical timestamps; an outer operation captures its
  predecessor, the committed topmost state stays uncaptured until Undo needs
  its Redo endpoint, and a new branch discards its former future.
- Snapshot manifests retain stable ordered object IDs while shared object
  archives carry native object timestamps and half-open lifetime intervals.
  Unchanged mutable objects, root byte payloads, and immutable meshes reuse
  their retained allocations; no command receipt, sparse rebase, or legacy
  compatibility path exists in the new core.
- One restore returns the model, plate-session/history context, and
  project-only configuration root together. Save marks only the active logical
  timestamp. Budget pressure releases reconstructable immutable data first,
  then oldest unprotected timestamps, while retaining the current and nearest
  usable navigation state and conservatively invalidating an evicted saved
  checkpoint.
- The deterministic native fixture covers multi-object add/move/delete and a
  non-adjacent direct restore, archive sharing, atomic three-root restore, lazy
  topmost capture, allocation-free Save, branch truncation, and budget/checkpoint
  behavior. The new target and the existing ProjectHistory, mesh-capture, and
  identity targets pass as actual serial and threaded wasm64 executables. Both
  production variants build, both existing bridge-history smokes pass, and all
  158 `@orca/slicer-wasm` tests plus its typecheck pass.
- The legacy bridge remains on `ProjectHistory`; migration is intentionally
  deferred. The pinned C++ submodule remains untouched with its pre-existing
  dirty state, and root acceptance is intentionally not recorded here.

### Stage 4 execution record — live bridge timestamp migration

- The Worker bridge now uses `TimestampedHistory` for mutation, Undo, Redo,
  direct menu jumps, abort, save-checkpoint, and project-load ownership. An
  outer transaction captures the canonical native model, complete plate
  session/history context, and project-only overlay roots at its predecessor;
  commit creates only the named logical topmost timestamp and leaves its
  archive lazy until a later Undo needs that Redo endpoint.
- Undo lazily captures only an uncaptured live topmost state. Redo and both
  directional history menus restore their selected explicit timestamp in one
  load, so crossing other entries cannot by itself make the selected target
  stale. Restored timestamps remain immutable when selection or active-plate
  context changes, and those UI-only changes neither create entries nor remove
  a retained Redo branch. Abort restores the predecessor after a mutation and
  remains revision-stable when the operation made no accepted change.
- Restore stages the complete model with the stable object, volume, and
  instance IDs delivered in Stage 2, then atomically restores the complete
  plate session and project-only overlay. Plate input revisions are regenerated
  rather than retained as project history, every successful restore invalidates
  all derived slice/preview results, and no slice result is retained by the
  history core. Stage 4 deliberately publishes the existing safe full-scene
  restore impact; incremental renderer `SceneDelta` projection remains Stage 5.
- The obsolete sparse Transform/Add Plate receipts, traversal/rebase restores,
  direct-frame Prime Tower/filament snapshots, and their bridge runtime
  identity fallbacks were removed instead of being preserved as internal
  compatibility paths. Filament and Prime Tower mutations now participate in
  the same three-root timestamp transaction.
- The expanded real-WASM history harness passes Add Cube → Move → Undo twice →
  Redo twice with exact stable IDs; one atomic multi-object add/move/delete
  transaction; multiple Add Plate entries with direct non-adjacent Undo/Redo
  menu targets; UI-only selection and active-plate changes; project-overlay
  restore; result invalidation; and direct timestamp selection after other
  entries are crossed. The serial and threaded quick builds and history/Prime
  Tower harnesses pass, as do the timestamp/identity executables in both
  variants, all 158 slicer-wasm tests, all 581 slicer-app tests, all 67 desktop
  tests, the affected typechecks, and a visible headed real-WASM Electron
  Add Cube/Move/Undo/Redo run.
- The pinned C++ submodule remains untouched with its pre-existing dirty state.
  Renderer delta projection is not included, and root acceptance is
  intentionally not recorded here.

### Stage 5 execution record — stable-ID SceneDelta projection

- Every committed timestamp edge now retains a non-authoritative `SceneDelta`
  derived from its authoritative before/after model roots. It contains the
  sorted stable object, volume, instance, and plate IDs changed by the complete
  outer transaction. Active derivation retains only stable IDs and native
  object timestamps; it never copies serialized mutable-object archives.
  Nested commits still produce one outer entry. A direct history jump unions
  each crossed edge once and publishes the final native object order with the
  single restore response.
- The bridge exposes one typed `orc_get_model_scene_patch` read that accepts
  the affected stable object IDs and returns only their current structure and
  renderable descriptions plus the complete target object order. The request
  also names retained volume resources; only missing geometry buffers are
  returned, once per native volume. Full and targeted renderable descriptions
  carry native object, volume, and instance IDs. Ordinary history commits now
  expose their already computed SceneDelta through the same projection path;
  see [object interaction performance](2026-09-23-object-interaction-performance.md). The
  typed Worker/client boundary validates and copies those targeted buffers;
  application code never calls the Emscripten module directly.
- The shared application validates the complete patch before publication,
  merges it by stable native identity, and publishes the GL collection once.
  Removed and changed volumes are disposed; every untouched `GLVolume` and
  `BufferGeometry` remains the identical live object. Object List selection,
  restored history selection, and authoritative plate transforms now use the
  same stable object/volume/instance IDs rather than positional composite
  strings. Ordinary Undo, Redo, and directional jumps do not call the full
  `getModelStructure`/`getModelMesh` projection route.
- Exact native and renderer fixtures cover nested multi-object add/move/delete,
  bounded delta metadata with no duplicate archive bytes, adjacent Undo/Redo,
  non-adjacent jump union, plate context, targeted real-WASM mesh reads, and
  unchanged-scene identity/geometry preservation. Both serial and threaded
  wasm64 quick builds,
  timestamped-history executables, and real history harnesses pass. The complete
  workspace unit suite passes (158 slicer-wasm, 584 slicer-app, and all host and
  supporting-package tests), the affected package typechecks pass, and a headed
  Electron run against the staged real WASM confirms Undo/Redo stays on the
  direct projection path with zero full-model reloads.
- The pinned C++ submodule remains untouched with its pre-existing dirty state.
  Full renderer projection remains limited to initial project load, Worker
  restart, or explicit renderer/context recovery. Root acceptance is
  intentionally not recorded here.

### Capture efficiency boundary

Timestamp model roots share immutable native object archives instead of copying
their bytes. Each root also owns exact ordered volume and instance transforms;
those transforms override the matrices embedded in the shared base archive on
restore. A transform-only transaction therefore captures no new object archive,
while remaining an ordinary authoritative timestamp snapshot for arbitrary
compound actions, abort, and direct history navigation.

Reuse requires stable child identities, the same immutable mesh owners, native
configuration and painting timestamps, and matching unversioned native metadata.
Zero configuration timestamps from imported objects are valid. Source metadata,
names, material/type, printable and assembly state, origin, layer configuration,
and other archived object fields participate in the proof. Complex unversioned
emboss/text state conservatively takes the complete archive path. Derived
bounding-box caches do not version history and are invalidated on restore.
Project load and successful restore prime the cache from authoritative state;
ordinary history begin/commit preserve it.

SceneDelta derivation retains shared archive identity and exact transform
metadata, so painting or other edits with unchanged object configuration
timestamps still update the correct renderer members without copying archives.
History memory accounting charges each shared archive allocation once.

Successor UI context may consume a typed receipt from the successful operation
instead of reading the complete model and plate session again. The receipt
declares either preserved stable model membership or an authoritative resulting
structure, plus the resulting active plate ID. Add Plate preserves membership
even when its layout reflows transforms, and uses its returned plate ID. UI
selection, gizmo, and project configuration are still sampled when committing;
compound operations without a complete receipt read the native projections.
Failed operations never consume a receipt or publish their renderer result.

Restore uses the same shared archive proof as capture. Within the transactional
staging model, objects whose archive allocation and stable child identities
match the live roots reuse their native object graph and apply the target's
authoritative transform overlays. Only new or changed object archives are
decoded; unchanged painting payloads are not serialized or deserialized during
a Move Undo. The target object order is restored after unused staged objects
are released through the Model ownership API. Validation still precedes live
publication and the existing rollback boundary covers all three history roots.

When every object's archive and child identity is unchanged, restoring transform
overlays invalidates Prime Tower projections while retaining pointer-free
filament-usage summaries. The existing effective-configuration and membership
checks validate those summaries during the next projection read. Changed object
archives conservatively clear the summaries, including painting and per-object
configuration changes. Slice-result invalidation remains independent of these
derived Prepare previews.
When plate settings and configuration are unchanged, only the old/new owning
plates of changed transform overlays lose their projections; untouched plates
retain their already computed tower estimates.

### Stage 6 execution record — asynchronous history and slicing

Threaded history restoration now withdraws renderer slice receipts immediately
and restores the authoritative history state without awaiting slice completion.
The native restore already advances every plate input stamp and calls
`PlateRuntimeRegistry::invalidate_presentations`, which requests cancellation
through each leased Print's atomic cancellation state. The renderer does not
schedule a second global cancel that could hit a later task. Late success,
failure, and rejected promises from an obsolete slice are ignored by the same
active-target stamp check. History never retains native or renderer results.

Serial slicing makes the Prepare workspace inert and disables history buttons,
history menus, shortcuts, and editing menus. A direct restore-coordinator call
returns `slice_busy` without clearing the active slice. The existing client
pre-postMessage guard and native terminal-epoch admission remain the second
boundary for API bypasses. Threaded execution stays editable and has no serial
busy restriction. Runtime execution state is a typed, synchronous local read;
it does not enqueue an RPC behind the serial Worker.

Self-verification includes the complete workspace unit suite and typecheck,
serial/threaded real history harnesses, serial bridge smoke including stale
terminal-epoch rejection, and a fresh visible Electron profile of the exact
45,586,816-byte Odyssey u1 project. The profile independently proves Undo's
response precedes the obsolete slice terminal and that SceneDelta restores the
actual Prepare model positions. The final measured run was Add Plate 39.66 ms,
Move 28.21 ms, active-slice Move 52.19 ms, and Undo 166.02 ms, passing the 100/500 ms
gates. Production builds exclude the new restore-during-slice probe; the
enabled and excluded artifact sentinel checks both pass. The real-project
runner always rebuilds its profile WASM before staging and launching Electron.
Root independently accepted commit `78fba05` on 2026-09-19 after reviewing the
threaded restore and serial admission boundaries. The independent serial bridge
smoke passed, including `slice_busy` and stale terminal-epoch rejection. Root
also ran `pnpm --filter @orca/desktop test:e2e:real-project-profile` with a fresh
WASM build and visible Electron window. That non-mock run loaded the exact
45,586,816-byte `OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf` fixture and
passed the restore-before-obsolete-terminal and actual Prepare-position checks.
It measured Add Plate to visible Undo at 38 ms and active-slice Move to visible
Undo at 46.2 ms. The runner restored production artifacts and passed the
profile-code exclusion check. These are root acceptance results, separate from
the implementation agent's measurements above.
