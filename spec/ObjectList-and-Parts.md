# Object List and Object Parts

**Date:** 2026-08-23

**Status:** Delivered. Design and implementation complete for the first version
(see `doc/2026-08-23-object-list-parts-implementation-plan.md`). Deferred items
(mesh boolean, Add Part/Modifier, multi-plate, undo/redo, painting, extruder
panels) remain queued.

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
- Separate instances into individual objects (**Set as an individual object** in
  the instance-row context menu).
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
  instance. It is not collapseable; its header line is a select control that
  selects every instance of the object (see §6.1).
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

### 6.1 Selection modes follow OrcaSlicer

The selection model follows OrcaSlicer's `Selection`
(`src/slic3r/GUI/Selection.{hpp,cpp}`). There are **only two selection modes**,
`Volume` (part) and `Instance`; an **object selection is not a third mode** — it
is the `Instance`-mode selection of every volume of an object's instances
(Orca's `SingleFullObject` / `MultipleFullObject`).

Excluded combinations (Orca's exclusions, which the shared app must respect):

- **Part (volume) selection is anchored to a single instance.** A part is
  resolved within the current selection's instance (Orca:
  `get_volume_idxs_from_volume(obj, instance_idx_from_selection_or_0, vol)`), and
  `Selection::add()` in `Volume` mode rejects a volume whose `instance_idx()`
  differs from the selection's sole instance. The shared app must not select a
  part across all instances at once.
- Selections are **mode-homogeneous**. `Instance` mode covers whole instances
  *and* whole objects (an instance is a full object at that level), so a full
  instance and a full object may be mixed. `Volume` mode covers parts/modifiers
  and is valid only as a lone set within one instance. A part-level entry mixed
  with an instance/object-level entry, or parts spanning several instances, is
  Orca's `Mixed` and is treated as invalid — no edit/transform is applied.
- The mode is derived from content: a full object/instance selection forces
  `Instance` mode; parts/modifiers use `Volume` mode.

Consequently the renderer `Selection`:

- uses `Instance` mode for instance and object rows (object = all instances of
  the object),
- uses `Volume` mode for part rows, resolved against a single instance anchor,
- keeps collection multi-select (Ctrl toggle / Shift range) within a homogeneous
  type when the equivalent Orca selection would be valid, and refuses an invalid
  mix. `classifyVolumeIds()` is mode-based: no partial instance anywhere → every
  touched whole instance/object is valid (`object`/`instance`, and these may be
  mixed); a partial instance is `part` only as a lone single-instance set,
  otherwise `Mixed` and refused (e.g. a part mixed with a full instance).

ObjectList highlighting is a projection of the viewport selection to the
**most-relative** row, resolved **per object** (spec §6): a fully selected object
highlights its object row (even when the object has several instances — see the
divergence note) **unless it was selected via the `Instances` group line**, which
highlights its instance rows instead; a not-fully-selected object highlights its
whole-instance rows; and a partial instance highlights only its selected volume
rows. So a mix of a full object and a full instance highlights each at its own
level, and the page records a per-object "row kind that last drove selection" to
choose between the object row and the `Instances` group. See
`doc/2026-08-23-object-list-highlight-orca.md` for the Orca cross-check and the
one deliberate divergence (a fully-selected multi-instance object is highlighted
as its object row, whereas Orca's `update_selections()` would otherwise list its
instance rows).

Instance rows show a printable toggle. Object rows show an aggregate printable
state that toggles every instance of that object. `auto_drop` is not exposed in
the first version.

Selection restoration after a mutation follows three rules:

- Non-destructive operations (rename, change type, reorder, printable toggle)
  restore the previous selection by stable ID.
- Operations that create new entities (Split to Objects, Assemble, Clone,
  Separate Instances, Split to Parts) select the newly created objects or
  parts and remove vanished nodes from selection.
- Delete moves selection to the next visible sibling, then the parent object,
  or clears selection when neither remains.

## 7. Identity Model

UI and slicing state are synchronized with libslic3r stable identifiers, not
only positional indices.

- `ObjectID` is the stable identity for `ModelObject`, `ModelVolume`, and
  `ModelInstance`.
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

## 9. Bridge Contract

The following bridge contract is the implementation baseline. Existing
index-based transform APIs remain unchanged unless a later decision extends
them.

### 9.1 Structure read

`orc_get_model_structure()` returns:

```json
{
  "ok": true,
  "objects": [
    {
      "id": 123,
      "index": 0,
      "name": "Cube",
      "printable": true,
      "instanceCount": 2,
      "volumes": [
        {
          "id": 456,
          "index": 0,
          "name": "Cube",
          "type": "model_part",
          "isSplittable": true
        }
      ],
      "instances": [
        { "id": 789, "index": 0, "printable": true },
        { "id": 790, "index": 1, "printable": false }
      ]
    }
  ]
}
```

Volume `type` is one of:

```text
model_part
negative_volume
parameter_modifier
support_blocker
support_enforcer
```

### 9.2 Operations

```text
orc_rename_object(objectId, name)
orc_rename_volume(volumeId, name)
orc_set_volume_type(volumeId, type)
orc_delete_objects(objectIds[])
orc_delete_volumes(volumeIds[])
orc_clone_objects(objectIds[])
orc_split_volume_to_parts(volumeId, maxExtruders, remapPaint)
orc_split_object_to_objects(objectId, autoDrop)
orc_merge_objects_to_multipart(objectIds[], name)
orc_instances_to_separate_objects(objectId, instanceIds[])
orc_set_object_printable(objectId, printable)
orc_set_instance_printable(instanceId, printable)
orc_reorder_objects(fromObjectId, toObjectId)
orc_reorder_volumes(objectId, fromVolumeId, toVolumeId)
```

Simple operations return:

```json
{ "ok": true }
```

Creating operations additionally return the generated IDs, for example
`newObjectIds`, `newVolumeIds`, or the single created `objectId`. Every
function returns `{ "ok": false, "error": "..." }` on failure.

### Bridge calling convention

- One `extern "C"` function per operation.
- JSON-in / JSON-out.
- Every function returns either `{ "ok": true, ... }` or
  `{ "ok": false, "error": "..." }`.
- Multi-selection operations receive JSON arrays of IDs.
- `ObjectID` crosses the boundary as a JSON number.
- `orc_get_model_structure()` takes no arguments and returns the complete
  object/part/instance tree.

## 10. Relationship to Other Documents

- Extends `spec/Web-Electron Shared Application Architecture.md`.
- Implements a new major milestone beyond
  `doc/2026-08-12-electron-gui-rewrite-design.md` and the delivered vertical
  slice.
- Implementation is broken into independently verifiable steps in
  `doc/2026-08-23-object-list-parts-implementation-plan.md`.
- Will be linked from `spec/Grand Plan.md` and
  `doc/high_level_dev_plan.md` once approved.
