# Surface Painting Implementation Plan

**Date:** 2026-09-29

**Branch:** `dev/surface-painting-spec` (continue in the current checkout).

**Status:** Sequential implementation in progress. Steps 01-02 accepted; later steps remain gated.

**Authority:** [Surface Painting Architecture](../spec/Surface%20Painting%20Architecture.md), [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md), [Undo and Redo](../spec/Undo%20and%20Redo.md), and [testing guidelines](testing_guidelines.md). This is the one living implementation task document. No parallel phase notes.

## Execution contract

- Execute numbered steps strictly in order. Start a fresh implementation subagent for every new step. Do not start the next step until the parent has independently accepted the previous one.
- Each child reads the designated spec, this step, repository guidance, and relevant ownership documents; implements only its bounded outcome; runs the required self-verification; reports exact commands/results and limitations. Children must not commit, change branches, edit the pinned submodule, launch other agents, or implement later steps.
- The parent reviews the actual diff, inspects affected flows/tests, reruns meaningful acceptance independently, requests repairs from the same step's child where needed, records evidence here, and commits the accepted piece narrowly. A green child report is not parent acceptance.
- Required unavailable or failing checks block that step. Diagnose and repair within authorization; never silently replace real-WASM evidence with mocks. Do not broaden unrelated configuration/build scope.
- Keep incomplete feature entrypoints inaccessible until their required dependencies are accepted. No temporary user-visible controls pretending to work, alternate painting authorities, or permanently skipped tests.
- The parent owns architecture/ABI decisions. Escalate a genuine conflict with the accepted spec, not routine implementation choices. If a step proves too large, split its remaining work into separately numbered bounded steps before executing it; preserve the same sequential gate.

## Fixed integration decisions

- Native owns annotations, selectors, authoritative picking, per-stroke commits and history. The renderer owns presentation/cursor-only BVH. Client/Worker/runtime boundaries remain as specified.
- Commands use session/stroke/revision identities. Camera input is a per-admitted-event viewport/pointer/camera-matrix snapshot; native reconstructs rays and uses authoritative object/instance transforms. Exact typed schemas are fixed by the relevant transport step and reused thereafter.
- Reuse one Worker and WASM module. No wx GUI compilation, extra native worker, session-long exclusive transaction, movement queue, pending-latest move, or new history authority.
- One painting event in flight; busy moves discarded; reliable terminal state; normal release paints its retained endpoint once before commit; Escape restores after the in-flight call and does not paint an endpoint.
- Preserve all six tools and every accepted lifecycle/history/slot policy. Support/seam/fuzzy remain adapter extension points, not extra delivered tools.

## Verification profiles

Every step requires `git diff --check`, child self-review, and parent independent review. Use pnpm; Windows native work uses the repository `.bat` driver, not Git Bash.

- **N:** Native history-core test executable (existing CMake target `timestamped_history_core_test`, enabled by `NEO_PROJECT_HISTORY_TEST`), affected serial quick build, plus `@orca/slicer-wasm` full tests/typecheck before commit. Record the exact configured test-build invocation; do not claim JS tests execute C++.
- **W:** `scripts\build-windows.bat quick --variant serial`, a focused real serial-WASM harness observing the new behavior, affected client tests and package typecheck/full suite before commit. Both variants at integration/handoff, not automatically on every edit.
- **T:** Affected client/runtime/platform package full unit suites and typechecks, plus behavior tests for protocol validation/ownership. Pure type shapes use TypeScript checks.
- **A:** `pnpm --filter @orca/slicer-app test` and `pnpm --filter @orca/slicer-app typecheck`, with focused behavior tests during the edit loop and import/boundary guards where affected.
- **E:** Focused host E2E for the interaction or host seam that lower layers cannot establish, using current native artifacts where the assertion concerns painting. Follow the real-project artifact identity rule.
- **P:** Reproducible benchmark runs with recorded machine/build/fixture identities; distinguish equivalent admitted-input measurements from end-to-end runs that intentionally drop moves.
- **R:** Repository-level `pnpm test`, `pnpm typecheck`, affected-host E2E, both WASM quick builds and required smoke/compatibility checks. Full release matrix only for a release/milestone claim per the guide.

