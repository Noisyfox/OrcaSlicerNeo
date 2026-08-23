# Object List - Step 4d: Separate Instances into Objects

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 4d

Spec baseline: spec/ObjectList-and-Parts.md section 3.3 / 9.2

Branch: dev/object-list-and-parts

## What was delivered

orc_instances_to_separate_objects(objectId, instanceIds[]) on the bridge, plus the
typed client method separateInstances, mock behavior, unit tests, and real-WASM
harness checks.

## Key decisions

- Each selected instance becomes a new object carrying a copy of the source
  volumes and a single copied instance (add_instance copies the transform), so
  the world position/transform of the separated object is preserved.
- The selected instances are removed from the source object. All selected IDs are
  validated before any mutation, so a bad request leaves the model intact.
- Building each separated object from scratch (rather than clone-then-strip) avoids
  the new_clone re-ID problem, which would otherwise prevent matching the target
  instance.
- Every successful separation calls state().print.clear().

## Verification

- Mock + client contract tests: pnpm --filter @orca/slicer-wasm test, 64 tests
  pass (3 new Step 4d cases: one object per selected instance + source instance
  removal, unknown-instance rejection, empty-list rejection).
- Typecheck: pnpm -r typecheck, clean.
- Quick WASM build: scripts\build-windows.bat quick, both variants stage.
- Real-WASM harness: bridge-smoke.mjs against both variants passes the Step 4d
  checks (single-instance live smoke: one new object with the source instance,
  since the bridge has no op yet to add extra instances). The multi-instance
  transform/one-object-per-instance behavior is pinned by the mock contract tests.

## Notes

- The pre-existing orc_get_presets(...) count=0 harness failures are
  environmental/unrelated (the harness does not stage the profile-resources
  package into MEMFS).
- The multi-instance real-WASM live check needs a multi-instance fixture; it is
  covered at the mock layer until a bridge op exists to create additional
  instances.
