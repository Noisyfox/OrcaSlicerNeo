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

## Destination-index reorder (append to end)

`reorderObjects` / `reorderVolumes` now take a **destination index** instead of a
target object/volume ID: `to_index` is the 0-based position in the final list,
and `to_index == count` (or anything ≥ count) appends the item at the end. This
makes "drag an object/part past the last one" possible: the ObjectList's empty
space is a drop target that calls reorder with `count` as the destination.

Row drops pass the dropped-on row's current index as the destination
(`obj.index` / `vol.index`), so a drop on a slot places the dragged item at that
slot. The bridge, the `@slicer/testing` mock, and the client all use the same
`[0, count]` destination-index semantics.

## Part drag reorder

Part rows are draggable, but the HTML5 `dragstart`/`drop` events bubbled up to
the parent object row, whose `onDragStart` overwrote the dragged payload with
`{kind:'object', …}`, so the part's `onDrop` guard (`kind === 'part'`) never
matched and dropping a part onto another part was a no-op. The part row's
`onDragStart`/`onDragOver`/`onDrop` now call `stopPropagation()` so the part drag
is isolated from the object drag (the object row's `onDrop` also stops
propagation so the list's append drop target does not double-handle). Part
reorder is covered by the unit + live harness (the mock only has a single-part
cube), so there is no mock e2e for it.

## Tradeoff

As with any other mesh reload, the scene resets ephemeral selection/state
(`SceneInteractionController.resetForModel` purges stale volume IDs — the
existing, documented behavior for a replaced collection). Preserving the
selection across an index-shifting mutation by re-selecting the same stable
ObjectIDs is the later spec §6/§7 refinement and is not implemented here.
