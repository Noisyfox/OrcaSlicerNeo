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
| Pointer-up to visible enabled Undo Move | 187.84 |
| Application mutation/publication | 179.24 |
| Client transaction | 154.03 |
| Worker transaction | 153.80 |
| WASM instrumented total | 141.30 |
| History begin total / capture | 108.22 / 106.63 |
| Transform total | 2.11 |
| History commit total / capture / history store | 30.96 / 21.66 / 4.26 |
| Undo click to restored projection fence | 3,782.98 |
| Application restore / publication | 1,800.57 / 1,922.27 |
| Client restore | 1,800.54 |
| Worker restore | 1,800.11 |
| WASM instrumented restore total | 1,795.44 |
| Restore equality / staging / mesh reconnect | 0.82 / 1,789.82 / 0.05 |
| Restore plate/session/overlay / cursor / response JSON | 0.55 / 0.01 / 0.09 |
| Renderer-to-Worker transport plus client JS residual | 0.43 |
| Worker JS plus uninstrumented native residual | 4.67 |

The native transform, capture, and restore samples are scalar-only and bounded;
their exact stage names are asserted by native history smoke and focused E2E.
The restore fence shows that mutable-object staging/deserialization dominates
the user-visible Undo latency (about 1,790 ms of 1,795 ms instrumented native
time). The remaining time is primarily renderer publication and model-mesh
reloading, while transport/client JS and uninstrumented Worker/native work are
reported separately as the two residuals above.

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
- `ORCA_E2E_REAL=1`, `VITE_USE_MOCK=0`, and the exact u1 fixture with
  `pnpm exec playwright test e2e/object-move-history-profile.e2e.ts -g "profiles a real object move"`
  from `apps/desktop` — passed; it asserts the real receipt (filename, byte
  count, and dynamically reported 11 native plates), actual canvas drag, the
  consumed Undo/visible enabled Redo restore fence, restored renderer
  projection, cross-layer residuals, and all seven full-restore stages; it
  prints every measurement above.
- `git diff --check` — passed.

Do not treat a build under `packages/slicer-wasm/.work` or
`packages/slicer-wasm/out` alone as Electron acceptance. Real-project tests
must run `pnpm stage:assets` after the WASM build and before the Electron
renderer build; copying an already-built renderer cannot update embedded
public assets. The test must set `VITE_USE_MOCK=0` explicitly and prove the
fixture name, byte count, and 11-plate native receipt before profiling.
