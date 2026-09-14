# Complex Project Interaction Performance

Date: 2026-09-14
Status: Implemented with object/mesh reuse, Add Plate delta history, and
real-project profiling
Scope: Prepare-viewport object transforms and multi-plate structural commands.

## Problem

Complex 3MF projects can stall after moving an object and while adding or
deleting a plate. The affected workflows include the 11-plate helmet project
used by the desktop plate-switch performance coverage.

## Accepted Behaviour

- A completed object gesture submits the complete renderer CompositeID
  snapshot and recomputes membership globally. This keeps rapid consecutive
  gestures and Worker history snapshots identical.
- Transform-payload reduction and partial membership rebuilds require a
  Worker-side history-aware design and are intentionally deferred.
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
| Renderer click to visible enabled Undo Add Plate | 546.89 |
| Application mutation/publication | 520.87 |
| Client transaction | 493.98 |
| Worker transaction | 493.81 |
| WASM instrumented total | 479.89 |
| History begin `delta_record` | 0.00 |
| Add Plate reflow | 471.52 |
| History commit `delta_record` | 0.07 |
| History-store insertion | 3.40 |
| Main-thread/Worker transport plus client JS residual | 0.16 |
| Worker JS plus uninstrumented read residual | 13.92 |

The history redesign reduces the visible delay from 1436.24 ms to 546.89 ms.
For Add Plate, the history begin/commit path now records a sparse delta and
emits no `capture_model_state` stage. Plate reflow remains the dominant native
cost at about 472 ms; subsequent work should optimize reflow rather than
reintroduce whole-model history capture.

## Object Move Profile: Gesture Completion to Undo

The object-move acceptance boundary is the renderer completing one real canvas
body drag and the toolbar showing enabled `Undo Move`. The focused Electron
profile uses the same exact h2d fixture, proves the 45,201,991-byte filename
receipt and 11 native plates, drains load-time samples, and uses the normal
selection, pointer, history, and Worker transaction path (no direct native
injection). The latest real threaded-WASM sample (milliseconds) is:

| Boundary or native stage | Time |
| --- | ---: |
| Pointer-up to visible enabled Undo Move | 107.54 |
| Application mutation/publication | 99.09 |
| Client transaction | 71.36 |
| Worker transaction | 71.11 |
| WASM instrumented total | 57.83 |
| History begin total / capture | 2.42 / 0.75 |
| Begin collection/cache / mutable archive / immutable retention | 0.05 / 0.67 / 0.00 |
| Transform input/JSON decode | 0.53 |
| Transform request validation/target resolution | 0.53 |
| Transform mutation | 0.00 |
| Plate-membership/reflow | 1.00 |
| Transform response JSON serialization | 0.06 |
| Transform total | 2.13 |
| History commit total / capture / history store | 53.27 / 45.24 / 5.20 |
| Commit collection/cache / mutable archive / immutable retention | 0.06 / 45.14 / 0.00 |
| Main-thread/Worker transport plus client JS residual | 0.25 |
| Worker JS plus uninstrumented native reads residual | 13.28 |

The native transform and history-capture samples are scalar-only and bounded.
Their stage names are asserted by the native history smoke and by the focused
E2E; the E2E also asserts that the only drained mutation samples are
`history_begin`, `set_model_transforms`, and `history_commit`. The measured
45.14 ms mutable-object archive stage accounts for nearly all of the 53.27 ms
native history commit. Cache comparison and immutable mesh retention are both
sub-millisecond, establishing that retained immutable shared meshes contribute
no mesh-byte serialization cost. The Move-to-Undo latency is therefore caused
primarily by mutable object archive work during history commit, with the
remaining delay in Worker/application scheduling and reads rather than object
movement, mesh serialization, or plate reflow.

## Verification

- `pnpm --filter @orca/slicer-wasm test` — 143 tests passed.
- `pnpm --filter @orca/slicer-wasm typecheck` — passed.
- `pnpm --filter @orca/slicer-app test` — 558 tests passed.
- `pnpm --filter @orca/slicer-app typecheck` — passed.
- `cmd /c scripts\build-windows.bat quick -j 8` — current threaded and
  serial WASM artifacts built and validated.
- `node packages/slicer-wasm/harness/history-smoke.mjs packages/slicer-wasm/.work/serial/build/orca_slice.js` — passed, including no-reflow/reflow delta, normal-edit crossing, Undo/Redo, and redo-branch checks.
- `pnpm stage:assets` from the repository root, then `pnpm exec electron-vite
  build` from `apps/desktop` with `VITE_USE_MOCK=0` and `VITE_E2E=1` — stages
  the just-built WASM into renderer source before the Electron bundle is made.
- `ORCA_E2E_REAL=1`, `VITE_USE_MOCK=0`, and the exact h2d fixture with
  `pnpm exec playwright test e2e/plate-add-history-profile.e2e.ts` from
  `apps/desktop` — passed; it asserts the real project receipt and the absence
  of `capture_model_state` on Add Plate history begin/commit.
- `ORCA_E2E_REAL=1`, `VITE_USE_MOCK=0`, and the exact h2d fixture with
  `pnpm exec playwright test e2e/object-move-history-profile.e2e.ts -g "profiles a real object move"`
  from `apps/desktop` — passed; it asserts the real project receipt, 11-plate
  native result, visible enabled `Undo Move`, cross-layer residuals, all six
  `set_model_transforms` timing stages, and all four normal history capture
  timing stages; it prints the measured stage values above.
- `git diff --check` — passed.

Do not treat a build under `packages/slicer-wasm/.work` or
`packages/slicer-wasm/out` alone as Electron acceptance. Real-project tests
must run `pnpm stage:assets` after the WASM build and before the Electron
renderer build; copying an already-built renderer cannot update embedded
public assets. The test must set `VITE_USE_MOCK=0` explicitly and prove the
fixture name, byte count, and 11-plate native receipt before profiling.
