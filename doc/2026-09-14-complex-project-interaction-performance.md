# Complex Project Interaction Performance

Date: 2026-09-14
Status: Delivered and qualified 2026-09-16, including the approved per-plate
Print architecture, object/mesh reuse, incremental plate history, sparse Move
history, renderer-local adjacent Move restore, bounded Prime Tower projection,
and the exact-u1 visible real-WASM performance gate
Scope: Prepare-viewport object transforms and multi-plate structural commands.

## Problem

Complex 3MF projects can stall after moving an object and while adding or
deleting a plate. The affected workflows include the 11-plate helmet project
used by the desktop plate-switch performance coverage.

## Accepted Behaviour

- A completed object gesture submits only the selected renderer CompositeIDs
  and their final transforms. The Worker transaction remains authoritative;
  all selected parts of the same object are included, while unrelated complex-
  project volumes no longer cross the JS/WASM seam or enter transform capture.
- Adjacent direct Move Undo/Redo consumes a validated native transform receipt
  in the renderer, reusing the retained GL volumes and stable-ID structure.
  The normalized native target context is validated against the retained
  session and receipt, then atomically published even when receipt-affected
  instances change plate membership, parking, out-of-bounds state, or their
  affected input revisions. Only the explicit transform receipt is applied;
  no plate-session snapshot or full session transform replay is performed.
  Because those changes can alter tower eligibility, the direct path performs
  one authoritative narrow all-plate tower projection read and patches only
  the tower collection. Malformed or stale receipts, failed identity/revision
  proofs, missing scene targets, and any non-adjacent/full-history crossing
  conservatively use the existing full model/session/tower projection.
  Unsaved project state has no cross-version receipt compatibility requirement.
- Plate reflow and renderer transform application use one identity lookup per
  operation rather than repeatedly searching every instance or rendered
  volume.
- Plate membership, placement, history, and invalidation results remain
  unchanged from the user's perspective.
- Repeated live-model history captures reuse immutable mesh keys and retained
  native `shared_ptr<const TriangleMesh>` ownership for the same mesh identity;
  ordinary captures do not serialize mesh bytes. History staging and Undo/Redo
  reconnect the retained native owner directly. Existing resident/deferred byte
  payloads remain a compatibility fallback only for explicitly byte-backed
  states. Cache keys retain shared ownership, and the bridge clears the cache
  at session, scene, project-load, and history-reset boundaries; replacement
  meshes therefore remain independent without relying on a stale raw pointer.
- ProjectHistory charges native mesh memory only when retained history is the
  sole owner (conservatively omitting meshes shared with the live model), and
  releasing or evicting an entry releases its native ownership. No unbounded
  global mesh cache is introduced.
- `Add Plate` uses a direct incremental history frame rather than a model
  capture at transaction begin or commit. It retains the plate/session context
  plus only the instance transforms actually changed by reflow. If an added
  plate leaves existing origins unchanged, neither transform receipt is
  allocated or serialized.
- Add/Delete Plate receipts also publish the authoritative project overlay
  produced when native code normalizes the wipe-tower X/Y arrays. This keeps
  the retained renderer overlay identical to the history context and prevents
  the next adjacent Move Undo from failing its direct-receipt proof solely
  because React retained the pre-structure-change array lengths.
- Adjacent Add Plate Undo/Redo applies only its sparse transform receipt and
  plate/session context. Crossing between an Add Plate frame and an ordinary
  model edit restores the complete predecessor model before applying the
  relevant receipt, so unrelated changes such as a volume transform cannot
  leak through Undo. A non-adjacent menu jump resolves its retained opaque
  entry ID to ordered adjacent steps inside one synchronous Worker command;
  each sparse receipt is rebased on its authoritative retained predecessor,
  and only the final full renderer projection is published.
- A completed `Move` transaction is a sparse transform-delta frame only when
  its actual model mutation is `orc_set_model_transforms` and no other model
  mutator ran in the transaction. The frame retains affected object, volume,
  and instance identities, before/after transforms, and history revisions;
  retained meshes and mutable-object archives remain shared and untouched.
- Adjacent Move Undo/Redo applies the sparse receipt directly and returns a
  narrow transform receipt plus a full renderer impact descriptor. Crossing
  between a Move frame and a normal model edit stages the retained predecessor
  only when needed. Non-adjacent jumps across Move frames use the same internal
  ordered-step path as Add Plate, while stale, evicted, and opposite-direction
  IDs remain rejected safely.
- The real-WASM bridge exposes a bounded, drain-on-read diagnostic timing ring
  for `history_begin`, `set_model_transforms`, `add_plate`, and
  `history_commit`. The atomic transform sample separates input/JSON decode,
  request validation/target resolution, transform mutation, plate-membership
  reflow, response JSON serialization, and total time. It carries timing
  scalars only; it never retains model, context, or project data.
