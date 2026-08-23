# Reorder keeps the scene and ObjectList in the same index space

Date: 2026-08-23

Branch: dev/object-list-and-parts

## Symptom

Dragging to reorder an object (or a part) in the ObjectList left the
selection-to-list highlight on the wrong row, and subsequently clicking a list
row / scene body could select the wrong entity.

## Cause

`reorderObjects` / `reorderVolumes` reorder `Model::objects` / `ModelObject`
volumes, so every object/volume **positional index** shifts. The reorder path
ran `refreshAfterModelMutation` with `geometryChanged = false`, which reloads
only the ObjectList `structure` (the new `index` values) and NOT the viewport
mesh. The mesh GLVolumes kept their old `objectIdx`/`volumeIdx`, so the scene
selection (index-keyed), the selectable rows, and the structure no longer shared
an index space. `projectSelection` maps by index, hence the wrong highlight.

## Fix

`reorderObjectsInList` and `reorderVolumesInList` now run
`refreshAfterModelMutation(runtime, true)`, which bumps `modelRevision` and
reloads the viewport mesh. Both the structure and the mesh are rebuilt from the
same `Model::objects` order, so object/volume indices agree again and the
selection-to-list projection is correct.

## Tradeoff

As with any other mesh reload, the scene resets ephemeral selection/state
(`SceneInteractionController.resetForModel` purges stale volume IDs — the
existing, documented behavior for a replaced collection). Preserving the
selection across an index-shifting mutation by re-selecting the same stable
ObjectIDs is the later spec §6/§7 refinement and is not implemented here.
