# Build-Plate Pointer Occlusion

Date: 2026-08-18
Status: Implemented
Scope: Renderer viewport pointer hit testing.

## Change

The build plate now participates in the canvas raycast solely as an occluder.
When the ray reaches the plate before a model-body mesh, the body intersection
is removed before React Three Fiber dispatches pointer events. Consequently an
occluded model body cannot be selected or begin a body drag.

The filter removes the plate itself after it has been considered, preserving
the established empty-bed click path (`onPointerMissed` clears selection).
Only meshes marked as model bodies are filtered; TransformControls gizmo
handles remain in the dispatch set and therefore retain priority and their
always-on-top interaction behavior.

## Verification

- Unit coverage exercises body intersections in front of and behind the plate,
  and verifies that a non-body gizmo intersection behind the plate remains.
- Run the desktop unit suite and TypeScript check.
