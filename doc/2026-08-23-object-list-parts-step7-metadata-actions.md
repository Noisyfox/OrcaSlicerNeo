# Object List - Step 7: Metadata / Non-Destructive Actions

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 7

Spec baseline: spec/ObjectList-and-Parts.md section 8

Branch: dev/object-list-and-parts

## What was delivered

- `objectList/actions.ts`: rename object/part, change part type, and toggle
  object/instance printable, each calling the matching bridge method then the
  unified `refreshAfterModelMutation` (invalidate slice/export, re-read the
  structure into the ObjectList store, and re-fetch the viewport mesh when the
  mutation changes geometry — e.g. a part-type change).
- The ObjectList rows now carry rename (inline input), part-type (a select), and
  printable toggles, wired to the action helpers. A `data-testid` expansion toggle
  expands an object to reveal its part rows.
- Desktop mock e2e: load model, rename, expand, check the part-type control,
  toggle printable, and slice successfully.

## Verification

- Unit tests: `actions.test.ts` (4 cases: rename refresh + slice invalidation,
  type-change geometry refresh, printable toggle, error propagation without
  refresh). `pnpm --filter @orca/slicer-app test` -> 112 tests pass; typecheck clean.
- Desktop e2e: `pnpm --filter @orca/desktop test:e2e` -> 10 passed, 1 skipped,
  including the new object-list metadata flow.

## Notes

- The mock cube is a single solid part, so the part-type select is exercised as
  a control (the guard rejects a single-solid-part change); the positive type
  change and guard are covered by the unit tests and live WASM harness.
- The pre-existing `slice-error.e2e.ts` skip is unrelated.