- Normal `history_begin` and `history_commit` samples additionally expose the
  stable scalar-only capture stages `capture_collection_cache`,
  `capture_mutable_object_archive`, `capture_immutable_mesh_retention`, and
  `capture_model_state` (the total capture duration). All four fields are
  present for normal captures, including zero-valued stages. The immutable
  stage covers retained shared mesh references and ownership accounting only;
  retained immutable meshes remain mesh-byte-free.
- Normal full-model history restore additionally exposes the bounded scalar
  stages `capture_model_equality_check`, `model_staging_deserialization`,
  `immutable_mesh_reconnect`, `plate_session_project_overlay_restore`,
  `history_cursor_commit`, `response_json_serialization`, and `total`. These
  fields never contain model, identity, byte, or text data; direct Add Plate,
  filament, and Prime Tower restore paths retain their existing semantics.

## Add Plate Profile: User Click to Undo

The acceptance boundary is not `orc_add_plate` returning. It is the time from
the renderer dispatching Add Plate until the toolbar shows enabled `Undo Add
Plate`. The focused Electron profile uses the exact h2d fixture:

`E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-h2d.3mf`

It proves the 45,201,991-byte project receipt and its 11 native plates before
measuring, drains load-time native samples, and records the following latest
real threaded-WASM sample (milliseconds):

| Boundary or native stage | Time |
| --- | ---: |
| Renderer click to visible enabled Undo Add Plate | 544.27 |
| Application mutation/publication | 517.03 |
| Client transaction | 490.20 |
| Worker transaction | 489.97 |
| WASM instrumented total | 476.12 |
| History begin `delta_record` | 0.01 |
| Add Plate reflow | 466.89 |
| History commit `delta_record` | 0.09 |
| History-store insertion | 3.55 |
| Main-thread/Worker transport plus client JS residual | 0.23 |
| Worker JS plus uninstrumented read residual | 13.85 |

The history redesign reduces the visible delay from 1436.24 ms to 546.89 ms.
For Add Plate, the history begin/commit path now records a sparse delta and
emits no `capture_model_state` stage. Plate reflow remains the dominant native
cost at about 472 ms; subsequent work should optimize reflow rather than
reintroduce whole-model history capture.

## Object Move Profile: Gesture Completion to Undo Restore

The object-move acceptance boundary is the real toolbar Undo action completing:
the matching `Undo Move` entry is consumed, enabled `Redo Move` is visible,
the restored selection pivot or bounds and renderer world projection equal the
pre-drag state, and the refreshed model projection is published. The focused
Electron profile uses the exact u1 fixture, proves the
`OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf` receipt of 45,586,816 bytes
and 11 native plates, and uses the normal canvas selection, pointer, history,
Worker, and renderer publication path (no direct native injection). The latest
real threaded-WASM sample (milliseconds) is:

| Boundary or native stage | Time |
| --- | ---: |
| Pointer-up to visible enabled Undo Move | 63.10 |
| Application mutation/publication | 54.14 |
| Client transaction | 23.44 |
| Worker transaction | 23.28 |
| WASM instrumented total | 10.78 |
| History begin total / sparse delta record | 1.40 / 0.01 |
| Transform total | 2.35 |
| History commit total / sparse delta record / history store | 7.02 / 0.06 / 5.04 |
| Undo click to restored projection fence | 558.78 |
| Application restore / publication | 9.73 / 481.25 |
| Client restore | 9.70 |
| Worker restore | 9.26 |
| WASM instrumented restore total | 2.72 |
| Restore delta apply / total | 2.72 / 2.72 |
| Narrow tower projection read / set / reconcile / emit | 477.00 / 0.24 / 0.17 / 0.05 |
| Renderer-to-Worker transport plus client JS residual | 0.45 |
| Worker JS plus uninstrumented native residual | 6.53 |

This independent acceptance run consumed the renderer-local transform receipt
(`transformReceiptApplied` delta 1), left `fullRestoreModelReloads` unchanged,
and restored all 14 model world centers plus renderer selection/bounds/pivot.
The exact u1 fixture receipt was 45,586,816 bytes across 11 native plates;
native restore stages remained `delta_apply` and `total` only. The direct path
performed exactly one tower read/set/reconcile/emit delta after the settled
pre-Undo baseline, and no receipt fallback occurred.

