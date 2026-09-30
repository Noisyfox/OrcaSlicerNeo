# Surface Painting Implementation Plan

**Date:** 2026-09-29

**Branch:** `dev/surface-painting-spec` (continue in the current checkout).

**Status:** Steps 01-12 implemented and independently accepted; functional delivery qualified 2026-09-30. Quantitative performance thresholds remain awaiting user review.

**Authority:** [Surface Painting Architecture](../spec/Surface%20Painting%20Architecture.md), [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md), [Undo and Redo](../spec/Undo%20and%20Redo.md), and [testing guidelines](testing_guidelines.md). This is the one living implementation task document. No parallel phase notes.

## Execution contract

- All newly started subagents use **gpt-6.1-sol / high**, per the latest user instruction; this overrides the skill default. Already-running agents finish their assigned work on their existing model. Earlier stage 10 onward and the two follow-up children used **gpt-6-sol / high**; stage 09 continued on **gpt-6-astra / medium**.
- Execute numbered steps strictly in order. Start a fresh implementation subagent for every new step. Do not start the next step until the parent has independently accepted the previous one.
- Each child reads the designated spec, this step, repository guidance, and relevant ownership documents; implements only its bounded outcome; runs the required self-verification; reports exact commands/results and limitations. Children must not commit, change branches, edit the pinned submodule, launch other agents, or implement later steps.
- The parent reviews the actual diff, inspects affected flows/tests, reruns meaningful acceptance independently, requests repairs from the same step's child where needed, records evidence here, and commits the accepted piece narrowly. A green child report is not parent acceptance.
- Parent acceptance requires a substantive code review as well as test execution: check design/ownership boundaries, control and data flow, state transitions and concurrency, failure atomicity, resource lifetime, protocol validation, maintainability and avoidable performance costs. Record concrete findings, their resolution and material remaining limits. Passing tests or a graph reporting no affected flows never substitutes for reading the implementation.
- Internal APIs target the current contract only: no older signatures, compatibility aliases or fallback handling for older internal receipts. There are no cross-version internal callers. Business-optional data and external project-file compatibility remain separate concerns.
- Required unavailable or failing checks block that step. Diagnose and repair within authorization; never silently replace real-WASM evidence with mocks. Do not broaden unrelated configuration/build scope.
- Keep incomplete feature entrypoints inaccessible until their required dependencies are accepted. No temporary user-visible controls pretending to work, alternate painting authorities, or permanently skipped tests.
- The parent owns architecture/ABI decisions. Escalate a genuine conflict with the accepted spec, not routine implementation choices. Prefer complete functional stages over microsteps; use internal checklists within the assigned stage. Only create an extra stage for a material independently verifiable boundary.

## Fixed integration decisions

- Native owns annotations, selectors, authoritative picking, per-stroke commits and history. The renderer owns presentation/cursor-only BVH. Client/Worker/runtime boundaries remain as specified.
- Commands use session/stroke/revision identities. Camera input is a per-admitted-event viewport/pointer/camera-matrix snapshot; native reconstructs rays and uses authoritative object/instance transforms. Exact typed schemas are fixed by the relevant transport step and reused thereafter.
- Reuse one Worker and WASM module. No wx GUI compilation, extra native worker, session-long exclusive transaction, movement queue, pending-latest move, or new history authority.
- One painting event in flight; busy moves discarded; reliable terminal state; normal release paints its retained endpoint once before commit; Escape restores after the in-flight call and does not paint an endpoint.
- Preserve all six tools and every accepted lifecycle/history/slot policy. Support/seam/fuzzy remain adapter extension points, not extra delivered tools.
- Follow the user's implementation reference: pinned Orca `TriangleSelectorGUI` and `TriangleSelectorPatch` in `GLGizmoPainterBase.{hpp,cpp}`, alongside base `TriangleSelector`. Reuse their selection/neighbor/update semantics through non-GUI adapters; separate candidate selection, paint-state change and render invalidation. Native owns candidate membership/contours even for same-color hover. OpenGL/wx resources stay outside WASM; NEO transports geometry to the dedicated React renderer.

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

**Status:** Accepted by parent. **Depends on:** 02 accepted by parent. **Verification:** N.

**Allowed scope:** src/history/TimestampedHistory.*.

**Functional boundary:** Implement compaction over retained committed paint runs using existing authoritative roots and unioned scene deltas. Preserve intervening non-paint entry identities. Do not cross the current cursor, reconstruct evicted nodes, replay model mutations, or resurrect children. Conservatively invalidate removed saved checkpoints.

**Acceptance boundary:** A/B/config/C/D becomes AB/config/CD with correct before/after roots and deltas; test cross-object runs, mid-history cursor, saved checkpoint removal, no-op runs, and existing byte-budget eviction.

### 04a. Atomic native history-session closure

**Status:** Accepted by parent. **Depends on:** 03 accepted by parent. **Verification:** N.

**Allowed scope:** src/history/TimestampedHistory.{hpp,cpp,test.cpp}.

**Functional boundary:** Close the identified session atomically: compact applied paint runs, discard every Redo entry/checkpoint if the lifetime effect latch is set, and remove the navigation floor/session. A no-effect session preserves Redo. Keep the current model timestamp and roots unchanged. Reject stale IDs or active operations without side effects; allocation failure retains the entire original open session/history. Reuse staged compaction rather than duplicating its run rules.

**Acceptance boundary:** Core tests cover close at top, after Undo to entry, at a mixed-history cursor, non-paint-only effects, no-effect sessions with preexisting Redo, saved Redo checkpoint removal, eviction, fresh session IDs and rejection. Verify removed children/Redo cannot be restored and prior history becomes accessible after floor removal. No bridge ABI in this step.

### 04b. Native history-session bridge

**Status:** Accepted by parent. **Depends on:** 04a accepted by parent. **Verification:** W.

**Allowed scope:** bridge_history.{hpp,cpp}; bridge state and CMake export list; focused real-WASM history harness; TimestampedHistory source/header/tests for staged response publication.

**Functional boundary:** Wire accepted core session open/status/close into the native bridge. Expose structured session identity and effective floor; reset on project replacement. Validate requests and transaction conflicts before mutation. Prepare the complete success response, including its output allocation, against staged history before publishing open/close. A throwing pre-publication callback must preserve original history/session; publishing and returning the prepared response require no allocations. Do not add painting entrypoints or renderer state.

**Acceptance boundary:** Real-WASM history harness covers opening, floor navigation, no-effect Redo preservation, committed non-paint effect followed by Undo/close, project reset, stale IDs, and failed close without partial effects. Native core tests retain responsibility for paint-run details until painting commands exist.

## Remaining stages — consolidated 2026-09-29

The user requested larger functional stages. Stages 05-07 use **gpt-6-astra / low**, stages 08-09 use **gpt-6-astra / medium**, and the latest model update selects **gpt-6-sol / high** for new children starting at stage 10. Completed steps 01-04b remain accepted. The former 27 pending microsteps are replaced by the eight stages below; their functional requirements and verification gates are retained. Internal checklists are implementation order within one stage, not separate child handoffs. Use one fresh child per stage and accept the complete stage before starting the next.

| New stage | Former coverage |
| --- | --- |
| 05 | 05-06: history transport and native painting-session foundation |
| 06 | 07-12: native picking and all six tools |
| 07 | 13-16: draft transport, per-stroke publication, remapping and Worker API |
| 08 | 17-22: interactive painting gizmo |
| 09 | 23-26: project-command and lifecycle integration |
| 10 | 27-29: functional interoperability and both hosts/variants |
| 11 | 30: measured performance baseline |
| 12 | 31: final regression and handoff |

### 05. History transport and native painting-session foundation

**Status:** Accepted by parent. **Depends on:** 04b accepted. **Model:** gpt-6-astra / low. **Verification:** N+W+T.

**Allowed scope:** slicer-wasm client/history/protocol/mock modules; slicer-runtime Worker/proxy and platform contracts; new native painting core/bridge files, native state and export/build wiring; focused tests/harnesses. No application UI.

**Functional boundary:**

1. Carry the accepted native editing-session open/close/status through typed client and existing Worker/runtime. Validate malformed responses, stale handles and reset metadata; project native floor-filtered history without a second stack.
2. Create native painting-session ownership for one object/instance and all eligible solid volumes, with TriangleSelector/FacetsAnnotation adapter boundaries reusable for future annotation kinds.
3. Initialize selectors from committed MMU facets; enforce state 0..16 and activation gates. Define session/stroke/revision identities, draft lifecycle and command/result schemas consumed by later stages. Opening and draft reads must not mutate model/history.
4. Support eligible target switching, >=2-slot activation, one-slot continuation, close/reset cleanup, and explicit stale/invalid/busy failures. Reserve tool sampling and committing for subsequent stages; do not expose unfinished UI.

**Acceptance boundary:** Full affected client/runtime/platform suites and typechecks, native lifecycle tests and real serial-WASM harness prove activation, loaded annotations, multipart scope, modifier exclusion, malformed/stale requests, floor/status transport, reset and resource release. History smoke still passes. Session open/close must neither retain an exclusive history transaction nor publish painting/model mutations. Typed schemas and native commands are ready for the tool engine.

### 06. Native picking and six-tool engine

**Status:** Accepted by parent. **Depends on:** 05 accepted. **Model:** gpt-6-astra / low. **Verification:** N+W.

**Allowed scope:** native painting geometry/input/tool adapters, focused bridge command wiring and native/WASM tests. Adapt pinned Orca code outside the read-only submodule; no wx GUI build or renderer authority.

**Functional boundary:**

