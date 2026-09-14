# Complex Project Interaction Performance

Date: 2026-09-14
Status: Implemented
Scope: Prepare-viewport object transforms and multi-plate structural commands.

## Problem

Complex 3MF projects can stall after moving an object and while adding or
deleting a plate. The affected workflows include the 11-plate helmet project
used by the desktop plate-switch performance coverage.

## Accepted Behaviour

- A completed object gesture submits only renderer composites whose final
  transforms changed. The pre-slice synchronization path remains the explicit
  full-model safety synchronization.
- A committed transform recomputes plate membership only for instances changed
  by that gesture; it preserves membership and parked state for other
  instances.
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
