# Alt+Click Selects an Individual Part

Date: 2026-08-23

Branch: dev/object-list-and-parts

## Behavior

Holding **Alt** and clicking a model body in the viewport selects the individual
part (volume) under the cursor rather than the whole instance — OrcaSlicer's
part-selection modifier. It combines with Ctrl/Cmd (Alt+Ctrl toggles the part).

## Implementation

- `SceneInteractionController.selectFromHit` / `selectFromClick` /
  `prepareBodyDragFromPointerDown` accept a `part` flag. When set, the click uses
  the `volume` selection mode (selecting that volume across all its instances),
  and the "already-selected member keeps the complete selection" guard is skipped
  so Alt explicitly narrows to the part.
- `GLVolumeMesh` forwards `event.nativeEvent.altKey` from the pointer-down and
  click handlers.
- After an Alt+click selects a part, `isVolumeScopedSelection()` is true, so a
  subsequent drag/Gizmo edit moves only that part (part-scoped transforms).

## Verification

- Unit test: Alt+click (part) selects the volume composite across its instances
  and marks the selection part-scoped.
- `pnpm --filter @orca/slicer-app test` -> 124 tests pass; typecheck clean.
- Desktop mock e2e: 13 passed, 1 skipped.