1. Reconstruct rays from per-event pointer/viewport/camera matrices; identify the closest eligible original part/facet using native transforms. Reject invalid/singular inputs without changing drafts. Never consume frontend hit points, face IDs or target-volume hints.
2. Implement circle/sphere with world-mm radius, native interpolation between admitted samples, triangle painting and state-zero erase/erase-all. Keep live per-event color/erase/size semantics.
3. Implement region fill and native hover candidate using the same region algorithm; default edge angle 30 degrees, adjustable 0..90 or disabled. Hover never mutates model/history.
4. Implement height painting from hit world Z through Z+h across intersecting solid parts, under arbitrary supported transforms; click and drag both work.
5. Implement native gap analysis/preview and Apply using threshold and lowest adjacent state, including zero. Apply covers the object's solid parts as one logical painting operation.

**Acceptance boundary:** Native and real-WASM deterministic cases cover all six tools, region preview/apply agreement, gap boundaries/state-zero choice, default-state erase, original-face picking, mirrors/nonuniform transforms, multiple parts, misses, live sample settings, no-effect updates and whole-stroke cancellation. Draft changes remain isolated from committed facets and history. No host event queue or frontend selection fallback.

### 07. Complete painting backend, publication and transport

**Status:** Accepted by parent. **Depends on:** 06 accepted. **Model:** gpt-6-astra / low. **Verification:** N+W+T.

**Allowed scope:** native painting bridge, history/invalidation and filament-remap integration; typed client geometry/protocol, runtime Worker/proxy, platform contract and mocks; relevant native/client tests.

**Functional boundary:**

1. Publish full replacement draft geometry for changed parts only, with facet-state groups and session/revision identities. Reuse unchanged parts; keep draft and committed resource IDs distinct. Copy/free WASM buffers on success, malformed reply and stale response.
2. Atomically commit each effective stroke as one Paint child, including final release sample; cancel restores pre-stroke draft. No-effect produces no entry; recoverable commit failure rolls back the whole stroke. Closing never recommits prior strokes.
3. Invalidate affected plate results immediately; defer expensive material/Prime Tower projections until close or dependency demand. Version settlement so repeated requests do not recompute unchanged state.
4. Apply existing filament Delete/Merge/remap semantics atomically to all actual annotation references. Reject explicit final state >16 before any mutation; default unpainted material above 16 remains legal. Synchronize selectors after successful remaps/history restores.
5. Complete every typed painting command/result/error/transfer through the existing Worker and sole Emscripten client. Mocks support UI tests without replacing native evidence.

**Acceptance boundary:** Real-WASM draft/commit/undo/redo/save resource checks, multi-plate invalidation, mixed-history close, final endpoint, failed commit, slot remap/undo and one-slot continuation all pass. Binary malformed-reply tests prove cleanup; client/runtime/platform full suites and boundary guards pass. Model and native annotation state agree after every restore, cancellation and close.

### 08. Interactive multi-material painting gizmo

**Status:** Accepted by parent. **Depends on:** 07 accepted. **Model:** gpt-6-astra / medium. **Verification:** A+E.

**Allowed scope:** shared app painting controller/store, dedicated viewport layer and resources, cursor/camera routing, gizmo toolbar/panel, history controls; focused component/controller and Electron tests. Follow existing gizmo styling and the accepted spec.

**Functional boundary:**

1. Implement a pure single-event-in-flight input controller: discard busy moves without a queue/latest cache; preserve reliable terminal actions. Normal release retains endpoint/settings; Escape waits for the active call then restores; unexpected focus/capture loss commits once. Reject presses while ending/cancelling until a fresh press.
2. Own painting session above viewport lifetime, with idle/drawing/ending/cancelling/closing/error states and short per-command transactions. Eligible target switches preserve session; hidden pages can retain ownership.
3. Render only the active editing instance's solid parts in dedicated painting mode, suppressing ordinary rendering/body dragging. Use separate draft geometry/materials, changed-part replacement, stale-response guards and disposal. Refresh opportunistically with one display request in flight and no fixed 30-Hz cap.
4. Frontend BVH draws cursor only. Route idle left-on-model to paint, empty/modifier-left to rotate, middle/right to pan, wheel to zoom; lock camera during a stroke and preserve gesture ownership.
5. Provide all six tools, first-16 palette, radius/height/edge-angle/gap controls, Erase/Erase all, Shift erase and modifier-wheel. No letter/digit tool shortcuts. Numeric settings persist for the run; selected filament follows project identity.
6. Enforce one gizmo at a time, including numeric panels; close painting before another activates. History buttons/menu use native floor and retained entries. Failed close keeps painting active.

**Acceptance boundary:** Deferred-promise controller tests prove dropped-move/terminal order, deduplication, fresh-press behavior and failure recovery. App full suite/typecheck plus focused real-WASM Electron journey prove all tool controls, isolated input/render mode, native annotation changes, undo/redo/close, cursor size, camera mapping and resource cleanup. Stroke-time tool switching is rejected; live color/erase/radius remains supported. Other project command/lifecycle seams are the next stage.

### 09. Project commands, lifecycle, slicing and palette coherence

**Status:** Accepted by parent. **Depends on:** 08 accepted. **Model:** gpt-6-astra / medium. **Verification:** A+W+T+E.

**Allowed scope:** project mutation/navigation entrypoints, selection, save/export/new/open/exit, slice admission/runtime, filament UI/session reconciliation and affected host seams.

**Functional boundary:**

1. Reject unrelated mutations during unfinished/pending strokes before dialogs or queues: config, slots, import, duplicate, arrange, plate operations, undo/redo, close, save/export, slice and normal lifecycle commands. Never replay ignored requests later.
2. While idle, valid object switches retain session; invalid selection/Preview closes, Home/Device hides without losing ownership. Target deletion/topology/split closes first. Ordinary config/slot edits stay chronological non-paint separators.
3. Idle Save/Export preserve expanded history and include committed data only; save does not split paint runs. Export settles dependencies and requires valid results without implicit slicing. New/Open/exit ask existing pre-load dialogs first; cancellation/save failure retains session, successful continuation closes before replacement. Open's post-load compatibility-warning cancellation leaves an empty project under the existing Orca/Per-Plate semantics; it does not restore the prior painting session.
4. User Slice closes and settles first. Threaded ongoing slice survives entry and cancels only when effective edits invalidate affected plates; no automatic replacement. Serial busy entry/edit fails immediately without queuing or killing Worker.
5. Reconcile selectors and palette after history/slot changes. Track logical selected filament through remaps, fallback to slot1 when unavailable/outside first16; New/Open resets. Verify active and inactive object references.

**Acceptance boundary:** Shared command-path tests plus focused Electron/Web seams prove the gate is not button-only, no queued work/dialogs during strokes, lifecycle cancellation/failure, hidden viewport ownership, valid export, slice invalidation by plate/runtime variant, slot/history coherence, mixed-operation compaction and saved-marker rules. No concurrent gizmos, draft persistence or extra history authorities.

### 10. Functional fixtures, interoperability and host/variant acceptance

**Status:** Accepted by parent. **Depends on:** 09 accepted. **Model:** gpt-6-sol / high. **Verification:** W+E.

**Allowed scope:** repository-owned deterministic/generated/real painting fixtures and harnesses, desktop/Web E2E, test-gated probes, and necessary bounded defect fixes against accepted contracts.

**Functional boundary:**

1. Own reproducible multipart/transformed/segmented fixtures and fixed real-project acquisition/manifest. Cover all six tools and independent future annotation channels.
2. Verify saved 3MF round trips and actual multi-material slicing of committed facets. Test instrumentation must compile out of production.
3. Run real Electron and desktop-Web painting journeys asserting authoritative annotations/history, event dropping, final endpoint, cancellation, mixed close and lifecycle outcomes.
4. Build both WASM variants; run comprehensive primary harness and alternate startup/painting/save/slice smoke, plus deployment/download/serial admission and production/non-root guards where affected.

**Acceptance boundary:** Current artifact identity is proven for real host tests; fixture regeneration, all named journeys, both native builds and interoperability checks pass. Failures are repaired without weakening assertions or substituting mocks. Record exact host/variant scope; do not yet invent performance thresholds or claim the final release matrix passed.

### 11. Measured performance baseline

**Status:** Accepted by parent as a measured baseline; numeric release thresholds await user review. **Depends on:** 10 accepted. **Model:** gpt-6-sol / high. **Verification:** P.

**Allowed scope:** painting benchmark corpus/runner and compile-time gated instrumentation; benchmark results and methodology for parent documentation.

**Functional boundary:** Measure generated size/part/subdivision tiers and fixed real projects on the current Windows reference machine for Electron and desktop Web. Record environment/artifact/fixture identity, admitted and dropped moves, native/transfer/GPU/terminal/history/close costs and peak memory. Compare same-machine pinned Orca when executable is available. Distinguish equivalent admitted-input comparisons from end-to-end move dropping.

**Acceptance boundary:** Repeated reproducible trials and machine-readable evidence. No fabricated Orca measurements or silently selected release thresholds. Report missing external baseline or required threshold decision explicitly; complete independent measurements before seeking that decision.

### 12. Final regression and specification handoff

**Status:** Accepted by parent on 2026-09-30 for functional delivery; performance limitations remain explicit. **Depends on:** 11 accepted. **Model:** gpt-6-sol / high. **Verification:** R.

**Allowed scope:** affected packages/hosts/variants, required regression fixes and test evidence. Parent owns final living-doc/spec/roadmap updates.

**Functional boundary:** Reconcile delivered behavior with every accepted spec requirement, resolve remaining defects, and run repository/release gates appropriate to claiming all six tools delivered. Record precise remaining limitations and update roadmap only for actual delivery.

