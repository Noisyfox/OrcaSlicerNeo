# Object List - Step 4c: Assemble Objects into a Multipart Object

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 4c

Spec baseline: spec/ObjectList-and-Parts.md section 3.1 (Assemble) / 9.2

Branch: dev/object-list-and-parts

## What was delivered

orc_merge_objects_to_multipart(objectIds[], name) on the bridge, plus the typed
client method mergeObjectsToMultipart, mock behavior, unit tests, and real-WASM
harness checks.

## Key decisions

- The bridge resolves each source object by stable ObjectID, creates one new
  object with the provided name, copies each source volume into it, and composes
  the source's first-instance transform into each volume transform (upstream
  ObjectList::merge "Assemble" behavior). The assembled object carries a single
  instance.
- The source objects are removed from the live model after assembly.
- Every successful assemble calls state().print.clear().
- Returns the new object's stable ID so the renderer can select it (spec #8).

## Verification

- Mock + client contract tests: pnpm --filter @orca/slicer-wasm test, 61 tests
  pass (3 new Step 4c cases: assembly + source removal + volume count, unknown-ID
  rejection, slice invalidation).
- Typecheck: pnpm -r typecheck, clean.
- Quick WASM build: scripts\build-windows.bat quick, both variants stage.
- Real-WASM harness: bridge-smoke.mjs against both variants passes the Step 4c
  checks - two cubes assemble into one "Assembly" object with two volumes, the
  source objects are gone, and the assembled multipart slices to valid G-code.

## Notes

- The pre-existing orc_get_presets(...) count=0 harness failures are
  environmental/unrelated (the harness does not stage the profile-resources
  package into MEMFS).
