# Delete selected objects (Del key)

**Date:** 2026-08-22

**Status:** Implemented

**Updated 2026-08-24:** the delete path became selection-scope-aware
(`doc/2026-08-23-delete-selected-parts.md`) and the bridge moved to stable
`ObjectID`s (commit b6fbd30); the sections below describe the current
behavior.

## Goal

Pressing **Del** (and Backspace, for keyboards without a Delete key) deletes
the currently selected content in the 3D viewport. This mirrors OrcaSlicer's
scene behavior: selection is instance-based, so deleting an instance selection
removes the complete objects that own the selected instances (all of their
instances and volumes). A **part-scoped** selection (some instance has only a
subset of its volumes selected) deletes only those parts instead.

## Flow

1. The viewport's existing window-level `keydown` handler (the same one that
   binds Esc / M / R / S) recognizes `Delete` / `Backspace`.
2. `SceneInteractionController.selectedVolumes()` /
   `selectedObjectIndices()` report the selection;
   `isVolumeScopedSelection()` decides the scope.
3. The `deleteSelection` helper waits for any in-flight settled transform
   commit, then:
   - part-scoped → `runtime.deleteVolumes(volumeIds)` with the deduped
     selected volume IDs (a volume is shared by every instance of the
     object), so only the selected parts are removed — the bridge's
     last-solid-part guard is surfaced if it fires;
   - object/instance → `runtime.deleteObjects(objectIds)` (unchanged).
   Both paths invalidate the sliced result (`status = idle`,
   `resultExported = false`, error cleared), then refresh the model:
   - if the plate is empty, `modelLoaded` becomes false (Toolbar slice/clear
     disable), otherwise `modelRevision` bumps so the loader re-fetches the
     structure and mesh;
   - selection and the armed gizmo reset with the reloaded collection.

## Bridge contract

- `orc_delete_objects(object_ids_json)`: input is a JSON array of **stable
  object IDs** (not indices — a prior mutation may have shifted indices). The
  bridge validates that every ID resolves and rejects duplicates/empty input,
  so a malformed request never partially deletes. Deletion is by ID and
  index-safe; `state().print.clear()` invalidates any previous slice, matching
  `orc_add_model` / `orc_clear_model`; output is `{ ok, objects, deleted }`
  where `objects` is the remaining count.
- `orc_delete_volumes(volume_ids_json)`: same contract for part/volume
  deletes, surfacing the upstream last-solid-part guard as an error.

## Client contract

`SlicerClient.deleteObjects(objectIds: number[])` and
`deleteVolumes(volumeIds: number[])` are added to the typed client, the mock
module, and the worker pass-through (worker dispatch is by op name, so no
worker change is required). The runtime proxy (`SlicerRuntime extends
SlicerClient`) exposes them unchanged.

## Tests

- client unit: delete removes the right objects, deduplicates, reports
  remaining counts, and errors on invalid IDs;
- controller unit: `selectedObjectIndices()` returns unique object indices in
  selection order; `isVolumeScopedSelection()` detects part-scoped selections;
- bridge smoke (`harness/bridge-smoke.mjs`, runs against the real WASM
  artifact): an unknown object ID is rejected without mutation (the scene
  stays intact), and a deduplicated stable-ID list removes the right objects
  (empty mesh when the plate empties);
- desktop e2e: extend the gizmo-keyboard test — select, press Delete, expect
  the model to disappear from the scene and the selection to clear.

## Deferred

- Undo/redo is not part of the milestone; a deleted object is gone for the
  session.
- Deleting a single instance of a multi-instance object is intentionally not
  exposed — native OrcaSlicer's Delete removes the whole object (only a
  part-scoped selection deletes parts, per above).
- The slice result is invalidated by delete like every other model mutation
  (the earlier note that a stale toolpath would persist is outdated).
