# Object List - Step 9: Drag Reorder

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 9

Spec baseline: spec/ObjectList-and-Parts.md section 9.2 (reorder ops)

Branch: dev/object-list-and-parts

## What was delivered

- Native HTML5 drag-and-drop on ObjectList object and part rows. Dragging an
  object onto another calls `reorderObjectsInList(fromObjectId, toIndex)` with
  the target row's index; dragging a part onto another within the same object
  calls `reorderVolumesInList(objectId, fromVolumeId, toIndex)`. Dropping onto
  the list's empty space (below the last row) passes `toIndex = count`, appending
  the dragged object/part at the end. The dragged stable ID travels in
  `dataTransfer` (avoiding a React-state race), and after the drop the structure
  and viewport mesh are re-read via the unified post-mutation refresh.
- Action helpers `reorderObjectsInList` / `reorderVolumesInList` in
  structuralActions.ts (each calls the bridge and refreshes).
- Desktop mock e2e: add two objects, drag the second onto the first, and assert
  the object order changed. Existing delete/selection tests remain green.

## Verification

- Unit tests: `structuralActions.test.ts` covers object/volume reorder calling
  the bridge with the source ID and destination index; the `@orca/slicer-wasm`
  client tests cover the index + append cases. `@orca/slicer-app` -> 137 tests
  pass; typecheck clean.
- Desktop e2e: `pnpm --filter @orca/desktop test:e2e` -> 16 passed, 1 skipped,
  including the drag-reorder flow.