## Ordered work packages

Paths beginning `src/` or `bridge_` below are under `packages/slicer-wasm/`; app paths are under `packages/slicer-app/`. New filenames are designated scope, not evidence that those files already exist.

### 01. Native history navigation floor

**Status:** Accepted by parent. **Depends on:** plan recorded. **Verification:** N.

**Allowed scope:** src/history/TimestampedHistory.{hpp,cpp,test.cpp}.

**Functional boundary:** Add a reversible native navigation floor, without holding an operation open. Reject Undo and direct/jump restores below the floor before lazy capture or any other mutation; clearing the floor restores normal navigation. clear() resets it. Setting an invalid future/nonexistent floor or changing it during an active operation fails without side effects. An evicted floor must not pin old snapshots.

**Acceptance boundary:** Tests exercise Undo, Redo, restore, restore_before/after, rejection with unchanged cursor/entries/save marker/resource counts, clear, active operations, and eviction. No session compaction, bridge ABI, or UI in this step.

### 02. Native editing-session history metadata

**Status:** Accepted by parent. **Depends on:** 01 accepted by parent. **Verification:** N.

**Allowed scope:** src/history/TimestampedHistory.*.

**Functional boundary:** Add one open editing-session identity, entry timestamp, effective-commit latch, and paint/non-paint entry classification. Preserve ordinary begin/commit/abort transactions; do not keep a transaction open for the session. Default existing callers to non-paint. Opening an empty session must retain Redo.

**Acceptance boundary:** Tests prove per-command navigation, interleaved classifications, no-effect/aborted operations not setting the latch, actual commits setting it permanently across Undo and eviction, and rejection of overlapping sessions.

### 03. Native continuous-run compaction

**Status:** Pending. **Depends on:** 02 accepted by parent. **Verification:** N.

**Allowed scope:** src/history/TimestampedHistory.*.

**Functional boundary:** Implement compaction over retained committed paint runs using existing authoritative roots and unioned scene deltas. Preserve intervening non-paint entry identities. Do not cross the current cursor, reconstruct evicted nodes, replay model mutations, or resurrect children. Conservatively invalidate removed saved checkpoints.

**Acceptance boundary:** A/B/config/C/D becomes AB/config/CD with correct before/after roots and deltas; test cross-object runs, mid-history cursor, saved checkpoint removal, no-op runs, and existing byte-budget eviction.

### 04. Atomic history-session closure and native bridge

**Status:** Pending. **Depends on:** 03 accepted by parent. **Verification:** W.

**Allowed scope:** src/history/TimestampedHistory.*; bridge_history.{hpp,cpp}; bridge state and CMake export list.

**Functional boundary:** Wire session open/status/close into the native bridge. Close atomically applies compaction, navigation-floor removal and all-Redo cleanup when the lifetime effect latch is set. No-effect sessions preserve Redo. Expose structured session identity and effective floor; reset on project replacement. Failures must keep the original open session/history usable.

**Acceptance boundary:** Core tests and real-WASM history harness cover close after undo-to-entry, interleaved edits, no-effect opening with preexisting Redo, eviction, stale IDs, and failed close without partial effects.

### 05. Typed history-session transport

**Status:** Pending. **Depends on:** 04 accepted by parent. **Verification:** T.

**Allowed scope:** src/client/history.ts, client types/module/protocol and slicer-runtime Worker/runtime; platform contract where owned.

**Functional boundary:** Expose only the native history-session operations needed by painting. Validate responses and preserve native ownership; add Worker proxy/mock behavior using existing conventions. Filter history navigation targets according to the native floor rather than introducing a parallel stack.

**Acceptance boundary:** Malformed/stale/session-reset replies, Worker dispatch, status projection and ordinary-history regression tests; affected package suites and typechecks. No painting UI.

### 06. Native painting-session and annotation adapter

