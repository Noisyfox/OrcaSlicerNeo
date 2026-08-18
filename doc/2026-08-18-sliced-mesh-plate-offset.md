# 2026-08-18 — Sliced preview plate offset

## Bug

After moving a model, the G-code toolpath followed the model but the current
layer's translucent sliced cross-section remained at the plate origin. This
made the cross-section appear as a ghost copy alongside the toolpath.

## Root cause

`bridge_buffers.cpp` emits the sliced layer polygons in the slicer's centered
object coordinates. The slicer already applies the layer's Z height and the
object's non-translation transform while building those polygons, but the
renderer did not apply the instance's XY plate placement when mounting
`SlicedMesh`. Toolpath positions come from post-processed G-code and already
contain that placement, so the two previews diverged after a move.

## Fix

`Scene` now passes the first print object's first instance offset to
`SlicedMesh`. The sliced mesh is translated in XY only. Its Z remains zero at
the scene node because the layer Z is already present in the bridge buffer;
adding the instance Z would double-translate it.

## Verification

- Added a unit regression test for the XY-only placement rule.
- Run the desktop unit tests and typecheck after implementation.
