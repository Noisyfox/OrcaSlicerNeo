# Object List — Step 2: Non-Destructive Metadata Operations

**Date:** 2026-08-23

**Plan step:** `doc/2026-08-23-object-list-parts-implementation-plan.md` → Step 2

**Spec baseline:** `spec/ObjectList-and-Parts.md` §4–§9

**Branch:** `dev/object-list-and-parts`

## What was delivered

Five bridge operations that mutate model metadata by **stable ObjectID** (not
positional index), plus their typed-client methods, mock-module behavior, unit
tests, and real-WASM harness checks:

| Bridge export | Client method | Effect |
|---|---|---|
| `orc_rename_object(objectId, name)` | `renameObject` | Rename a `ModelObject` |
| `orc_rename_volume(volumeId, name)` | `renameVolume` | Rename a `ModelVolume` |
| `orc_set_volume_type(volumeId, type)` | `setVolumeType` | Change a part's type |
| `orc_set_object_printable(objectId, printable)` | `setObjectPrintable` | Object gate + every instance |
| `orc_set_instance_printable(instanceId, printable)` | `setInstancePrintable` | Toggle one instance |

## Key decisions

### Stable-ID resolution

`state().model.objects` is a `ModelObjectPtrs` (vector of raw pointers). The new
helpers `find_object_by_id` / `find_volume_by_id` / `find_instance_by_id` scan the
live model linearly and match on `id().id`. ObjectID values are globally unique
across objects/volumes/instances (`ObjectBase::generate_new_id`), so cross-model
search is safe. IDs cross the boundary as JS `Number`; the bridge validates the
value is a finite positive integral double before narrowing to `size_t`.

### Print invalidation

Every successful mutation calls `state().print.clear()`, matching the existing
`orc_delete_objects` discipline. This prevents the renderer from displaying a
stale slice/export after a metadata change. Renames don't change geometry but
still invalidate, because the model's reported structure changed.

### Last-solid-part guard

`orc_set_volume_type` refuses to turn a `ModelVolume` that is the only
`MODEL_PART` of its object into a non-print part, using upstream
`ModelVolume::is_the_only_one_part()`. Error message matches the native guard:
`changing the last solid part is not allowed`.

### Object printable semantics

The object row toggle is an aggregate. `orc_set_object_printable` sets both the
object-level gate (`ModelObject::printable`) and every instance's `printable`, so
the per-instance rows and `ModelInstance::is_printable()` (`object->printable &&
printable && …`) stay consistent. A single instance toggle touches only that
instance.

### Error shape

The bridge returns failures as `{ "error": "..." }` (no `ok:false`), the existing
`error_json()` convention. `spec/ObjectList-and-Parts.md` §9.2 literally specifies
`{ "ok": false, "error": "..." }`; that exact shape is a pre-existing global
discrepancy and was deliberately **not** changed here to keep this step scoped to
the metadata operations. Consumers detect errors with `if (!r.ok)` (undefined is
falsy), which works with both shapes. Aligning the global error helper is a
candidate follow-up.

## Verification

- Mock-module + client contract tests: `pnpm --filter @orca/slicer-wasm test` — 43
  tests pass (9 new Step 2 cases, including error paths and slice invalidation).
- Typecheck: `pnpm --filter @orca/slicer-wasm typecheck` and workspace
  `pnpm -r typecheck` — clean.
- Quick WASM build: `scripts\build-windows.bat quick` builds and stages both
  `out/threaded` and `out/serial` artifacts.
- Real-WASM harness: `bridge-smoke.mjs` against both artifacts passes the Step 2
  checks (rename object/part, last-solid-part guard, object/instance printable
  toggle, unknown-ID/type errors). The single-volume cube fixture exercises the
  guard; a successful positive type change with a multi-part object is covered at
  the mock layer because no multi-volumement fixture exists yet.

## Out of scope

Steps 3–10 of the plan (delete/clone/reorder by ID, split/assemble, list UI,
selection modes, drag reorder, release e2e) remain for later steps.
