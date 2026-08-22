# Delete selected objects (Del key)

**Date:** 2026-08-22

**Status:** In implementation

## Goal

Pressing **Del** (and Backspace, for keyboards without a Delete key) deletes
the currently selected content in the 3D viewport. This mirrors OrcaSlicer's
scene behavior: selection is instance-based, and deleting removes the complete
objects that own the selected instances (all of their instances and volumes).

## Flow

1. The viewport's existing window-level `keydown` handler (the same one that
   binds Esc / M / R / S) recognizes `Delete` / `Backspace`.
2. `SceneInteractionController.selectedObjectIndices()` returns the unique,
   sorted `objectIdx` values behind the current selection.
3. The new `deleteSelection` helper waits for any in-flight settled transform
   commit, calls `platform.runtime.deleteObjects(indices)`, then refreshes the
   viewport model:
   - a successful delete invalidates the sliced result (`status = idle`,
     `resultExported = false`, error cleared);
   - if the plate is empty, `modelLoaded` becomes false (Toolbar slice/clear
     disable), otherwise `modelRevision` bumps so the loader re-fetches the
     mesh;
   - selection and the armed gizmo reset with the reloaded collection.

## Bridge contract

New `orc_delete_objects(const char* indices_json)` command (JSON-in/JSON-out,
like every other bridge function):

- input: JSON array of object indices to delete (original indices, before any
  removal);
- the bridge validates bounds (a raw `Model::delete_object(idx)` has no
  bounds check at the pinned SHA) and rejects duplicates/empty input;
- deletion runs in **descending** index order so earlier indices stay valid as
  the `Model.objects` vector shrinks;
- `state().print.clear()` invalidates any previous slice, matching
  `orc_add_model` / `orc_clear_model`;
- output: `{ ok, objects, deleted }` where `objects` is the remaining count.

## Client contract

`SlicerClient.deleteObjects(indices: number[])` is added to the typed client,
the mock module, and the worker pass-through (worker dispatch is by op name,
so no worker change is required). The runtime proxy (`SlicerRuntime extends
SlicerClient`) exposes it unchanged.

## Tests

- client unit: delete removes the right objects, deduplicates, reports
  remaining counts, and errors on invalid indices;
- controller unit: `selectedObjectIndices()` returns unique object indices in
  selection order;
- desktop e2e: extend the gizmo-keyboard test — select, press Delete, expect
  the model to disappear from the scene and the selection to clear.

## Deferred

- Undo/redo is not part of the milestone; a deleted object is gone for the
  session.
- Deleting a single instance of a multi-instance object is intentionally not
  exposed — native OrcaSlicer's Delete removes the whole object.
