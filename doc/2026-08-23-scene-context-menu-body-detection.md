# Scene Context Menu Body Detection Fix

Date: 2026-08-23

Branch: dev/object-list-and-parts

## Bug

Right-clicking a part of an object (e.g. the second part of a multipart object)
in the 3D viewport opened the empty-scene context menu (Add Cube / Add Model /
Clear Scene) instead of doing nothing and treating the click as being on a model
body.

## Cause

`SceneContextMenu.topmostHitIsModelBody` only inspected `hits[0]`. Transient
overlays — notably the always-on-top toolpath lines (`lineBasicMaterial
depthTest:false`) and gizmo handles — could be the topmost raycast intersection
in front of a part, so the ray was misclassified as "empty space". Also,
`Mesh.raycast` respects the material's `side` (FrontSide), so a part whose visible
surface is a back face (e.g. after `ModelVolume::split` may flip winding) was not
detected as a body at all.

## Fix

- `topmostHitIsModelBody` now walks the intersections in distance order, skips
  objects without a raycast role (toolpath, gizmo, selection box), and decides on
  the first model-body or build-plate hit. A model body under an overlay is still
  "on a body"; the bed plate is "empty space".
- The model body meshes are rendered/raycast with `side: THREE.DoubleSide`, so a
  part is selectable and detectable regardless of its winding.

## Follow-up (2026-08-24)

Since this fix landed, a right-click on a model body no longer "does nothing":
it opens the object context menu and selects the clicked instance
(`doc/2026-08-23-object-list-parts-context-menu.md`). The detection logic
described above — walking intersections past overlay hits and rendering
bodies double-sided — is what still routes a body hit away from the
empty-scene menu.
