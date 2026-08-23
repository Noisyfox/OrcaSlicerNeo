# Object List — Step 3: Delete, Clone, and Reorder by Stable ObjectID

**Date:** 2026-08-23

**Plan step:** `doc/2026-08-23-object-list-parts-implementation-plan.md` → Step 3

**Spec baseline:** `spec/ObjectList-and-Parts.md` §7–§9

**Branch:** `dev/object-list-and-parts`

## What was delivered

Five bridge operations that mutate object/volume structure by **stable ObjectID**,
matched by typed client methods, mock-module behavior, unit tests, and real-WASM
harness checks:

| Bridge export | Client method | Effect |
|---|---|---|
| `orc_delete_objects(objectIds[])` | `deleteObjects` | Delete whole objects by ID |
| `orc_delete_volumes(volumeIds[])` | `deleteVolumes` | Delete parts by ID (with guard) |
| `orc_clone_objects(objectIds[])` | `cloneObjects` | Clone objects; returns new IDs |
| `orc_reorder_objects(fromObjectId, toObjectId)` | `reorderObjects` | Move an object before another |
| `orc_reorder_volumes(objectId, fromVolumeId, toVolumeId)` | `reorderVolumes` | Move a part before another |

## Key decisions

### `orc_delete_objects` migrated from index-based to stable-ID

The previous `orc_delete_objects(indices_json)` (index based) was replaced by the
spec's ID contract. All IDs are resolved and validated **before** any mutation, so
a bad request leaves the scene intact; duplicates are ignored; the deletion uses
`Model::delete_object(ObjectID)`. The format/count response is unchanged
(`{ok, objects, deleted}`).

### Last-solid-part guard for volume deletion

`orc_delete_volumes` refuses to delete a `ModelVolume` that is the only `MODEL_PART`
of its object, reusing `ModelVolume::is_the_only_one_part()` and the upstream
message. Deletion uses `ModelObject::delete_volume(idx)`, which collapses the
remaining volume's transform into the instance transforms when one volume is left.

### Clone semantics

`orc_clone_objects` uses `Model::add_object(const ModelObject&)`, which performs
`ModelObject::new_clone` and assigns **fresh recursive IDs** to the clone. The new
object/volume/instance IDs are returned so the renderer can restore selection to
the clones.

### Reorder semantics

`(from, to)` moves `from` to sit **immediately before `to`**, preserving the
relative order of every other entity. Reorders return the current structure
(`{ok, objects}`) so the renderer can refresh in one round trip. The reorder rule
is deliberately documented because the spec leaves the drop direction implicit;
the Step 9 drag UI can choose the direction by passing the appropriate `from`/`to`.

### Print invalidation

All five operations call `state().print.clear()`, so a completed slice/export is
never shown after a structural change.

### App adapter for `deleteObjects`

Because the bridge's delete is now ID-based, `deleteSelection.ts` maps the
viewport's object **indices** to the current structure's object **IDs** via
`getModelStructure()` before calling `deleteObjects`. A stale index that no longer
maps to a live object fails closed (reports an error) instead of deleting the wrong
entity.

## Verification

- Mock + client contract tests: `pnpm --filter @orca/slicer-wasm test` — 51 tests
  pass (8 new Step 3 cases: delete-by-ID + dedup, volume guard, clone fresh IDs,
  reorder objects/volumes, unknown-ID errors, slice invalidation).
- Typecheck: `pnpm -r typecheck` — clean.
- Quick WASM build: `scripts\build-windows.bat quick` — both `out/threaded` and
  `out/serial` stage.
- Real-WASM harness: `bridge-smoke.mjs` against both variants passes the Step 3
  checks (delete by ID, clone fresh IDs, reorder object, volume guard, volume
  no-op); the single-volume cube fixture exercises the guard, while the positive
  multi-part volume delete/reorder paths are covered by the mock contract tests
  (no multi-part fixture exists yet).

## Notes

- The pre-existing `orc_get_presets(...)` `count=0` harness failures are
  environmental/unrelated (the harness does not stage the profile-resources
  package into MEMFS).
- The `{ error }` (no `ok:false`) error shape is retained for consistency with the
  existing `error_json()` convention (see the Step 2 note).