**Status:** Pending. **Depends on:** 05 accepted by parent. **Verification:** W.

**Allowed scope:** new src/painting/ core files and bridge_painting files; bridge state, CMake exports.

**Functional boundary:** Create session ownership for one object/instance, eligible solid-volume selectors, current tool settings and mmu annotation adapter. Initialize from committed facets; state 0..16 validation. Define explicit begin/sample/end/cancel/read-draft/close commands with session, stroke and revision IDs. Separate temporary selectors from committed model resources; other painting kinds get extension boundaries, not implementations.

**Acceptance boundary:** Real-WASM harness proves activation gates, multi-part scope, load existing painting, single-slot continuation, >16 palette restriction, stale identity rejection, reset/close resource release, and no model/history mutation from opening or draft reads.

### 07. Authoritative native picking

**Status:** Pending. **Depends on:** 06 accepted by parent. **Verification:** W.

**Allowed scope:** src/painting/ native geometry/input adapter.

**Functional boundary:** Reconstruct rays in native from pointer coordinates, viewport and captured camera matrices; resolve closest eligible original volume/facet using current native transforms. Do not consume frontend hit points, face IDs or target-volume hints. Handle misses, mirrored and nonuniform transforms; keep wx/GUI sources out of WASM.

**Acceptance boundary:** Deterministic native/WASM rays hit expected original faces across multiple parts, transforms and misses; reordered frontend indices have no input authority. Invalid/singular input fails without mutating drafts.

### 08. Circle and sphere brush application

**Status:** Pending. **Depends on:** 07 accepted by parent. **Verification:** W.

**Allowed scope:** src/painting/ brush adapter.

**Functional boundary:** Apply pinned TriangleSelector cursor algorithms with mm radius and native interpolation between admitted positions. Snapshot live state/radius per admitted event. Preserve native handling of surface transitions/misses. Implement draft checkpoint cancellation.

**Acceptance boundary:** Tests cover circle versus sphere coverage, radius invariance under zoom, small-brush subdivision, color/erase changes within one stroke, transformed models, and exact restoration after cancellation.

### 09. Triangle brush and whole-object erase

**Status:** Pending. **Depends on:** 08 accepted by parent. **Verification:** W.

**Allowed scope:** src/painting/ tool adapter.

**Functional boundary:** Add native triangle painting and state-zero erase, plus Erase all over current object's solid parts. Erase all is an effective painting operation rather than session rollback; other objects/modifiers remain untouched.

**Acceptance boundary:** Native tests validate original/subdivided triangle behavior, inherited material after erase, all-solid-parts scope, no-effect detection, and one operation result.

### 10. Region fill and native hover candidates

**Status:** Pending. **Depends on:** 09 accepted by parent. **Verification:** W.

**Allowed scope:** src/painting/ fill adapter and draft response.

**Functional boundary:** Add native region candidate and continuous-drag application, edge-angle controls enabled at 30 degrees, 0..90 range and disabled constraint. Candidate revisions are non-mutating; off-model/part changes clear candidates.

**Acceptance boundary:** Tests compare hover candidate with applied set for same inputs/settings, multiple regions in one stroke, disabled edge constraint, stale revision rejection and no history/model mutation from hover.

### 11. World-Z height-range painting

**Status:** Pending. **Depends on:** 10 accepted by parent. **Verification:** W.

**Allowed scope:** src/painting/ height tool adapter.

**Functional boundary:** Use hit world Z through Z+h mm, including intersecting eligible parts of the current object, click and drag. Keep world-axis semantics under object transforms; no numeric Zmin/Zmax workflow.

**Acceptance boundary:** Native tests cover rotated/mirrored/nonuniform objects, multiple solid parts intersecting the band, modifiers excluded, erase and live state changes, misses and cancellation.

### 12. Gap-fill candidate and Apply

**Status:** Pending. **Depends on:** 11 accepted by parent. **Verification:** W.

**Allowed scope:** src/painting/ gap tool adapter.

