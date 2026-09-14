# Complex Project Interaction Performance

Date: 2026-09-14
Status: Implemented with transform-payload rollback and real-project profiling
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
- The real-WASM bridge exposes a bounded, drain-on-read diagnostic timing ring
  for `history_begin`, `add_plate`, and `history_commit`. It carries timing
  scalars only; it never retains model, context, or project data.

## Add Plate Profile: User Click to Undo

The acceptance boundary is not `orc_add_plate` returning. It is the time from
the renderer dispatching Add Plate until the toolbar shows enabled `Undo Add
Plate`. The focused Electron profile uses the exact h2d fixture:

`E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-h2d.3mf`

It proves the 45,201,991-byte project receipt and its 11 native plates before
measuring, drains load-time native samples, and records the following real
threaded-WASM sample (milliseconds):

| Boundary or native stage | Time |
| --- | ---: |
| Renderer click to visible enabled Undo Add Plate | 1436.24 |
| Application mutation/publication | 1379.48 |
| Client transaction | 1351.15 |
| Worker transaction | 1350.89 |
| WASM instrumented total | 1346.14 |
| History begin `capture_model_state` | 433.62 |
| Add Plate reflow | 466.57 |
| History commit `capture_model_state` | 428.22 |
| History-store insertion | 11.45 |
| Main-thread/Worker transport plus client JS residual | 0.26 |
| Worker JS plus uninstrumented read residual | 4.75 |

The delay is therefore native work, not JavaScript or the Worker transport:
two full-model history captures account for roughly 862 ms, and reflowing the
existing plate instances accounts for about 467 ms. Preserve the complete
history snapshot while optimizing these native stages; reducing the transform
payload already caused stale rapid-gesture undo and remains rejected.

## Verification

- Focused transform/history and plate-session unit coverage.
- Affected package typecheck and applicable native WASM quick build.
- The real desktop multi-plate interaction performance scenario when its
  runtime artifacts are available.
- `apps/desktop/e2e/plate-add-history-profile.e2e.ts` against the real h2d
  project, including the visible Undo boundary and native/JS/Worker breakdown.
- Real-project Electron acceptance always rebuilds the renderer with
  `VITE_USE_MOCK=0`, stages both current WASM variants, copies them to
  `apps/desktop/out/renderer`, and proves the exact project receipt before
  measuring interaction.
