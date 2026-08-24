# Object List - Actions Moved to a Context Menu

Date: 2026-08-23

Branch: dev/object-list-and-parts

## What changed

The ObjectList row action buttons (rename, type, printable, delete, clone, split
to objects, split to parts, set as individual object, assemble all) were removed
from the row chrome and moved into a per-row right-click context menu, mirroring
the scene context menu.

- `ObjectListContextMenu` opens on `contextmenu` on an object/part/instance row
  (the row's menu is scoped to its target; the menu closes on outside press,
  Escape, or item selection). Nested row `onContextMenu` handlers call
  `stopPropagation` so a part/instance row right-click does not bubble to the
  enclosing object row.
- Rename opens an inline text input (the context menu "Rename" item), matching
  the previous behavior. Renaming a single-volume object also renames its only
  part to the same name (Orca behavior); multi-volume objects keep their part
  names. While the rename editor is active its row is not draggable — for a
  part editor that also freezes the enclosing object row, since a
  non-draggable part's native drag source is its draggable ancestor
  (updated 2026-08-24).
- "Set as an individual object" (OrcaSlicer's label for separating instances)
  appears only on an instance row of a multi-instance object and promotes that
  single instance into its own top-level object.
- "Split to parts" appears only for a volume whose mesh has disconnected shells
  (`isSplittable`), and "Split to objects" only for a splittable object (multiple
  volumes or a splittable volume) — matching Orca.
- "Assemble" (updated 2026-08-24) replaces the old "Assemble all": it appears
  on the object row menu (and the list-level menu on right-clicking empty list
  space) only when at least two full objects are selected, and it merges only
  the selected objects. With no multi-selection the menu has no assemble item,
  and an empty list-level menu is not shown at all.
- The e2e tests were updated to drive the actions through the context menu.