**Functional boundary:** Port only required patch analysis from pinned Orca into non-GUI adapter code. Preview threshold changes and lowest adjacent state (including zero); Apply covers current object's solid parts as one painting operation.

**Acceptance boundary:** Native tests cover multiple neighboring states, state-zero winner, threshold boundaries, preview/apply agreement, no-op apply, current-object scope and no writes during preview.

### 13. Draft geometry buffers and ownership

**Status:** Pending. **Depends on:** 12 accepted by parent. **Verification:** W+T.

**Allowed scope:** bridge_painting; src/client painting geometry decoder; native buffer helpers.

**Functional boundary:** Publish complete replacement geometry only for changed parts, with facet-state groups and session/revision identities. Keep draft and committed resource IDs separate. Copy/free WASM buffers on success and malformed replies; reuse unchanged parts and dispose replaced renderer-neutral buffers.

**Acceptance boundary:** Real-WASM and client tests prove split geometry/group validity, default-state semantics, unchanged-part reuse, stale responses, malformed buffer cleanup and no original-mesh mutation.

### 14. Per-stroke commit and native derived-state policy

**Status:** Pending. **Depends on:** 13 accepted by parent. **Verification:** W.

**Allowed scope:** bridge_painting, bridge_history and affected native invalidation helpers.

**Functional boundary:** Commit completed selector results atomically as one paint child; final release sample belongs to that child. Cancel restores draft only. Immediate affected-plate invalidation and deferred material/Prime Tower recomputation; close/demand settle once. Recoverable commit failure restores pre-stroke state.

**Acceptance boundary:** Harness proves draft isolation, commit/undo/redo, final endpoint, no-effect strokes, rollback, slice result invalidation, other-plate isolation, no repeated commit at close and derived-state settlement by version.

### 15. Native filament-remap safety

**Status:** Pending. **Depends on:** 14 accepted by parent. **Verification:** W.

**Allowed scope:** bridge_filament and painting-session synchronization.

**Functional boundary:** Validate actual explicit facet states after existing Delete/Merge remap and renumbering, across active and inactive objects. Reject >16 atomically before slot/model changes. Synchronize active selectors on success and history restore; default unpainted material above 16 remains legal.

**Acceptance boundary:** Real-WASM slot/history tests cover invalid final targets with zero partial mutation, legal renumbering, deleted-slot erase, merge, 2-to-1 open-session continuation and undo/redo coherence.

### 16. Complete typed painting client and Worker API

**Status:** Pending. **Depends on:** 15 accepted by parent. **Verification:** W+T.

**Allowed scope:** src/client painting module/types; slicer-runtime and platform contract; mock runtime.

**Functional boundary:** Wire native painting commands through the sole allowed Emscripten client and existing Worker. Typed terminal results, structured errors, transfer ownership and invalidation receipts; no native globals in app. Extend mocks for later UI tests, not as authoritative verification.

**Acceptance boundary:** Affected package suites/typechecks cover every dispatch/result kind, stale/error paths, buffer transfers, native failure propagation and import-direction guards; focused real-WASM command smoke.

### 17. Single-event input controller

**Status:** Pending. **Depends on:** 16 accepted by parent. **Verification:** A.

**Allowed scope:** new slicer-app painting input controller and tests.

**Functional boundary:** Pure controller with at most one painting event in flight. Drop busy moves without queue/latest cache; retain terminal state and release-time endpoint/settings. Escape stops admission and restores after current call. Unexpected focus/capture loss commits once. Pending commit/cancel rejects new presses until fresh press.

**Acceptance boundary:** Deferred-promise tests cover event storms, no replay, terminal ordering/dedup, final sample, live settings snapshots, late responses, stale sessions, failure and fresh-press behavior.

### 18. Application painting session owner

**Status:** Pending. **Depends on:** 17 accepted by parent. **Verification:** A.

**Allowed scope:** new slicer-app painting session store/controller; history projections.

**Functional boundary:** Own session outside viewport lifetime; connect native open/close, history session and input controller. Explicit idle/drawing/ending/cancelling/closing/error states. Cross-object eligible switches preserve session; hidden pages retain it. Per-command project transactions, not a session-long lease.

