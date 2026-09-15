# Complex Project Interaction Performance

Date: 2026-09-14
Status: Implemented with object/mesh reuse, Add Plate delta history, sparse
Move delta history, renderer-local adjacent Move restore projection, validated
retained plate/session delta publication and narrow wipe-tower projection
refresh, plus bounded Prime Tower projection profiling and runtime per-plate
projection caching
Scope: Prepare-viewport object transforms and multi-plate structural commands.

## Problem

Complex 3MF projects can stall after moving an object and while adding or
deleting a plate. The affected workflows include the 11-plate helmet project
used by the desktop plate-switch performance coverage.

## Accepted Behaviour

- A completed object gesture submits the complete renderer CompositeID
  snapshot and recomputes membership globally. This keeps rapid consecutive
  gestures and Worker history snapshots identical.
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
- Adjacent Add Plate Undo/Redo applies only its sparse transform receipt and
  plate/session context. Crossing between an Add Plate frame and an ordinary
  model edit restores the complete predecessor model before applying the
  relevant receipt, so unrelated changes such as a volume transform cannot
  leak through Undo. Non-adjacent menu jumps that would skip uncomposed Add
  Plate deltas are rejected rather than restoring an incomplete state.
- A completed `Move` transaction is a sparse transform-delta frame only when
  its actual model mutation is `orc_set_model_transforms` and no other model
  mutator ran in the transaction. The frame retains affected object, volume,
  and instance identities, before/after transforms, and history revisions;
  retained meshes and mutable-object archives remain shared and untouched.
- Adjacent Move Undo/Redo applies the sparse receipt directly and returns a
  narrow transform receipt plus a full renderer impact descriptor. Crossing
  between a Move frame and a normal model edit stages the retained predecessor
  only when needed; stale identities and non-adjacent jumps across Move frames
  are rejected safely.
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

## Verification

- `pnpm --filter @orca/slicer-wasm test` — 148 tests passed.
- `pnpm --filter @orca/slicer-wasm typecheck` — passed.
- `pnpm --filter @orca/desktop test` — 67 tests passed.
- `pnpm --filter @orca/desktop typecheck` — passed.
- `pnpm --filter @orca/slicer-app test` — 571 tests passed.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `cmd /c scripts\build-windows.bat quick --variant both` — threaded and
  serial WASM artifacts built and validated.
- `node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js` — passed, including sparse Move begin/commit/Undo/Redo, normal-edit crossing, Add Plate delta, and redo-branch checks.
- `node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js` — passed with the same sparse Move coverage.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-step13-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js` — passed; verifies cache hits have zero plate-local used-slot/Print work, Z translation invalidation, and configuration/history invalidation.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-step13-smoke.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js` — passed with the same cache and invalidation coverage.
- `node packages/slicer-wasm/harness/multi-filament-prime-tower-move-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js` and the threaded artifact — passed; Prime Tower Undo/Redo repopulates the target plate projection after its targeted cache invalidation while retaining the narrow frame and unaffected preview contract.
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
- `git diff --check` — passed.

Do not treat a build under `packages/slicer-wasm/.work` or
`packages/slicer-wasm/out` alone as Electron acceptance. Real-project tests
must run `pnpm stage:assets` after the WASM build and before the Electron
renderer build; copying an already-built renderer cannot update embedded
public assets. The test must set `VITE_USE_MOCK=0` explicitly and prove the
fixture name, byte count, and 11-plate native receipt before profiling.
