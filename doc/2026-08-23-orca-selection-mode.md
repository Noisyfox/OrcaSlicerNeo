# Follow OrcaSlicer's Selection Mode

Date: 2026-08-23

Branch: dev/object-list-and-parts

## Requirement

spec/ObjectList-and-Parts.md section 6.1 records OrcaSlicer's selection-mode
exclusions; this implements them.

## Changes

- **Part (volume) selection is anchored to a single instance.** `Selection`
  now selects the part in `Volume` mode / for a part target within **one**
  instance (the clicked instance for a viewport hit; the selection's single
  instance — or 0 — for an ObjectList part row). A part is never selected
  across all instances of the object, matching Orca's
  `get_volume_idxs_from_volume(obj, instance_idx_or_0, vol)`.
- `SceneInteractionController.getSelectionInstanceAnchor(objectIdx)` returns the
  single focused instance of an object (or 0), used by the ObjectList part rows.
- **Type-homogeneous multi-select.** The ObjectList Shift-range refuses a range
  whose rows are not all the same kind, or whose part rows span more than one
  object (which would be Orca's `Mixed`, invalid for edits). Ctrl+click still
  toggles a single row; the mode is derived from content (full object/instance =
  Instance; parts = Volume).
- `buildSelectableRows` rows now carry a `kind` and part rows default to
  instance 0; the ObjectList re-anchors them to the focused instance.

## Verification

- `@orca/slicer-app` test: 130 pass (updated part/volume assertions to
  single-instance anchoring; added row-kind assertions); typecheck clean.
- Desktop mock e2e: 15 passed, 1 skipped (Ctrl/Shift multi-select, part flows).
