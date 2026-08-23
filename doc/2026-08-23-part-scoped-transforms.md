# Part-Scoped (Volume) Transforms

Date: 2026-08-23

Branch: dev/object-list-and-parts

## What changed

When only a part (volume) of an object is selected — via the ObjectList part row
context menu's composite selection — drag, move/rotate/scale gizmo, and the
transform panels now apply to the selected **volume transforms** instead of the
instance transform. Previously a part selection moved/rotated/scaled the whole
instance (all its parts).

- `SceneInteractionController.isVolumeScopedSelection()` detects a part-scoped
  selection (some instance has a strict subset of its volumes selected).
- `captureDragTargets()` captures either instance transforms (instance/object
  scope) or volume transforms (part scope); `applyTargetTransforms()` applies the
  matching kind.
- The drag/gizmo/panel delta application branches on scope. For a volume scope it
  composes the world-space delta with the volume's world matrix (instance·volume)
  and solves the volume transform back out, leaving the instance transform fixed.
- `transformDeltaMath` gained matrix-level `translateMatrix`/`rotateMatrixAroundPivot`
  /`scaleMatrixAroundPivot` helpers used by the volume solve.

The existing pre-slice transform synchronization already persists both the
instance and volume transforms per composite via `syncModelTransforms`, so a
part-scoped edit reaches the bridge unchanged.

## Verification

- Unit tests: 3 new part-scoped cases in `SceneInteractionController.test.ts`
  (volume-scope detection, part-only move, part-only scale). `pnpm --filter
  @orca/slicer-app test` -> 122 tests pass; typecheck clean.
- Desktop mock e2e (12 passed, 1 skipped), desktop real-WASM e2e (13 passed), and
  Web e2e (threaded + serial) all pass.

## Notes

- An e2e that drags a selected part is not added because the mock fixture is a
  single-volume object (a part selection on it is instance-scoped); the
  multi-part behavior is pinned by the unit tests.
