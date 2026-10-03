# Surface Painting Implementation Plan

**Date:** 2026-09-29

**Branch:** `dev/support-seam-fuzzy-painting` for the authorized 2026-10-02
adapter work; historical MMU work used `dev/surface-painting-spec`.

**Status:** Steps 01–12 implemented and independently accepted; MMU functional
delivery qualified 2026-09-30. Scheme B support/seam/fuzzy adapters approved and
implementation authorized 2026-10-02; steps 13–19 independently accepted,
adapter functional delivery qualified 2026-10-03. Quantitative
performance thresholds remain awaiting user review.

**Authority:** [Surface Painting Architecture](../spec/Surface%20Painting%20Architecture.md), [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md), [Undo and Redo](../spec/Undo%20and%20Redo.md), and [testing guidelines](testing_guidelines.md). This is the one living implementation task document. No parallel phase notes.

## Execution contract

- From the 2026-10-02 authorization, every new step uses a fresh **gpt-6.1-sol / medium** child. This supersedes the earlier new-child **gpt-6.1-sol / high** policy. Historical executions and their recorded models remain unchanged; stage 10 onward and two earlier follow-up children used **gpt-6-sol / high**, and stage 09 continued on **gpt-6-astra / medium**.
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
- Preserve all six MMU tools and every accepted lifecycle/history/slot policy. Scheme B support/seam/fuzzy adapters under sections 2.4–2.6 and 9.2 of the specification passed sequential acceptance on 2026-10-03.
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

## Adapter stages — authorized 2026-10-02

The user accepted scheme B and authorized implementation immediately after the
documentation piece is independently accepted and committed. Continue in this
same living record, with one fresh **gpt-6.1-sol / medium** child per numbered
step. No overlapping stages; child self-verification precedes substantive parent
review and independently rerun acceptance. The parent commits each accepted
piece before launching the next. Existing steps and evidence below are historical
MMU delivery, not evidence for these new channels.

