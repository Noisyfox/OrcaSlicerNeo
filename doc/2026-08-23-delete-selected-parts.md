# Delete Key Deletes the Selected Parts

Date: 2026-08-23

Branch: dev/object-list-and-parts

## Bug

Pressing Delete with a part-scoped selection (only some parts of an object
selected) deleted the entire object behind the selection.

## Fix

`deleteSelection` (replacing `deleteSelectedObjects` in the Delete-key path) is
selection-scope-aware:

- **Part-scoped** (some instance has a strict subset of its volumes selected) →
  calls `deleteVolumes` with the deduped selected volume IDs (a volume is shared
  by every instance of the object), so only the selected parts are removed. The
  bridge's last-solid-part guard is surfaced if it fires.
- **Object/instance** → calls `deleteObjects` with the object IDs (unchanged).

Both paths wait for settled transforms, invalidate the slice/export, refresh the
structure + mesh, and flip `modelLoaded` off when the plate empties.
