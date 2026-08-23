# Object List - Step 9: Drag Reorder

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 9

Spec baseline: spec/ObjectList-and-Parts.md section 9.2 (reorder ops)

Branch: dev/object-list-and-parts

## What was delivered

- Native HTML5 drag-and-drop on ObjectList object and part rows. Dragging an
  object onto another calls `reorderObjectsInList(fromObjectId, toObjectId)`;
  dragging a part onto another within the same object calls
  `reorderVolumesInList(objectId, fromVolumeId, toVolumeId)`. The dragged stable
  ID travels in `dataTransfer` (avoiding a React-state race), and after the drop
  the structure is re-read via the unified post-mutation refresh.
- Action helpers `reorderObjectsInList` / `reorderVolumesInList` in
  structuralActions.ts (each calls the bridge and refreshes).
- Desktop mock e2e: add two objects, drag the second onto the first, and assert
  the object order changed. Existing delete/selection tests remain green.

## Verification

- Unit tests: 2 new reorder cases in `structuralActions.test.ts` (object and
  volume reorder call the bridge with stable IDs). `pnpm --filter @orca/slicer-app
  test` -> 119 tests pass; typecheck clean.
- Desktop e2e: `pnpm --filter @orca/desktop test:e2e` -> 12 passed, 1 skipped,
  including the drag-reorder flow.