The native transform and restore samples are scalar-only and bounded. Direct
Move begin/commit expose `delta_record` (and `history_store` on commit), while
direct Undo/Redo expose `delta_apply` and `total`; no full native model staging
or `capture_model_state` stage occurs on this adjacent path. Renderer-local
publication now applies the receipt's exact target instance/volume transforms,
updates the normalized target session context without a Worker session read,
and restores selection, pivot, and bounds without replacing model meshes.
Application diagnostics expose each restore substage: plate-session snapshot,
plate-session transform application, receipt application, selection restore,
and prime-tower read/set/reconcile/emit. The positive adjacent Move profile
shows zero count deltas for the session snapshot/transform stages and one
isolated narrow tower projection delta; fallback coverage verifies that
malformed/stale or ambiguous session/receipt values take the authoritative
projection path.

## Prime Tower Projection Profile: Post-Undo Read

The profiling-only native contract now records one bounded, drain-on-read
`prime_tower_projection` sample for the narrow projection read. Its aggregate
`stages_ms` contains session preparation, printer bounds, the seven plate-local
stages, final JSON serialization/copy, and the ABI `total`. Its
`per_plate_stages_ms` array is indexed only by native plate index and contains
the plate-local stages plus `total`; it contains no plate IDs, project names,
model data, or mesh bytes. The client normalizer requires these exact stage
sets, rejects extra or missing stages, and bounds the profile ring at 16
samples.

The latest real threaded-WASM post-Undo sample on the exact u1 fixture (11
plates; 45,586,816-byte `OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf`),
captured after draining the settled pre-Undo baseline, measured (milliseconds):

| Native aggregate stage | Time |
| --- | ---: |
| Session preparation | 0.00 |
| Printer bounds scan | 0.00 |
| Effective config construction (sum of plates) | 3.69 |
| Plate-local model construction (sum of plates) | 2.48 |
| Used-slot scan (sum of plates) | 196.73 |
| Printable/height/bounds scan (sum of plates) | 5.17 |
| Direct Orca-style wipe-tower estimate (sum of plates) | 0.03 |
| `Print.apply` fallback (sum of plates) | 0.00 |
| Footprint/bands projection JSON (sum of plates) | 0.16 |
| Final JSON serialization | 0.07 |
| Final JSON copy | 0.00 |
| Native ABI total | 208.87 |

The slowest indexed plate-local samples were plate index 9 at 178.70 ms
(170.92 ms used-slot scan) and plate index 0 at 29.61 ms. The direct estimator
is the Orca pre-slice formula: it uses the current height, used-slot count,
prime volume, layer height, infill gap, wall type, rib settings, filament
change volume, and (when enabled) the square SEMM purge matrix. It does not
construct a temporary `Print`; only malformed or incomplete matrix/numeric
inputs use the local `Print.apply` fallback, which is profiled separately and
was zero on this real project. The rectangle, Rib, Smooth timelapse, and
multi-filament native-input smoke cases all assert the direct path and zero
fallback. This is runtime-only state and is never serialized or compatibility
loaded.

The measured direct-estimator run is compared with the accepted post-cache
baseline below: it removes the 31.26 ms temporary Print/wipe stage, while the
remaining cost is the still-unchanged used-slot scan. This step deliberately
does not implement per-object used-slot caching.
The same-plate translation-only path retains all cached plate projections;
cross-plate membership or out-of-bounds changes evict only source and
destination plates;
rotation/scale/mirror/shear changes evict affected plates; plate structure,
configuration, project load, and complete history restore evict all entries.
The cache is never serialized and has no cross-version compatibility contract.

The independently accepted post-cache real threaded-WASM run measured 322.80 ms
click-to-restored-projection, 247.16 ms application publication, and 242.47
ms client projection round-trip. The native history restore itself was 3.31
ms; the remaining time is the authoritative projection publication/read
fence. Only two indexed plates were recomputed: plate 0 (36.40 ms) and plate
9 (205.03 ms); the other nine plate-local samples were zero. Native projection
time was 241.94 ms, including 199.25 ms used-slot scanning and 31.26 ms
Print/wipe data construction. The Step 14 direct-estimator run measured
208.87 ms native projection time, including 196.73 ms used-slot scanning,
0.03 ms direct estimate, and zero fallback. It measured 278.85 ms
click-to-restored projection, 214.19 ms application publication, and 209.43
ms client projection round-trip. The same run measured 99.44 ms from pointer-up
to visible Undo and 0.81 ms of renderer-to-Worker/client-JS residual around
the read. A cache hit records zero for every plate-local stage and returns the
same projection JSON; same-plate XY-only movement therefore avoids this
projection work entirely, while Z/geometry or membership changes invalidate
only the affected plate entries.

## Step 15: incremental used-slot summaries

The remaining Step 14 hotspot was the per-plate `used_slot_scan`. The bridge
now keeps a runtime-only summary for each stable plate ID. The summary stores
the effective used-slot contribution of each currently printable object, the
active object-ID set, and the plate custom-toolchange contribution. A same
plate projection is a summary hit. When membership changes move an object
between plates, only the source/destination object-ID sets and changed object
contributions are merged; volume extruders, layer-range extruders, support and
raft fallbacks, object material IDs, and custom toolchanges retain the exact
ascending unique-slot semantics of the original scan.