**Acceptance boundary:** Store/controller tests prove lifecycle, native/renderer failure recovery, same-session target changes, close compaction receipts, history refresh and lack of exclusive transaction while idle.

### 19. Dedicated painting renderer

**Status:** Pending. **Depends on:** 18 accepted by parent. **Verification:** A+E.

**Allowed scope:** viewport painting layer and GLVolume resource integration.

**Functional boundary:** Render only active editing instance and its solid parts using separate draft geometry/materials; suppress ordinary object rendering/input for that mode. Reuse Canvas/camera/original immutable mesh. Refresh at display opportunities with one request in flight, no fixed 30 Hz cap.

**Acceptance boundary:** Resource and viewport tests prove only changed parts replaced, stale replies discarded, state-zero color inheritance, palette refresh without unnecessary geometry work, hidden instances and cleanup on close/reset.

### 20. Cursor and camera routing

**Status:** Pending. **Depends on:** 19 accepted by parent. **Verification:** A+E.

**Allowed scope:** viewport painting cursor/pointer wiring and camera controls.

**Functional boundary:** Frontend BVH serves cursor only. Render mm brush radius; native-only region hover. Idle left-over-model paints, empty-left or modifier-left rotates, middle/right pans, wheel zooms. Lock camera during strokes; camera-owned gesture never switches to paint.

**Acceptance boundary:** Interaction tests and focused Electron E2E prove pointer ownership, camera mappings, no ordinary body drag, scaled cursor, native hover candidates and reliable capture/release/cancel.

### 21. Multi-material painting panel

**Status:** Pending. **Depends on:** 20 accepted by parent. **Verification:** A+E.

**Allowed scope:** GizmoToolbar and dedicated shared painting panel.

**Functional boundary:** Follow existing gizmo panel styling/layout. Six named tool controls, first-16 palette, Radius mm, Height mm, edge detection/angle and gap threshold/Apply, explicit Erase, Erase all. Shift erase and modifier-wheel only; no letter/digit tool shortcuts. Persist numerical settings per app run and selected filament per project.

**Acceptance boundary:** Component tests exercise each control and command, ranges/defaults, active-stroke tool switch rejection, live color/erase/radius, text-input shortcut isolation and no project/history writes for UI settings.

### 22. Single-gizmo activation and history navigation

**Status:** Pending. **Depends on:** 21 accepted by parent. **Verification:** A+E.

**Allowed scope:** SceneInteractionController/GizmoToolbar integration; history UI/navigation.

**Functional boundary:** Activate painting only through native/runtime admission; normal close before another gizmo, refusal prevents activation. Enforce open-session floor and retained history in buttons and menu jumps. Keep transforms in their own gizmos.

**Acceptance boundary:** Shared tests plus focused E2E prove no concurrent gizmos, switch during stroke ignored, failed close retains painting, undo at floor remains open, eviction boundary, close/reopen no child-history resurrection.

### 23. Unified command admission and navigation

**Status:** Pending. **Depends on:** 22 accepted by parent. **Verification:** A+E.

**Allowed scope:** project mutation entrypoints, ObjectList and page navigation.

**Functional boundary:** Before any dialog/queue, reject all unrelated project mutation commands during unfinished/pending strokes. Idle eligible selection switches preserve session; invalid selection/Preview closes; Home/Device hides. Target topology/delete commands close first; general config edits remain chronological separators.

**Acceptance boundary:** Tests cover import/duplicate/arrange/plate/config/slot entrypoints, no queued execution, selection clear/switch, page lifetime and close failure. Focused host command path proves gate is not button-only.

### 24. Save/export/project lifecycle integration

**Status:** Pending. **Depends on:** 23 accepted by parent. **Verification:** A+E.

**Allowed scope:** project save/export/open/new and normal host exit entrypoints.

**Functional boundary:** Idle Save/Export preserve expanded history and committed-only data; do not split paint runs. New/Open/normal-exit dialogs precede close; cancellation preserves session. During strokes ignore these commands before dialogs. Preserve existing saved-marker policy.