**Acceptance boundary:** Root tests/typechecks, both WASM quick/smoke, required real desktop/Web and compatibility/performance evidence, and applicable milestone matrix from testing guidelines. No feature-complete claim with required gates failing/unrun. Parent independent acceptance remains mandatory.

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

Accepted step 02 code commit: `4e7046a7`.

### Step 03 acceptance — continuous paint-run compaction

Child: `/root/painting_step_03` (`gpt-6-luna`, max). Parent reviewed the staged
copy-and-swap implementation, mixed-operation boundaries, retained snapshot roots,
saved-checkpoint invalidation and the unchanged Redo side. Review required actual
entry-vector capacity release, covered by a 40-stroke regression. Native tests also
exposed and fixed restore traversal across a removed interior timestamp: availability
and monotonic-path checks now reject before lazy capture, without looping.

Child and parent independently passed the configured native history target build
and CJS runner, serial quick WASM build, slicer-wasm full suite (193 tests/8 files),
typecheck and diff check. Graph review reported no associated flows/tests; direct
native cases verify AB/config/CD, cross-object deltas, cursor/Redo boundaries,
invalid requests, saved markers, eviction and retained-memory reduction. Step 03
accepted. No bridge/UI change; host/alternate-variant gates remain deferred.

The next work package was split into 04a (atomic core closure) and 04b (bridge and
real-WASM integration), with a separate fresh child and acceptance gate for each.

Accepted step 03 code commit: `2444e37e`.

### Step 04a acceptance — atomic native session closure

Child: `/root/painting_step_04a` (`gpt-6-luna`, max). Parent inspected staged
compaction reuse, lifetime-latch Redo cleanup, navigation-floor release and saved
marker handling. Tests cover mixed history, full Undo, non-paint-only commits,
no-effect Redo preservation, eviction, stale IDs, operation conflicts and fresh
session identities. A requested regression directly verifies metadata capacity
and bytes released by Redo-only cleanup. Allocation failure was not fault-injected;
exception safety was reviewed from the staged ownership and final swap boundary.

Child rebuilt and passed the native history-core target/runner, serial quick build,
full slicer-wasm tests (193/8 files), typecheck and diff check. Parent independently
reran the native runner, serial quick build, full package tests, typecheck and diff
check, all passing, and reviewed the actual diff after graph change detection.
Only the three native history files changed. Step 04a accepted; bridge coverage is
the separate next gate, with host and alternate-WASM validation still deferred.

Accepted step 04a code commit: `f774b555`.

### Step 04b acceptance — native session bridge and publication

Child: `/root/painting_step_04b` (`gpt-6-luna`, max). Native ABI is
`orc_history_session_open("{}")` and
`orc_history_session_close({sessionId, label?})` (JSON-encoded argument).
Opaque IDs are canonical `hs-<positive uint64 decimal>` strings. Status adds
`editingSession: {id, entryTimestamp, hasEffectiveCommit} | null` and
`navigationFloor: number | null`; Undo entries and labels respect the reachable
session floor. Open/close advance the history metadata revision, without model or
plate mutation. Existing clear/reset paths invalidate sessions without reusing IDs.

Parent review found and required two repairs: rejecting embedded-NUL ID suffixes,
and preparing success JSON plus its output allocation before publishing history.
Core pre-publication callbacks now provide the staged read-only candidate; a thrown
callback preserves live history. Native fault tests cover failed open/close, and
the real bridge harness verifies prepared status matches the published state.
No extra CMake exports were needed: real calls verify EMSCRIPTEN_KEEPALIVE retention.

Child and parent independently passed:

- `scripts\build-windows.bat quick --variant serial`.
- `pnpm --filter @orca/slicer-wasm history-editing-session-smoke`.
- `pnpm exec node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`.
- Native history-core CJS runner, full slicer-wasm tests (193/8 files), typecheck and diff check.

The existing history smoke had a stale scene-patch request missing the required
`known_paint_keys: []`; that one fixture field was repaired to match both current
native and client contracts, without weakening production validation. Parent
reviewed actual changes after graph analysis. Step 04b accepted; no app UI or
typed transport is claimed yet.

Accepted step 04b code commit: `55efbe0a`. Consolidated stage/model policy commit: `570886c6`.

### Stage 05 acceptance — transport and native session foundation

Child: `/root/painting_stage_05` (`gpt-6-astra`, low). Delivered strict typed history
session transport through the existing Worker/runtime, a native MMU selector owner
with stable object/instance/volume identities, staged target switching, lifecycle
ABIs and schemas. Native lifecycle commands use version 1, opaque `ps-` session
handles and numeric revisions; metadata includes per-part draft resource identity.
No painting samples, commits, complete painting transport or application UI yet.

Parent code review traced Worker dispatch/admission and native open/target/read/
close/reset paths. Reviewed shared immutable mesh ownership and selector destruction
order, absence of raw model pointers, original annotation preservation, stale target
checks, prepared-response publication, strict handles and floor projections. App
changes are required status-fixture updates only; no app implementation boundary
was bypassed. Graph reports no indexed flows, so actual source review and executable
evidence supplied the missing coverage.

Review required repairs before acceptance:

- Saved Redo checkpoint removal in the mock now clears its saved cursor as native does.
- Session transitions previously bypassed a pending Worker Undo/begin. A short
  pre-await transition guard now rejects overlaps without queuing or holding a lock
  for the editing session. Only its owning request releases the guard, also repairing
  duplicate-begin rejection that cleared another request's start flag.
- Deferred hook/module initialization tests prove rejected requests do not reach
  native, Undo retains its floor, guards release on errors, and idle sessions still
  allow ordinary project edits. Native admission also checks core operation activity.

Child full verification passed: root tests/typecheck; final slicer-wasm suite
(221 tests/9 files), runtime suite (35/5), native painting-session and history-core
builds/runners; serial quick build; painting-session, history-editing-session and
existing history smokes; diff check.

Parent independently passed root tests and typecheck (including app 679 tests,
runtime 35, platform 15), both native runners, serial quick build and all three
real-WASM smokes. After the concurrency repair, parent reran affected wasm/runtime
suites, the final 28-case history-session protocol test file, root typecheck and
final serial build/painting lifecycle smoke. The existing generated painted fixture
emits missing-parent profile diagnostics on import; authoritative lifecycle and
annotation assertions pass. No threaded/host E2E claim is made at this stage.

Stage 05 accepted. Automatic selector reconciliation after restore/remap remains
stage 07/09 scope; current native reads reject stale targets and explicit target
rebind reconstructs selectors. Tool sampling and geometry/per-stroke publication
remain stages 06/07, with no unfinished UI exposed.

Accepted stage 05 code commit: `ca8fdf82`.

### Stage 06 acceptance — native picking and six tools

Child: `/root/painting_stage_06` (`gpt-6-astra`, low). Native AABBMesh picking
reconstructs rays from camera input and resolves original faces through native
instance/volume transforms. Circle/sphere, triangle, region, world-Z height, gap
fill and erase operate on isolated selector drafts. Stroke finish enters an
explicit pending state; cancel/discard restores its predecessor. No Model/history
publication or UI is claimed in this stage.

Parent source review compared the adapter with pinned TriangleSelector cursor,
bucket-fill, height and serialization implementations and TriangleSelectorGUI/
TriangleSelectorPatch in GLGizmoPainterBase.hpp/.cpp. Mapped render invalidation,
seed-fill membership/contours and patch analysis independently from GPU ownership.
The non-GUI gap port preserves the source's strict threshold, area arithmetic,
neighbor propagation and lowest-state choice, including zero.

Parent review required these changes before acceptance:

- Replaced partial internal-vector cloning, which omitted private selector free
  lists, with supported canonical serialization/deserialization reconstruction.
- Made per-event isolation lazy by touched part and cached pre-stroke comparison
  data. Misses and untouched parts retain selector identity; routine command
  receipts do not scan full facet counts.
- Preserved region candidate membership/contours even for same-state/NONE hover;
  gap fragments are separate from prospective assigned colors.
- Rejected direct history-session closure while a painting draft is drawing or
  finished, before any history mutation. Validated off-viewport misses before
  unbounded interpolation and synchronized TypeScript lifecycle schemas.
- Added acceptance cases for perspective depth/original-face picking, combined
  rotated/nonuniform/mirrored world-Z bands, competing nonzero gap neighbors,
  selector subdivision/undivision/repaint, and untouched-part identity.

Child passed root tests/typecheck, full slicer-wasm suite (221/9 files), native
painting and history runners, final serial quick build, both painting smokes and
both history smokes. Parent independently reviewed the final implementation/test
diff, passed the native painting/history runners, final serial quick build,
painting-engine smoke, painting-session smoke, history-editing-session smoke,
full slicer-wasm tests/typecheck and diff check. Existing history smoke and root
checks were child-verified for this stage; earlier parent root checks remain
recorded at stage 05. Fixture import profile-parent diagnostics are unchanged.

Stage 06 accepted. Allocation failure was not injected; abandoned-candidate
tests and staged response-before-publication ownership establish its isolation.
Geometry export, per-stroke publication, native remap reconciliation and full
typed painting transport remain stage 07. GPU rendering, both-host journeys and
threaded qualification retain their later gates; no performance threshold claim.

### Stage 07 acceptance — publication and transport

Child: `/root/painting_stage_07` (`gpt-6-astra`, low). Parent accepted the complete
backend after substantive source review and independent execution. Following the
user's model selection at that acceptance, stages 08-09 use `gpt-6-astra / medium`; the later selection for stages 10-12 is recorded above.

