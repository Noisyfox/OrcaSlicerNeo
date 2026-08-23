# Object List - Step 4b: Split an Object into Objects

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 4b

Spec baseline: spec/ObjectList-and-Parts.md section 3.1 / 9.2

Branch: dev/object-list-and-parts

## What was delivered

orc_split_object_to_objects(objectId, autoDrop) on the bridge, plus the typed
client method splitObjectToObjects, mock behavior, unit tests, and real-WASM
harness checks.

## Key decisions

- The bridge resolves the object by stable ObjectID, guards that the object is
  splittable (more than one volume, or a single volume that is splittable), calls
  ModelObject::split, removes the source object, and returns the freshly generated
  object IDs plus the object count so the renderer can restore selection.
- autoDrop is accepted for signature parity with the spec (auto_drop has no
  first-version UI); when true the bridge runs Model::adjust_min_z().
- ModelObject::split uses FaceDetector, which is core libslic3r and compiles in
  the WASM build (verified by the live build + harness).
- Every successful split calls state().print.clear().

## Verification

- Mock + client contract tests: pnpm --filter @orca/slicer-wasm test, 58 tests
  pass (3 new Step 4b cases: fresh object IDs + source removed, unknown-ID
  rejection, slice invalidation).
- Typecheck: pnpm -r typecheck, clean.
- Quick WASM build: scripts\build-windows.bat quick, both variants stage
  (ModelObject::split + FaceDetector link).
- Real-WASM harness: bridge-smoke.mjs against both variants passes the Step 4b
  checks - multipart splits into 2 objects with fresh IDs, source removed, and the
  split objects slice to valid G-code.

## Notes

- The pre-existing orc_get_presets(...) count=0 harness failures are
  environmental/unrelated (the harness does not stage the profile-resources
  package into MEMFS).
