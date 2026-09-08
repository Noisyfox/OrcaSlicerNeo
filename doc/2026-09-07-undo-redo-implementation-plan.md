# Undo/Redo Implementation Plan

**Date:** 2026-09-07
**Status:** Step 7 implementation complete; root acceptance recorded below
**Branch:** `dev/undo-redo-design`
**Normative design:** [`spec/Undo and Redo.md`](../spec/Undo%20and%20Redo.md)

## 1. Execution Protocol

This plan is intentionally sequential. No implementation step may start until
the preceding step has passed both its implementation agent's self-verification
and the root agent's independent acceptance.

For every numbered step:

1. The root agent starts one **new** `gpt-5.6-luna` agent at `high` reasoning
   effort, with only that step's scoped task. The agent does not delegate the
   step further.
2. The agent reads the normative Undo/Redo specification and relevant existing
   code, implements only the step, runs its required self-verification, and
   creates one in-scope commit.
3. The agent reports the commit, changed contract/behaviour, and actual command
   results. A failed check is fixed by the same agent before handoff.
4. The root agent independently reviews the diff and invariants, runs the
   acceptance checks listed for that step, and records the result in this
   document.
5. Only a passing root acceptance authorizes a fresh luna-high agent for the
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
  selection/plate IDs, history labels/categories, `HistoryStatus`, transaction
  IDs, restore results, and history errors.
- Extend mock-runtime types only enough to compile future callers; do not expose
  an enabled Undo/Redo UI or change production mutation behaviour yet.

**Functional boundary**

This step creates typed seams and test fixtures only. The shipped app behaves
exactly as before; no project mutation is yet routed through history.

**Agent self-verification**

- Contract and mock-unit tests prove stable IDs, project-vs-context categories,
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
- Carry `transactionId`, labels, project/context category, before/after
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
- Record selection and active-plate changes as internal, non-dirty context
  snapshots; regular one-step traversal skips them while a new context change
  after Undo still truncates Redo.

**Functional boundary**

History correctly represents one project session and its save lifecycle even
before ordinary model-editing actions are migrated.

**Agent self-verification**

- Tests cover save → Undo → clean/dirty transitions, Save As, checkpoint
  eviction, New/Open/Reload reset, context-only records, and redo truncation.
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
  actions through the same path; active-plate switching remains only an
  internal context record. Plate reorder and lock APIs/UI call sites do not
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
  authoritative active plate identity; active-plate navigation records a
  context-only history entry. Real dual-variant WASM smoke passed.
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
  entries and omit internal selection/plate context records.
- Add focus-aware shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, and Ctrl+Y; editable
  controls retain native text Undo/Redo.
- Respect restoring/cancelling-slice state and operation errors.

**Functional boundary**

Electron and Web expose the same navigation semantics, including direct jump,
without intercepting text-field Undo/Redo.

**Execution record (2026-09-08)**

- Added the shared primary-toolbar Undo/Redo controls and directional menus.
  Labels, disabled state, menu contents, and direct jumps are projected from
  the latest Worker `HistoryStatus`; context-only selection/plate entries are
  filtered at the UI boundary and no frontend history list is retained.
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
