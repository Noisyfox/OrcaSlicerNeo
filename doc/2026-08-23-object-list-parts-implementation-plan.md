# Object List and Object Parts — Implementation Plan

**Date:** 2026-08-23

**Status:** Draft — proposed for review

**Design baseline:** `spec/ObjectList-and-Parts.md`

## Principles

- Every step below is an independently verifiable unit.
- Each step gets its own commit; no unrelated changes are bundled.
- C++/WASM work is verified against both `threaded` and `serial` artifacts.
- UI work is tested against the mock module first, then real WASM in e2e.
- The existing dirty `packages/slicer-wasm/cpp` submodule change is not included
  in any step commit.

## Step 1: Read-only model structure through the bridge

Deliverable:

- `orc_get_model_structure()` in `bridge.cpp`.
- `getModelStructure()` on the typed client.
- Matching mock-module behavior.
- TypeScript result types for object/volume/instance IDs, names, types, and
  printable state.

Scope:

- Returns objects, their direct parts, and instance nodes.
- No mutation APIs yet.

Verification:

- `pnpm --filter @orca/slicer-wasm test`
- `pnpm --filter @orca/slicer-wasm typecheck`
- `scripts/build-windows.bat quick` or `scripts/build.sh quick`
- Run both `out/threaded` and `out/serial` bridge smoke checks.

## Step 2: Non-destructive metadata operations

Deliverable:

- `orc_rename_object`
- `orc_rename_volume`
- `orc_set_volume_type`
- `orc_set_object_printable`
- `orc_set_instance_printable`

Scope:

- Stable `ObjectID` input.
- Bridge resolves IDs against the current `Model`.
- Print/slice result is invalidated on every successful mutation.

Verification:

- Mock-module unit tests cover each operation and error cases.
- Bridge harness verifies rename, type change, and printable state against a
  loaded STL/3MF fixture.
- `pnpm --filter @orca/slicer-wasm test`
- Quick WASM build for both variants.

## Step 3: Delete, clone, and reorder

Deliverable:

- `orc_delete_objects`
- `orc_delete_volumes`
- `orc_clone_objects`
- `orc_reorder_objects`
- `orc_reorder_volumes`

Scope:

- Multi-delete uses a JSON array of IDs.
- Reorder accepts stable IDs and returns current structure or an error.
- Delete enforces the last-solid-part guard for volumes.
- Clone creates new stable IDs and returns them.

Verification:

- Mock-module unit tests for index shifting, deduplication, and guard errors.
- Bridge harness verifies object/part count changes and slice invalidation.
- `pnpm --filter @orca/slicer-wasm test`
- Quick WASM build for both variants.

## Step 4a: Split volume to parts

Deliverable:

- `orc_split_volume_to_parts(volumeId, maxExtruders, remapPaint)`.

Verification:

- Mock-module test for generated volume IDs and stale-ID clearing.
- Real-WASM harness on a multi-shell fixture.
- Slice smoke confirms the split parts still produce valid G-code.

## Step 4b: Split object to objects

Deliverable:

- `orc_split_object_to_objects(objectId, autoDrop)`.

Verification:

- Mock-module test for new object IDs and selection restoration behavior.
- Real-WASM harness on an object with multiple connected shells.
- Quick build for both variants.

## Step 4c: Assemble objects to multipart

Deliverable:

- `orc_merge_objects_to_multipart(objectIds[], name)`.

Verification:

- Mock-module test for generated multipart object structure.
- Real-WASM harness verifies each source object becomes a volume and transforms
  are preserved.
- Slice smoke on the assembled fixture.

## Step 4d: Separate instances into objects

Deliverable:

- `orc_instances_to_separate_objects(objectId, instanceIds[])`.

Verification:

- Mock-module test for instance-to-object conversion.
- Real-WASM harness verifies one object per selected instance and correct
  transforms.
- Quick build for both variants.

## Step 5: Viewport selection modes

Deliverable:

- Extend renderer `Selection` with object, volume, and instance expansion.
- Add controller methods to select by stable object/volume/instance ID.
- Keep the existing pre-slice transform synchronization invariant.

Verification:

- `packages/slicer-app/src/components/viewport/Selection.test.ts` and
  `SceneInteractionController.test.ts`.
- Existing viewport unit tests remain green.
- `pnpm --filter @orca/slicer-app test`
- `pnpm --filter @orca/slicer-app typecheck`

## Step 6: Read-only ObjectList and selection sync

Deliverable:

- `useObjectListStore` for structure, expansion, and current projection.
- `ObjectList` tree component above `SettingsPanel`.
- Two-way selection sync with `SceneInteractionController`.
- Parts render directly under objects; the `Instances` group appears only for
  multi-instance objects.

Verification:

- Unit tests for structure normalization and selection projection.
- Component tests for object/part/instance selection sync.
- `pnpm --filter @orca/slicer-app test`
- `pnpm --filter @orca/slicer-app typecheck`

## Step 7: ObjectList metadata and non-destructive actions

Deliverable:

- Rename object/part in the tree.
- Change part type.
- Toggle printable on object and instance rows.
- Wire these actions through the new bridge methods.
- Apply the unified post-mutation refresh and selection-restoration flow.

Verification:

- Unit tests for action helpers and slice invalidation.
- Electron mock e2e: load model, rename, change type, toggle printable, slice.
- `pnpm --filter @orca/slicer-app test`
- `pnpm --filter @orca/desktop test:e2e`

## Step 8: ObjectList structural actions

Deliverable:

- Delete object and part.
- Clone object.
- Split to parts and split to objects.
- Assemble selected objects.
- Separate instances.
- Wire selection restoration rules from the spec.

Verification:

- Unit tests for generated-selection and delete-neighbor rules.
- Electron mock e2e for each structural action.
- `pnpm --filter @orca/slicer-app test`
- `pnpm --filter @orca/desktop test:e2e`

## Step 9: ObjectList drag reorder

Deliverable:

- Drag reorder of objects and parts.
- Reorder bridge calls with stable IDs.
- Re-read structure after drop and restore selection.

Verification:

- Unit tests for reorder target resolution.
- Electron mock e2e for object and part reordering.
- Existing delete/selection tests remain green.

## Step 10: Real-artifact e2e and documentation closure

Deliverable:

- Web e2e for the object-list flow with threaded and serial artifacts.
- Desktop e2e against real WASM where the environment supports it.
- Update `spec/ObjectList-and-Parts.md` status.
- Mark Milestone 13 delivered or record exact skipped tests.

Verification:

- `pnpm test`
- `pnpm typecheck`
- `pnpm --filter @orca/desktop test:e2e`
- `pnpm --filter @orca/web test:e2e:threaded`
- `pnpm --filter @orca/web test:e2e:serial`

## Commit and Review Boundary

Each step is committed separately. Steps 1–4d are C++/client/mock work; steps
5–9 are shared React work; step 10 is release verification and doc closure.