Native commands now export per-part P3N3 geometry, state groups and independent
region/gap candidate manifests; publish each effective stroke as one Paint entry;
restore idle selectors after Undo/Redo and slot remaps; and invalidate affected
plate stamps immediately. Material-use and Prime Tower settlement is read-only,
versioned and demand/closure driven. Ordinary readers outside the painting session
and inside external transactions retain their existing authoritative behavior.
Complete typed client/Worker methods and protocol mocks are available for stage 08.

Parent review required and verified these corrections:

- Stage history begin/commit before publication, including success-response
  allocation, so failure preserves Redo, timestamps, save markers and memory
  accounting. Immutable archives remain shared; changed volumes alone are backed
  up for model rollback. No fallible work follows successful history publication.
- Replace unsafe payload-address frees with native request-owned geometry leases.
  Stale or malformed geometry with an intact lease releases actual allocation
  bases. Duplicate release and release after session closure are safe. A corrupted
  lease token cannot identify ownership and is rejected without speculative frees;
  such unidentified allocations remain native-owned until module teardown.
- Generate state buckets in one leaf traversal and visit gap membership directly;
  reuse unchanged draft/candidate resources. Session-monotonic generations prevent
  stale geometry after target A/B/A switching or mesh replacement. Explicit active
  candidate manifests distinguish retained overlays from cleared hover.
- Validate request/response identities, phase/stroke consistency, geometry ranges,
  group coverage and recovery receipts. Preserve same-color candidate membership.
- Include annotation-only history restores in affected-plate invalidation; enforce
  the 16-state limit against actual remapped annotation references before mutation.
  Keep unpainted high-slot defaults and one-slot continuation legal.
- Keep settlement separate from persisted Prime Tower coordinate normalization;
  closure adds no new project edit. Metadata-only history open/close does not cause
  repeat settlement. Mock region/gap preview-to-commit paths match native lifecycle.

Parent independently passed `scripts\build-windows.bat quick --variant serial`,
both `painting_session_test.cjs` and `timestamped_history_core_test.cjs` through
`pnpm exec node`, `pnpm --filter @orca/slicer-wasm painting-backend-smoke`,
`pnpm --filter @orca/slicer-wasm history-editing-session-smoke`, full slicer-wasm
tests (245 tests/10 files), slicer-runtime tests (35), platform-contract tests (15),
root `pnpm typecheck`, and `git diff --check`. Backend smoke proves draft isolation,
final endpoint, commit/Undo/Redo/exported annotations, affected/unaffected plates,
injected failure rollback, mixed-history close, remap/Undo, 18-slot reference
rejection, legal unused-source remap, one-slot continuation and lease lifetime.
Child additionally passed root `pnpm test`, platform import guard, engine/session
smokes and existing full history smoke; all five real-WASM smokes exited zero.
Existing fixture profile-parent diagnostics remain visible and do not invalidate
their assertions. Fault injection is compiled only with `NEO_PROJECT_HISTORY_TEST`.

Stage 07 accepted. Interactive rendering, global application command admission,
both-host/both-variant qualification and measured performance retain stages 08-12.

### Stage 08 acceptance — interactive MMU gizmo

Stage 07 code commit: `ae6df0da`. Child: `/root/painting_stage_08`
(`gpt-6-astra`, medium). Parent accepted after source review, independent tests
and actual rendered screenshot inspection.

The user's directory and naming decisions are implemented in
`packages/slicer-app/src/components/workspace/viewport/gizmo/painting/`:
`PaintingGizmoBase` owns shared input/cursor/resource drawing and accepts a colour
adapter; `MmuPaintingGizmo` owns MMU filament mapping; `MmuPaintingPanel` supplies
the six-tool UI. `PaintingProvider` remains mounted at the application root.

The controller serializes native input, display and history transitions in one
RPC lane. Busy moves are discarded; normal release retains its endpoint/settings;
Escape and capture/focus interruption follow their separate terminal semantics.
Dedicated painting uses the existing Canvas and camera, draws only eligible
active-instance parts, borrows original geometry for cursor-only BVH, and never
builds a BVH on subdivided geometry. Idle native hit results select painting or
empty-space rotation. Changed geometry and candidate resources are reused/disposed
by explicit manifests. Other gizmos close painting first, including numeric panels.

Parent review required and verified these fixes:

- Reject selection changes during target/open/close transitions, allowing explicit
  history restoration, to prevent the object list and native target diverging.
- Explicitly dispose contour materials as well as externally owned geometries.
- Disable residual camera damping while painting and synchronize on exit; camera
  pose/target remains unchanged across closure within floating-point tolerance.
- Preserve selection through the committed-geometry handoff between the DOM and
  Canvas React roots until Canvas observes the authoritative replacement collection.
- Correct native gap display to use each candidate's prospective destination colour
  while retaining original facet membership. Prospective selector topology can
  renumber leaves, so membership indices cannot simply address that selector.
- Exercise actual same-colour region contours and red-to-default gap preview/Apply
  in rendered frames; remove diagnostic-only console logging from the journey.

Parent independently passed the full slicer-app suite (702 tests/90 files), root
`pnpm typecheck`, serial quick build, extended `painting-backend-smoke`, and
`pnpm exec node scripts/run-painting-e2e.mjs` (one real Electron journey, 19.2 s
total). The runner verifies exact fixture import and hashes staged JS/WASM/data
against the current serial artifacts. It covers all six tools, native annotation
changes, Undo/Redo, prospective gap colour and Apply, camera gesture mapping and
stroke lock, radius wheel, Escape cancellation, close/reopen and switching to
Move's numeric panel. Camera position/quaternion/target are checked after close,
screenshot and two settled frames with `1e-10` tolerance.

Parent inspected the generated region, red patch, gap preview and ordinary
Prepare screenshots under the ignored desktop test-results directory. Child
additionally passed root `pnpm test` (1,112 tests/126 files), both import guards
and final diff check. Existing fixture profile-parent and build tool warnings
remain visible; all required assertions and commands passed. No pinned-submodule
edits. Broad global command/project lifecycle admission and palette remap wiring
remain stage 09; Web/threaded qualification and performance remain later gates.

### Stage 09 acceptance — project commands and palette coherence

Child: `/root/painting_stage_09` (`gpt-6-astra`, medium). Parent accepted after
reviewing the native identity/rollback paths, shared project FIFO, Save checkpoint
reservation, lifecycle admission, configuration/slot publication and actual tests.
Painting owns synchronous admission before entering the existing FIFO; ordinary
commands retain that FIFO, while painting moves still have no queue. Save holds
the reservation through host write and saved-marker publication without nesting
a second queue operation. Generic Process selection belongs to settings actions
and creates one existing project-history transaction, not another history stack.

Concrete review findings were repaired before acceptance: hidden-owner Preview
navigation now preserves the normal preview prewarming transition; a failed
ordinary command cannot expose an idle painter while another command is pending;
Save's checkpoint no longer recursively enters its own FIFO; logical slot identity
publication is staged and failed reset/profile/remap paths preserve the rack IDs.
Runtime identities distinguish duplicate-looking materials, restore through native
history, and never rewind their allocator. User-confirmed post-load Open warning
cancellation leaves an empty project; pre-load cancellation retains painting.
These decisions are recorded in the approved Surface Painting and Undo specs.

Child passed root `pnpm test` (1,120 tests; app 710, WASM/client 245), root
`pnpm typecheck`, serial quick build, real painting backend, editing-session and
native Project preset history smokes, Electron painting (23 seconds), real Web
serial painting/download/lifecycle (17.5 seconds), and diff/import boundary checks.
Eight shared command tests exercise production coordinators, including deferred
press rejection without dialogs/replay, concurrent command failure, Save host-write
reservation, cancellation/failure retention, palette identity and invalid export.
Existing per-plate cancellation tests and extended Worker tests establish affected
plate cancellation and immediate serial admission rejection without posting RPCs.

Parent independently ran:

- `pnpm --filter @orca/slicer-app test` — 710 tests/91 files passed.
- `pnpm typecheck` — all packages passed.
- `scripts\build-windows.bat quick --variant serial` — passed.
- `pnpm --filter @orca/slicer-wasm painting-backend-smoke` — passed, including
  duplicate slot identities, failed operations, Undo/Redo/jump, branch nonreuse,
  and Paint/Process/Paint compaction with correct annotations and Process restore.
- `pnpm exec node scripts/run-painting-e2e.mjs` — real serial Electron 1/1 passed
  in 19.6 seconds, with current artifact hashes checked by the runner.
- `git diff --check` and local links in all three changed documents — passed.

Parent logs are under `packages/slicer-wasm/.work/serial/parent-stage09-*.log`;
child logs are ignored root `stage09-*.log`. Fixture imports still emit known
profile-parent diagnostics; assertions pass. Pinned submodule unchanged. Both
variant/host interoperability qualification remains stage 10 and measured
performance remains stage 11; these results do not claim the release matrix.

### Stage 10 acceptance — interoperability and both runtime variants

Child: `/root/painting_stage_10` (`gpt-6-sol`, high). Six test/harness/probe files
changed; no production bridge or pinned-submodule changes were required. Existing
engine/session harnesses retain all six tools, multipart solids/modifiers,
transforms, subdivision and lifecycle coverage. The backend now proves newly
committed paint survives 3MF save/reload without changing support/seam/fuzzy
annotation channels or losing shared instances. Actual extrusion uses only tool 1
before painting and tools 0/1 afterward, establishing the paint's material effect.

Parent review strengthened causal assertions: busy Electron moves stay on the
first face and only pointerup reaches the second; exactly six painted indices in
one native part prove retained terminal input. Native history is observed directly
after closure, before a new session hides older entries below its floor. Web keeps
the original five-state imported Preview phase and separately verifies new paint,
downloaded 3MF content and resulting Preview. The observer is compiled out of
production, with a Web bundle sentinel guard. Slice-preview heap buffers are
released by the harness after copying their data.

