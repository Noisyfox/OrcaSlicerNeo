# Object List - Step 5: Viewport Selection Modes

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 5

Spec baseline: spec/ObjectList-and-Parts.md section 6

Branch: dev/object-list-and-parts

## What was delivered

Extended the renderer `Selection` and `SceneInteractionController` to support
object, volume, and instance expansion modes (the native GLCanvas3D selection
modes), plus composite selection for the upcoming ObjectList.

- `Selection.replaceFromHit` / `toggleFromHit` take a `SelectionMode`
  ('object' | 'volume' | 'instance'), defaulting to the existing instance mode.
- `Selection.replaceComposite` / `toggleComposite` select a target by width:
  object only, object+volume, or object+instance. `SelectableVolume.buffer` now
  exposes `volumeIdx`.
- `SceneInteractionController` gains `selectionMode` (get/set) and
  `selectComposite(objectIdx, volumeIdx?, instanceIdx?, additive?)`. The
  pre-slice transform synchronization invariant is unchanged.

## Verification

- Unit tests: `Selection.test.ts` (5 new: object/volume expansion, composite
  replace/toggle) and `SceneInteractionController.test.ts` (3 new: mode-based hit
  expansion, composite select, set-mode no-op). `pnpm --filter @orca/slicer-app
  test` -> 104 tests pass; typecheck clean.
- Desktop e2e: `pnpm --filter @orca/desktop test:e2e` -> 9 passed, 1 skipped
  (the pre-existing `slice-error.e2e.ts` skip).
