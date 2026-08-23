# Object List - Step 4a: Split a Volume into Parts

Date: 2026-08-23

Plan step: doc/2026-08-23-object-list-parts-implementation-plan.md, Step 4a

Spec baseline: spec/ObjectList-and-Parts.md section 3.2 / 9.2

Branch: dev/object-list-and-parts

## What was delivered

orc_split_volume_to_parts(volumeId, maxExtruders, remapPaint) on the bridge, plus
the typed client method splitVolumeToParts, mock behavior, unit tests, a live
multi-shell fixture, and real-WASM harness checks.

## Key decisions

- The bridge resolves the volume by stable ObjectID, validates it is splittable
  (ModelVolume::is_splittable), then calls upstream ModelVolume::split.
- ModelVolume::split re-IDs the original volume and inserts new volume(s) for the
  disconnected shells, so the caller's volumeId becomes stale. The bridge computes
  the freshly generated volume IDs (before/after diff) and returns them with the
  current structure, so the renderer can clear stale selection and re-read.
- remapPaint is passed through to libslic3r. Painting is deferred by the spec, so
  UI callers pass false; the core path is available regardless.
- The split is a pure connected-components operation (its_split), so it compiles
  and runs in the WASM build without CGAL/OCCT (unlike the deferred mesh-boolean
  operations).
- Every successful split calls state().print.clear().

## Fixture

Added packages/slicer-wasm/fixtures/make-multipart.mjs, which emits multipart.stl
- one volume containing two disjoint 20 mm cubes. This yields a single ModelVolume
  with isSplittable = true for the real-WASM live check. multipart.stl is the
  generated artifact committed alongside it.

## Verification

- Mock + client contract tests: pnpm --filter @orca/slicer-wasm test, 55 tests pass
  (4 new Step 4a cases: generated IDs + stale original ID, non-splittable
  rejection, unknown-ID rejection, slice invalidation).
- Typecheck: pnpm -r typecheck, clean.
- Quick WASM build: scripts\build-windows.bat quick, both out/threaded and
  out/serial stage (the ModelVolume::split + save_painting/restore_painting
  machinery links).
- Real-WASM harness: bridge-smoke.mjs against both variants passes the Step 4a
  checks - multipart fixture loads, volume is splittable, split yields 2 parts
  with fresh IDs and the old ID is stale, and the split parts slice to valid
  G-code (lineCount > 0).

## Notes

- The pre-existing orc_get_presets(...) count=0 harness failures are
  environmental/unrelated (the harness does not stage the profile-resources
  package into MEMFS).
