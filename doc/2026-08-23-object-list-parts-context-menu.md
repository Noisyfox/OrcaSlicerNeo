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
  the previous behavior.
- "Set as an individual object" (OrcaSlicer's label for separating instances)
  appears only on an instance row of a multi-instance object and promotes that
  single instance into its own top-level object.
- "Assemble all" is available from the object row menu (and the list-level menu
  on right-clicking empty list space).
- The e2e tests were updated to drive the actions through the context menu.

## Verification

- slicer-app unit tests (119) + typecheck pass.
- Desktop mock e2e: 12 passed, 1 skipped.
- Desktop real-WASM e2e: 13 passed.
- Web e2e (threaded + serial): both pass.
