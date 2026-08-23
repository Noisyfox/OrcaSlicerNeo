# Object List and Object Parts

**Date:** 2026-08-23

**Status:** Draft — interactive design in progress

**Branch:** `dev/object-list-and-parts`

## 1. Goal

Add the OrcaSlicer Object List and object-part management to the shared React
application. The feature must work identically through the Electron host and
the static Web host, with all geometry and model-structure semantics owned by
the C++/WASM `libslic3r` layer.

This specification is the major milestone record for this feature, at the same
level as `spec/Grand Plan.md`.

## 2. Selected Approach

Use the approved thin-bridge approach:

- `packages/slicer-wasm/src/bridge.cpp` exposes small, explicit model-structure
  operations backed by the `Slic3r::Model` API.
- React renders a tree and calls those operations through the existing typed
  client / Worker boundary.
- No wxWidgets GUI code is ported, and no mesh topology algorithms are
  reimplemented in JavaScript.

Alternative rejected options:

- Porting/extracting upstream `GUI_ObjectList` command logic into a WASM
  controller: too coupled to wxWidgets, PartPlate, and UndoRedo.
- JavaScript-side mesh split/merge plus model re-import: loses volume types,
  configuration, transforms, painting, and 3MF metadata.

## 3. First-Version Scope

### 3.1 Included object operations

- Select an object.
- Rename an object.
- Delete an object.
- Clone an object.
- Split to Objects.
- Assemble selected objects into a multipart object (`ObjectList::merge(true)`
  semantics, upstream menu “Assemble”).
- Reorder objects in the list (`orc_reorder_objects`).

### 3.2 Included part/volume operations

- Select a part.
- Rename a part.
- Delete a part, with a guard preventing deletion of the last solid part.
- Change part type among `MODEL_PART`, `NEGATIVE_VOLUME`,
  `PARAMETER_MODIFIER`, `SUPPORT_BLOCKER`, and `SUPPORT_ENFORCER`, with the
  upstream last-solid-part guard.
- Split a part into parts (`ModelVolume::split`).
- Reorder parts inside an object (`orc_reorder_volumes`).

### 3.3 Included instance operations

- Select an instance.
- Separate instances into individual objects.
- Toggle an instance/object printable state.

### 3.4 Explicitly deferred

- Mesh boolean union/subtraction (`ObjectList::boolean()` /
  `Plater::combine_mesh_fff()`): requires re-adding the currently dropped
  `MeshBoolean`/MCUT/CSGMesh path.
- `merge(false)` / `append_menu_item_merge_to_single_object()`: the upstream
  menu function is defined but has no call site and is not part of the
  delivered feature.
- Add Part / Add Modifier as a new volume of an existing object.
- Multi-plate behavior.
- Undo/redo.
- Painting, layer ranges, brim points, cut connectors.
- Extruder/color editing panels.

## 4. Object List Tree Shape

The tree is:

```text
Object
├─ Part 1
├─ Part 2
├─ ...
└─ Instances
    ├─ Instance 1
    ├─ Instance 2
    └─ ...
```

- Parts are direct children of the object.
- `Instances` is a group under the object, after all parts.
- The `Instances` group is shown only when the object has more than one
  instance.
- Settings and Layers nodes are omitted in the first version.

## 5. Sidebar Layout

The first version places the ObjectList and SettingsPanel in the same existing
left sidebar:

- ObjectList is rendered above SettingsPanel.
- ObjectList is scrollable and may be limited in height.
- The existing resizable sidebar width preference continues to apply to the
  shared sidebar.

## 6. Selection and UI Synchronization

The viewport `SceneInteractionController` remains the single source of truth
for selection. ObjectList is a projection and command surface; it does not
maintain a second parallel selection model.

Selection mapping:

- Object row: selects all GL volumes of the object.
- Part row: selects every GL volume for the `(objectIdx, volumeIdx)` composite.
- Instance row: selects every GL volume for the `(objectIdx, instanceIdx)`
  composite.
- Viewport selection updates ObjectList highlighting in reverse.
- Ctrl/Cmd is additive/toggle selection in both surfaces.
- Shift remains reserved for viewport box selection.
- Empty selection clears ObjectList highlighting.

The renderer `Selection` must be extended from its current instance-only
expansion to support object, volume, and instance expansion modes.

Instance rows show a printable toggle. Object rows show an aggregate printable
state that toggles every instance of that object. `auto_drop` is not exposed in
the first version.

## 7. Identity Model

UI and slicing state are synchronized with libslic3r stable identifiers, not
only positional indices.

- `ObjectID` is the stable identity for `ModelObject`, `ModelVolume`, and
  `ModelInstance`.
- `ObjectInstanceID` is the stable identity for a `(ModelObject, ModelInstance)`
  composite.
- Structure results expose both:
  - stable IDs for React keys and selection restoration;
  - current positional indices for operation dispatch and display.
- Structural mutations may shift indices; after any mutation, the UI re-reads
  the structure and mesh and restores selection by stable ID where possible.

This deliberately avoids replicating upstream wxWidgets'
`m_ui_and_3d_volume_maps`, incremental tree edits, and UI-index bookkeeping in
React. Native OrcaSlicer uses that mapping because it keeps a live wxDataView
tree in sync; the shared React app instead uses stable IDs plus whole-structure
refresh.

## 8. Mutation Flow

Every structural mutation follows the same choreography:

1. Wait for any settled viewport transform synchronization.
2. Call the bridge operation with stable IDs and/or current indices.
3. The bridge mutates `Slic3r::Model` and clears/invalidates the current
   `Print`.
4. JS clears slice result state (`status = idle`, `resultExported = false`).
5. JS re-reads `getModelStructure()` and `getModelMesh()`.
6. Selection is restored by stable ID where possible, otherwise cleared.
7. ObjectList and viewport re-render.

## 9. Planned Bridge Direction

The final bridge API list is still being clarified. The intended shape is:

- `orc_get_model_structure()`
- `orc_rename_object(id)`
- `orc_rename_volume(id)`
- `orc_set_volume_type(id, type)`
- `orc_delete_objects(ids)`
- `orc_delete_volumes(ids)`
- `orc_clone_objects(ids)`
- `orc_split_volume_to_parts(id)`
- `orc_split_object_to_objects(id)`
- `orc_merge_objects_to_multipart(ids)`
- `orc_instances_to_separate_objects(...)`
- `orc_set_instance_printable(...)`
- `orc_reorder_objects(fromIndex, toIndex)`
- `orc_reorder_volumes(objectId, fromVolumeId, toVolumeId)`

Existing index-based transform APIs remain unchanged unless a later decision
extends them.

## 10. Open Questions

The following items are still being clarified before this document moves from
Draft to Approved:

- Exact bridge function signatures and error contract.
- How selection restoration behaves when a structural operation replaces the
  selected object with newly generated objects.

## 11. Relationship to Other Documents

- Extends `spec/Web-Electron Shared Application Architecture.md`.
- Implements a new major milestone beyond
  `doc/2026-08-12-electron-gui-rewrite-design.md` and the delivered vertical
  slice.
- Will be linked from `spec/Grand Plan.md` and
  `doc/high_level_dev_plan.md` once approved.
