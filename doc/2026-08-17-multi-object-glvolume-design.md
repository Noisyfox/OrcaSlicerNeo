# Multi-object GLVolume Model Design

Date: 2026-08-17
Status: Implementing

## Goal

Support a complete FDM project containing multiple `ModelObject`s, each with
multiple `ModelVolume`s and `ModelInstance`s. The renderer owns the interactive
plate state. The WASM-side `Slic3r::Model` remains the authoritative project
container used only when synchronizing and slicing.

## Model correspondence

`Slic3r::Model` is the full project. It owns `ModelObject`s; each object owns
both its `ModelVolume`s (geometry/modifiers) and its `ModelInstance`s (plate
placements).

The 3D scene renders the JavaScript `GLVolume` collection directly, not a
separate object-mesh list. One JavaScript `GLVolume` represents this composite
identity:

```
CompositeID = (objectIdx, volumeIdx, instanceIdx)
```

Its render geometry is the referenced `ModelVolume` mesh. It carries two
mutable transforms:

- `instanceTransform`: the transform shared by all renderer GLVolumes with
  the same `(objectIdx, instanceIdx)`.
- `volumeTransform`: the transform shared by all renderer GLVolumes with the
  same `(objectIdx, volumeIdx)`.

This matches `GLCanvas3D::do_rotate`: instance-mode manipulation writes the
GLVolume instance transform to `ModelInstance::set_transformation`; volume-mode
manipulation writes its volume transform to `ModelVolume::set_transformation`.

## Bridge contract

`orc_get_model_mesh()` returns one entry per `(object_idx, volume_idx,
instance_idx)`, with local `ModelVolume` geometry and both transformation
states. The entry contains independent heap allocations because the JS client
copies and frees each entry independently.

The bridge adds `orc_set_model_transform(object_idx, volume_idx, instance_idx,
instance_transform_json, volume_transform_json)`. It is intentionally an
application operation rather than a renderer callback: it validates indices,
updates the matching `ModelInstance` and `ModelVolume`, and invalidates the
object bounding box. Transform JSON uses offset, Euler rotation, scaling, and
mirror vectors so it can be expanded by future rotate/scale/mirror tools.

## Synchronization and slicing

The renderer never writes to WASM while dragging or editing numeric controls.
Immediately before `slice()` it synchronizes its GLVolume collection:

1. Group instance transforms by `(objectIdx, instanceIdx)` and reject an
   inconsistent group.
2. Group volume transforms by `(objectIdx, volumeIdx)` and reject an
   inconsistent group.
3. Send one bridge update for every composite ID, using the grouped transforms.
4. Call `orc_slice` only after every update succeeds.

This has the same effective state as the native canvas path while preventing
worker round trips during interaction. A failed synchronization leaves the
slice status in error and never starts a slice with stale C++ state.

## Initial scope

The existing move tool edits `instanceTransform.offset`. Rotation, scale,
mirror, and volume-mode controls use the same data model but are deferred.
Selection is by `CompositeID`, so multiple instances and multiple volumes are
addressable immediately. Existing single-volume STL behavior remains a single
`(0, 0, 0)` GLVolume.

## Verification

- Client unit tests validate that every returned mesh entry has a complete
  composite ID and transform state.
- Renderer/store tests validate independent selection and movement of two
  instances of one object and two volumes of one object.
- The bridge smoke test validates transform application to a non-zero instance
  and volume index when a multi-object fixture is available.
