# Object Pointer-down Drag Fix

Date: 2026-09-11
Status: Verified
Scope: Restore the existing viewport contract that a primary press on an
unselected ordinary model instance selects it synchronously and may continue
as the same body-drag gesture. Prime Tower behavior and the pinned WASM
submodule are out of scope.

## Accepted behavior

- A press-and-release on an unselected ordinary model selects its complete
  instance without creating transform history.
- A press followed by a same-event-turn movement past the body-drag threshold
  moves that newly selected instance in the same gesture; the first movement
  delta is retained without waiting for a React selection render.
- Existing selected-object, multi-selection, lock, gizmo-priority, Prime Tower,
  cancellation, and one-history-entry-on-success behavior remains unchanged.

## Verification

The controller regression performs pointer-down selection and its first
threshold-crossing body-drag call synchronously, with no Promise/React render
gap. It asserts that only the recorded pointer-down ordinary volume may claim
the body gesture, retains the first delta, and commits one history entry.

Ordinary `DragControls` remain armed at pointer-down rather than waiting for a
selection-driven React prop update. `SceneInteractionController` records the
ordinary pointer-down hit, synchronously selects its instance, and allows only
that hit to claim the thresholded body gesture. It clears the pending candidate
on release, cancellation, or successful ownership transfer. Prime Tower keeps
its pre-existing conditional drag enablement and its scene-only movement path.
The Electron mock-host regression queues trusted `pointerdown` and the first
threshold-crossing `pointermove` without an await between them, checks immediate
body ownership and a changed pivot, then verifies the single Move history entry
after release. The focused controller and Prime Tower tests, complete
`@orca/slicer-app` suite, root typecheck, and focused ordinary-body and gizmo
Electron E2E all pass.