An initially failing combined harness was not accepted by splitting its scenarios.
Investigation found malformed test annotations: hex `1` denotes an incomplete
split tree; valid unsplit state 1 is hex `4`. With all three independent channels
corrected to `4`, the complete same-instance scenario passes, including the
unpainted baseline and painted reload/slice. Alternate interoperability also
includes consecutive project replacements before the first slice. No native
memory leak or project-lifecycle fix was established by this fixture failure.

Child verification: both quick builds and `scripts\build-windows.bat smoke
--variant both`; six-tool engine and multipart session smokes; root `pnpm test`
before the final read-only E2E probe addition and final `pnpm typecheck`; real
Electron 1/1; real Web serial 1/1 (33.8 seconds) and threaded 1/1 (33.6 seconds);
production non-root guard and diff check. The final serial build has
`NEO_PROJECT_HISTORY_TEST=ON`; threaded was explicitly rebuilt with it `OFF`.
Backend expected-mode flags assert fault-hook presence/absence rather than
inferring production status from a directory name.

Parent independently ran:

- `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --expect-test-hooks` — full combined scenario passed, 47,029 segments, baseline tool 1 and painted tools 0/1.
- `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js --interop-only --expect-production` — final corrected fixture passed, same material assertions, production hook absent.
- `pnpm exec node scripts/run-painting-e2e.mjs` — 1/1 passed, 20.6 seconds, current serial artifact identity verified.
- `pnpm --filter @orca/web test:non-root` — production build, deployment base and painting instrumentation sentinel passed.
- `pnpm typecheck` and `git diff --check` — passed.

Web reproduction: set `ORCA_E2E_PAINTED_FACET_PROJECT` to the absolute generated
`packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf`, then run
`pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts painted-facet-preview.e2e.ts`.
Set `ORCA_WEB_NO_ISOLATION=1` for serial; unset it for threaded. The runner config
builds with its E2E gate. Fixture: 5,791 bytes, SHA-256
`10471af07fd7a7c4090d2c56a89874c9fa37a492df2f17f2b78d492e76b3e503`.

Existing fixed real archives use
`packages/slicer-wasm/fixtures/project-compatibility/manifest.json` and
`pnpm exec node packages/slicer-wasm/harness/acquire-project-fixtures.mjs --download`.
Child verified all three pinned hashes and ran
`pnpm exec node packages/slicer-wasm/harness/project-compatibility.mjs --module packages/slicer-wasm/out/serial/orca_slice.js`.
Orca/Bambu/Prusa generic geometry-only compatibility passed; this does not claim
those archives imported their original project settings.

Final serial JS/WASM hashes remain `27e99e1977a02bde42017966b55cfe6eee01041250fb48e68bfebe507478b174` /
`f7353ca74e55897feddfb5be487f1ee3caab8c32073f74853944be9543d29288`.
Threaded production JS/WASM: `11ca5e89cfb00cd5efbdca84128aaf2259d1f44af033edec1179a35c30ecaaea` /
`6ac768a886d9801b04ec798dc350a6169efdbb271c01dd524dccd12841cff8e9`.
Both DATA: `31105d0d32a3f7ba60c46851c0e6ef2138892037ec620d67d0688e593cb99169`.
Parent logs: `.work/serial/parent-stage10-*.log`; final child native logs:
`.work/stage10-final-serial-backend.log` and
`.work/stage10-final-threaded-production-interop.log`, all under slicer-wasm.
Performance and final release qualification remain stages 11 and 12.

### Stage 11 acceptance — reproducible measured baseline

Child: `/root/painting_stage_11` (`gpt-6-sol`, high). Parent accepted the
measurement implementation, evidence and stated limitations. This does not approve
numeric release thresholds. The [reference summary](../packages/slicer-wasm/benchmarks/painting/reference-2026-09-29/summary.json)
and [index](../packages/slicer-wasm/benchmarks/painting/reference-2026-09-29/index.json)
retain 36 compressed raw reports: Electron and Web, six cases, three trials each.
Generated cases contain 12, 192, 3,072 and 12,288 original triangles, including a
four-part 3,072-triangle case. Brush size varies subdivision density. The existing
fixed real project contributes a selected three-part, 143,912-triangle object.
The archive records fixture, source-diff, artifact and analysis-script hashes.

Reference hardware: Windows 10.0.26200, Ryzen 9 5900X, 64 GiB RAM, RTX 3080;
both hosts actually used hardware D3D11 rendering. Measurements use serial wasm64,
E2E instrumentation and native painting profiling. The archived native artifact
also had history fault-test support enabled: the old build driver did not forward
that environment gate and retained its cached value. The driver now forwards
both gates with default zero. The archived measurements record the actual old
configuration; they are not silently relabeled as production measurements.

All six tools committed effective edits. All 288 intended releases and 36 Escape
events correlate with their terminal receipt and geometry revision. Another 72
pointerups (after synthetic release or Escape) are explicitly reported without a
terminal receipt, not hidden or included in latency statistics. Logical revision
frame p95 after release was 37.65–49.00 ms for generated Electron cases and
45.90–66.60 ms for generated Web cases. The real case measured 215.84 / 263.20 ms
(Electron / Web); close-to-disposal p95 was 444.20 / 480.30 ms. A revision observed
by `useFrame` is not verified GPU presentation or display-pixel latency.

The real-case sampled process working-set sums peaked at 2,598,539,264 /
2,759,450,624 bytes. These nominal one-second samples can miss short peaks and
can count shared pages in multiple processes. Native retained history was about
105.20 MB before compaction and 103.51 MB after. Renderer resources balance after
close and reopen/reclose; native geometry observations always transition from
zero previous leases to one current lease. Large cases dropped most or all of
the 40-event move burst; this demonstrates saturation and reliable termination,
not an equivalent-work speedup. No fixed triangle admission cutoff was added.

Parent source review corrected measurement defects before acceptance: distinguish
automation wall time from browser events; count `bufferSubData` payloads correctly;
retain all frame intervals and explicit unmatched inputs; correlate terminal
events by receipt revision without arbitrary timing ceilings; aggregate matched
samples only; compile instrumentation out of ordinary bundles; read the existing
native history projection without triggering another project operation. The last
change also fixes the history-boundary violation introduced by stage 10's final
E2E probe. Native selector scopes include cloning/comparison and related selector
serialization; project-history commits and bridge response serialization are
outside those counters. WebGL timings measure CPU submission, not GPU execution.

The nearby native Orca executable has unverified binary provenance and its
associated checkout differs from the pinned source. No comparable pinned native
measurement is claimed. Numeric latency/memory gates remain a user decision;
functional and resource-lifetime assertions still apply independently.

Reproduce the instrumented run in PowerShell:

```powershell
$env:NEO_PAINTING_PROFILE='1'
$env:NEO_PROJECT_HISTORY_TEST='0'
.\scripts\build-windows.bat build --variant serial
pnpm exec node scripts/run-painting-benchmark.mjs --host both --trials 3
pnpm exec node scripts/summarize-painting-benchmark.mjs
```

Changing CMake gates requires `build`, not `quick`. The archive script is the
explicit command for replacing the dated reference archive, not a routine rerun
step. Restore both environment gates to zero and run `build` before production
validation. The new benchmark runner records actual cache flags.

Child passed root tests (1,122), root typecheck, real Electron painting, fresh
native builds, production interoperability and normal host builds. Final serial
and threaded caches both have painting profiling and history test support OFF.
Parent independently passed `pnpm test` (including app 712 tests/92 files),
`pnpm typecheck`, `scripts\build-windows.bat quick --variant serial`,
`pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --interop-only --expect-production`
(47,029 segments), and
`pnpm exec node scripts/check-painting-profile-elision.mjs` (21 artifacts).
Parent independently audited all 36 decompressed raw hashes, effective tool
outcomes, terminal coverage, balanced resources and analysis-script identity.
Logs: `packages/slicer-wasm/.work/parent-stage11-*.log`. Diff/link checks pass;
the pinned submodule is unchanged. Final milestone regression remains stage 12.

### Stage 12 acceptance — final functional qualification

Child: `/root/painting_stage_12` (`gpt-6-sol`, high). Parent accepted after
reviewing actual coverage and source changes, not only the reported test counts.
The only final code changes are in the E2E Preview probe and its two type
declarations. The original probe read an optional source-text field that the
lazy Preview no longer populates, falsely reporting no G-code tool changes.
It now reads committed G-code only when explicitly requested, retains parsed
tool numbers for the complete receipt/geometry identity, discards results after
renderer changes or disposal, and clears its cache on cleanup. The original
`T1`, extrusion-tool, palette and rendered-colour assertions remain intact.
Ordinary product builds contain no such probe.

Parent review also rejected a proposed backend-harness condition change: the
existing `if`/`else if` already handled `--expect-production` correctly. The first
two child attempts were interrupted on that misreading, not harness failures;
the unchanged full contracts subsequently passed. An initial elision check ran
against an E2E bundle and correctly detected its instrumentation; final checks
use restored ordinary builds. Neither episode establishes a product defect.

The full mock Electron command reports 42 passes and 11 skips. Parent inspection
found that five rack tests were suppressed by a file-level real-mode condition,
while the real-project runner covered only one. This was not accepted as complete
rack verification: the child ran all five on real threaded WASM, exposed and
fixed the stale probe, then passed them. Parent independently passed all five
again on the final source, including stale-result consistency refinements.
The Prime Tower warning fixture was also exercised by its dedicated runner.

Requirement reconciliation:

