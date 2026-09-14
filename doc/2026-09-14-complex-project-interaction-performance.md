# Complex Project Interaction Performance

Date: 2026-09-14
Status: Implemented with object/mesh reuse, Add Plate delta history, sparse
Move delta history, and renderer-local adjacent Move restore projection
Scope: Prepare-viewport object transforms and multi-plate structural commands.

## Problem

Complex 3MF projects can stall after moving an object and while adding or
deleting a plate. The affected workflows include the 11-plate helmet project
used by the desktop plate-switch performance coverage.

## Accepted Behaviour

- A completed object gesture submits the complete renderer CompositeID
  snapshot and recomputes membership globally. This keeps rapid consecutive
  gestures and Worker history snapshots identical.
- Adjacent direct Move Undo/Redo consumes the validated native transform
  receipt in the renderer, reusing the retained GL volumes and stable-ID
  structure. Malformed or stale receipts, missing scene targets, and any
  non-adjacent/full-history crossing conservatively use the existing full
  model projection.
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
| Pointer-up to visible enabled Undo Move | 64.50 |
| Application mutation/publication | 55.78 |
| Client transaction | 25.09 |
| Worker transaction | 24.86 |
| WASM instrumented total | 11.02 |
| History begin total / sparse delta record | 1.69 / 0.01 |
| Transform total | 2.19 |
| History commit total / sparse delta record / history store | 7.14 / 0.06 / 5.18 |
| Undo click to restored projection fence | 591.33 |
| Application restore / publication | 10.69 / 511.27 |
| Client restore | 10.65 |
| Worker restore | 9.97 |
| WASM instrumented restore total | 2.87 |
| Restore delta apply / total | 2.86 / 2.87 |
| Renderer-to-Worker transport plus client JS residual | 0.68 |
| Worker JS plus uninstrumented native residual | 7.10 |

This independent acceptance run consumed the renderer-local transform receipt
(`transformReceiptApplied` delta 1), left `fullRestoreModelReloads` unchanged,
and restored all 14 model world centers plus native selection/bounds/pivot. The exact u1 fixture receipt
was 45,586,816 bytes across 11 native plates; native restore stages remained
`delta_apply` and `total` only. No receipt fallback occurred in this run.

The native transform and restore samples are scalar-only and bounded. Direct
Move begin/commit expose `delta_record` (and `history_store` on commit), while
direct Undo/Redo expose `delta_apply` and `total`; no full native model staging
or `capture_model_state` stage occurs on this adjacent path. Renderer-local
publication now applies the receipt's exact target instance/volume transforms,
refreshes the authoritative plate-session context, and restores selection,
pivot, and bounds without replacing model meshes. Receipt application and
full-projection fallback are exposed as bounded application diagnostics.

## Verification

- `pnpm --filter @orca/slicer-wasm test` — 143 tests passed.
- `pnpm --filter @orca/slicer-wasm typecheck` — passed.
- `pnpm --filter @orca/slicer-app test` — 558 tests passed.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `cmd /c scripts\build-windows.bat quick --variant both` — threaded and
  serial WASM artifacts built and validated.
- `node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js` — passed, including sparse Move begin/commit/Undo/Redo, normal-edit crossing, Add Plate delta, and redo-branch checks.
- `node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js` — passed with the same sparse Move coverage.
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
  restored renderer projection, and sparse native `delta_record`/
  `delta_apply` stages without full native staging.
- `git diff --check` — passed.

Do not treat a build under `packages/slicer-wasm/.work` or
`packages/slicer-wasm/out` alone as Electron acceptance. Real-project tests
must run `pnpm stage:assets` after the WASM build and before the Electron
renderer build; copying an already-built renderer cannot update embedded
public assets. The test must set `VITE_USE_MOCK=0` explicitly and prove the
fixture name, byte count, and 11-plate native receipt before profiling.