**Acceptance boundary:** Shared tests plus affected Electron/Web seams prove cancel/save failure, successful continuation, normal exit, export validity, save-at-mid-run compaction and absence of draft persistence.

### 25. Slicing and derived-state integration

**Status:** Pending. **Depends on:** 24 accepted by parent. **Verification:** W+T+E.

**Allowed scope:** slice command/runtime admission and native/app projection synchronization.

**Functional boundary:** User Slice closes/settles first. Threaded ongoing slice survives entry and is cancelled only by effective edits to affected plates; no automatic replacement. Serial busy admission rejects immediately without killing Worker or queueing.

**Acceptance boundary:** Real-WASM/runtime tests plus one host journey prove affected/unaffected plate behavior, obsolete-result rejection, serial busy denial, deferred projections on demand/close and failure preventing slice.

### 26. Filament UI and external history reconciliation

**Status:** Pending. **Depends on:** 25 accepted by parent. **Verification:** A+W.

**Allowed scope:** filament session projection and painting session/palette integration.

**Functional boundary:** Follow logical selected filament through remap; fallback to slot 1 when unavailable or outside palette; New/Open resets. Reconcile selectors/draft after non-paint history restores and slot operations; cross-object paint history remains ordered.

**Acceptance boundary:** Shared and real-WASM integration tests cover slot deletion/merge/undo while open, one-slot continuation, >16 project rack, interleaving, current-project palette lifetime and ordinary rendering after close.

### 27. Reproducible functional fixtures and native interoperability

**Status:** Pending. **Depends on:** 26 accepted by parent. **Verification:** W.

**Allowed scope:** painting fixture builders/smoke harness in slicer-wasm; existing fixture conventions.

**Functional boundary:** Add deterministic multi-part/transformed/segmented cases and fixed real-project acquisition. Validate all six tools, independent future-annotation channels, saved 3MF round trips and actual multi-material slicing with committed facets. New instrumentation must compile out of production.

**Acceptance boundary:** Fixture regeneration/manifest checks; comprehensive serial painting harness and actual import-paint-save-reload-slice checks. Verify production instrumentation absence and no changes to pinned submodule.

### 28. Primary desktop painting acceptance journey

**Status:** Pending. **Depends on:** 27 accepted by parent. **Verification:** E.

**Allowed scope:** apps/desktop/e2e and test-gated probes only where necessary.

**Functional boundary:** Real native painting journey plus focused desktop menu/dialog seams. Assert authoritative model/facet/history outcomes rather than generic pixel change. Include event dropping, final endpoint, mixed-history closure and cancellation.

**Acceptance boundary:** Run focused current-artifact Electron E2E, verify artifact/load identity and all named cases; fix within earlier accepted contracts, not weaken assertions.

### 29. Web and WASM-variant seams

**Status:** Pending. **Depends on:** 28 accepted by parent. **Verification:** W+E.

**Allowed scope:** apps/web/e2e and real runtime harness selection.

**Functional boundary:** Prove real desktop Web painting in primary variant and focused alternate-variant session/paint/save/slice path; test resource deployment, downloads, runtime admission and serial behavior. Keep common exhaustive logic in lower layers.

**Acceptance boundary:** Web real tests, both native quick builds, comprehensive primary harness and alternate startup/painting smoke; production build guard and non-root seam where affected.

### 30. Benchmark corpus and measured baseline

**Status:** Pending. **Depends on:** 29 accepted by parent. **Verification:** P.

**Allowed scope:** repository-owned painting benchmark runner and compile-time gated diagnostics.

**Functional boundary:** Implement generated-size/part/subdivision tiers plus fixed real projects on current Windows reference machine. Record environment, admitted/dropped events, native/transfer/GPU/terminal/history/close costs and peak memory; compare same-machine pinned Orca where executable available.

**Acceptance boundary:** Run repeatable trials and save results/method in this living task doc or machine-readable test artifacts. Do not fabricate missing Orca numbers or choose release thresholds silently; report measured limitations and obtain user decision if required.

