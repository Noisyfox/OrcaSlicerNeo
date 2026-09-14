# Complex Project Interaction Performance

Date: 2026-09-14
Status: Implemented with transform-payload rollback
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

## Verification

- Focused transform/history and plate-session unit coverage.
- Affected package typecheck and applicable native WASM quick build.
- The real desktop multi-plate interaction performance scenario when its
  runtime artifacts are available.
- Real-project Electron acceptance always rebuilds the renderer with
  `VITE_USE_MOCK=0`, stages both current WASM variants, copies them to
  `apps/desktop/out/renderer`, and proves the exact project receipt before
  measuring interaction.