The research baseline is the pinned submodule
`489cbe91840ff97aaf4d8029009d5db410f32893`; preserve it. Scheme B's complete
accepted semantics live in the [surface specification](../spec/Surface%20Painting%20Architecture.md#24-approved-support-seam-and-fuzzy-skin-adapters--scheme-b).
The native/transport first steps are independently testable hidden foundations;
a toolbar entry appears only when its complete channel stage is accepted.

### Current execution and verification scope

- Documentation piece: independently accepted by the parent on 2026-10-02;
  scheme B and stages 13–19 are recorded before code implementation. Parent
  source/diff review, local links/anchors, command references, native driver help
  and `git diff --check` passed. No adapter code is delivered by this piece.
- Step 13: independently accepted by the parent on 2026-10-02; hidden native
  adapters and strict transport are implemented.
- Step 14: independently accepted by the parent on 2026-10-02; four-channel
  history/cache restoration is implemented.
- Step 15: independently accepted by the parent on 2026-10-02; complete Seam
  editor, persistence and native downstream slicing are implemented.
- Step 16: independently accepted by the parent on 2026-10-02; native Smart Fill,
  Support Gap and independent overhang foundations are implemented.
- Step 17: independently accepted by the parent on 2026-10-02; complete Fuzzy
  editor, explicit scoped configuration and native downstream slicing are
  implemented.
- Step 18: independently accepted by the parent on 2026-10-02; complete Support
  editor, independent highlight scheduling and actual native support/derived
  integration are implemented.
- Step 19: independently accepted by the parent on 2026-10-03; both-host/variant
  functional qualification, native-format interoperability and measured resource
  cleanup are complete. Quantitative performance thresholds remain pending.
- Existing serial/threaded build trees and pnpm/native tools were verified by the
  parent as available for this checkout. Children must still verify configured
  source roots, build flags and current artifact identity before running evidence.
- Profiles N/W/T/A/E/P/R above continue to apply. Native quick commands on this
  macOS/Linux checkout are `bash scripts/build.sh quick --variant serial` and
  `bash scripts/build.sh quick --variant both`; Windows uses the existing
  `scripts\build-windows.bat` equivalents. Smoke is
  `bash scripts/build.sh smoke --variant serial` or `--variant both`.
- For each affected package run its `pnpm --filter @orca/slicer-wasm test` /
  `typecheck`, `@orca/slicer-runtime` equivalents and/or A's app commands.
  Each child reports the exact invocations and actual fixture/assertion scope;
  a profile name by itself is not verification evidence.
- Extend the existing real-WASM `painting-session-smoke.mjs`,
  `painting-engine-smoke.mjs`, `painting-backend-smoke.mjs` and
  `history-plate-runtime-smoke.mjs` as appropriate, rather than relying on mock
  receipts. Invoke them with the current variant module path; comprehensive
  failure cases require the appropriate compile-gated native test build, while
  production interoperability uses the harness's production mode. Record build
  configuration and restore ordinary artifacts before production/elision checks.
- Current ordinary-production backend command is
  `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --interop-only --expect-production`.
  Expand its assertions per step; the old passing harness cannot establish a
  new channel. Host runner is `pnpm exec node scripts/run-painting-e2e.mjs`;
  extend its real journey for each enabled adapter and verify artifact receipts.
  New probes must compile out of ordinary builds, checked with
  `pnpm exec node scripts/check-painting-profile-elision.mjs` after ordinary
  `pnpm --filter @orca/desktop build` and `pnpm --filter @orca/web build`.

### 13. Channel-aware native sessions and strict typed transport

**Status:** Accepted by parent on 2026-10-02. **Depends on:** documentation piece accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** W+T+A (MMU regression).

**Allowed scope:** Native painting Session/Settings/open/commit/reconcile and
channel adapters under `packages/slicer-wasm/src/`; client, Worker and runtime
contracts; all internal callers/mocks needed for the required schema; focused
native harnesses and protocol tests. No new channel toolbar entry.

**Functional output:** Required channel discriminant selects exactly one native
field/tree. Channel-specific state/tool validation, deserialize/writeback,
serialization, timestamps, resource identities, revision checks, cancellation,
staged publication/rollback and history names work for all four fields. Carry
the discriminant through responses and transfers; update every current caller
with no omitted-channel MMU default or old-contract aliases. MMU palette/rack
validation is specific to MMU; new channels work on single-filament projects.
Implement the reusable circle/sphere/triangle paths only where the approved
channel tool table allows them; reject unavailable tool paths. Smart Fill and
support auxiliary operations remain inaccessible until their later stages.
Ordinary committed mesh resources remain MMU-only.

**Child self-check:** Affected full package suites/typechecks, serial quick build,
focused real-WASM session/backend tests and all-six-tool MMU regression. Assert
missing/invalid channel, cross-channel illegal states/tools, stale receipt,
independent imported trees, changed/untouched annotation bytes and failed commit
rollback; exercise live stroke state changes and cancellation. Use a configured
native failure-test artifact for atomicity evidence, with production elision.

**Parent acceptance:** Read the native field adapter, transaction/publication and
all transport consumers; rerun affected suites/typechecks plus current serial
native harness with per-channel state/bytes/timestamps/resource assertions.
Independently rerun existing real MMU journey. No new channel is exposed.

**Delivered and verified:** Required `channel` now crosses native sessions,
receipts, strict client decoding, Worker transfer and application consumers.
Support/seam/fuzzy load and publish independent native fields, validate their
state/tool domains, retain committed timestamps and use channel-qualified draft
and candidate resource identities. Native rollback restores the active field;
ordinary geometry remains MMU-only. No new toolbar entry is exposed. Parent
reviewed all 22 changed source/test/harness files, including staged publication,
resource lease release, channel matching and current internal callers.

Child self-verification passed before final parent acceptance. The parent
independently ran:

- `NODE_OPTIONS=--no-experimental-webstorage pnpm test`: passed all suites
  (WASM 256, runtime 35, app 880, desktop 71, web 28; other workspace suites
  also passed). `pnpm typecheck`: passed. After final caller/test adjustments,
  `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @orca/slicer-app test`
  and `pnpm --filter @orca/slicer-app typecheck` passed again.
- `bash scripts/build.sh quick --variant serial`: passed. Current Release
  configuration has history-test/profile gates OFF and threading 0. Final
  JS/WASM/DATA SHA256 values exactly match the independently tested artifact:
  `7c2d376880701217290f8b427e71edc39fa7b9560ffd87e546f185b6eac562db`,
  `19f8f7f0bdd3df04f157225d7559ddd746a2162130693896a29f2d70bf1c47c9`,
  `6c5376312b22d659cf8e77c1e3596fe5b914c80121c51b0537b1b04d8983b12e`.
- `pnpm exec node packages/slicer-wasm/harness/painting-session-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`
  and `pnpm exec node packages/slicer-wasm/harness/painting-engine-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`:
  passed required/malformed channel identity, imported independent subdivisions,
  invalid imported states, single-slot admission, all six MMU tools, new native
  brushes/triangle, live settings and cancellation.
- `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --interop-only --expect-production`:
  passed per-channel field bytes/timestamps/resources, untouched parts/fields,
  target/reconcile/erase/no-op/3MF assertions and real MMU slicing (47,012
  segments, tools 0 and 1).
- `pnpm exec node packages/slicer-wasm/.work/step13-history-test/painting_session_test.cjs`
  and `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/.work/step13-history-test/orca_slice.js --expect-test-hooks`:
  passed native lifecycle/domain tests and comprehensive MMU plus all three
  new-channel injected commit rollbacks. Parent verified all five preserved
  artifact hashes against the build receipt. This test artifact was built
  using `emcmake cmake -S packages/slicer-wasm -B packages/slicer-wasm/.work/serial/build -DNEO_PROJECT_HISTORY_TEST=ON`
  and `cmake --build packages/slicer-wasm/.work/serial/build --target orca_slice painting_session_test -j 8`;
  ordinary production was restored with the same configure command using OFF,
  then serial quick. Test-hook bytes are absent from production JS/WASM.
- `pnpm exec node scripts/run-painting-e2e.mjs`: passed 1/1 independently
  (39.5 seconds total), verifying current artifact hashes, actual six-tool MMU
  input, native history and renderer/camera/material evidence.
- `pnpm --filter @orca/desktop build`, `pnpm --filter @orca/web build`, then
  `pnpm exec node scripts/check-painting-profile-elision.mjs`: passed; 21
  ordinary production artifacts contain no painting probe/profile sentinels.
  `git diff --check` and changed local-link/command review passed.

The machine runs Node 26.7 rather than the repository's pinned Node 24.19.0.
The child's initial root run failed 11 unchanged browser-adapter localStorage
tests; disabling Node's experimental Web Storage explicitly made both child and
parent runs pass, without repository configuration changes. The existing real
MMU journey initially assumed a custom titlebar menu on macOS, an obsolete
colour-badge span and synchronous colour-history publication. It now invokes
the native macOS menu, locates the existing colour label and waits for the same
required history label; all original behavior assertions remain. Both child
and parent reruns passed. Native fixture loads still print missing-parent config
diagnostics; the asserted operations and downstream slices passed.

Threaded rebuild, second-host journeys and the full release matrix were
intentionally deferred to step 19. This step does not establish all-channel
affected-plate/usage restoration (step 14), complete editors or downstream
support/seam/fuzzy slicing qualification.

### 14. Four-channel history restoration and slice invalidation

**Status:** Accepted by parent on 2026-10-02. **Depends on:** 13 accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** N+W+T+A.

**Allowed scope:** Native history/painting/plate cache and derived-use/Prime Tower
integration, client/runtime restore projection, affected app restore coordinator,
real history/plate harness and behavior tests. No new toolbar entry.

**Functional output:** Close the MMU-only restore gaps in affected-plate comparison
(`bridge_history.cpp` around line 562) and usage comparison (around line 735).
Commit/Undo/Redo restores all channels and invalidates all affected before/after
instance plates, input/result stamps, Worker caches and published previews.
Support changes invalidate implicated support usage summaries and Prime Tower
projections; preserve channel-specific dependency handling and deferred versioned
settlement. Native snapshot capture already holds four fields; do not introduce
another history authority. Retain compaction, non-paint separators, floors,
saved markers, Redo rules and atomic failed restore/reconciliation/publication.

**Child self-check:** History-core executable in the configured N test build,
affected suites/typechecks, serial quick build and real history/plate harness.
Use multiple instances on different plates and all three new channels to prove
stale results after commit and Undo/Redo, actual fresh slicing, support-use/Prime
Tower invalidation, unaffected plate reuse, and fault rollback with unchanged
model/history/cache publication. Repeat mixed config/paint close and MMU history.

**Parent acceptance:** Review restored roots, before/after plate calculation,
usage dependencies, deferred settlement and staged rollback. Independently rerun
core and real plate/history scenarios plus affected package checks. Observe cache
and slice outcomes, not only annotation equality; all new entries remain hidden.

**Execution / acceptance (2026-10-02):** Fresh child
`/root/painting_step14`, `gpt-6.1-sol` / medium, implemented and self-verified;
parent independently reviewed the complete native/history/cache and harness diff.
All four annotation fields now participate in affected before/after instance plate
restoration. MMU/support evict implicated usage summaries and advance deferred
settlement; seam/fuzzy preserve summaries and ordinary MMU renderer resources.
Undo/Redo/Jump stage a transient native navigation owner that rolls back lazy
live-top capture, saved markers, Redo, budget eviction and exact history accounting
when reconciliation or response publication fails. No additional history authority
or channel toolbar entry was introduced.

The fault fixture exposed three native restoration defects: replay of an unchanged
parentless Print owner, mutation of history accounting before failed publication,
and unchanged Project/Print root replay invalidating an unrelated plate. Bounded
repairs retain genuine owner/configuration restoration. Existing config fixtures
were updated to the authoritative `renderables` field and current native override
admission: rejected metadata remains atomic, density clamping and reset exclusion
remain asserted.

Parent verification passed (gated module below is the child's preserved final
Release serial test build, not the ordinary production artifact):

```sh
pnpm exec node packages/slicer-wasm/.work/step14-history-test/timestamped_history_core_test.cjs
pnpm exec node packages/slicer-wasm/.work/step14-history-test/painting_session_test.cjs
pnpm exec node packages/slicer-wasm/harness/painting-history-plate-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js --expect-test-hooks
pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js --expect-test-hooks
pnpm exec node packages/slicer-wasm/harness/config-scope-invalidation-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/native-project-preset-history-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/native-scoped-config-mutation-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/transform-plate-invalidation-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/history-editing-session-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/prime-tower-cache-validity-smoke.mjs packages/slicer-wasm/.work/step14-history-test/orca_slice.js
bash scripts/build.sh quick --variant serial -j 8
pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --interop-only --expect-production
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm typecheck
git diff --check
```

The new real-WASM fixture passed **48 fresh slices and 20 fault rollbacks** across
all channels, shared instances on two plates and an independent third plate.
It checks actual preview/export eligibility, unchanged unrelated results, retained
ordinary scene resources, support FullScan versus seam/fuzzy Hit, deferred
settlement and membership-changing Jump. Core tests cover exact failed-navigation
accounting, saved marker, editing-session floor and successful navigation. The
child also passed `history-smoke.mjs` against its gated module. Existing imported
fixture parent-config diagnostics remain visible; all assertions passed.

At the user's request, fetched and merged latest `origin/main` (`69f13cd`) in
merge commit `0ff3a06` before proceeding. The unaccepted step-14 changes were
stashed, merged without conflicts and restored byte-for-byte. Parent reran root
checks after the merge: **1,303 tests passed**, plus typecheck. The new upstream
regression also passed:

```sh
pnpm exec node packages/slicer-wasm/harness/prime-tower-slice-settings-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
```

It confirms the DeltaMaker negative-coordinate bed and exported Prime Tower
motion follow Prepare after a native tower move. The merge changes no native
source; parent verified every source/artifact hash in the retained production
receipt still matches. Production serial WASM SHA256 is
`3e59fbf9ab4cee367c62dee48e7673625ca1c747a83d5ca98cb5bf4e6e180de8`;
gated WASM is
`e83626b953c4ea4e44b970bf875516bfbae469566b44d1703d83b870cb6e8308`.
Production is Release, threading 0, painting profiling OFF, history hooks OFF.
Parent confirmed commit-failure, restore-failure and cache-snapshot hooks are
absent from production JS/WASM. The pinned C++ submodule remains unchanged.

Two optional exploratory child checks remain **failing**, not accepted evidence:
`multi-filament-command-smoke.mjs --module <gated module>` stops at imported
scenario-reset identity equality (`filament-259` versus `filament-3`), before its
history navigation cases; `preset-draft-registry-smoke.mjs --module <gated module>`
stops at a nullable source vector assertion (`nil,nil,nil,nil,nil,nil` versus
`nil`). Parent inspected those assertions and call paths; their current failures
do not exercise the new painting restore paths. They must be reconciled at step
19 if part of the applicable qualification gate. Host E2E, threaded build and full
release qualification are intentionally deferred: this native foundation keeps
new editors hidden. No downstream seam/fuzzy/support effects are claimed here.

### 15. Complete seam editor, native persistence and downstream slicing

**Status:** Accepted by parent (2026-10-02). **Depends on:** 14 accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** W+A+E.

**Allowed scope:** Shared painting adapter/provider/controller/panel/toolbar,
native seam screen-X constraint and channel reconciliation; native-format fixtures,
seam save/slice harness, actual-draw/interaction E2E and gated probes.

**Functional output:** A complete seam editor with circle/sphere and
Enforce/Block/Erase; Vertical constrains native drag screen X using the current
camera snapshot. Per-channel memory-only tool parameters, single-filament entry,
active-channel colours and normal MMU scene return work. Idle switching normally
closes the old channel before opening the new one; failed closure prevents entry.
All existing mounted lifetime, command/terminal/history/save/slice policies apply.
Provide a separate seam toolbar entry following Orca’s independent gizmo entries;
support/fuzzy entries remain hidden until their complete steps. Expose seam only
when this complete boundary passes acceptance.

**Child self-check:** Serial quick and real seam annotation/save/reopen/slice
cases, A, affected transport typechecks and extended real Electron journey.
Prove transformed/camera-rotated screen-X behavior; 0/1/2 independent persistence;
erase/cancel/Undo/Redo and actual native seam placement effects; busy ignored
switches, close failure/retry, normal pan/erase shortcuts and ordinary MMU colours.
Production builds and elision are required for new probe paths.

**Accepted implementation and child self-verification (2026-10-02):**

The separate Seam painting toolbar entry opens the shared mounted controller with
single-filament admission; MMU retains its entry-only two-filament gate. The seam
panel exposes only Circle/Sphere, Enforce/Block/Erase, Vertical, radius and Erase
all. Support/fuzzy entries remain absent. Idle switches close/settle the previous
history session before entry; busy switches are discarded and close failure
requires a successful retry. Each channel retains its own memory-only tool and
settings, including inactive MMU choice reconciliation after slot deletion/merge.
Seam commits invalidate plate results while retaining ordinary MMU geometry/BVH.

Native Vertical substitutes the stroke's initial CSS screen X before hit testing
and one-pixel trajectory projection using the supplied camera matrices. Turning
Vertical off uses the actual pointer; turning it on retains the stroke anchor.
The visual cursor mirrors that projection while raw input remains native-owned.
Native tests exercise Circle/Sphere on a rotated, mirrored, non-uniformly scaled
part and a rotated camera; the real renderer records projected cursor agreement.

Self-check commands and results:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm typecheck
emcmake cmake -S packages/slicer-wasm -B packages/slicer-wasm/.work/serial/build -DNEO_PROJECT_HISTORY_TEST=ON -DNEO_PAINTING_PROFILE=OFF
cmake --build packages/slicer-wasm/.work/serial/build --target orca_slice painting_session_test timestamped_history_core_test -j 8
pnpm exec node packages/slicer-wasm/.work/serial/build/painting_session_test.cjs
pnpm exec node packages/slicer-wasm/.work/serial/build/timestamped_history_core_test.cjs
pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/.work/step15-history-test/orca_slice.js --expect-test-hooks
pnpm exec node packages/slicer-wasm/harness/painting-history-plate-smoke.mjs packages/slicer-wasm/.work/step15-history-test/orca_slice.js --expect-test-hooks
pnpm exec node packages/slicer-wasm/harness/history-editing-session-smoke.mjs packages/slicer-wasm/.work/step15-history-test/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/.work/step15-history-test/orca_slice.js
emcmake cmake -S packages/slicer-wasm -B packages/slicer-wasm/.work/serial/build -DNEO_PROJECT_HISTORY_TEST=OFF -DNEO_PAINTING_PROFILE=OFF
bash scripts/build.sh quick --variant serial -j 8
pnpm exec node packages/slicer-wasm/harness/painting-session-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/painting-engine-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/seam-painting-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --interop-only --expect-production
pnpm exec node scripts/run-painting-e2e.mjs
pnpm --filter @orca/desktop build
pnpm --filter @orca/web build
pnpm exec node scripts/check-painting-profile-elision.mjs
git diff --check
```

Workspace tests pass **1,312** tests (app 891, client 256, runtime 35); typecheck
passes. Gated native lifecycle/history tests and comprehensive backend/session/
history regressions pass; four-channel plate coverage includes 48 fresh slices
and 20 rollback injections. Serial production is restored with test/profile
gates OFF and threading 0. Imported fixtures still emit the previously recorded
missing-parent diagnostics while all assertions pass.

The generated native-format seam fixture proves all four exact per-triangle
annotation streams survive save/reopen, independent seam 0/1/2, split trees,
local erase, cancel, Undo/Redo and unchanged ordinary MMU resource keys. A
single-filament controlled cube proves actual outer-wall seam starts: baseline
0 starts in the front-face strip, Enforce 53, Block 0; Erase all exactly restores
the baseline. Undo/Redo, undo-erase and saved/reopened Enforce reproduce exact
seam-start coordinates. G-code, two saved native 3MFs and JSON evidence are in
`packages/slicer-wasm/.work/step15-seam/`; gated artifacts and SHA256SUMS are in
`packages/slicer-wasm/.work/step15-history-test/`.

The extended actual Electron journey exercises the distinct toolbar entries,
real green seam draw frames, rotated-camera screen-X cursor, Block, Shift erase,
Undo/Redo, cancel, middle/right pan, Ctrl-wheel, busy ignored switches, injected
RPC close failure/retry, exact per-channel parameter restoration and ordinary
MMU draw return. Its close-failure probe is gated in the existing painting probe;
production elision checks its new unique sentinels. Source/artifact hashes and
preserved renderer evidence are recorded in the child's final handoff receipt.

The full threaded/dual-host release matrix and quantitative performance remain
Step 19 qualification; no acceptance for those deferred checks is claimed here.
The pinned submodule remains unchanged. Independent parent acceptance follows.

**Parent acceptance:** Review input projection, native constraint, adapter/UI
availability, resource lifetime and failure paths. Rerun real seam fixture and
current-artifact journey plus app checks; inspect actual seam/state and viewport
evidence. Verify no world-Z substitution, other-channel changes or MMU regression.

**Independent parent acceptance (2026-10-02):**

The parent read every changed production path, focused regression and new native
harness, using graph change/flow analysis as a locator. The graph was built at
`dbee028` and could not establish current coverage; actual source and executed
native/renderer assertions supplied that evidence. Reviewed boundaries included
native screen-X projection before picking/interpolation, transformed geometry,
strict seam-only settings, mounted renderer ownership, per-channel parameter
memory, inactive MMU logical-slot reconciliation, exclusive input/close lanes,
failed closure/retry, reliable cancellation, resource retention and production
probe removal. The same child repaired findings about close/reopen parameter
retention, inactive MMU merge/delete reconciliation and constrained visual-cursor
agreement before final handoff. No unresolved acceptance defect remains.

At the user's renewed request, the parent fetched and merged main `86ce9f7` as
`c2c375a` before completing acceptance. The only merge conflict concerned an
existing colour-label test locator; main's exact label locator was retained.
The child's 25 source hashes were verified before merge, and all except that
expected locator delta matched afterward. Native sources/artifacts were unchanged
by the merge. Electron now runs the same typed painting session in a Node Worker
inside its utility process; Web retains its browser Worker. No Python capability
is introduced by this feature.

Independent commands and results:

```sh
NODE_OPTIONS=--no-experimental-webstorage pnpm test
pnpm typecheck
bash scripts/build.sh quick --variant serial -j 8
pnpm exec node packages/slicer-wasm/.work/step15-history-test/painting_session_test.cjs
pnpm exec node packages/slicer-wasm/.work/step15-history-test/timestamped_history_core_test.cjs
pnpm exec node packages/slicer-wasm/harness/seam-painting-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/.work/step15-history-test/orca_slice.js --expect-test-hooks
pnpm exec node packages/slicer-wasm/harness/painting-history-plate-smoke.mjs packages/slicer-wasm/.work/step15-history-test/orca_slice.js --expect-test-hooks
pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --interop-only --expect-production
NODE_OPTIONS=--no-experimental-webstorage pnpm exec node scripts/run-painting-e2e.mjs
pnpm --filter @orca/desktop build
pnpm --filter @orca/web build
pnpm exec node scripts/check-painting-profile-elision.mjs
git diff --check
```

All passed. Before merge the workspace passed 1,312 tests; after merge the parent
reran tests and typechecks: **1,320** tests across eight projects (app 891, client
260, runtime 36), with all typechecks passing. Serial quick and both native test
executables passed. The comprehensive backend retained all six MMU tools,
four-channel exact native annotations and fault rollback; plate/history tests
passed 48 fresh slices and 20 restore-failure injections. Production interop
observed 47,012 actual toolpath segments and MMU tools 0/1. The parent independently
reproduced Seam's 0/53/0 placement witness and exact erase/history/reopen positions.
The final Electron journey passed **1/1 in 36.5 seconds** on the merged utility
runtime, with source/staged serial artifact hashes checked by the runner. The
parent inspected its rotated-camera screenshot and draw evidence: separate armed
Seam entry/panel, constrained cursor, green seam draw and ordinary MMU return.

Final production desktop/Web builds passed; elision checked **24** production
artifacts including utility bundles. Native history/painting test hooks were
absent from production JS/WASM; the serial cache has history/profile gates OFF,
threading 0. Production SHA256s are JS
`2ddb6c4816bd1ceb2d8d14af9308f5f37cb6d6433fd2bc32a69ff7d685017889`, WASM
`57b894d7a3ab6877cd9db83924d1286a4a75a5f2e742231b2cc6fbb462667be7` and data
`6c5376312b22d659cf8e77c1e3596fe5b914c80121c51b0537b1b04d8983b12e`.
All preserved gated/native artifacts also matched the child's manifest. Parent
renderer evidence is preserved in `.work/step15-parent-electron-evidence/` under
slicer-wasm; child receipt remains `.work/step15-handoff.json`. Changed local
link targets and command paths were verified against authoritative sources.

Node 26.7.0 differs from the pinned 24.19.0, so browser/jsdom checks used the stated
Node flag. Previously recorded missing-parent fixture diagnostics and Web chunk
warnings remain non-failing. Threaded/full-host release qualification and
quantitative performance are intentionally not run in this piece; they remain
step 19 gates. Earlier optional step-14 harness failures retain their recorded
status and are not reclassified by this acceptance.

### 16. Native Smart Fill and support Gap/overhang foundations

**Status:** Accepted by parent. **Depends on:** 15 accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** W+T+A.

**Allowed scope:** Non-GUI native selection/preview/Apply adapters, typed settings
and draft resource transport, affected shared preview controls not yet exposed,
transformed/generated fixtures and real engine/backend harnesses.

**Functional output:** Support/fuzzy Smart Fill uses `seed_fill_select_triangles`
with native geometry/angle membership, not MMU `bucket_fill_select_triangles`
same-state Region Fill. Candidate preview and committed selection use identical
settings and revision. Support Gap Fill calculates object-wide native destinations
and preview/Apply parity with 0/1/2 states; overhang highlighting/restricted
painting uses transformed native surface/angle semantics. No support generation
preview, horizontal restriction or angle-batch marking. Support/fuzzy entrypoints
and consumer controls remain hidden until their complete editor stages.

**Child self-check:** Serial quick, real engine/backend selection fixtures,
affected full suites/typechecks. Prove differently painted adjacent facets
separate native Smart Fill from MMU Region Fill; transformed/multipart and
boundary-angle membership, stale preview rejection, restriction enforcement,
Gap destination-state/Apply parity and preview-only no dirty/history writes.
All-six MMU and seam regressions remain passing.

**Parent acceptance:** Read algorithm dispatch, transformed normals/camera/angles,
state/tree ownership, candidate resource revisions and Apply atomicity; rerun real
native membership/annotation assertions and affected checks. No unfinished
support/fuzzy consumer is exposed and existing Region Fill semantics are retained.

**Step 16 accepted implementation:** Native `smartFill` is a
separate support/fuzzy tool. It calls pinned `seed_fill_select_triangles`, follows
local source-normal edge angles across original facets and their subdivision
children, and ignores existing paint states. MMU `region` retains its state-barrier
bucket fill. Smart Fill requires a numeric 0–90 degree angle; `null` remains an
MMU Region-only way to disable geometry edge detection. Preview and actual stroke
share the native parameters and channel revision; candidate admission checks the
complete settings, including overhang threshold/restriction and brush dimensions.
Support `gap` uses the existing object-wide native patch algorithm and ordered
lowest adjacent state (0 before 1 before 2), with preview-only calculation and
one Apply transaction over all solid parts.

Support overhang geometry is an independent, native-owned overlay. It survives
Smart Fill/Gap candidate replacement, drawing, cancellation, commit, target
changes and history reconciliation. Its `ph-support` identity depends on the
active draft geometry revision and highlight-setting revision; unchanged hover
reuses its buffers. Transform/target changes invalidate the highlight identity
without invalidating unchanged local-space draft buffers. Native inverse-transpose
normalized surface normals and the pinned strict cosine comparison determine
membership. A numeric zero disables the native filter and includes every eligible
leaf; `null` clears the overlay. Restricted painting requires a numeric angle.
The 90-degree pinned float-radian boundary admits exactly vertical side normals;
the adapter intentionally matches that native behavior. Circle, sphere and Smart
Fill pass the same restriction into native selection. Highlight requests grant
no Apply candidate receipt and never write annotations, dirty state or history.
Typed resource validation rejects cross-channel, stale/future and unsafe revision
identities; native leases and shared buffers are disposed on clear/replacement.

Support/fuzzy toolbar entries and their consumer controls remain hidden. The
existing shared overlay renderer/resources can retain highlights concurrently
with selection candidates. MMU and Seam continue to reject Smart Fill and omit
support-only settings from native requests. No support generation preview,
horizontal restriction, angle batch operation or later editor step is included.

The [foundation harness](../packages/slicer-wasm/harness/painting-foundations-smoke.mjs)
compares actual native preview/edit membership, annotations, project/history and
plate snapshots, retained/cleared highlights, restrictions, gap destinations and
unchanged channel streams. Focused C++ fixtures additionally cover multipart Gap,
all destinations, adjacent different-state selection, mirrored/nonuniform/tilted
transforms and below/at/above angular boundaries. Child self-verification passed:

- Focused native C++ test: configure with
  `emcmake cmake -S packages/slicer-wasm -B packages/slicer-wasm/.work/serial/build -DNEO_PROJECT_HISTORY_TEST=ON -DNEO_PAINTING_PROFILE=OFF`,
  build with `ninja -C packages/slicer-wasm/.work/serial/build painting_session_test -j 8`,
  and run the preserved executable with
  `pnpm exec node packages/slicer-wasm/.work/step16-native/painting_session_test.cjs`.
  It covers the new native fixtures plus six-tool, seam and lifecycle regressions.
- Restore production with the same configure command using
  `-DNEO_PROJECT_HISTORY_TEST=OFF -DNEO_PAINTING_PROFILE=OFF`, then
  `bash scripts/build.sh quick --variant serial -j 8`; final flags are OFF/OFF
  and `WASM_THREADING=0`. The driver requires `-j 8`, not `-j8`.
- `pnpm exec node packages/slicer-wasm/harness/painting-foundations-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`:
  all new foundation assertions pass, including committed support/fuzzy tree
  independence and unchanged preview-only history/plate/project observations.
- `pnpm exec node packages/slicer-wasm/harness/painting-backend-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js --expect-production`:
  comprehensive production publication/geometry/history/remapping/3MF/slicing
  checks pass, with actual MMU downstream output of 47,012 segments. Injected
  rollback hooks are compiled out of this ordinary artifact.
- `pnpm exec node packages/slicer-wasm/harness/painting-engine-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`
  and the equivalent `painting-session-smoke.mjs` command: six-tool and native
  lifecycle regressions pass.
- `pnpm exec node packages/slicer-wasm/harness/seam-painting-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js packages/slicer-wasm/.work/step16-seam`:
  native 0/1/2, tree round-trip and actual seam placement pass (0 baseline,
  53 enforced and 0 blocked). The optional evidence directory preserves the
  prior accepted step's artifacts.
- Root `NODE_OPTIONS=--no-experimental-webstorage pnpm test` and the equivalent
  `pnpm typecheck`: pass on Node 26.7.0: 1,328 tests, including app 893 and client 266. Node 24.19.0 remains the repository pin.
- `NODE_OPTIONS=--no-experimental-webstorage pnpm exec node scripts/run-painting-e2e.mjs`:
  current-artifact real Electron utility-worker painting journey passes 1/1
  (35.9 seconds), including MMU and Seam. Source/staged module hashes match.
- Sequential `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @orca/desktop build`
  and `pnpm --filter @orca/web build`, then
  `pnpm exec node scripts/check-painting-profile-elision.mjs`: pass; instrumentation
  is absent from all 24 inspected ordinary production artifacts.
- `git diff --check` and changed local-link/command checks pass.

Final production serial SHA256 values: JS
`bfd296e2107ab85196b4fc72146fd387e3e55e20f99a7ebeea7a179ebba69e65`, WASM
`d5271e3c9e818d6c3c583c56575c8492e286d1f5ffba3cb6fff03b1cf82e2d44`, data
`6c5376312b22d659cf8e77c1e3596fe5b914c80121c51b0537b1b04d8983b12e`.
Desktop staged JS/WASM/data match the native artifact byte-for-byte. Web
WASM/data also match; its ordinary web-only JS loader exactly matches the
existing `apps/web/vite.config.ts` Node-import/process removal transform and has
SHA256 `1a9943cc5a33b6af3d53f50f2b10ff96b36bdd7725376ee1443286e076e99c91`.
Logs, preserved gated native executable/cache/source manifest, seam/Electron
evidence, all changed-source hashes and artifact hashes are listed in
`packages/slicer-wasm/.work/step16-handoff.json`. Pinned C++ remains
`489cbe91840ff97aaf4d8029009d5db410f32893`, with no submodule modifications.

Full Web/dual-variant/release/performance qualification remains step 19. Complete
support/fuzzy editor and slicing-effect acceptance remain steps 18/17. Existing
optional multi-filament command and nullable preset-draft smoke limitations from
step 14 were not rerun or relabeled as passing.

**Independent parent acceptance (2026-10-02):** The parent read every changed
production/test file and the new harness, including native selection and
candidate admission, bridge publication/resource leases, strict client manifests,
mock parity, controller tool/settings/display ownership and renderer resource
retention. Graph change detection was used first, but its index was still built
at `dbee028`; the review used current source and executable tests for coverage.
Review repairs completed by this step's same child included independent highlight
lifetime, transform-specific highlight invalidation without draft rebuilding,
Support-only settings stripping, exact pinned angular boundaries, all Gap
destinations, committed Fuzzy tree isolation and safe/future resource revisions.
The parent folded the resulting accepted semantics into section 2.4 of the spec.

Parent independently passed the same root test command (1,328 tests) and
`pnpm typecheck`, the serial quick command, preserved native C++ executable,
foundation/backend/engine/session harnesses, and seam harness with the separate
output directory `packages/slicer-wasm/.work/step16-parent-seam`. The native
backend again produced 47,012 MMU segments; seam remained 0/53/0 with exact
erase/history/save-reopen checks. The current-artifact Electron runner passed
1/1 (40.9 seconds), and the parent inspected its rotated-camera Seam screenshot.
Evidence is preserved in `packages/slicer-wasm/.work/step16-parent-electron-evidence`.
Sequential ordinary Desktop then Web builds and the elision command passed on
24 artifacts. All 21 child source hashes and 11 artifact hashes were verified;
after parent rebuilds, artifact hashes still match the receipt. The actual serial
JS/WASM omit all three native history/painting test exports, with OFF/OFF/0 flags.
The parent also verified the pinned submodule is clean, re-fetched `origin/main`
at `86ce9f7` and confirmed it is already an ancestor of this branch. Parent logs
are `/tmp/painting-step16-parent-*.log`. Changed documentation links/anchors and
commands and `git diff --check` passed. The stated step-17/18/19 qualification
limits remain; no later child was launched before this acceptance. Step 16 accepted.

### 17. Complete fuzzy-skin editor and explicit configuration action

**Status:** Accepted by parent on 2026-10-02. **Depends on:** 16 accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** W+A+E.

**Allowed scope:** Shared fuzzy adapter/panel/provider and existing scoped-config
mutation/read projection, native downstream fixtures/save/slice harnesses,
focused inherited-configuration tests and real journey extension.

**Functional output:** Circle/sphere/triangle/Smart Fill, Enable/Erase and exactly
0/1 native states, single-filament entry and channel colours. Resolve effective
fuzzy settings with applicable inherited scopes. Editing while `disabled_fuzzy`
is allowed with a clear warning. Explicit object-scoped enable sets `none`
(Painted only) through the existing config path as an independent non-paint
history operation; no brush silently enables it. Warning reflects still-applicable
more-specific overrides. Erase does not override whole-surface modes. Preserve
fuzzy-plus-MMU and native XY-compensation warnings. Expose only after acceptance.

**Child self-check:** A and affected config/transport tests/typechecks, serial quick
if native changes, current real fuzzy save/reopen and slice harness/journey.
Observe native fuzzy segmentation/toolpath effects, disabled annotations with no
fuzzy texture, explicit enable and separate config Undo/Redo, inherited/object/part
settings, whole-surface erase, mixed channels and warnings. Prove other channel
bytes and ordinary MMU material rendering unchanged; production probe elision.

**Parent acceptance:** Review scope resolution and mutation/history boundaries,
Smart Fill integration, resources and controls. Independently rerun native effects,
configuration/history behavior and current journey plus affected checks. A stored
fuzzy annotation alone does not establish downstream acceptance.

**Implementation / child self-check (2026-10-02):** The dedicated Fuzzy toolbar
entry is ordered between Seam and MMU; Support remains hidden. Its shared mounted
controller, own wrapper and panel expose Circle, Sphere, Triangle and native Smart
Fill with Enable/Erase, independent memory-only parameters and native neutral/green
colours. MMU toolbar matching is explicitly `channel === 'mmu'`. Effective fuzzy
modes reuse the existing native scoped projection for each solid part and parameter
modifier; native names/enum labels and provenance identify surviving overrides.
Missing, unknown or refresh-required projections remain unavailable. Explicit
object enable captures the stable object ID and uses the existing scoped mutation
coordinator, creating an independent configuration history separator. Brushing never
enables configuration; busy actions are ignored and failures remain retryable.

The [native fuzzy harness](../packages/slicer-wasm/harness/fuzzy-painting-smoke.mjs)
proves all four tools make effective 0→1 edits, exact four-field native split-tree
save/reopen, unchanged other-channel trees and ordinary MMU resource keys,
erase/cancel/Undo/Redo, disabled/no-jitter versus Painted only/jitter, independent
configuration and paint Undo/Redo, Project/object/part inheritance, retained part
and coincident modifier overrides, all whole-surface modes after erase, and actual
MMU+fuzzy dual-tool G-code. Baseline/disabled/independent history-disabled paths
produce 290 extrusion commands; Painted only produces 10,620. A modifier override
reduces 10,587 inherited commands to 290 and retains that result after reopen.
The solid cube has no holes: Hole mode proves native configuration/painted effect
and erased contour baseline, not textured hole-surface geometry.

A required warning-retention repair in `bridge_slicing_pipeline.cpp` projects
current native Print/PrintObject step warnings into the existing durable string
array before completed-result publication, within its existing exception boundary.
This preserves native XY-compensation messages/object names through serial progress
coalescing. Durable enabled/disabled warnings, erased/cached warning removal and a
live unrelated object on another plate all pass. The ABI and pinned submodule
remain unchanged.

Checks run: focused app/controller/panel/scoped-projection/toolbar checks (131 tests),
`NODE_OPTIONS=--no-experimental-webstorage pnpm test` (143 files, 1,337 tests),
`NODE_OPTIONS=--no-experimental-webstorage pnpm typecheck`, production
`bash scripts/build.sh quick --variant serial -j 8` (Release, history-test OFF,
painting-profile OFF, threading 0), the current serial fuzzy harness and accepted
Smart Fill/overhang foundation harness, the existing Prime Tower slice-settings
warning/result regression, and the current real Electron painting
journey (one test, 36.7 seconds) all pass. The journey retains all six MMU tools,
Seam controls and adds real Fuzzy control routing, effective edits, configuration
history, independent channel parameters and ordinary MMU rendering after close.
Production Desktop then Web builds ran sequentially; production probe elision
passes across 24 artifacts. Source/build/out/staged serial artifacts and the exact
existing transformed Web loader are checked by the handoff receipt. Build warnings
are the existing macro redefinitions and Vite chunk-size advisory.

Evidence and exact command logs are retained in ignored
`packages/slicer-wasm/.work/step17-native/` and
`packages/slicer-wasm/.work/step17-electron-final/`; the source/artifact/fixture receipts
are in `packages/slicer-wasm/.work/step17-handoff.json`. Repaired development
attempts are recorded in `step17-native/attempts.txt`; no failing attempt is claimed
as passing. Code-review-graph tools were unavailable to the child, so focused
source review was used. Full Web/dual-variant/release/performance qualification,
textured hole geometry and the previously recorded unrelated multi-filament
logical-ID/preset-draft optional probes remain stage 19 work. No parent acceptance,
roadmap milestone change or commit is claimed here.

**Independent parent acceptance (2026-10-02):** Reviewed all 15 handed-off
source files, including the native warning publication and its failure boundary,
scoped inheritance and stable-target mutation, mounted controller admission,
resource colours, toolbar order and actual journey assertions. Graph change
analysis reported 41 affected flows but was built at `dbee028`; its missing test
edges were checked against current source/tests rather than treated as coverage
results. Accepted the repaired unavailable/stale configuration handling, separate
configuration history, effective tool-edit assertions and durable current warnings.
Clarified the specification: disabled annotations produce no fuzzy texture but
still trigger the pinned native XY-compensation behavior.

Independently verified every handoff source/artifact/evidence hash, deleted only
the derived slicing-pipeline object, and forced the current serial quick rebuild.
The rebuilt object and JS/WASM/data hashes match the child receipt. Parent checks:

- `NODE_OPTIONS=--no-experimental-webstorage pnpm test`: **143 files / 1,337 tests passed**.
- `pnpm typecheck`: all workspace packages passed.
- `bash scripts/build.sh quick --variant serial -j 8`: current Release, history-test
  OFF, painting-profile OFF, threading 0 build passed.
- Current serial `fuzzy-painting-smoke.mjs` with separate
  `.work/step17-parent-fuzzy` output: all four effective tool edits, exact native
  fields/save/reopen, disabled/explicit-enable and independent configuration/paint
  history, scoped part/modifier inheritance, whole-mode effects, actual dual-tool
  MMU+Fuzzy G-code and durable XY warnings passed. Baseline/disabled 290 versus
  enabled 10,620 extrusion commands; modifier Disabled restored 290.
- Current serial `painting-foundations-smoke.mjs`,
  `painting-backend-smoke.mjs --expect-production`, `seam-painting-smoke.mjs`
  (separate `.work/step17-parent-seam`) and
  `prime-tower-slice-settings-smoke.mjs`: passed. Backend retained 47,012 MMU
  segments; Seam placement remained baseline 0 / Enforce 53 / Block 0.
- `NODE_OPTIONS=--no-experimental-webstorage pnpm exec node scripts/run-painting-e2e.mjs`:
  actual current Electron utility-process/Node Worker journey passed **1/1, 49.4 s**.
  Preserved 73 evidence files in `.work/step17-parent-electron-evidence` before
  restoring production builds.
- Production Desktop then Web builds ran sequentially and passed;
  `check-painting-profile-elision.mjs` passed **24 artifacts**. Actual serial and
  existing threaded export tables contain none of the three native test hooks;
  this is not a current threaded stage-17 build qualification.
- Changed local links/anchors, command paths and `git diff --check`: passed.
  Pinned `cpp` remains clean at `489cbe91840ff97aaf4d8029009d5db410f32893`.

Parent logs are `/tmp/painting-step17-parent-*.log`; preserved native fixtures,
G-code and host evidence use the directories above. Accepted production hashes:
JS `bfd296e2107ab85196b4fc72146fd387e3e55e20f99a7ebeea7a179ebba69e65`,
WASM `37d350870f93eca8e4756b5443ef9b34fc2bee1df0dbe3fd7921b7709e5019c0`,
data `6c5376312b22d659cf8e77c1e3596fe5b914c80121c51b0537b1b04d8983b12e`.
Node 26.7.0 differs from pinned 24.19.0; the stated Web Storage switch was used
for jsdom. Current dual-variant/Web/release gates, textured hole-surface evidence,
performance and the two recorded optional probes remain step 19. No full adapter
milestone or quantitative performance threshold is claimed by this acceptance.

### 18. Complete support editor and derived projection integration

**Status:** Accepted by parent on 2026-10-02. **Depends on:** 17 accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** W+A+E.

**Allowed scope:** Shared support adapter/panel/controller and native consumers
of accepted fill/overhang/Gap paths, support-use/Prime Tower settlement where
required, save/slice fixtures/harnesses and focused current-artifact E2E.

**Functional output:** Circle/sphere/Smart Fill/Gap Fill and explicit
Enforce/Block/Erase. Overhang highlight/restriction and object-wide Gap Apply work
without preview-only edits. State 0 restores default automatic support policy;
it does not force no-support. Single-filament projects remain eligible. Maintain
independent native tree, memory-only parameters, normal close/switch, deferred
support-use/Prime Tower settlement and MMU-only ordinary scene colours. Expose
support only after the complete stage is accepted.

**Child self-check:** A, affected native/client/runtime suites/typechecks, serial
quick and actual support save/reopen/slice/Undo/Redo fixtures and journey. Observe
support generation changes after enforce/block/erase, transformed overhang
restriction and Gap parity, unchanged other fields, affected-plate freshness and
support-filament usage/Prime Tower settlement. Include busy/failure/cancellation
and no-op preview paths; production probe elision.

**Parent acceptance:** Review restriction/Apply admission and atomic commits,
downstream support/derived dependencies and UI resources. Rerun real native
support outcomes and settlement assertions plus app/transport checks and journey.
No support-generation preview or deferred auxiliary control is exposed.

**Step 18 implementation (accepted by parent 2026-10-02):** The dedicated Support
entry precedes Seam, Fuzzy and MMU. Its own panel/wrapper uses native 0
Auto/Default, 1 Enforce and 2 Block, with explicit Enforce/Block/Erase and
Circle/Sphere/Smart Fill/Gap Fill. Smart Fill requires a numeric 0–90 local-normal
edge angle. Gap uses object-wide native preview and one Apply transaction; it
retains lowest-neighbor destination states including zero, and never uses a
clicked region. The panel disables the brush-only overhang restriction control
for Gap and explains that Gap remains unrestricted.

The shared controller schedules independent overhang angle/null RPCs on its
existing single lane. Threshold changes coalesce; highlight-only work is admitted
only while idle, so a held stroke cannot create repeated empty display reads.
Highlight preference is retained separately per channel and grants no candidate
or Apply ownership. Native geometry revision/transform/history reconciliation
owns highlight identities while unchanged local-space draft buffers and hover
highlights remain reusable. Candidate and highlight resources render together:
amber transparent highlights precede white selection fills, use distinct depth
bias, and neither overlay writes depth. Existing ordinary Prepare rendering
remains MMU-only. No native ABI, Worker architecture, generation-preview control,
or implicit support-configuration mutation is introduced. Existing stage-14
commit invalidation and close/history settlement publish support-use/Prime Tower
projections at the existing lifecycle boundary.

**Step 18 child self-check:** `NODE_OPTIONS=--no-experimental-webstorage pnpm test`
passed 144 files / 1345 tests, and the same environment with `pnpm typecheck`
passed every workspace package. Focused Support panel/controller/toolbar tests
cover single-slot entry, independent parameters, explicit native angle/null,
live-threshold bounded scheduling, preview nonmutation, failure/close admission
and target/history reconciliation. `bash scripts/build.sh quick --variant serial
-j 8` passed against the current production source; Ninja reported no work
because no native source changed. Release cache retains history/profile hooks
OFF. `pnpm exec node packages/slicer-wasm/.work/serial/build/painting_session_test.cjs`
and the current serial `painting-foundations-smoke.mjs` harness passed native
Smart Fill, transformed restriction/0/90 boundaries, Gap state-zero parity,
candidate staleness and four-field independence. The current
[support native harness](../packages/slicer-wasm/harness/support-painting-smoke.mjs)
proves native single-filament editing, independent split-tree save/reopen,
Enforce/Block/Erase, cancellation,
Undo/Redo, actual native support generation and unchanged support configuration.
The grounded mushroom fixture explicitly selects manual/automatic support
configuration rather than enabling support through painting. Manual support
extrusion counts are 0 baseline, 1937 Enforce, 0 Block, 1937 Undo, 0 Redo, 0 Erase,
and 1937 after save/reopen; automatic Erase restores generated support rather
than forcing no-support. Actual support extrusion uses native configured slot 2.
Native config-driven Prime Tower usage remains slots 1/2 and eligible; settlement
refreshes native material/plate/history revisions; stale affected receipts are
rejected while unrelated plate receipts and tower projections remain reusable.
It does so without inventing
annotation-driven slot removal. The imported project material routing projection
continues to report its existing project/object support default 0; actual native
Print configuration, tower slot usage and support G-code independently prove
configured slot 2 consumption. This existing projection distinction is retained.

`NODE_OPTIONS=--no-experimental-webstorage pnpm exec node scripts/run-painting-e2e.mjs`
passed the final current-serial Electron journey (37.6 seconds): all six MMU
operations plus Seam, Fuzzy and Support, simultaneous retained native highlight
and Smart Fill draws, MMU region depth behavior, Support state edits/Undo/Redo,
Gap no-op, explicit clearing, independent editor parameters and ordinary MMU-only
rendering after close. The actual Support editor screenshot was visually checked
with simultaneous Smart Fill/overhang state and all panel controls visible.
Test evidence is retained under
`packages/slicer-wasm/.work/step18-*`; sequential ordinary Desktop and Web builds
and painting-profile elision in 24 production artifacts passed, as did
`git diff --check`. The current serial Fuzzy downstream/MMU/XY-warning/modifier
harness also passed. The handoff manifest records exact commands,
source/artifact/evidence hashes and repaired attempts. Full Web, dual-variant,
release/performance qualification and previously recorded optional stage-14
logical-ID/scalar/vector probes remain stage-19 work. No parent acceptance or
milestone status is claimed here.

**Independent parent acceptance (2026-10-02):** Reviewed all 14 final changed
source files and the existing native restriction/Gap/usage/settlement boundaries.
Graph change detection/flow review reported 26 flows but still used the earlier
`dbee028` graph, so current source/tests and direct native evidence supplied the
coverage review. Confirmed dedicated toolbar order Support/Seam/Fuzzy/MMU,
single-slot admission, idle close/settle/switch, stable native state identity,
channel-only settings, explicit angle/null highlight transport and candidate
ownership separation. Required and accepted the bounded held-stroke scheduling
repair, exact four BBS attributes with nonempty independent witnesses, automatic
support default restoration, effective T1 support use and actual unaffected-plate
receipt reuse. Reviewed the independent highlight/selection render ordering and
no-depth-write overlays; inspected the actual parent-run screenshot with all
Support controls visible. The specification now states the native restriction's
three-tool scope and the final independent toolbar order explicitly.

Parent independently verified **14 source, 51 native-source, 15 artifact and 328
evidence hashes**, plus the four affected native object identities. No native
source changed in this step. Actual parent checks:

- `NODE_OPTIONS=--no-experimental-webstorage pnpm test`: **144 files / 1,345 tests passed**;
  `pnpm typecheck`: all workspace packages passed.
- `bash scripts/build.sh quick --variant serial -j 8`: current Release production
  serial build validated/staged, Ninja no work; history/profile hooks OFF.
- Current serial `support-painting-smoke.mjs` with separate
  `.work/step18-parent-support` output: independent native fields, single-slot
  editing, cancel/erase/history/save/reopen, unchanged support configuration,
  actual manual generation **0 / Enforce 1,937 / Block 0 / Undo 1,937 / Redo 0 /
  Erase 0 / reopen 1,937** passed. Automatic generation **1,937 / Block 0 /
  Erase 1,937** passed. Support uses T1; native tower used slots remain [1,2].
  Affected stale receipt rejection, unaffected receipt reuse/tower equality,
  native material/history/plate revision settlement all passed. The recorded
  default-zero material routing projection distinction remains unchanged.
- Current serial `painting-foundations-smoke.mjs` and `fuzzy-painting-smoke.mjs`
  (separate `.work/step18-parent-foundations` / `.work/step18-parent-fuzzy`), plus
  full `painting-backend-smoke.mjs --expect-production`: passed. Native transformed
  overhang/Gap parity and Fuzzy configuration/XY-warning/modifier behavior remain
  intact; MMU downstream retained 47,012 segments.
- `NODE_OPTIONS=--no-experimental-webstorage pnpm exec node scripts/run-painting-e2e.mjs`:
  current Electron utility-process/Node Worker all-channel journey **1/1 passed,
  52.7 s**. Preserved and inspected the screenshot and 78 evidence files in
  `.work/step18-parent-electron-evidence` before restoring ordinary builds.
- Ordinary Desktop then Web builds passed sequentially;
  `check-painting-profile-elision.mjs` passed **24 artifacts**. All 15 normal
  serial build/out/staged/Desktop/Web artifact hashes match the handoff after
  restoration. Pinned submodule is clean at
  `489cbe91840ff97aaf4d8029009d5db410f32893`.
- Changed local links/anchors, actual command paths and `git diff --check`: passed.

Parent logs are `/tmp/painting-step18-parent-*.log`; native/host outputs use the
separate directories above. Production serial JS/WASM/data retain stage 17's
accepted identities. Node 26.7.0 differs from the pinned 24.19.0 and jsdom used
the stated Web Storage switch. Full current threaded/Web/release gates,
textured-hole Fuzzy evidence, measurements and the recorded optional probes
remain step 19; this acceptance claims no full adapter milestone or numeric
performance threshold.

### 19. Interoperability, both hosts/variants and measured qualification

**Status:** Accepted by parent on 2026-10-03. **Depends on:** 18 accepted/committed.
**Model:** gpt-6.1-sol / medium. **Verification:** R+P and milestone gate if claiming delivery.

**Allowed scope:** Channel fixtures, native compatibility/save/slice harnesses,
Electron/Web journeys, gated benchmark corpus/instrumentation, bounded defects
against accepted requirements. Parent updates this record, spec and both roadmaps.

**Functional output:** Fulfil [adapter acceptance](../spec/Surface%20Painting%20Architecture.md#92-required-adapter-editing-and-interoperability-acceptance):
four-channel editing/save/reopen and native BBS attributes, actual downstream
slicing, strict contracts, all MMU regressions, history/cache/derived-use restore,
channel switches, failures, lifecycle and cross-host desktop input. Both current
WASM variants must be qualified; native interoperability and fuzzy-plus-MMU/
XY-compensation behavior must be preserved. Record representative channel costs
and memory under the existing methodology without inventing thresholds/cutoffs.

**Child self-check:** `pnpm test`, `pnpm typecheck`, both quick builds and native
smokes, comprehensive channel contract/roundtrip harness on one variant plus
focused startup/channel/save/slice on the other (both comprehensive contracts
when variant-dependent code warrants it). Real Electron and Web threaded/serial
journeys verify current artifact identities, download/save/reopen and runtime
admission/cancellation; production builds/elision and non-root deployment where
affected. Run the full release matrix in the testing guide when claiming
milestone delivery. Record reproducible measurements, environment/build/fixture
identities and missing pinned-native comparison explicitly.

**Parent acceptance:** Independently review affected flows, fixture independence,
actual downstream assertions, production gates and measured evidence. Rerun root
checks, both native builds/applicable smokes, required host/variant/interop gates
and representative measurements. No delivered checkbox with required checks
missing/failing. Numeric threshold approval and unavailable native performance
comparison remain explicit limitations, separate from functional qualification.

**Stage 19 implementation and child self-check:**

Both current production WASM variants passed the four-channel contracts. The
final host qualification passed root tests (1,346), root typecheck, dual quick
build/smoke, the 28 production native harness runs, the instrumented serial
backend/history fault suites, full mock Electron (44 passes/12 existing skips),
real Electron project/performance (10/10), real rack (5/5), the six-tool painting
journey, the four-channel imported/adapters/cancellation journey, and both full
Web variants (12 passes/one separately gated benchmark each). The dedicated
Prime Tower warning fixture passed. Ordinary macOS packaging, real packaged
slice/export and startup/missing/corrupt profile probes passed (4/4); the core
ZIP was restored byte for byte. Web non-root deployment, painting elision (26
artifacts), real-project-profile exclusion and actual initialized native export
checks passed. Both production caches have all three `NEO_*` instrumentation/test
flags OFF. No pinned C++ source or submodule pointer changed.

Browser journeys save `paint_color`, `paint_supports`, `paint_seam` and
`paint_fuzzy_skin`, reopen the actual downloaded bytes through the file chooser,
verify each nonempty channel and ordinary MMU rendering, and reexport identical
canonical per-triangle fields, including subdivision strings. Reopening restores
object selection across both instances; actual Alt single-part picking selects
one current native object/instance before testing painting eligibility. During
serial slicing, all four entries disable with the same selected identities and
without toggling selection. Both hosts exercise panel states, Shift erasing,
Undo, right/middle pan and mounted hidden viewport navigation. Three ordinary
Electron Cancel attempts use physical clicks immediately after the button becomes
enabled; each native acceptance is followed by `slice cancelled` and Ready with
no error. A separate test fixes native-terminal-before-DOM-Cancel order, observes
`no active slice job`, verifies natural Sliced/no-error convergence, and completes
a subsequent actual slice after a real edit. This deterministic race check does
not establish the cause of an earlier Error attempt without transport receipts.

The Fuzzy harness now uses a closed square-ring prism with a real through-hole.
Its modal XYZ/E parser identifies positive-extrusion inner perimeters inside the
retained hole bounds: the disabled baseline has 804 segments, while erased Hole
mode has 4,490 textured segments. Other annotation fields remain identical. A
solid cube alone did not prove hole behavior. Current threaded Fuzzy finalization
also retains native XY-compensation warnings after the worker join.

Bounded test repairs preserve actual macOS native menus, use Meta for additive
selection, wait for File Manager navigation and a fresh New Project native
reset-history request/response, refresh painting coordinates after restoration,
and resolve `.app` resources. Fresh project loads allocate new runtime filament
IDs; exact Undo/Redo identity remains asserted within each history. Nullable and
numeric preset vector expectations follow exported native slot/variant metadata,
retaining untouched tails. The mixed-temperature rejection fixture similarly
expands temperatures/ranges by native `filament_self_index` and
`filament_extruder_variant`; rejection and actual T0/T1 output assertions remain.
An invalidated projection read crossing a timing baseline was observed directly;
the E2E-only pending observer tracks every old/new promise, including rejection.
Undo/Redo baselines wait for actual settlement and retain the exact one-read
assertion. No projection behavior was changed.

One product repair was necessary: R3F emitted a missed-pointer event for a
right-button context menu and cleared eight selected volumes before menu
membership was checked. The viewport now admits only primary-button missed
selection clearing. Final context-menu, primary/additive/empty-canvas selection
and right-drag pan checks pass. Temporary product diagnostics were removed.
Original failed attempts, including a Web page crash followed by an unchanged
isolated full-suite pass, remain in the handoff; the crash's cause is unproven.
Fixture acquisition and the initial Electron download encountered TLS failures.
System curl with normal CA verification restored the exact manifest fixture
hashes; packaging used the supported CLI `electronDist` override to the already
installed Electron 43.4.0 distribution. No TLS verification was disabled.

The existing benchmark authority now supports all four channels and macOS launch
and memory commands while retaining Windows branches and headed Web policy.
The locally retained macOS four-channel archive
contains 96 samples: both hosts, four channels, four cases and three trials
(32 groups). Cases vary original triangle count (12/3,072), part count and native
subdivision work, and include the fixed real project. All renderer/native leases
balance; Escape has 96/96 matched terminal-to-logical-frame measurements. Normal
physical-release statuses are 403 matched, 168 without a geometry receipt, 178
without a terminal receipt, 14 duplicate inputs and five without a bounded
revision frame. Only matched observations enter latency aggregates. The five
successful commits without a bounded frame publish their large geometry after
a subsequent admitted stroke; the analysis correctly excludes those later
frames. Raw targets were not captured for every physical release, so missing
receipts are not silently classified as panel input or successful no-op.

At the user's request on 2026-10-03, the 98 generated measurement files are
excluded from Git and the PR. Their SHA-verified local copy is retained under
`packages/slicer-wasm/.work/step19/benchmark-archive/reference-2026-10-02-macos-four-channel/`.
The benchmark runners and analysis scripts remain versioned for reproduction.

Representative medians from that repeated baseline:

| Host/channel | 12-face release to logical frame (ms) | Fixed-project release to logical frame (ms) | Fixed-project Escape to logical frame (ms) | Fixed-project sampled host memory (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Electron Support | 39.2 | 116.2 | 73.3 | 2,790.9 |
| Electron Seam | 40.9 | 112.4 | 57.3 | 2,772.6 |
| Electron Fuzzy | 41.5 | 108.9 | 182.1 | 2,796.0 |
| Electron MMU | 41.2 | 132.5 | 111.6 | 2,698.3 |
| Web Support | 44.5 | 110.9 | 61.0 | 2,657.1 |
| Web Seam | 45.3 | 111.3 | 59.3 | 2,742.8 |
| Web Fuzzy | 43.6 | 115.5 | 184.0 | 2,659.6 |
| Web MMU | 44.0 | 120.4 | 102.7 | 2,734.4 |

Memory is whole-host sampled working set (Electron) or RSS (Web), at one-second
intervals, rather than incremental painting allocation. Native timing, transfer,
CPU upload, logical frames, heap/history and cleanup are recorded; logical frames
do not measure GPU execution or pixel visibility. A compact gated observer reads
published session/settings/revision/resource metadata without triangle scans;
small-fixture agreement with the full functional observer and bounded real-object
read cost were verified. Final Gap waits require current requested settings plus
native preview, geometry publication and rendered revision. An earlier area-0,
in-flight observation did not prove completed area-3 no-op; that interpretation
is withdrawn. Legitimate completed empty previews remain valid no-ops.

The 96-sample run precedes the independent pending-history observer and per-sample
bundle hashing. Its source/native identities and captured Web bundle are retained;
its original Electron bundle SHA was not saved and cannot be reconstructed by
claim. A subsequent uniform eight-sample final-source pilot (all four channels,
both hosts, 12-face fixture) passed native counters, cleanup and disk identity
checks. Every sample records actual HTML/assets and selected JS/WASM/data SHA
before the memory/journey window; the Web JS matches the existing exact transform.
Both pilot host bundles and the complete ON/ON serial module/cache/build recipe
are retained privately. Production serial bytes were then restored exactly.
The Mac baseline records Apple M1, Darwin arm64 24.6.0, Node 26.7.0, Chrome
154.0.8037.93 and Electron 43.4.0. The historical Windows reference is unchanged.
The installed Orca 2.4.2 binary provides a supplemental exact native-format
roundtrip; it is not a pinned performance comparator. No native-equivalent
speedup, GPU execution measurement or numeric threshold is claimed.

A supplemental real-only invalid-configuration test exposed `RuntimeError: Aborted`
after setting object-scoped `layer_height=0`. This additional failure remains
unresolved and is not counted as passing qualification. Its navigation changes
were withdrawn. The scoped configuration panel and slice action sources equal
current `origin/main`; the native pipeline difference is post-success warning
collection, with apply/validate/process unchanged. No baseline rebuild or native
call-site traceback was captured, so pre-existence and painting causality are
unproven. The failed logs/trace and source comparison are retained in
`step19/supplemental-slice-error-limit.json`; no native guard was added.

Exact commands, failures/retries/skips, source/artifact/fixture hashes and the
requirement-to-evidence matrix are retained in
`packages/slicer-wasm/.work/step19-handoff.json`. Level 4 profile-package coverage
is the current resource build (67 vendors), both-variant compatibility and the
ordinary packaged profile probes. No separate instrumented packaged app or
additional unnamed licensed fixture/generic cross-check was run. The independent
parent acceptance below qualifies delivery; numeric thresholds remain pending.

**Independent parent acceptance (2026-10-03):**

Child `/root/painting_step19` used **gpt-6.1-sol / medium**, completed its self-check
and explicitly stopped all mutations before parent verification. The parent
refreshed `origin/main` (`86ce9f7`) and merged it: already up to date. Earlier
main integrations remain separate merge commits. Each of stages 13–19 used a
fresh child; the next stage began only after independent acceptance and commit.

The parent reviewed the actual source and test diffs, native-field independence,
modal hole-path classification, settings/geometry publication, terminal
correlation, actual native menu/transport paths and failure assertions. The graph
was stale at `dbee028`; its flow hints were supplemented by current focused
source inspection and actual coverage. Repairs retained strict native rejection,
history identity and one-read projection assertions. Production changes in this
stage are the primary-button missed-pointer guard; the projection/benchmark
observers are E2E-gated and independently confirmed absent from production.

Before rebuilding, all 966 manifest hash records matched. Separate native
identity verification matched 968 records, including 228 object files per
variant; only the two mutable Ninja logs changed during parent builds. All 96
archived raw samples passed uncompressed SHA checks. Independent reanalysis
reproduced every row and aggregate, all 32 groups of three, cleanup and terminal
coverage above. The actual Escape/release/cancel and cross-stroke attribution
check passed without overwriting child evidence.

| Independent parent command / scope | Result |
| --- | --- |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm test`; `pnpm typecheck` | 145 files / 1,346 tests; all workspace types passed. The Node 26 localStorage workaround changes no repository configuration. |
| `bash scripts/build.sh quick --variant both`; `bash scripts/build.sh smoke --variant both` | Both current variants passed. |
| `pnpm exec node packages/slicer-wasm/harness/<name>.mjs <module>` with the harness arguments below | 28 production runs passed on both variants. |
| Backend and history/plate harnesses against `step19/instrumented-serial/orca_slice.js --expect-test-hooks` | Injected channel commit rollback and all four channel/plate history fault suites passed. Production modules were not replaced for these checks. |
| `pnpm --filter @orca/desktop test:e2e`; `pnpm --filter @orca/desktop test:e2e:real` | Mock 44 passed / 12 declared skips; real project/performance 10/10 passed, serially and without competing heavy jobs. |
| Real `playwright test e2e/multi-filament.e2e.ts`; `e2e/painted-facet-preview.e2e.ts`; `pnpm exec node scripts/run-painting-e2e.mjs` | Rack 5/5, imported adapters/three immediate Cancels/late-Cancel recovery 1/1, serial four-channel/six-MMU journey 1/1 passed. |
| `pnpm --filter @orca/desktop test:e2e:prime-tower-warnings` | Dedicated warning fixture 1/1 passed. |
| Full Web `playwright test --config ../../apps/web/playwright.config.ts`, repeated with `ORCA_WEB_NO_ISOLATION=1` | Threaded 12 passed / 1 separately gated benchmark; serial 12 passed / 1 separately gated benchmark. Actual download/reopen/reexport, native cancel and same-selection serial admission passed. |
| `pnpm --filter @orca/profile-resources build`; actual packaged `e2e/packaged-real.e2e.ts` and `e2e/packaged.e2e.ts` with `ORCA_E2E_PACKAGED_ROOT=release/mac-arm64/OrcaSlicerNeo.app` | 67 vendor packages; packaged probes 4/4 passed. Parent exercised the frozen ordinary app whose source/artifact hashes matched, rather than repackaging unchanged sources. Missing/corrupt ZIP probes restored the exact core bytes. |
| `pnpm exec node scripts/run-painting-benchmark.mjs --host both --channels mmu,support,seam,fuzzy --cases cube-3072-4parts --trials 1 --native-cache packages/slicer-wasm/.work/step19/instrumented-serial/CMakeCache.txt --output packages/slicer-wasm/.work/step19-parent/benchmark-current` | Eight current-source representative samples passed. Every disk HTML/asset/active-native hash and positive native counter was checked; Electron used zero renderer Workers, Web one non-isolated serial Worker. All renderer resources and native leases balanced. |
| Ordinary `pnpm --filter @orca/desktop build`, then `pnpm --filter @orca/web test:non-root`; painting-profile elision and real-project-profile exclusion scripts | Passed sequentially; 26 ordinary production artifacts contained no painting observers/profile sentinels. Actual initialized serial/threaded exports had no fault/profile hooks. |

For each `out/{serial,threaded}/orca_slice.js`, the production harness basenames
were `painting-engine-smoke`, `painting-session-smoke`,
`painting-foundations-smoke`, `history-editing-session-smoke`,
`painting-backend-smoke`, `seam-painting-smoke`, `support-painting-smoke`,
`fuzzy-painting-smoke`, `multi-filament-command-smoke`,
`preset-draft-registry-smoke`, `profile-compatibility-smoke`, `profile-smoke`,
`project-compatibility` and `multi-filament-slice-preview-smoke`.
The backend adds `--expect-production`; Seam/Support/Fuzzy receive an output
directory after the module. Material-command, preset-registry, project and
MMU-preview use `--module <module>`. The two private harnesses are
`painting-backend-smoke.mjs` and `painting-history-plate-smoke.mjs`, both with
`--expect-test-hooks`. Full argv and results are in `step19-parent/native-results.json`.

The parent's first serial painting run captured one distinct held-triangle
contour where the existing frame assertion expected two. An isolated repeat
passed the complete journey in 37.8 seconds with source and assertions unchanged.
Both complete frame/trace sets are retained; the first failure's cause remains
unproven. No retry or original failure is silently relabeled as an initial pass.
The supplemental invalid-layer-height abort above remains unresolved and is not
a passed check or a demonstrated painting regression. These observations and
the historical Electron-bundle provenance gap remain explicit limitations.

For the representative measurement the parent backed up the three production
serial files, temporarily copied the preserved ON/ON module, and supplied its
private cache explicitly. Production caches remained OFF/OFF/OFF. All three
production files were restored by SHA in a `finally` block, then ordinary hosts
were rebuilt in Desktop-to-Web order. The final 38 source and 58 production
artifact records matched the frozen handoff before documentation finalization.
The staged new-file check then found an extra EOF blank line in the project-menu
test helper. The same child removed exactly one LF, and the parent independently
verified all preceding bytes unchanged and reran the full staged whitespace check.
Exact parent argv/results and evidence are under
`packages/slicer-wasm/.work/step19-parent/`; child receipts remain separate.

All named required functional gates passed. **Step 19 accepted; scheme B Support,
Seam and Fuzzy functional delivery is complete.** The three separate Orca-style
entries remain ordered Support, Seam, Fuzzy, MMU. Numeric thresholds, pinned
native performance comparison and GPU execution timing remain unapproved or
unavailable; no universal latency/memory guarantee is claimed.

**Latest-main integration verification (2026-10-03):** Parent merged remote
`main` at `2f25b0fe00cd66c1b2361c62c2c64042f8f7649f` without conflicts
(`f54fc76`). This adds NODEFS-backed Electron threaded temporary files; Web
and Electron serial retain MEMFS. The automatic merges preserve both painting
behavior and the new `/tmp/plate-result-*` native/mock paths.

| Command / focused check | Parent result |
| --- | --- |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm test`; `pnpm typecheck` | 1,371 tests / 148 files passed; all workspace typechecks passed. |
| `bash scripts/build.sh quick -j 4` | Both production variants rebuilt and validated; all three native instrumentation/test gates OFF. |
| `pnpm exec node packages/slicer-wasm/harness/nodefs-bridge-smoke.mjs`; `bash scripts/build.sh smoke --variant serial` | NODEFS comprehensive bridge and serial slice/bridge/DRC/STEP, including cancellation and malformed STEP preservation, passed. |
| Threaded `support-painting-smoke.mjs`, `seam-painting-smoke.mjs`, `fuzzy-painting-smoke.mjs`; serial `painting-backend-smoke.mjs --interop-only --expect-production` | Native annotation independence, edit/history/save/reopen, downstream slicing and four-channel production interoperability passed. |
| `pnpm --filter @orca/desktop test:e2e` | 44 passed / 12 existing skips. |
| Current-artifact threaded Electron DRC/STEP and `painted-facet-preview.e2e.ts` | 3 passed; imported four-channel edits, native cancellation and history passed. Staged threaded JS/WASM/data hashes match current build outputs. |
| `ORCA_E2E_REAL=1 ORCA_E2E_NODEFS_EXPECT_VARIANT=threaded` with `e2e/nodefs-runtime.e2e.ts` | Independent parent rerun passed: native byte equality, generation replacement, paged preview, saved 3MF/configuration reopening, reload/crash/quit cleanup. |
| `pnpm --filter @orca/desktop exec node ../../scripts/run-painting-e2e.mjs`; serial NODEFS lifecycle test with `ORCA_E2E_NODEFS_EXPECT_VARIANT=serial` | Six-tool real serial painting passed; serial runtime remains MEMFS and cleans up its empty native session directory. |
| Headed real Web NODEFS compatibility, DRC, STEP and painted-project E2E; repeated without isolation for serial | Threaded 4/4 and serial 3/3 passed. Threaded compatibility serves exact unmodified shared artifacts; export and File Manager download bytes match. |
| `VITE_USE_MOCK=0 pnpm --filter @orca/desktop build`; `VITE_USE_MOCK=0 pnpm --filter @orca/web build`; `pnpm exec node scripts/check-painting-profile-elision.mjs` | Ordinary host builds and painting test/profile-hook exclusion passed. |

The first default `pnpm test` run failed 11 Web tests because Node 26.7.0's
experimental `localStorage` global was undefined. Disabling Node Web Storage
for the rerun passed without source/test edits. The first threaded NODEFS E2E
passed native file checks and 3MF save, then failed looking for a custom menu
button under macOS native chrome. A fresh GPT-6.1-sol / medium child reused
the existing `openProjectMenu` helper without changing assertions, passed its
typecheck and real test, and the parent independently reviewed and reran both
before accepting `bfcb2af`. The first supplemental backend harness invocation
omitted production-mode arguments and rejected the correctly absent failure
hook; the correct production interoperability invocation passed. These first
attempts remain separate from their passing reruns.

Exact logs are retained only in ignored
`packages/slicer-wasm/.work/main-merge-2026-10-03/`. No benchmark measurements
or generated archives were added. This is focused merge validation; packaged
installers, performance benchmarks and instrumented fault-injection rebuilds
were not rerun. Earlier step-19 qualification remains historical evidence.

### Adapter acceptance checklist

- [x] Documentation piece independently reviewed and verified; committed before step 13.
- [x] 13 strict channel/native/transport boundary and all-six MMU regression accepted.
- [x] 14 all-channel history, affected plates and support-derived invalidation accepted.
- [x] 15 complete seam editor/save/slice accepted before entrypoint exposure.
- [x] 16 native Smart Fill/Gap/overhang foundations accepted; consumers remain hidden.
- [x] 17 complete fuzzy editor and explicit independent configuration action accepted.
- [x] 18 complete support editor and derived settlement accepted.
- [x] 19 both-host/variant interoperability, cleanup and functional qualification accepted.
- [ ] Quantitative performance thresholds separately reviewed and approved.

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

## Follow-up: retain Region fill preview during movement (2026-09-30)

The user reports the same flicker in Region fill. Its accepted hover still
clears candidates before calculating the next native preview; retained-display
handling currently applies only to Triangle.

One bounded step shares the pointer-preview retention/publication lifecycle
between Triangle and Region fill. Keep the prior matched display until a
complete current native candidate, native miss or painted display replaces it.
Preserve native fill geometry/angle/erase behavior and candidate appearance.
Busy intermediate moves remain dropped; leave, tool/target changes,
cancellation and errors clear immediately and suppress late responses. Keep
Gap behavior intact and do not introduce native APIs or compatibility branches.
A fresh gpt-6.1-sol/high child implements and self-verifies, followed by parent
code review and independent tests. Verify delayed/stale Region reads and actual
continuous hover across different native regions without missing fill/contour
frames, preserving Triangle's existing regression and unchanged hover history.

The child delivered the shared predicate and delayed-read/lifecycle coverage.
Parent reviewed admission, terminal handling, complete resource publication,
native Region semantics and actual interleaved vertex extraction. Parent
independently passed `pnpm test` (1,188 including 777 app tests),
`pnpm typecheck`, and the real serial painting Electron journey (1/1, 23.2
seconds total). Region captured 24 continuous frames without missing native
fill or contour, across two distinct native regions; its hover history and
draft geometry remain unchanged. Parent viewed the Region screenshot.
Circle, Sphere and Height range captured 25, 21 and 22 held frames with no
missing cursor, including native model replacements. Triangle remains covered
by its continuous hover/held regression. Child's controlled negative using the
previous controller failed eight unit cases and lost both Region fill and
contour in four of 27 frames; restored fixed source passed again.
Parent restored ordinary Desktop/Web builds and passed production elision
on 21 artifacts plus `git diff --check`. No native build or full release
matrix was required; native sources and the pinned submodule are unchanged.

## Follow-up: audit other tools and retain static Gap preview (2026-09-30)

The audit found a separate Gap lifecycle defect: ordinary pointer movement
clears static candidates without requesting replacement, and area/settings
changes clear candidates before asynchronous calculation completes. Circle,
Sphere and Height range use the separate cursor path and their actual held
frame checks show no equivalent interruption.

After Region acceptance, a fresh gpt-6.1-sol/high child fixes this bounded Gap
step. Gap preview is independent of pointer position: movement, canvas leave
and camera navigation must preserve it without hover RPCs. Settings changes
retain the complete matched display until the current complete native preview
and geometry replace it; a valid empty result clears it. Tool/target changes,
errors and closure invalidate it, and obsolete responses cannot revive it.
Preserve native threshold/fill/apply semantics, dropped intermediate moves,
reliable terminals and the existing API. Verify deferred preview/geometry and
stale settings tests, real continuous static Gap rendering during pointer
movement/leave and threshold changes, and unchanged hover history. Parent
reviews the implementation and independently verifies before acceptance.

Upstream reference: `GLGizmoPainterBase.cpp`'s Moving handler excludes
`GAP_FILL`; `GLGizmoMmuSegmentation.cpp` updates the threshold and applies
fragments through selectors. `TriangleSelectorPatch` rebuilds patch render
data and selects fragments with area below the threshold. Retaining the static
preview during pointer movement therefore follows its tool semantics.
The bounded lifecycle audit also covers a project/history operation reserved
while a preview read is pending: obsolete selection publication must wait for
the resulting current display, preserving the complete old model bundle.

The child delivered separate pointer/candidate preview policies, a static
Gap hover no-op, complete-bundle retention and obsolete-read rejection.
A current successful native preview explicitly authorizes Gap candidates;
model-only error recovery cannot resurrect a failed preview. Seventeen added
controller cases cover delayed preview/geometry, successive settings,
pointer-independent behavior, empty results, tool/target/error/close
invalidation, Apply failure and project/history reservation. The Gap fixture
uses the native empty contour. Real Gap verification checks native fragment
positions and absence of synthetic contours, preserving current appearance.

Parent reviewed the controller ownership/version guards, lifecycle resets,
known-resource reuse, native leaf membership probe and actual-frame checks.
No API compatibility paths, move queues, native algorithm or host-boundary
changes were introduced. Child's controlled previous-controller negative
failed 11 unit cases and lost candidates in 52 of 57 actual Gap frames;
fixed production source was restored byte-for-byte and checks rerun.

Parent independently passed `pnpm test` (1,205 including 794 app tests),
`pnpm typecheck`, and `pnpm exec node scripts/run-painting-e2e.mjs` (1/1,
25.9 seconds total, current serial artifact hashes verified). Actual captures
have no missing expected draw: Gap movement/leave 58 frames and settings 147;
Circle/Sphere/Height held cursors 25/23/20; Triangle hover/held contours 27/75;
Region hover fill and contour 27. Gap settings retain draft geometry and
history; threshold zero clears only its completed native empty result,
restoring the threshold restores selection, and Apply still commits normally.
Parent inspected the Gap screenshot. Logs are
`packages/slicer-wasm/.work/parent-gap-retain-*.log`; child negative and restored
positive evidence is preserved in ignored `.work/gap-retention`.
Parent restored ordinary builds with `pnpm --filter @orca/desktop build` and
`pnpm --filter @orca/web build`, passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 artifacts and
`git diff --check`. No native build, Web real E2E or full release matrix was run
for this shared controller fix. Native sources and the pinned submodule remain
unchanged.

## Follow-up: unify candidate preview lifecycle (2026-09-30)

The user approved consolidating Triangle, Region fill and Gap fill beyond the
shared scheduler. One independently testable step replaces Gap-only validity
and pointer-presence-based publication authorization with common candidate
preview ownership. All three tools use the same request generation,
invalidation, retained complete display and current-result publication rules.
Only the tool strategy determines preview input (pointer or static), triggers
for recalculation/clear and stroke versus Apply execution. Pointer presence
remains an input requirement, not an alternate validity protocol.

Keep native geometry and tool appearance unchanged. Pointer previews clear on
leave; static Gap ignores pointer/leave/camera input. Completed native misses
or empty results replace the previous display. Triangle's native stroke
selection remains publishable, while Region's completed painted display may
contain no candidate. Error, target/tool/close and queued project/history
reservations reject obsolete publication without mixing session, resource or
palette ownership. Preserve dropped intermediate moves, reliable terminals,
ordinary cursor behavior and existing public API; remove Gap-only validity
state and avoid compatibility paths or a new generic framework.

A fresh gpt-6.1-sol/high child implements and completely self-verifies, then
parent independently reviews code and runs acceptance checks before commit.
Use shared parameterized behavioral coverage for all three tools where
semantics match, plus explicit pointer/static and native stroke differences.
Retain actual six-tool continuous-frame regression, stale reads, failure
recovery, resource disposal and history evidence. Run root tests/typecheck,
the current serial real painting journey, ordinary Desktop/Web builds,
production elision and diff checks. No native build or release matrix is
required for this application-controller-only consolidation.

The child implemented a small `previewInput` policy and one
`previewGeneration`/successful `candidateOwner` lifecycle inside the existing
controller. `gapPreviewValid`, tool-specific authorization predicates and
`settingsVersion` were removed. Current successful native preview or admitted
stroke receipts authorize publication; pointer presence and model-only reads
cannot. Settings/admissions revoke ownership while retaining the previous
complete display. All three tools use the same stale-read rejection and
matching resource/session/palette publication. Project/history refresh uses
common input readiness to recalculate from the last admitted pointer or static
input. Reliable terminal endpoints capture their generation and settings;
endpoint-free termination after leave cannot reauthorize a candidate.

Parent reviewed the production diff and consolidated behavioral test matrix.
Equivalent lifecycle coverage is parameterized across all three tools, with
pointer/static input, native begin/sample misses, Region painted display,
Triangle held selection and terminal differences covered explicitly. There
are 100 controller tests; no compatibility paths, framework or native/API
changes were introduced. Stale reads leave published known-resource IDs
untouched; a stable invalidated generation can publish model-only recovery,
so invalidation does not create an endless read loop.

Child self-verification passed root tests (1,238), typecheck, current serial
real painting journey, ordinary builds, production elision and diff checks.
Parent independently passed `pnpm test` (1,238 including 827 app tests),
`pnpm typecheck` and `pnpm exec node scripts/run-painting-e2e.mjs` (1/1,
25.6 seconds total, current serial artifact hashes verified). Actual expected
draws have zero gaps: Triangle hover/held 28/75 frames, Region hover 25,
Gap movement/leave 57 and settings 139, and Circle/Sphere/Height held cursors
25/23/22. The unchanged journey also verifies native geometry membership,
empty results, colour, camera, model rendering, commits and history. Logs use
`packages/slicer-wasm/.work/parent-unified-preview-*.log`; child preserved its
actual renderer evidence under `.work/child-unified-preview-evidence` there.
Parent restored ordinary builds with `pnpm --filter @orca/desktop build` and
`pnpm --filter @orca/web build`, passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 artifacts and
`git diff --check`. No native build, second-host real E2E or full release
matrix was run; the pinned submodule and native sources are unchanged. This
behavior-preserving consolidation did not require an old-controller negative
experiment.

## Follow-up: toolbar, Height range and Gap camera fixes (2026-09-30)

The user requests three fixes in this order, each implemented by a fresh
gpt-6.1-sol/high child, fully self-verified and independently code-reviewed and
accepted by the parent before starting the next step:

1. Painting toolbar activation: an open painting session already supplies
   `aria-pressed`, but the button lacks the armed appearance. Use a shared
   toolbar button variant for active visual state, preserving existing toggle,
   enable/disable, selection and one-gizmo ownership semantics. Verify active
   opening/idle/busy/error/closing versus closed state, transform button
   consistency and actual rendered activation/closure.
2. Height range presentation: compare the pinned Orca height cursor drawing
   and match its geometry, height placement, colouring, transparency and depth
   behavior. Replace the current wireframe box without changing native height
   selection/painting. Verify actual rendered geometry/material and continuous
   held cursor frames, preserving other tools' presentation.
3. Gap fill camera input: allow normal left drag started outside the model to
   rotate around the existing painting pivot, while preserving static Gap
   candidates and preventing a paint stroke/history entry. Respect native
   collision authority for pointer painting tools, drop busy intermediate moves
   and preserve reliable terminal handling. Verify camera ownership, rotation, static
   preview continuity and unchanged history/native annotations.

Keep the current branch, public API and pinned native submodule intact unless
verified native evidence requires a separately reviewed change. Update this
living document and the approved spec in batches at step acceptance. Each
step runs its affected package tests/typecheck and focused real painting
journey; final handoff also runs root checks and restores ordinary
Desktop/Web builds with production elision. Commit each accepted step
separately; no release matrix or new standalone task notes are required.

Step 1 accepted: the `gizmo` Button variant owns armed accent background and
foreground, including hover and the inherited dark-theme hover rule. Paint and
transform toolbar buttons use it; Add Model and other variants are unchanged.
Parent reviewed the variant scope, state subscriptions, disabled gates and
single-gizmo transitions. Ten component cases cover all eight session phases
and successful/failed closure. Actual color assertions wait for settled CSS
animations and compare to armed Move rather than hardcoding theme colors.

Child self-verification passed app tests/typecheck, real serial six-tool
journey, ordinary Desktop build, elision and diff checks. Parent independently
passed `pnpm --filter @orca/slicer-app test` (837 tests), app typecheck and the
real painting journey (1/1, 26.8 seconds total, current serial hashes checked).
Parent inspected the active toolbar screenshot and computed-color JSON: paint
matches armed Move during idle, hover, disabled drawing, reopening and switch
back; closure/switch to Move restores transparent inactive paint. Transient
opening/ending/cancelling/error/closing states use component coverage rather
than claiming individual real-frame captures. Logs use
`packages/slicer-wasm/.work/parent-toolbar-active-*.log`.
Parent restored the ordinary Desktop build and passed production elision on
21 artifacts plus `git diff --check`. Native build and second-host real E2E
were omitted for this shared toolbar-only step; root gates remain scheduled
for the final three-fix handoff.

Step 2 implementation boundary follows the pinned upstream
`GLGizmoPainterBase::render_cursor_height_range` and `update_contours`:
white mesh-section outlines at clamped world hit Z and world hit Z plus height,
with no outline at the global min/max planes. `GLGizmoMmuSegmentation::on_render`
enables depth testing before cursor drawing; Height does not disable it.
The original wireframe box, selected-filament tint and X-ray depth behavior are
replaced for Height only. Circle and Sphere keep their existing color rules.
Use accelerated original-mesh BVH intersection for this visual cursor, caching
by displayed transforms and cut heights. Preserve native selection, complete
display ownership, held cursor identity, history and resource cleanup. Verify
actual non-box section geometry, transformed/multipart meshes and boundary
behavior as well as real held-frame continuity; no native API is introduced.

Step 2 accepted after parent source review and independent validation.
`HeightRangeCursor` owns opaque white `LineSegments`, normal depth testing,
no depth writes and the existing final cursor order. It borrows the immutable
original BVH; a world-Z plane is transformed for shapecast pruning and vertices
are transformed for section calculation. Native half-open top-edge ownership,
deduplication and float hit/bounds/height arithmetic handle coplanar edges and
the observed infinitesimal-below-top hit. Visual sections do not implement
native slicer topology repair. Required typed mesh/render-order inputs avoid
compatibility overloads and the parent-confirmed import cycle was removed.
Memoized planes/meshes reuse the cut buffer through XY/color/native display
updates; owned buffers/material are disposed without disposing borrowed data.

Child passed 27 focused cases, all 845 app tests, typecheck, current serial
real journey, ordinary Desktop build, elision and diff checks. Parent reviewed
geometry, transformed/hollow/cap tests, cache/disposal, public call sites and
actual renderer instrumentation, then independently passed app tests (845),
app typecheck and the real six-tool journey (1/1, 29.0 seconds total, current
serial hashes verified). Parent inspected the Height screenshot: two front
white sections with rear occlusion, using no depth bias. Actual world cut
positions/perimeters, upper clamp and empty global cap are checked together
with retained model/history and the other five tools. Logs use
`packages/slicer-wasm/.work/parent-height-contours-*.log`.
Parent's held capture has 27/27 Height draws with one line object and one cut
buffer across native model updates. Upper clamp has 2/2 draws using only the
lower plane; the global cap has two retained-model frames and zero Height
draws. Parent restored ordinary Desktop and passed elision on 21 artifacts
plus diff checks. Native build/root matrix/second-host real E2E remain omitted
for this visual-only step; final root checks follow step 3.

Step 3 accepted: static Apply-only Gap presses enter camera ownership when idle,
the native lane is free and the complete display matches the session. Ordinary
left drag rotates from both empty space and model surfaces without native
picking, opening a stroke, invalidating candidates or writing history. Orca's
`GLGizmoPainterBase::gizmo_event` returns false on a native miss; a Gap hit is
consumed without brush/fill action. NEO intentionally permits navigation on a
Gap hit as well because it has no pointer painting operation. Other tools keep
native hit authority. No public/native API or internal compatibility path was
added; existing capture, terminal and model-centre orbit code is reused.

Child self-verification passed 121 focused cases, all 853 app tests, app
typecheck, the real serial journey (1/1, 29.4 seconds total), ordinary Desktop
build, 21-artifact elision and diff checks. Parent reviewed admission gates,
static candidate ownership, asynchronous gesture resolution/capture cleanup,
test fixtures and actual-render assertions. Coverage includes busy preview,
target handoff, unfinished Apply/commit/cancel, closure, and early pointerup,
cancel, capture loss, blur and Escape without reviving the abandoned gesture.

Final independent parent gates passed `pnpm test` (1264 tests), `pnpm typecheck`,
and `pnpm exec node scripts/run-painting-e2e.mjs` (1/1, 29.8 seconds total;
current serial JS/WASM/DATA hashes verified). Parent inspected camera and frame
evidence: outside drag 41/41 and surface drag 40/40 frames each retain a single
stable candidate geometry. Actual camera orientation changes while the model pivot
retains its camera-space/projected position; reverse ordinary drag restores the
pose. RPC/resource counts, committed annotations and history remain unchanged,
and subsequent Gap Apply still succeeds. The same journey also covers the
accepted toolbar activation and Height section rendering.

Parent rebuilt ordinary `pnpm --filter @orca/desktop build` and
`pnpm --filter @orca/web build`, then passed
`pnpm exec node scripts/check-painting-profile-elision.mjs` on 21 production
artifacts and `git diff --check`. Logs are
`packages/slicer-wasm/.work/parent-three-fixes-*.log`; real evidence is in
`apps/desktop/test-results/painting.e2e.ts-real-paint-996d1-ts-history-camera-and-close/`.
The pinned submodule remains `c7801bdbdbfb0ca1176c2c69792a65fdd4f2db0d`.
No native build, second-host real E2E or dual-host/dual-WASM release matrix was
run for these shared application fixes; production builds cover both hosts.

## Object-list mutation preparation naming

The shared object-list entrypoint is `prepareObjectListMutation`: it owns
synchronous painting command admission, rejects busy commands without queuing,
and awaits pending model-transform synchronization before admitting the edit.
All 16 metadata and structural callers use this name and a `prepared` outcome.
Target-specific `beforePaintingTopologyChange` checks remain in their existing
callers and order; the helper does not own target closure or a global command
policy. This is an internal naming/comment refactor with unchanged behavior,
types and failure outcomes; no compatibility alias or architecture-spec change.

Child self-review confirmed the helper body and topology-check order are
unchanged. Exact workspace lookup found no remaining old identifier and no
test/mock references requiring rename. Existing focused verification passed:
`pnpm --filter @orca/slicer-app exec vitest run src/components/workspace/objectList/actions.test.ts src/components/workspace/objectList/structuralActions.test.ts src/components/workspace/viewport/gizmo/painting/projectCommands.test.ts`
(3 files, 30 tests), `pnpm --filter @orca/slicer-app test` (98 files, 853 tests),
`pnpm --filter @orca/slicer-app typecheck`, and `git diff --check`.
Parent independently reviewed the complete source diff, verified all 16 callers
and the absence of old exports/aliases, and passed app tests (853), app
typecheck, `pnpm test` (1264), `pnpm typecheck` and `git diff --check`.
Logs use `packages/slicer-wasm/.work/parent-object-list-admission-*.log`.
Under the testing-guidelines pure-shared-logic routing, no rendered
interaction, DOM/WebGL wiring, host seam, native bridge or WASM artifact changed;
no host E2E, native build, real-WASM run or release matrix was run for this
refactor. The existing behavior tests cover transform settlement/failure and
busy painting command rejection without replay; no rename-only test was added.

## Painting closure performance — 2026-09-30

The reported slow exit also occurs when opening and closing without painting.
The measured redundant work was `PaintingProvider.prepareClosed` reading the
entire project through `getModelMesh`, projecting every renderable, and replacing
every `GLVolume`. Existing resource keys already shared original geometry and
BVHs; this was not evidence of rebuilding their BVHs.

Accepted implementation: retain Prepare without a geometry read when the session
has no committed paint. Otherwise collect every successfully painted object ID
through the session, including target switches, and refresh only those objects
using the existing `readSceneDeltaProjection` and known source/paint keys. Project
commands and history navigation continue to publish their own projections. Keep
the touched set through Undo and native-close/render-publication failure, and
clear it only after successful Prepare publication. Preserve the native close,
material/Prime Tower settlement, epoch publication, history compaction, conditional
Redo cleanup, and synchronous lane ownership through resource publication. No
native ABI, architecture contract, submodule, or deferred-update policy changed.

The reference workload is the checked-in `fixtures/big-proj.3mf`, SHA-256
`de8afeac2e7b53a63fe5925d8b05ddfe0c0b7f0a7b3f88fbc2a5fc29c0524ce0`.
It contains 51 objects, 321 source volumes/renderables and 3,031,116 original
triangles. The selected target has three solid parts with 126,922, 8,590 and
8,400 source triangles, initially unpainted and unsubdivided. Its no-op session
has no history effects. This reproduces the repository workload, not the user's
unsupplied scene. Additional generated corpus cases hold four coincident solid
parts (3,072 source triangles total) and two instances (12,288 triangles in the
shared source mesh); edited workloads exercise triangle painting, Undo, and an
interleaved filament-colour edit.

Baseline and after each use three consecutive no-op sessions in one fresh
Electron process on the same Ryzen 9 5900X / 64 GiB machine, with current serial
wasm64, identical native artifact hashes, and native profile/history-test gates
OFF. The recorded index includes OS, browser/GPU, fixture, artifact, source-diff
and build identities. The initial after run overlapped other checks and is
excluded from the timing comparison; `after-isolated` ran without another test
or harness process. No absolute latency threshold is asserted.

| Observed phase | Before | After, isolated |
| --- | --- | --- |
| Input pointer-up to painting-resource disposal, all three samples | 455.535 / 449.990 / 427.120 ms | 59.135 / 55.885 / 55.040 ms |
| Full-project mesh RPC | 380.960 / 388.330 / 372.825 ms | No call |
| Prepare publication including mesh RPC | 384.900 / 392.220 / 375.945 ms | 1.205 / 1.180 / 1.070 ms |
| History-session close RPC | 22.015 / 19.840 / 19.110 ms | 21.775 / 19.935 / 19.715 ms |
| Existing GLVolume wrappers retained | 0 of 321 | 321 of 321 |

The median observed no-op exit falls from 449.990 to 55.885 ms (87.6% reduction).
The old renderer work beyond its full mesh RPC was approximately 3–4 ms; the
dominant cost was the mesh request, not renderer geometry construction. The
separate production-native harness reports 0.215–0.943 ms for no-op native
history closure versus 225–296 ms for full native mesh export and allocation of
54,567,552 buffer bytes. These direct calls exclude Worker transfer, JS decoding,
and renderer scheduling and must not be treated as a decomposition of the same
host sample. No-op native settlement does not scan materials when the derived
version is zero; settlement caching remains intact for later sessions.

Final complex-project workload checks measured no-op / painted / Undo / separator
exit at 55.545 / 160.155 / 60.155 / 203.785 ms. Painted exits request only their
one touched object, export zero original geometries, and retain all 318 unrelated
wrappers; the current paint resource is ready before Prepare appears. Undo's
already-projected geometry requires zero newly exported paint resources. Material
settlement and history closure remain awaited; these edited timings are not a
new quantitative guarantee or a claim that their remaining costs were removed.

Reproduction commands (PowerShell, production serial artifact):

```powershell
pnpm exec node packages/slicer-wasm/harness/painting-close-profile.mjs
pnpm exec node scripts/run-painting-benchmark.mjs --host electron --cases big-project-fixed --trials 1 --close-only --expect-incremental-close --output packages/slicer-wasm/.work/painting-close/after-isolated
pnpm exec node scripts/run-painting-benchmark.mjs --host electron --cases big-project-fixed,cube-3072-4parts,cube-12288 --trials 1 --close-edits --expect-incremental-close --output packages/slicer-wasm/.work/painting-close/accepted-workloads
```

Raw evidence is under `packages/slicer-wasm/.work/painting-close/`: `baseline/`,
`after-isolated/`, `native.json`, and `accepted-workloads/`. Each host sample
contains the complete before/after history, facet counts, observed RPCs, retained
wrappers, and Prepare resources. The baseline index corrects the old runner's
hardcoded native-profile flag; the runner now records the actual CMake flag.
The observer lives in the existing compile-gated E2E probe; ordinary artifacts
contain no observer call sites or new `exportedSourceGeometries` sentinel.

Child self-verification passed `pnpm test` (1,273 tests; app 862), `pnpm typecheck`,
the serial quick build, the direct native profile harness, all three final real
close-workload E2Es, and `pnpm exec node scripts/run-painting-e2e.mjs` (current
serial six-tool/history/camera/close journey, 29.1 s). Provider tests execute the
production publication function and cover no-op no-read/no-publication, targeted
paint refresh with original BVH and unrelated wrapper retention, failed resource
publication/retry, release of earlier staged resources on a later-part failure,
and deletion of a previously painted object. Controller tests cover multiple
targets, ineffective/recovered failed commits, cancellation, Undo reconciliation,
and retry after native closure without losing touched targets. Final real
workload assertions preserve no-op cursor/Undo/Redo/dirty/save state, preserve
non-paint entry identities, clear edited Redo, and verify actual Prepare paint
geometry, facet states, and original geometry identity after closure.

Ordinary Desktop and Web builds and `check-painting-profile-elision.mjs` passed
(21 artifacts); `git diff --check` passed. Logs are `unit-final.log`,
`typecheck-final.log`, `serial-quick.log`, `six-tools.log`,
`accepted-workloads.log`, `desktop-production.log`, and `web-production.log`
under the same evidence directory. No C++ edit required a new native test build;
no second real host, threaded rebuild, or full release matrix was run for this
bounded shared-app optimization.

Parent independent acceptance passed after substantive source review of dirty
target tracking, publication failure/retry, stable-resource leasing and atomic
SceneDelta composition, benchmark observers and production elision. Parent
confirmed the baseline fixture is tracked and reviewed its raw timing records.
Independent `pnpm test` passed all 1,273 tests and `pnpm typecheck` passed.
The no-op complex-project benchmark passed (30.4 s total): 56.580 / 55.620 /
50.780 ms, each retaining all 321 wrappers with zero full-mesh or patch reads.
The same complex-project edited benchmark passed (33.1 s total): no-op / paint /
Undo / separator exit at 56.190 / 161.640 / 55.110 / 216.285 ms. Each edited
closure requested only object 16 and exported no original geometry; paint and
separator exported one current paint resource, while Undo exported none. Actual
Prepare resource/state and history assertions passed in this independent run.

Parent also passed the current-serial real six-tool journey (1/1, 28.8 s total,
staged JS/WASM/DATA hashes checked), ordinary Desktop and Web builds,
21-artifact profile elision and `git diff --check`. Independent logs and raw
benchmark records use `parent-*.log`, `parent-noop/` and `parent-edits/` under
the same evidence directory. No native source or pinned submodule changed;
parent did not repeat the unchanged native build or run a second real host,
threaded variant or full release matrix.

## Painting viewport chrome — 2026-09-30

Painting mode hides the Prepare plate controls while keeping the bottom-left
3D orientation navigator visible, including opening, drawing and closing. The
plate controls return when the viewport returns to Prepare.

Acceptance includes source review and the real serial Electron six-tool
journey. The journey asserts toolbar visibility before/during/after painting
and records actual navigator draw callbacks in the separate HUD scene.
The native load receipt can precede load-overlay removal; the test waits for
that overlay and two animation frames before selecting via raw coordinates.
`pnpm test` (1,273 tests), `pnpm typecheck`, Desktop/Web production builds,
21-artifact painting observer elision and `git diff --check` passed. No native
code changed, and no native rebuild or full release matrix was run.

## Circle cursor screen width — 2026-10-01

The circle cursor uses the existing drei `Line` (`Line2`/`LineMaterial`) with
`worldUnits=false` and a fixed 2 CSS-pixel line width. Unit-circle samples are
scaled by the configured brush radius and face the camera. Its shader expands
the projected line in screen space, avoiding per-frame CPU geometry updates.
Zoom follows the existing cursor lifecycle: hide the stale hit, then recreate
the cursor on the next pointer move. Sphere and height-range cursors keep their
existing rendering.

Orca's core-profile reference uses `GLGizmoPainterBase::render_cursor_circle`
with the `dashed_thick_lines` geometry shader: it supplies viewport dimensions
and `width = 0.25`, which the shader clamps to a 1-pixel core plus a 0.5-pixel
antialias fringe on each side. Its non-core path uses `glLineWidth(1.5f)`.
NEO uses the same screen-space expansion principle through its existing Three
line shader, while retaining the configured brush footprint and filament
highlight colour.

The accepted dashed-circle follow-up uses Orca's core-profile geometry rule,
rather than setting a generic dash/gap material pattern. Its interval count is
`2 * (4 + trunc(252 * (zoom - 1) / 249))` with camera zoom capped at 250;
only alternating pairs of circle samples are drawn, leaving equal angular gaps,
including the closing gap. Neo uses drei `Line` in `segments` mode. It derives
the effective pixels/mm scale at the brush plane from camera projection and
clip W (valid for perspective and orthographic cameras), and memoizes points
by integer interval count. Pointer motion and native publications do not
recreate geometry when that count is unchanged. Orca's core path sets
`gap_size=0` because its geometry already supplies the gaps; its non-core path
instead uses `glLineStipple(4, 0xAAAA)`.

Independent source review checked shader viewport units, stable circle points,
resource disposal and final transparent-pass ordering. `pnpm test` passed all
1,273 tests, including 862 shared-app tests. `pnpm typecheck` passed. The real
serial Electron six-tool journey passed (1/1, 35.2 s): it checks actual circle
draws before/after zoom, fixed width and viewport resolution, unchanged history,
filament colour, and cursor visibility/order through a native stroke replacement.
Zoom screenshots were visually reviewed. Acceptance logs are
`painting-viewport-cursor-unit.log`, `painting-viewport-typecheck.log` and
`painting-viewport-cursor-e2e-acceptance.log` in `packages/slicer-wasm/.work/`.
Desktop and Web production builds and painting observer elision in 21 production
artifacts also passed; build logs use `painting-viewport-*-production.log` in
the same directory. `git diff --check` passed.
No native source or pinned submodule changed; no native rebuild, second real
host or full release matrix was required for these shared viewport changes.

Dashed-circle acceptance: source review and zoom/held-stroke screenshot review
passed. `pnpm test` passed 1,279 tests (868 shared-app tests), `pnpm typecheck`
passed, and `pnpm exec node scripts/run-painting-e2e.mjs` passed the real serial
Electron six-tool journey (1/1, 39.8 s). The journey validates actual uploaded
segment endpoints, equal painted/gap angles and closure, reduced dash density
after zooming out, fixed line width and viewport resolution, and held-stroke
visibility/colour/order. The runner checks staged JS/WASM/DATA against current
serial artifacts. Logs use `painting-circle-dashes-{tests,typecheck,e2e}.log`
in `packages/slicer-wasm/.work/`. No native code changed or was rebuilt.
Desktop/Web production builds, 21-artifact observer elision and
`git diff --check` also passed. Build logs use
`painting-circle-dashes-{desktop,web}-production.log` in the same directory.