### 31. Final regression and specification handoff

**Status:** Pending. **Depends on:** 30 accepted by parent. **Verification:** R.

**Allowed scope:** affected packages, hosts, build variants; this task doc and authoritative roadmap only for delivered scope.

**Functional boundary:** Resolve remaining defects through the responsible step's agent or a new narrowly scoped repair step. Run repository and release/milestone gates appropriate to claiming all six tools delivered. Reconcile spec with actual implementation and document all evidence.

**Acceptance boundary:** Root test/typecheck, both WASM quick/smoke, required real desktop/Web journeys and compatibility/performance evidence per testing guide. No feature-complete claim with a required gate failing/unrun; update roadmap only for actually accepted delivery.

## Execution ledger

Record each step's child identity, self-verification, parent verification/review, acceptance decision and commit here. Pending steps must not be described as delivered.

| Step | Child | Self-verification | Parent acceptance | Commit |
| --- | --- | --- | --- | --- |
| Plan | Parent planning | Documentation only | Links/commands checked; diff check passed | Initial plan commit |

### Step 01 acceptance — native history navigation floor

Child: `/root/painting_step_01` (`gpt-6-luna`, max). Scope remained the three
TimestampedHistory source/header/test files. Parent reviewed early guards across
Undo and direct/menu restore paths and confirmed eviction does not pin the floor.
Graph coverage misses the standalone C++ main test, so acceptance used the actual
native test executable and source assertions rather than graph test counts.

Child verification: existing serial CMake target rebuilt with
`cmd.exe /d /c "call D:\emsdk\emsdk_env.bat >nul && D:\ninja\ninja.exe -C packages\slicer-wasm\.work\serial\build timestamped_history_core_test -j 8"`;
`node packages/slicer-wasm/.work/serial/build/timestamped_history_core_test.cjs`
passed. Serial quick build, full slicer-wasm suite (193 tests/8 files), typecheck,
and diff check passed. These local toolchain paths are recorded execution evidence,
not a new repository setup requirement.

Parent independently ran:

- `pnpm exec node packages/slicer-wasm/.work/serial/build/timestamped_history_core_test.cjs` — passed.
- `scripts\build-windows.bat quick --variant serial` — passed/current target verified.
- `pnpm --filter @orca/slicer-wasm test` — 193 tests/8 files passed.
- `pnpm --filter @orca/slicer-wasm typecheck` — passed.
- `git diff --check` — passed.

Parent requested a fixed-allocation accounting guard. It exposed `sizeof(Impl)`
as 280 bytes versus the old 256-byte slot; child corrected the slot and added a
compile-time assertion, then rebuilt/retested native targets. Parent reran the
final native test and quick build. No UI/ABI changed; host E2E and the second WASM
variant are intentionally reserved for their integration gates. Step 01 accepted.

### Step 02 acceptance — native session metadata

Child: `/root/painting_step_02` (`gpt-6-luna`, max). Added native session identity,
entry boundary, effective-commit latch, and paint/non-paint operation classification;
existing callers stay non-paint and nested operations retain outer metadata. The
parent reviewed compatibility and side effects and required a non-paint-only
commit/Undo regression as well as a retained-entry allocation-size guard. Both
were added and self-verified. Core no-effect operations continue through the
existing caller-controlled abort path; this step did not change that contract.

Child and parent independently passed the serial history-core CJS runner,
`scripts\build-windows.bat quick --variant serial`, the full slicer-wasm suite
(193 tests/8 files), slicer-wasm typecheck, and `git diff --check`. Child rebuilt
the native test target using the same configured command recorded for step 01.
Parent inspected the final native diff and graph-reported impacts; direct C++
test evidence covers graph-unrecognized standalone tests. No UI/bridge ABI changed.
Native canonical slots are compile-guarded at 336 bytes for Impl and 192 bytes
for retained entries (also bounding active Operation). Step 02 accepted.

Accepted step 01 code commit: `3d85d465`.
