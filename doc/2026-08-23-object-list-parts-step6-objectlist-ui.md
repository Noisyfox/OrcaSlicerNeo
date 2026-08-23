# Object List - Step 6: ObjectList Store + Component + Selection Sync

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 6

Spec baseline: spec/ObjectList-and-Parts.md sections 4, 5, 6

Branch: dev/object-list-and-parts

## What was delivered

- `useObjectListStore` (structure, loaded flag, expansion map, selection
  projection).
- `projectSelection` pure helper that maps the viewport's selected GL volumes
  (index composites) onto the current structure's stable IDs.
- `ObjectList` tree component rendered above the SettingsPanel: objects, parts,
  and an Instances group for multi-instance objects (spec #4). Rows call
  `SceneInteractionController.selectComposite` on click; the controller remains
  the source of truth and the list reads its selection to highlight (two-way sync,
  spec #6).
- Re-exported the structure/result types from `@slicer/client`.
- Hardened the mock e2e hook (`selectMockInstance`) to null-guard `sceneInteraction`
  and made the desktop e2e selection a polling call (a pre-existing load race was
  exposed by the new concurrent structure fetch on model load).

## Verification

- Unit tests: `projection.test.ts` (4 cases: instance projection, multi-volume
  projection, out-of-range guard, stable reload). `pnpm --filter @orca/slicer-app
  test` -> 108 tests pass; typecheck clean.
- Desktop e2e: `pnpm --filter @orca/desktop test:e2e` -> 9 passed, 1 skipped,
  stable across repeated runs (the mock selection race is fixed).
