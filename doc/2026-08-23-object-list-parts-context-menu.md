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
- A row right-click also selects its target exactly like a left-click would
  (the menu then shows the freshly selected state): an unselected object row
  selects the whole object, an instance row its instance, a part row its
  anchored part, and the Instances group line its object's instances. When the
  row's volumes are already fully selected the selection is left untouched —
  the same guard as the scene's right-click, so a right-click never collapses
  a multi-selection (updated 2026-08-24).
- Rename opens an inline text input (the context menu "Rename" item), matching
  the previous behavior. Renaming a single-volume object also renames its only
  part to the same name (Orca behavior); multi-volume objects keep their part
  names. While the rename editor is active its row is not draggable — for a
  part editor that also freezes the enclosing object row, since a
  non-draggable part's native drag source is its draggable ancestor
  (updated 2026-08-24).
- The Rename item is hidden while multiple full objects are selected (the
  rename target would be ambiguous; Orca hides it there too) — both on the
  object-row and part-row menus (updated 2026-08-24).
- Toggling printable/unprintable applies to the whole selection when the
  clicked row is part of it (object rows flip every selected object, instance
  rows every selected instance); otherwise it targets the clicked row alone.
  The label always follows the clicked row (updated 2026-08-24).
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
- Hovering a selected row keeps it visibly blue: the row's selected style
  (`bg-accent`) previously fell back to the ghost button's `hover:bg-muted`
  while hovered, muting it to gray; selected rows now tint to `bg-accent/85`
  on hover (updated 2026-08-24).

## Scene object context menu (updated 2026-08-24)

Right-clicking a model body in the 3D viewport opens the same object-row
context menu as the object list (`ObjectListContextMenu` with an `object`
target), resolved from the raycast hit's GLVolume `buffer.objectIdx` via the
store structure. Right-clicking anywhere else (bed plate, empty space) keeps
the existing empty-scene menu. A right-click on a body also selects the
clicked instance only — the same granularity as a plain left-click (selection
mode "instance"), so on a multi-instance object just that instance is
selected (updated 2026-08-24: the earlier object-level selection was narrowed
to instance-level to mirror left-click; for a single-instance object the two
are identical). Unless the clicked volume is already selected, in which case
the selection is left untouched (mirroring a plain left-click on an existing
selection member, so a right-click never collapses a multi-selection). The
selection-driven "Assemble" item therefore appears only when the selection
holds ≥ 2 full objects — the same rule as the list.

- `pickTopmostModelVolume` moved from `Viewport.tsx` into
  `buildPlatePointerOcclusion.ts` so both the viewport click path and the
  context-menu press can share it (Viewport imports SceneContextMenu, so the
  menu cannot import from Viewport).
- The scene menu passes `showRename={false}`: the viewport has no inline
  editor, so Rename is dropped from the scene menu entirely (an earlier modal
  `ObjectRenameDialog` was removed again for the same reason; the object list
  keeps its inline rename). The scene menu passes only `object` targets; the
  part/instance scene menus are follow-up work.
- e2e: right-click on a body asserts the object menu (that the empty menu
  does not appear, and that Rename is absent).