| Accepted boundary | Evidence retained across the stages and final gate |
| --- | --- |
| Native target/picking, transforms, subdivision and all six tools | Both production `painting-engine-smoke` and `painting-session-smoke`; native/controller tests; real six-tool Electron journey. |
| Single event in flight, dropped moves, retained endpoint/Escape, isolated rendering/camera and one gizmo | Deferred controller tests; causal endpoint/annotation assertions; real Electron camera, close/reopen and numeric-gizmo transition. |
| Per-stroke commits, mixed history, floor/compaction/Redo, failure atomicity | Native history core/fault-build evidence from earlier stages; both final production editing-session/backend contracts; real Undo/Redo and close. Production hook absence asserted separately. |
| Slots/identity/remaps, commands, saves, lifecycle and affected-plate slicing | Shared command tests, native remap/history contracts, real rack five-test suite, painting lifecycle/download journeys and isolated Prime Tower warning. |
| Standard persistence, other annotation channels, shared instances and actual material use | Full production backend contracts on both variants; unpainted tool 1 versus painted tools 0/1 with 47,029 segments; imported painted-facet Preview and fixed project compatibility. |
| Host/build/resource boundaries | Root suites/types, dual native builds/smokes, real Web serial/threaded, packaged probes, production elision and the stage 11 raw resource/measurement archive. |

Child final matrix (commands run from the repository root unless noted):

| Command / scope | Result |
| --- | --- |
| `pnpm test`; `pnpm typecheck` | 1,122 tests and all types passed. After the final E2E repair, affected app 712 tests and app/desktop types passed again. |
| `scripts\build-windows.bat quick --variant both`; `scripts\build-windows.bat smoke --variant both` | Both production variants passed. |
| `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs <module> --expect-production` | Full contract passed for each `out/serial/orca_slice.js` and `out/threaded/orca_slice.js`; no fault hook. |
| `painting-engine-smoke.mjs`, `painting-session-smoke.mjs`, `history-editing-session-smoke.mjs`, each invoked with `pnpm exec node` and each module path | All six tools, multipart/session and editing history passed on both variants. |
| `pnpm --filter @orca/desktop test:e2e` | 42 passed, 11 documented skips. |
| `pnpm exec node scripts/run-painting-e2e.mjs` | Real six-tool journey 1/1 passed. |
| `pnpm --filter @orca/desktop test:e2e:real` | Real project/current-artifact suite 10/10 passed. |
| `pnpm --filter @orca/web test:e2e:threaded`; `pnpm --filter @orca/web test:e2e:serial` | Each 11 passed; dedicated benchmark skipped once per host run. |
| `pnpm --filter @orca/web test:non-root` | Deployment/build guard passed. |
| `pnpm --filter @orca/desktop test:e2e:painted-facet:real` | Fixture self-test and real Electron/Web imported Preview passed. |
| `pnpm --filter @orca/profile-resources build` | 66 packages built. |
| `pnpm exec node packages/slicer-wasm/harness/acquire-project-fixtures.mjs --download` | Three fixed hashes verified. |
| `project-compatibility.mjs --module <module>`, `profile-compatibility-smoke.mjs <module>`, `profile-smoke.mjs <module>`, via `pnpm exec node packages/slicer-wasm/harness/…` | Passed on both variants; external archives retain their established geometry-only compatibility scope. |
| `pnpm --filter @orca/desktop package:dir` | Ordinary package built. |
| Set `ORCA_E2E_PACKAGED_ROOT=release/win-unpacked`; `pnpm --filter @orca/desktop exec playwright test e2e/packaged-real.e2e.ts` | Real threaded package slice/export 1/1 passed. |
| Same packaged root; `pnpm --filter @orca/desktop exec playwright test e2e/packaged.e2e.ts` | Startup/missing/corrupt profile probes 3/3 passed; restored core ZIP hash identical. |
| Real threaded build; `pnpm --filter @orca/desktop exec playwright test e2e/multi-filament.e2e.ts` | Full 5/5 after probe repair; focused final Preview 1/1 after consistency refinement. Parent final full5 result below. |
| `pnpm exec node packages/slicer-wasm/harness/multi-filament-slice-preview-smoke.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js` | 107,862 segments; actual exported G-code contains `T1`. |
| `pnpm --filter @orca/desktop test:e2e:prime-tower-warnings` | Isolated warning fixture 1/1 passed. |

Parent independent final acceptance:

- Root `pnpm test` (1,122) and `pnpm typecheck` passed on the final probe source.
- Full production backend command above passed independently on serial and
  threaded; each proves baseline/painted slicing and absent test hooks.
- `pnpm exec node scripts/run-painting-e2e.mjs` passed 1/1 in 19.8 seconds.
- Final real threaded `multi-filament.e2e.ts` passed all 5 in 1.1 minutes. Parent
  staged current artifacts, built with `ORCA_E2E_REAL=1`, `VITE_USE_MOCK=0`,
  `VITE_E2E=1`, no scoped-configuration variant override, copied the fresh public
  assets into `out/renderer`, and verified all six JS/WASM/data source/served
  SHA-256 pairs before launching Playwright. Thus this was not a launch-time-only
  mock override or stale renderer result.
- Ordinary host builds and the 21-artifact profiling-elision check were restored
  and passed after E2E. Both CMake caches have `NEO_PAINTING_PROFILE=0` and
  `NEO_PROJECT_HISTORY_TEST=0`. Diff/link checks pass; the pinned submodule is
  still `c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`.

Child logs are ignored root `stage12-*.log`; parent logs are
`packages/slicer-wasm/.work/parent-stage12-*.log`. Remaining mock skips are real
DRC/STEP (covered by real runner), the rack file (full real5 above), macOS native
menu (not applicable on Windows), the mock painted-facet fixture (real fixture
runner passed), Prime Tower warning (dedicated runner passed), and the separate
real-only rejecting-slice fixture (not rerun in this painting qualification).
The general Web suite skips the dedicated benchmark; stage 11 supplies its
36-sample evidence. Surface Painting names no additional licensed fixture or
generic native G-code cross-check; `crosscheck-slice.mjs` was not run or replaced
by the material-consumption assertion. A comparable pinned native performance
baseline and GPU execution timing remain unavailable. Numeric performance
thresholds remain awaiting user review. These limits do not prevent functional
delivery, but no universal latency/memory or native-equivalence claim is made.

## Follow-up: shared history revision publication (2026-09-30)

Accepted after child implementation/self-verification and parent independent
code review and verification. Opening painting and committing an effective
stroke advance the native global history revision. Filament commands validate
against that same revision, but the retained rack previously kept an older
token, causing colour edits during an idle painting session to fail with
`stale_revision`.

The shared `projectHistoryStatus` publication and history-status store now own
revision fan-out. One synchronous application-lifetime filament subscription
advances only the retained session/project command tokens; it neither reads a
Worker snapshot nor replaces/notifies rack content. The subscription is disposed
on development HMR. Painting uses the ordinary history publisher, and transform
and restore fast paths no longer maintain filament history tokens themselves.
They retain separately guarded plate-input receipt projection. Rejected restore
status also uses the shared publisher. Bootstrap, empty/reset stores and older
receipts cannot regress a loaded token. Content-changing operations retain
their complete snapshot publication and existing mutation/restore fences;
per-stroke material/Prime Tower settlement remains deferred.

Parent review made the token helper private, required explicit fixture history
resets, and strengthened the real regression to clear existing paint before
the tested stroke and prove a new native Paint entry/revision. The first colour
edit follows painter open alone; the second follows the effective stroke.
Colour Undo/Redo, another stroke and interleaved history separators are verified.
The mock now reports the same global native revision after retained rack edits.

Child checks: focused app 52/52; final directly affected 22/22; full app 716/716;
client 245/245; both package typechecks; `git diff --check`; real current-serial
`pnpm exec node scripts/run-painting-e2e.mjs` 1/1. Earlier new-test failures in
selectors, newest-first history ordering and no-op fixture setup were repaired.
Parent independently passed `pnpm test` (1,126), `pnpm typecheck`, and the same
real Electron runner (1/1, 23.8 seconds), including fixture self-test and served
JS/WASM/data hash verification. Logs are under ignored
`packages/slicer-wasm/.work/parent-painting-revision-*.log`.
The parent restored the ordinary desktop build with
`pnpm --filter @orca/desktop build` and passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` (21 artifacts).

Native bridge/build code and the pinned submodule are unchanged; no native
rebuild or dual-host release matrix was needed for this shared projection fix.

## Follow-up: current internal painting contract (2026-09-30)

The user requires current internal APIs without cross-version compatibility.
A fresh child reviewed the painting controller, client/Worker/native painting
contract and shared history revision integration. The parent independently
reviewed the concrete changes and callers before accepting the cleanup.

`PaintingPorts.coordinate`, `palette` and `targetAvailable` are now required.
Production already supplies all three, so missing-port branches served only
incomplete callers/fixtures: direct uncoordinated RPC, skipped palette query
and implicitly available targets. Those branches are removed and fixtures
provide the complete contract. A nullable palette snapshot remains a current
loading state. New behavior tests prove coordinator admission precedes native
history open and removal of a painting target closes its session without a
stale session read. This adds no alternative API or compatibility wrapper.

The bounded audit found no further demonstrated older painting signature or
receipt fallback. Exact v1 validation rejects unsupported internal requests;
tool-specific settings, candidate guards, retained geometry IDs, recoverable
errors and release cleanup describe current behavior. The history mutation
module's publisher re-export is a current barrel used by Workspace/settings,
not a second implementation or older-signature adapter. This is not a claim
that every unrelated repository API has been audited.

Child self-verification: focused app 27/27, full app 718/718, app and root
typechecks, real serial Electron painting 1/1, ordinary desktop build and
21-artifact profiling elision. Parent independently passed `pnpm test`
(1,128), `pnpm typecheck`, `pnpm exec node scripts/run-painting-e2e.mjs`
(1/1, 20.9 seconds, with current served artifact hash verification), and
`git diff --check`. Parent logs use ignored
`packages/slicer-wasm/.work/parent-painting-contract-*.log`. No native build,
submodule change or external project-format compatibility change is involved.
The parent also restored `pnpm --filter @orca/desktop build` and independently
passed `pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 ordinary
production artifacts.