The summary and its instance-owner index are never serialized. Complete model,
filament, project-config, plate-structure, custom-G-code, and history restores
clear them. A missing owner, changed effective used-slot config signature, or
unknown model object takes the original full scan fallback and rebuilds the
summary. Thus a stale runtime summary cannot change the published slot set.
The native profile now separates `used_slot_summary_hit`,
`used_slot_summary_delta`, and `used_slot_full_scan_fallback`; `used_slot_scan`
remains their total lookup wall time.

The independently accepted real u1.3mf threaded non-mock E2E measured 104.58
ms from Undo click to restored projection, 28.70 ms client projection read,
11.96 ms Worker projection read, and 11.65 ms native projection work. The
affected plates used summary hits only: `used_slot_summary_hit` was 0.115 ms,
`used_slot_summary_delta` and `used_slot_full_scan_fallback` were 0 ms, and
the complete native `used_slot_scan` total was 0.115 ms. This is lower than
the Step 14 208.87 ms native projection / 278.85 ms click-to-restored profile;
the remaining native work is primarily effective-config construction,
plate-local model construction, and height bounds.

### Dedicated real-project interaction acceptance profile

Step 15 now has one dedicated, headed Electron acceptance profile for the
exact 45,586,816-byte u1.3mf fixture. The runner requires `VITE_USE_MOCK=0`,
builds a separate threaded WASM variant with `NEO_REAL_PROJECT_PROFILE=1`,
stages it as `profile-threaded`, and drives a visible window. It proves the
11-plate native load receipt, Add Plate to enabled `Undo Add Plate`, a genuine
canvas Move to enabled `Undo Move`, and Undo to the exact pre-Move model-center
projection with enabled `Redo Move`.

The dedicated build records application/client/Worker timing, JSON bytes and
wall time for each JS-to-WASM call, and the named native stages for history,
plate mutation, transform, restore, and prime-tower projection. Its snapshot
attributes the WASM heap, history retention, shared source meshes, per-plate
`Print`/`GCodeProcessorResult` core-cache counts and byte estimates, renderer
typed arrays, and estimated GPU geometry buffers. Shared mesh storage is
charged once at the authoritative-model level and each per-plate mesh-byte
attribution is explicitly zero.

The Step 16 baseline reproduced 1,494.93 ms from Undo click to the restored
renderer/model fence. Native restore itself was 6.50 ms, the complete
JS-to-WASM call 13.45 ms, Worker 13.97 ms, client 14.50 ms, and renderer bounds
polling only 0.64 ms. The application projection stage consumed 1,418.81 ms
because the sparse native transform receipt was rejected and the application
reloaded the complete 57,317,544-byte mesh projection. The proof failed for
two independent reasons: Add Plate had normalized native wipe-tower coordinate
arrays without publishing the resulting overlay, and the proof treated each
plate input revision as a per-plate counter even though revisions come from a
single global monotonic allocator. Native transform restore also advances every
plate containing the transformed object, not only the explicit instance's
plate.

The optimized path carries the normalized overlay in structural plate
receipts, atomically publishes it with the plate session, and validates Move
restore revisions as strictly forward stamps on exactly the plates containing
the transformed object. Unrelated plates, non-forward stamps, malformed
receipts, overlay changes, and non-adjacent/full-history crossings still use
the existing conservative full restore. No internal-state compatibility path
was added.

The final accepted visible run measured 68.56 ms from Add Plate click to
visible Undo, 60.72 ms from Move pointer-up to visible Undo, and 104.09 ms from
Undo click to the restored renderer/model plus enabled Redo fence. The Undo
call was 14.19 ms end-to-end across JS/WASM, including 6.66 ms native history
restore; Worker and client boundaries were 14.72 ms and 15.20 ms. Application
restore was 15.23 ms, sparse receipt application 0.15 ms, selection restore
2.57 ms, the authoritative narrow Prime Tower read 25.84 ms (11.94 ms native),
and total application projection 30.53 ms. The receipt applied once with zero
proof failures, zero fallbacks, and zero full model reloads; Redo restored the
exact moved renderer projection. This is a 93.0% reduction of the measured
Undo recovery fence. The post-Undo snapshot
reported a 1,873,543,168-byte WASM heap, 11,069,344 retained history bytes,
57,317,544 shared-mesh bytes, 4,896 aggregate per-plate structural bytes,
239,712 aggregate derived-cache bytes, 57,317,544 renderer typed-array bytes,
and 76,412,856 estimated GPU bytes. Both mutation availability fences remain
below the accepted 100 ms boundary.

