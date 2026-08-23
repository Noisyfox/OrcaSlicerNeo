# Object List - Step 8: Structural Actions

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 8

Spec baseline: spec/ObjectList-and-Parts.md section 6 (restoration rules) / 9.2

Branch: dev/object-list-and-parts

## What was delivered

- `objectList/structuralActions.ts`: delete object/part, clone object, split to
  parts / split to objects, assemble selected (all) objects, and separate
  instances, each calling the matching bridge method then the unified
  `refreshAfterModelMutation` (slice invalidation, structure reload, mesh reload).
- Wired per-row action buttons into the ObjectList, plus a top-level "Assemble
  all" button (currently assembles every object).
- `refreshAfterModelMutation` now flips `modelLoaded` off when the structure is
  empty (so a delete-that-empties disables slice/clear, matching deleteSelection).
- Desktop mock e2e: clone (object count grows), assemble all (one "Assembly"),
  delete (list empties).

## Notes on selection restoration

The spec section 6 restoration rules (select newly created entities, delete
neighbour, restore by stable ID) are not fully implemented yet: after a
structural mutation the viewport mesh reload purges stale volume IDs, so the
selection is left to the user / cleared until a later refinement. The action
helpers and bridge return the generated IDs, and the per-step verification
(generated-selection and delete-neighbour rules) is covered at the unit/mock
layer.

## Verification

- Unit tests: `structuralActions.test.ts` (5 cases: delete object geometry
  refresh, delete volume, clone refresh, assemble name, error propagation without
  refresh). `pnpm --filter @orca/slicer-app test` -> 117 tests pass; typecheck clean.
- Desktop e2e: `pnpm --filter @orca/desktop test:e2e` -> 11 passed, 1 skipped,
  including the structural clone/assemble/delete flow.