## Follow-up: continuous painting model display (2026-09-30)

Accepted after a fresh gpt-6.1-sol/high child implemented and self-verified the
fix, followed by parent source review and independent checks. Entering painting
previously removed the Prepare model before the first painting geometry arrived.
Ordinary project operations, including filament colour edits, cleared the
painting display and known resources before asynchronously replacing them.
Both transitions could expose a model-free viewport frame.

The controller now retains one matched visual bundle: complete part/candidate
manifest, CPU resources, target/part transforms and palette. A replacement is
validated before publication; missing resources, incomplete parts and stale
receipts cannot replace the previous bundle. Ordinary operations retain known
resource IDs, so colour edits reuse their geometry. The dedicated painting
renderer uses the displayed bundle's metadata and palette; native interaction
metadata can advance separately. Unseen target/transform changes cannot accept
paint input. Initial painting uses passive Prepare visuals until its complete
bundle is installed, while painting already owns input. Failed renderer
publication preserves the old visual and reserves error phase. Close cancels a
remaining native draft before closing history, retaining retry state on failure
and avoiding duplicate cancellation after a successful receipt.

Borrowed cursor meshes retain identity for equal geometry and actual matrix
values, avoiding repeated tight-bound vertex scans on RGB/config metadata reads.
Bounds and cursor picking follow the displayed transforms. Input listeners read
the current borrowed mesh set through a ref and remain stable across geometry
refreshes. A component test with the former mesh-dependent listener effect
failed because resource replacement synthesized release while the mouse was
still held; the corrected effect passes. Pointer up, blur, pointercancel, lost
capture and actual unmount still terminate the gesture.

The real Electron regression observes actual selected-target draw callbacks for
each main-scene render across entry and RGB editing. It rejects empty frames,
Prepare/painting overlap, RGB geometry replacement and failure to draw the new
material colour. The renderer also serves a separate GizmoHelper overlay scene;
that scene is deliberately excluded from model-frame counting. Hooks and draw
markers are compiled out of ordinary production builds. Failure diagnostics
retain native hit, pointer and target evidence without an alternate paint API.

Child final checks: app 730/730 across 93 files, root typecheck, current serial
real Electron runner 1/1 (20.5 seconds), both ordinary host builds and 21-artifact
profiling/probe elision. Earlier root checks passed before the final component
tests. A single earlier Region press observed idle rather than drawing; its
trace cannot establish the precise cause. The deterministic listener negative
control establishes the resource-refresh defect independently; no six-tool
assertion was weakened to accept that earlier failure.

Parent independently passed `pnpm test` (1,140), `pnpm typecheck`, and
`pnpm exec node scripts/run-painting-e2e.mjs` (1/1, 20.7 seconds). The runner
checks the fixture and current served serial JS/WASM/data hashes. Entry captured
15 main-scene frames (11 Prepare, 4 painting); RGB captured 15 painting frames.
Both have zero empty/overlapping frames; RGB has one geometry UUID and seven
frames drawing the new `445566` material. Frame JSON is under ignored desktop
`test-results`; parent command logs use ignored
`packages/slicer-wasm/.work/parent-painting-flicker-*.log`.

The parent restored fresh ordinary production output with
`pnpm --filter @orca/desktop build` and `pnpm --filter @orca/web build`, then
independently passed `pnpm exec node scripts/check-painting-profile-elision.mjs`
on 21 artifacts. `git diff --check` passed; the pinned submodule remains
`c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`.

Native code and the pinned submodule are unchanged. No native rebuild, full
dual-host/dual-variant release matrix or universal frame-rate/GPU-latency claim
is involved in this shared rendering fix.

## Follow-up: painting camera rotation centre (2026-09-30)

The user requires the current model bounding-box centre as the painting camera
rotation centre. The pinned Orca source implements this in
`GLCanvas3D.cpp`: the `MmSegmentation`/other painter camera branch passes
`Selection::get_bounding_box().center()` to
`Camera::rotate_on_sphere_with_target`, falling back to all-volume bounds only
without a selection. `Camera.cpp` preserves the pivot's camera-space position
while rotating the camera pose. The painter's opening/closing `set_target` and
`look_at` code is commented out; opening alone does not recenter the viewport.

Delivered as one bounded step: derive the world bounding-box centre of the
displayed editing instance's solid parts using its original vertices and
displayed transforms; rotate the camera pose about that centre while preserving
framing. Keep the navigation target coherent with the camera pose for pan,
zoom and returning to Prepare. Model switching/transform handoff updates the
rotation centre with the displayed bundle; colour changes, strokes and pan do
not move it. Opening/closing does not itself reframe the camera. Preserve stable
pointer listeners, reliable terminal handling and unfinished-stroke camera
guards. Do not add a native API or internal compatibility path.

A fresh gpt-6.1-sol/high child implemented and self-verified this step. Parent
accepted the camera math, resource/transform ownership, stable listener effect
and current internal signatures after independent source review and checks.
The original-vertex tight bounds are reused by the height cursor and rotation
pivot; equal RGB/stroke metadata does not repeat vertex scans. A nullable pivot
reserves rotation until a displayed model exists. The world-Z azimuth and
current-camera-right zenith quaternion rotate camera position, orientation and
the navigation target together about the pivot. Retain Neo's previous safe
polar range (`1e-6` to `PI-1e-6`) using the view direction; the pinned Orca
painter passes `false` for polar limits. This deliberate bounded difference
preserves ordinary OrbitControls handoff without introducing inverted-view or
dynamic-up camera behavior.

Deterministic tests cover multi-part tight AABBs, mirrored/nonuniform transforms,
Z height and exclusion of other instances; pan then orbit; both pole limits;
entry and closure without reframing; delayed same-instance transforms and
different-object/instance display handoffs; RGB/stroke cache reuse; and camera
guards/reliable terminals during unfinished strokes. The real Electron journey
checks the fixture's independent centre `[100,100,10]`, performs middle/right
pan before modified-left orbit, and verifies unchanged pivot camera-space and
screen position. Entry, RGB, close, six tools and nested history assertions
remain. The existing E2E-only probe exposes the actual displayed pivot rather
than a separately calculated test pivot.

Child self-verification: focused 16/16; app 736/736 in 93 files; root
`pnpm test` 1,146/1,146; app/root and desktop typechecks; current serial real
Electron runner 1/1 (20.4-second test); fresh ordinary Desktop/Web builds and
21-artifact profiling/probe elision. The first new entry-camera assertion tried
to read the Prepare scene probe after that scene had unmounted. Its concrete
observability failure was corrected to use the existing painting camera pose;
before-open and after-close continue using the Prepare probe. No product
camera change or assertion relaxation was used to repair the test.

Parent independently passed `pnpm test` (1,146), `pnpm typecheck` and
`pnpm exec node scripts/run-painting-e2e.mjs` (1/1, 20.5 seconds total). The
runner verified the fixture and served current serial JS/WASM/data hashes.
The pivot stayed `[100,100,10]` through both pans and rotation. Its camera-space
position before/after rotation differed by at most approximately `3e-14`.
Entry captured 19 main-scene frames; RGB captured 16. Both have zero empty or
overlapping frames; RGB retains one geometry UUID and six frames drawing the
new `445566` colour. Evidence JSON is under ignored desktop `test-results`;
parent logs use `packages/slicer-wasm/.work/parent-painting-camera-*.log`.

Parent also restored fresh ordinary production builds with
`pnpm --filter @orca/desktop build` and `pnpm --filter @orca/web build`, and
passed `pnpm exec node scripts/check-painting-profile-elision.mjs` on 21
artifacts. `git diff --check` passed. The pinned submodule remains
`c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`.

No native code/submodule change or native rebuild is required for this shared
camera fix. The full dual-host/dual-WASM release matrix was intentionally not
rerun; focused shared behavior is exercised in real serial Electron.

## Follow-up: persistent brush visibility and solid sphere cursor (2026-09-30)

The user reports that starting a stroke hides the brush behind refreshed model
surfaces until leaving/re-entering the model, and requires a translucent solid
sphere rather than a wireframe. The user additionally requires the selected
filament's highlighted colour using Orca's algorithm. The pinned MMU renderer
enables blending and depth testing, renders triangles/cuts, then calls `render_cursor()`.
`GLGizmoPainterBase::render_cursor_circle` disables depth testing for its circle;
`render_cursor_sphere` uses a solid sphere/flat shader under normal depth testing.
The base pressed sphere colours use alpha 0.25. Neo's current white wire sphere
and ordinary opaque cursor meshes lack a stable cursor render-order contract.

Implement one bounded step: make all existing brush cursors render in a stable
final cursor layer after draft surfaces/candidates/contours across geometry
replacement, without writing depth. Keep circle/height/pointer cursor overlays
independent of model depth. Use a translucent filled sphere with normal model
depth testing and a fixed 0.25 opacity; retain existing brush
size/position/input semantics. Do not add native APIs, clipping,
wireframe modes or internal compatibility signatures.