The normal CMake default leaves `NEO_REAL_PROJECT_PROFILE` off and does not
compile the profile translation unit. Renderer/Worker hooks use direct Vite
build-time branches, not runtime guards. Ordinary staging deletes the
`profile-threaded` directory. The runner finishes by rebuilding the normal
threaded WASM and Electron renderer with `VITE_USE_MOCK=0`, then scans both
artifacts and fails if any profile ABI, hook, path, or sentinel remains.

The canonical command is
`pnpm --filter @orca/desktop test:e2e:real-project-profile`. It always rebuilds
the dedicated WASM, stages that artifact, builds the profiled renderer, runs the
visible test, restores production artifacts, and executes both
inclusion/exclusion scans. The former `ORCA_REAL_PROJECT_PROFILE_SKIP_WASM_BUILD`
bypass has been removed; older run records below describe historical evidence,
not an available verification shortcut.

## Per-Plate Print Architecture Final Qualification

The approved [`Per-Plate Print Architecture`](../spec/Per-Plate%20Print%20Architecture.md)
is delivered as one FFF-only path. `BridgeState` no longer owns a singleton
`Print` or preview-result record. Each stable runtime plate entry owns its
`Print`, `GCodeProcessorResult`, generation-scoped immutable MEMFS G-code
source, input/presentation stamps, and job/tombstone lifetime. Slice applies
the authoritative world-space model directly to the selected plate's Print;
result projection, source-text paging, Export, and Send all require the same
plate/input/generation receipt. History captures inputs only and reconciles
the runtime registry; it never serializes a Print, G-code, or projection.

The final code/test audit found no remaining implementation gap against
specification sections 2.1–2.19. The requirements-to-evidence map is:

| Spec | Production boundary and acceptance evidence |
| --- | --- |
| 2.1 | `PlateRuntimeRegistry::Entry` owns each plate's Print, result, generation, file, stamps, and lease state; `plate-local-slice-smoke.mjs` proves independent retained results. |
| 2.2 | `orc_slice` resolves only the selected registry entry and always runs its normal task/result terminal; `multi-filament-slice-plate-index-smoke.mjs` proves direct world-model plate context and current-plate processing. |
| 2.3 | `project-roundtrip.mjs` proves fresh session IDs/entries, close-before-load failure semantics, no restored runtime result, and collective-centre geometry-only import; persistence contains no runtime identity. |
| 2.4 | Registry presentation state is distinct from core ownership; `config-scope-invalidation-smoke.mjs` and `transform-plate-invalidation-smoke.mjs` prove local/shared stamp fan-out, failed-edit preservation, and explicit stale/unavailable results. |
| 2.5 | Input invalidation retains core objects and G-code until replacement/destruction; the exact-u1 profile attributes heap, shared mesh, per-plate structure/derived cache, React, and GPU bytes without eviction. |
| 2.6 | `orc_add_plate` gates reflow on the column transition and `orc_reorder_plates` preserves origin-stable entries; the exact-u1 Add Plate profile and `plate-reorder-smoke.mjs` prove sparse invalidation and no eager Print apply. Duplicate Plate remains absent. |
| 2.7 | Delete parks instances and registry retirement retains only the leased incarnation; `plate-delete-tombstone-smoke.mjs` proves active deletion, stale result rejection, distinct Undo incarnation, and terminal release. |
| 2.8 | Plate-local tower coordinates move only with affected origins; the Prime Tower Step 13, projection, and Move harnesses prove targeted cache invalidation and zero prepare-time Print fallback for supported inputs. |
| 2.9 | `history-plate-runtime-smoke.mjs` and `history-smoke.mjs` prove input-only history, sparse one-entry Move/plate receipts, registry reconciliation, and no restored derived result. |
| 2.10 | Full restore validates/stages first, reconciles exact stable plate IDs, and destroys absent entries; the history/runtime harness covers add/delete/restore and failed atomic restoration. |
| 2.11 | Input stamps and task/incarnation checks gate every history/slice publication; transform invalidation and tombstone harnesses prove no stale output and no authoritative-Model deletion tombstone. |
| 2.12 | `useSliceResult` retains one current projection and receipt/epoch-checks delivery; visible serial/threaded Web multi-plate Preview tests prove release, needs-slicing state, retained native revisit, and projection-terminal separation. |
| 2.13 | `plate-local-slice-smoke.mjs`, `sliceActions.test.ts`, and Send dialog tests prove selected-current Slice/Export/Send, generation-addressed immutable MEMFS reuse, active-job export lock, and input-only save behavior. |
| 2.14 | Runtime and bridge serial gates keep selected/active/preview identities locked in serial, while threaded selection and editing remain responsive; Worker tests and visible multi-plate host tests cover both projections. |
| 2.15 | `bridge-smoke.mjs` proves detached pthread processing, shared-state responsiveness, asynchronous cancellation, pool reporting, and serial epoch rejection; `async-task-mailbox.mjs` proves global IDs and ordered no-overwrite FIFO delivery. |
| 2.16 | The bridge smoke proves one global job, last explicit replacement wins, edits create no replacement, and ordinary result handling still runs; feasibility terminals are produced only after apply inside the task. |
| 2.17 | The same real-WASM job coverage proves serial Cancel rejection, threaded nonblocking Cancel, retained Print ownership, terminal completion, and no partial/stale publication. |
| 2.18 | Real bridge/Worker tests cover serial busy and stale epoch admission, replacement/progress identity, explicit projection invalidation, lifecycle tombstones, and result terminals; the visible exact-u1 case proves active-slice edit plus Undo under 100 ms. |
| 2.19 | The visible non-mock exact-u1 profile records complete renderer/client/Worker/JS-WASM/native timings, operation counts, memory attribution, and the no-reflow Add Plate, Move, Undo, and active-slice Move fences. |