Use the selected positive filament slot from the displayed bundle's matched
palette for all cursor tools and throughout hover, held painting and erasing.
The MMU adapter owns colour selection; generic rendering receives a required
cursor colour resolver/value. Orca's `TriangleSelectorGUI::get_seed_fill_color`
(`GLGizmoPainterBase.cpp`) computes `min(channel * 1.25, 1)` separately for the
three original RGB channels. Apply that formula in encoded sRGB before Three's
linear-working-space conversion, without a brightness floor or HSV substitute.
The helper returns alpha 1; retain the separately specified sphere opacity
0.25. This uses Orca's highlight algorithm as explicitly requested; the pinned
MMU hover cursor itself reads the unmodified selected extruder colour and its
base pressed cursor colours differ. Filament selection updates cursor colour
immediately; palette refresh publishes cursor colour with its matched display
bundle and preserves cursor/geometry identity.

A fresh gpt-6.1-sol/high child implemented and self-verified this step. Parent
source review confirmed the required colour resolver and all current callers,
the module-private slot lookup shared by MMU surface/cursor adapters, exact
encoded-channel highlighting, and explicit cursor group/object render order.
The display bundle, model-centre camera rotation and stable pointer listeners
remain intact. No optional legacy signature or internal compatibility path was
introduced. Independent IEC sRGB equations verify highlighted linear channels;
the source parser avoids an approximate inverse-colour round trip before
highlighting.

The controlled negative restored the old opaque circle/default draw order:
22/22 frames after native geometry replacement drew the cursor before both
model surfaces. The fixed source was restored and the positive journey rerun.
This establishes that refresh-induced draw sorting caused the reported hiding.

Child validation passed 24 focused tests, 1,159 root tests, root typecheck and
the real serial Electron journey (1/1). Parent independently reviewed code and
passed `pnpm test` (1,159, including 749 app tests), `pnpm typecheck` and
`pnpm exec node scripts/run-painting-e2e.mjs` (1/1, 21.4 seconds total). The
runner checked fixture and served serial JS/WASM/data hashes. Parent actual
renderer captures contain 31 circle, 22 sphere, 24 triangle and 23 height
frames. Each crosses two model geometry UUIDs, retains one cursor UUID and
draws the cursor last in every frame. Selected-filament switching captured
15 frames with both red and green cursors. RGB editing captured 15 frames,
including actual `#556a80` cursor rendering for source `#445566`, independent
linear-channel checks and unchanged sphere alpha 0.25. Entry (19 frames) and
RGB captures both have zero blank or overlapping model frames. Parent visually
reviewed held-sphere and highlighted-sphere screenshots. Evidence lives in
ignored desktop `test-results`; independent logs use
`packages/slicer-wasm/.work/parent-painting-cursor-*.log`.

Parent restored fresh ordinary builds with `pnpm --filter @orca/desktop build`
and `pnpm --filter @orca/web build`, then passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 artifacts.
`git diff --check` passed. No native rebuild or full dual-host/dual-WASM release
matrix was run for this shared renderer-only change; the pinned native
submodule remains `c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`.

## Follow-up: Triangle mode facet highlight (2026-09-30)

The user requires Orca's Triangle mode: highlight the corresponding triangle
instead of drawing a brush. Pinned `GLGizmoPainterBase::render_cursor()` draws
only circle, sphere and height cursors. The POINTER path in its Moving handler
selects through `bucket_fill_select_triangles(hit, facet, clipping, -1, false)`
and clears selection on miss or part change. The paint path uses the same
selection, including native subdivided leaves.

One bounded step extends the existing isolated native candidate preview and
shared controller publication to Triangle mode, removes the point brush, and
renders native-selected facet geometry using Orca's highlight semantics. The
MMU gizmo instantiates `TriangleSelectorPatch`: its renderer keeps patch-state
material colours and draws the selected native contour in white. Triangle
preview therefore uses that outline without a destination tint or Region's
translucent fill overlay. Keep
preview selection separate from annotations/history; preserve current draft,
palette, camera and event-lane contracts. All internal callers migrate together.
A fresh gpt-6.1-sol/high child implemented and self-verified this step; parent
independently reviewed the native selection lifetime, current typed protocol
migration, strict resource decoder, matched display publication, contour shader
and event admission. No compatibility branches were added. Triangle preview
retains the selected native leaf's geometry for membership/cache validation,
but renders only its contour. The material has normal depth testing, no depth
write and Orca's `0.00001 * abs(w)` clip-depth offset. It allocates no unused
face materials. Region preview and other brush render paths remain intact.

Scheduled/busy Triangle hover moves are dropped rather than queued. Leave,
tool/settings changes and newer admitted samples invalidate old responses.
Setting changes while still on-model and release during an outstanding native
geometry read are tested separately; terminal endpoints are preserved. Native
tests assert one selected leaf for both original and actually subdivided
meshes, unchanged selector/Model data during hover, part changes, misses,
preview-to-paint membership and cancel restoration. The subdivided fixture
uses the collision's local coordinates; world height must not be substituted.

Child checks passed root tests (1,166), typecheck, both current-header WASM
quick builds, native painting suites, serial production backend contract,
threaded smoke, real serial Electron, ordinary host builds and production
elision. Parent independently passed:

- `pnpm test` (1,166; app 755 and slicer-wasm 246) and `pnpm typecheck`.
- `scripts\build-windows.bat quick --variant both`.
- `packages\slicer-wasm\.work\triangle-native-test.cmd`: reconfigure the
  existing independent history-test build with current cereal include, check
  both PaintingSession source objects, relink the configured target's response
  file against fresh serial production core/deps archives and run its CJS.
  Original/subdivided preview, six-tool engine and lifecycle suites all passed.
  The local helper and response generator are ignored build artifacts.
- `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs
  packages/slicer-wasm/out/serial/orca_slice.js --expect-production`: original
  and subdivided preview/history, publication, remap, 3MF and two-material
  slicing passed. The existing `--interop-only` option still skips editing
  preview tests.
- `scripts\build-windows.bat smoke --variant threaded`.
- `pnpm exec node scripts/run-painting-e2e.mjs`: 1/1, 22.1 seconds total, current
  serial artifact hashes verified. Native hover captured 36 model frames, 32
  with the white contour; held Triangle captured 8 frames across two model
  geometries, 5 with the current contour. Undo replacement captured 39 frames
  across two model geometries. All three captures have zero Triangle brush
  draws and zero duplicate fill draws. Actual contour positions match native
  selected geometry; its colour/depth properties are correct in every draw.
  The real subdivided leaf is smaller than its original 200 mm² triangle,
  belongs to the current draft, and hover leaves history unchanged. Parent
  visually reviewed original-face and subdivided-leaf screenshots.

Independent logs use `packages/slicer-wasm/.work/parent-triangle-*.log`; frame
JSON/screenshots are in ignored desktop `test-results`. Parent restored fresh
ordinary builds with `pnpm --filter @orca/desktop build` and
`pnpm --filter @orca/web build`, passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 production
artifacts and `git diff --check`. The read-only pinned submodule remains
`c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`. Pinned selector behavior is unchanged:
exact subdivision-edge hits can return an
empty leaf selection; verification uses interior points. No full release
matrix is claimed.

## Follow-up: retain Triangle highlight during movement (2026-09-30)

The user reports flickering Triangle contours during mouse movement and
requires the prior result to remain until the next result is available.
Before this fix, accepted moves called `withoutCandidates()` before native
preview or geometry completion; Triangle press/sample admission did the same.
This created an empty rendered interval between valid native results.

One bounded controller/render-publication step retains the previous complete
Triangle display through hover, press and admitted samples. Atomically replace
it with a current native result, including an authoritative miss. Canvas leave
and tool changes clear immediately; outdated responses may neither resurrect
cleared candidates nor blank a still-valid preview. Preserve one-event
admission, dropped intermediate moves, reliable terminals and matched resource,
transform and palette ownership. No native algorithm/API change is required.
A fresh gpt-6.1-sol/high child implemented and self-verified. Parent source
review confirmed that Triangle admission/settings retain the complete bundle,
obsolete geometry reads request a fresh publication without installing their
resources, and candidate/cache ownership remains matched. Target-start
invalidation is limited to Triangle; Region/Gap keep their existing behavior.
Canvas leave, target/tool changes, cancellation and errors clear the contour
without clearing the model. Eight added controller tests cover delayed
preview/geometry, stale settings/terminal responses, miss/leave/tool/target/error
lifecycle, known-resource reuse and disposal. A controlled negative with the
old controller triggered five regression failures; fixed source was restored.

Child checks passed 36 controller tests, root tests (1,174), typecheck, real
serial Electron, ordinary Desktop/Web builds and production elision. Parent
independently passed `pnpm test` (1,174, including 763 app tests),
`pnpm typecheck` and `pnpm exec node scripts/run-painting-e2e.mjs` (1/1,
22.8 seconds total; current serial artifact hashes checked). Actual renderer
captures contain 31 continuous hover frames and 75 hover/press/held movement
frames. Every frame has exactly one native white contour, with two distinct
selected contour shapes in each capture. Hover retains one draft geometry;
held movement replaces it across three geometries. A held miss captures four
frames retaining the prior contour while native work is pending, then 28
cleared frames, ending with no contour. The stroke remains active and native
re-entry succeeds. Hover leaves geometry/history unchanged, and the existing
colour, camera, six-tool and history journey passes. Parent reviewed the held
outline screenshot. Independent logs use
`packages/slicer-wasm/.work/parent-triangle-retain-*.log`; actual frame JSON and
screenshots are under ignored desktop `test-results`.

Parent restored fresh ordinary builds with `pnpm --filter @orca/desktop build`
and `pnpm --filter @orca/web build`, passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 production
artifacts and `git diff --check`. No native build or full release matrix was
run for this shared controller-only fix; native sources and the pinned
submodule are unchanged.