The delivery also closes the renderer-result boundary. An admitted explicit
Slice immediately clears only the transferable React projection, retains the
native core for incremental processing, executes the complete native Slice
pipeline, publishes the global Slice terminal before any delayed renderer
projection, and rejects late payloads by plate, input stamp, generation, and
local presentation epoch. Reordering preserves only origin-stable entries;
deleting an actively sliced plate tombstones that incarnation until its job
terminates; Undo creates a distinct live incarnation.

The final visible exact-u1 Electron run used
`OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf` (45,586,816 bytes, 11 native
plates) with `VITE_USE_MOCK=0`. Its current measurements supersede earlier
baselines in this document:

| Acceptance boundary | Time |
| --- | ---: |
| Add Plate dispatch to visible `Undo Add Plate` | 50.995 ms |
| Ordinary Move dispatch to visible `Undo Move` | 32.397 ms |
| Undo click to restored model | 65.254 ms |
| Active-threaded-slice Move to visible Undo | 92.925 ms |
| Active-slice Move Worker / client / application | 46.960 / 47.310 / 50.670 ms |
| Native history begin / transform / commit | 7.435 / 4.865 / 13.860 ms |

The active-slice case performs the production transform/history mutation while
a detached pthread owns the Slice job. The matching Undo appears below the
100 ms gate, the old result fails its stamp/publication proof, and Export does
not expose it. Transform capture sends only the selected CompositeIDs. Its
history transaction projects the returned filament/history revision without a
full filament snapshot read, and the application subscribes only to shell-
rendered project fields so internal mutation-fence updates do not rerender the
whole application.

The final memory attribution was a 1,985,937,408-byte WASM heap, 13,251,872
history bytes, 57,317,544 shared source-mesh bytes, 44,432 per-plate structural
bytes, 504,840 per-plate derived bytes, 57,317,544 React typed-array bytes,
and 76,412,856 estimated GPU bytes. No derived cache was automatically
evicted.

The acceptance runner always opens a visible Electron window. Both Web
Playwright configurations also hard-code visible operation. Production does
not execute even a profile-feature guard: native probes are compiled only
under `NEO_REAL_PROJECT_PROFILE`, renderer hooks use Vite compile-time
branches, and the restored production WASM/Electron artifacts pass the
sentinel and call-site exclusion scan.

## Verification

- `pnpm --filter @orca/slicer-wasm test` — 153 tests passed.
- `pnpm --filter @orca/slicer-wasm typecheck` — passed.
- `pnpm --filter @orca/slicer-runtime test` — 34 tests passed.
- `pnpm --filter @orca/slicer-runtime typecheck` — passed.
- `pnpm --filter @orca/desktop test` — 67 tests passed.
- `pnpm --filter @orca/desktop typecheck` — passed.
- `pnpm --filter @orca/slicer-app test` — 579 tests passed, including the
  structural-overlay publication and bounded Move receipt proof/fallback
  cases.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `pnpm --filter @orca/web test` — 27 tests passed.
- `pnpm --filter @orca/web typecheck` — passed.
- `cmd /c scripts\build-windows.bat quick --variant both` — threaded and
  serial WASM artifacts built and validated.
- `node packages/slicer-wasm/harness/history-smoke.mjs` against serial and
  threaded artifacts — passed. The Add Plate Undo/Redo regression verifies
  stable session plate IDs, stable logical membership and ModelObject IDs,
  complete rematerialized live instance IDs, and strictly newer monotonic
  slice-input stamps for every affected restored plate.
- `node packages/slicer-wasm/harness/history-plate-runtime-smoke.mjs` against
  both serial and threaded artifacts — passed.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-step13-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js` — passed; verifies cache hits have zero plate-local used-slot/Print work, Z translation invalidation, and configuration/history invalidation.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-step13-smoke.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js` — passed with the same cache and invalidation coverage.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-move-smoke.mjs
  --module packages/slicer-wasm/out/serial/orca_slice.js` and the freshly built
  threaded artifact — passed; Prime Tower
  Undo/Redo repopulates the target plate projection after its targeted cache
  invalidation while retaining the narrow frame and unaffected preview
  contract. The threaded-only WASM out-of-bounds failure was an intermittent
  slice-worker lifecycle race: the pthread enqueued its terminal before it had
  finished unwinding, while mailbox consumption immediately released the
  active-job gate. The threaded bridge now keeps that pthread joinable and
  joins it before publishing the terminal or starting another task. The exact
  threaded regression then passed eight consecutive untraced runs in addition
  to the final serial/threaded acceptance runs.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-native-input-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js` and the threaded artifact — passed; painted volume slots, custom plate toolchanges, routing, and hidden-object filtering retain the exact slot sets.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-projection-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js` and the threaded artifact — passed; rectangle, Rib, Smooth timelapse, and multifilament cases use the direct estimator and record zero Print fallback.
- `pnpm stage:assets` from the repository root, then `pnpm exec electron-vite
  build` from `apps/desktop` with `VITE_USE_MOCK=0` and `VITE_E2E=1` — stages
  the just-built WASM into renderer source before the Electron bundle is made.
- `ORCA_E2E_REAL=1`, `VITE_USE_MOCK=0`, and the exact h2d fixture with
  `pnpm exec playwright test e2e/plate-add-history-profile.e2e.ts` from
  `apps/desktop` — passed; it asserts the real project receipt and the absence
  of `capture_model_state` on Add Plate history begin/commit.
- `ORCA_E2E_REAL=1`, `VITE_USE_MOCK=0`, and the exact u1 fixture with
  `pnpm exec playwright test e2e/object-move-history-profile.e2e.ts -g
  "profiles a real object move"` from `apps/desktop` — passed; it verifies
  the real receipt, canvas drag, consumed Undo/visible enabled Redo fence,
  restored renderer projection, Worker/client read boundaries, and the exact
  scalar native `prime_tower_projection` aggregate/per-plate stage schema
  alongside sparse native `delta_record`/`delta_apply` stages without full
  native staging.
- Dedicated `NEO_REAL_PROJECT_PROFILE=1` threaded WASM build — passed;
  `orca_slice.wasm` was 34,104,592 bytes and exported the profile ABI only in
  `out/profile-threaded`.
- `$env:ORCA_REAL_PROJECT_PROFILE_SKIP_WASM_BUILD='1'; pnpm --filter
  @orca/desktop test:e2e:real-project-profile` — passed after the final direct
  receipt assertions and exact Redo projection check. The run staged the real
  profile artifact, built with
  `VITE_USE_MOCK=0`, ran one headed/visible exact-u1 acceptance test, restored
  the normal threaded artifact, rebuilt the production Electron renderer, and
  verified that production retained no profile sentinel or call site.
- `$env:VITE_USE_MOCK='0'; pnpm --filter @orca/web test:e2e:threaded` — six
  visible real-WASM Playwright tests passed.
- `$env:VITE_USE_MOCK='0'; pnpm --filter @orca/web test:e2e:serial` — six
  visible real-WASM Playwright tests passed.
- `$env:ORCA_E2E_VISIBLE='1'; pnpm --filter @orca/desktop test:e2e` — the full
  visible Electron regression suite passed.
- `node scripts/verify-real-project-profile-exclusion.mjs` — restored
  production WASM and Electron bundles contain no dedicated profile ABI, hook,
  call site, or sentinel.
- `git diff --check` — passed.

Do not treat a build under `packages/slicer-wasm/.work` or
`packages/slicer-wasm/out` alone as Electron acceptance. Real-project tests
must run `pnpm stage:assets` after the WASM build and before the Electron
renderer build; copying an already-built renderer cannot update embedded
public assets. The test must set `VITE_USE_MOCK=0` explicitly and prove the
fixture name, byte count, and 11-plate native receipt before profiling.

### Timestamp restore archive reuse (2026-09-19)

The full timestamp restore had decoded every object archive, including painted
volume payloads and a second volume encode/decode pass, even when only one
instance transform changed. Shared archive identity now proves which staged
native objects can be reused with the target transform overlays. Changed
archives still use complete decoding and stable-ID materialization. The
transactional staging/validation/rollback boundary and renderer SceneDelta
contract remain intact.

The fresh, no-skip `scripts/run-real-project-profile.mjs` run against the exact
45,586,816-byte Odyssey u1 fixture in visible, non-mock Electron measured:

| Boundary | Time |
| --- | ---: |
| Add Plate to visible Undo | 45.865 ms |
| Move pointer-up to visible Undo | 26.263 ms |
| Move during active slice to visible Undo | 87.215 ms |
| Undo click to restored model | 185.896 ms |
| Native history restore | 5.670 ms |
| Native model staging | 0.730 ms |
| Native Prime Tower projection | 46.790 ms |
| Native used-slot summary lookup | 0.630 ms |
| Native full used-slot scan | 0 ms |

The historical restore callback had also unconditionally cleared Prime Tower
usage summaries after the history path had already selected its invalidation.
That duplicate callback is removed. Transform-only restores retain summaries;
changed object archives still invalidate them. The fixture conservatively
recomputed all 12 plate projections in this run, but each reused its usage
summary. Where unchanged plate/config roots can be proved, only affected owning
plates lose their cached estimates. The real-project profile now asserts zero
full used-slot scan after Move Undo. Its runner restores the production build
and verifies the absence of dedicated profile sentinels and call sites.

Repeated native acceptance exposed an independent upstream single-tool priming
fault. With the same release artifact, the fourth independent threaded run
failed during the first actual Slice, before mixed-object history restoration.
A separately linked symbol-map artifact reproduced the failure and resolved
the stack to `WipeTower2::prime` → `Print::_make_wipe_tower` → `Print::process`.
The third fixture plate uses one tool while smooth timelapse requires a tower.
The final-tool branch indexed `tools[idx_tool - 1]` when `idx_tool` was zero,
causing an unsigned underflow and nondeterministic out-of-bounds heap access.

The same expression remains in [Orca's upstream implementation](https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/libslic3r/GCode/WipeTower2.cpp).
Formal Orca patch `0009-wipe-tower-single-tool-priming.patch` uses the existing
`old_tool`, captured before changing tools. This preserves the previous-tool
matrix lookup for multi-tool priming and selects the same-tool diagonal for
one-tool priming, where no material transition occurs. Existing loading and
the wipe routine's mandatory first row remain unchanged; no artificial purge
minimum or fixture workaround is introduced. The native harness now explicitly
checks that this plate uses exactly one tool before slicing. Patch validation
replays the complete Orca patch stack against the pinned HEAD using a temporary
Git index, leaving pre-existing submodule edits untouched.

After the patch, ten independent threaded processes completed the complete
three-plate history/tower harness with tracing enabled. The artifact SHA-256
remained `11c45576e4c588087e8a1825950b201c7270b8614bb9a07ef01061c2bedf760b`
before and after the ten runs. Both real-WASM history harnesses, the serial
tower harness, and both variants' native identity/model-history tests passed.
The subsequent fresh, no-skip, visible exact-u1 profile also passed: Add Plate
45.475 ms, Move 33.368 ms, active-slice Move 81.385 ms, Undo 168.993 ms, native
restore 5.695 ms, and full used-slot scan 0 ms. The runner restored production
and passed profile-code exclusion verification.

The root's independent 2026-09-19 acceptance of asynchronous history restoration
used another fresh run of
`pnpm --filter @orca/desktop test:e2e:real-project-profile`. It loaded the same
exact 45,586,816-byte u1 fixture in visible, non-mock Electron and measured
Add Plate to visible Undo at 38 ms and active-slice Move to visible Undo at
46.2 ms. The test verified that Undo returned before the obsolete slice's
terminal event and restored the actual Prepare model positions. Production
artifact restoration and profile-code exclusion passed. The root also
independently passed the serial bridge smoke, including `slice_busy` and stale
terminal-epoch rejection; these checks qualify the serial admission boundary
separately from the threaded real-project profile.

### Prime Tower projection validity (2026-09-19)

Every committed plate input stamp is a Prime Tower projection dependency.
Prepare refreshes from plate-session mutation receipts even when transforms
retain the same GLVolume and object-list arrays. Selecting a different plate
only changes interaction ownership and does not issue another projection read.
Native cached projections carry the input stamp and display index; a read
recomputes a mismatched entry lazily. Explicit cache eviction is no longer the
only validity proof. Unaffected plates and incremental filament-usage summaries
remain reusable; no new model traversal or reflow is added to cache hits.

The real-WASM `prime-tower-cache-validity-smoke.mjs` covers warm reads,
selection, ordinary movement, the final object leaving and returning to a bed,
configuration changes, plate reorder, and deletion to an empty plate. It checks
the returned eligibility, dimensions, and slot data, with zero recomputation
for unrelated plates during movement and zero full used-slot scans for ordinary
translation. The Workspace regression exercises the committed transform
receipt and actual WipeTowerVolumeCollection, proving tower removal/restoration
without replacing scene geometry and no projection read for plate selection.
