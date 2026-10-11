# Object List and Object Parts

**Date:** 2026-08-23

**Status:** Delivered. Design and implementation complete for the first version.
Mesh booleans, layer ranges, brim points and cut connectors remain deferred.


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

- Add Part, Negative Part, Modifier, Support Blocker and Support Enforcer as
  native volumes; section 9 defines primitive/file submenus and selection.

### 3.3 Included instance operations

- Select an instance.
- Add an instance to an object (`orc_add_instance`).
- Remove the last instance of an object (`orc_remove_instance`), with a guard
  keeping at least one instance per object.
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
- Layer ranges, brim points and cut connectors.

Multi-plate, history, painting and preset editing are delivered under their
respective specifications; they are not deferred by this document.

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
  instance. Like the object line, it has an expand/collapse caret that toggles
  the instance sub-list; clicking the header label selects every instance of the
  object (see §6.1).
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
- Part row: selects the volume for `(objectIdx, volumeIdx)` within the
  selection's single instance (Orca anchors a part to one instance — never across
  all instances).
- Instance row: selects every GL volume for the `(objectIdx, instanceIdx)`
  composite.
- Viewport selection updates ObjectList highlighting in reverse.
- Ctrl/Cmd is additive/toggle selection in both surfaces.
- Shift selects a contiguous range in the ObjectList and is also the viewport
  box-selection modifier (Shift+drag).
- Empty selection clears ObjectList highlighting.

The renderer `Selection` supports object, volume, and instance expansion modes.

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
choose between the object row and the `Instances` group. The deliberate divergence is (a fully-selected multi-instance object is highlighted
as its object row, whereas Orca's `update_selections()` would otherwise list its
instance rows).

Instance rows show a printable toggle. Object rows show an aggregate printable
state that toggles every instance of that object. `auto_drop` is not exposed in
the first version.

Selection restoration follows stable native identities and the operation target:

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
- Structural mutations may shift indices. Apply the committed stable-ID scene
  delta and refresh affected metadata before resolving positional indices.

This deliberately avoids replicating upstream wxWidgets'
`m_ui_and_3d_volume_maps`, incremental tree edits, and UI-index bookkeeping in
React. The shared application uses native identities and incremental scene
publication, retaining unchanged geometry and GPU resources.

## 8. Mutation and publication

Every structural operation prepares the painting boundary, waits for settled
transforms, and runs through the native history transaction. Failure to settle
aborts the mutation. Native commit returns one SceneDelta and the authoritative
affected plate set. The renderer requests changed descriptions and missing
geometry, restores selection, and invalidates only affected presentations.
Unchanged meshes and BVHs remain shared by session and native volume identity.
Project initialization is the full-baseline path. See
[Undo and Redo](Undo%20and%20Redo.md) and
[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md).

Reordering uses a destination index in the final list; an index at or above
the count appends. Part-row drag events remain isolated from object-row and
list append handlers. Delete / Backspace applies to deduplicated native volume IDs in Volume mode;
those shared parts disappear from every instance copy. In Instance mode it
deletes the complete owning objects, including all their instances and volumes.
Removing one instance is a separate instance command. Stable-ID deletion
validates every target and rejects empty, duplicate or unknown IDs before any
mutation; malformed requests never partially delete. Preserve the native
last-solid-part and last-instance guards for their respective commands.
Editable controls retain their Delete / Backspace behavior.

The current typed operation contract lives in
[client types](../packages/slicer-wasm/src/client/types.ts) and native bridge
implementations. There is one JSON-in/JSON-out ABI; specifications do not retain
obsolete parallel payload examples.

## 9. Context menus, additions and filament assignment

The object list and viewport share the object/part context menu. Add Part,
Add Negative Part, Add Modifier, Add Support Blocker, and Add Support Enforcer
appear in that order in the object menu for a single full object or a single
full instance only. The viewport uses the object menu for complete instances;
Object List instance rows retain the native instance-menu scope.
Partial parts and multiple-object/instance selections do not offer them.
Right-clicking a part row after selecting a complete instance switches to
that part in the selected instance. A parent's geometric inclusion of a part
does not mark the part row selected; the preservation guard uses the list's
projected part-row selection, so selected part sets still survive right-click.
This follows `MenuFactory::append_menu_items_add_volume` and
`ObjectList::is_instance_or_object_selected` in the pinned Orca sources.

Each submenu offers Load..., a separator, Cube, Cylinder, Sphere, Cone, Disc,
and Torus. Text, SVG, precise seam, and height-range editing are omitted until
implemented. Additions use native model volumes, preserve the owning object
and its instances, and participate in the existing project history and plate
invalidation flow. Primitive placement follows `load_generic_subobject`;
file placement follows `load_modifier`, including source mesh offsets.

Both standalone primitives and primitive parts use Orca's shared sizing rule:
`side = 0.1 * max(printable-area bounding-box width, height)`. This uses the
current printer bed, not the selected object's dimensions. Disc thickness
remains 0.2 mm; other proportions follow the native mesh builders. Existing
objects retain their size when the printer changes. Measured Cube/Cube Part
sizes are 25.6 mm for P1P, 18 mm for A1 mini, and 25 mm for Prusa MK4.
The mock's fixed 20 mm geometry remains a deterministic fixture; real sizing
is validated against both WASM variants.

Change Filament becomes a submenu. It is hidden with one filament or for
negative/support volumes. Objects and full instances assign their owning
object; model parts and parameter modifiers retain the native assignment
boundary. Existing model-part context-menu Default/inherit support remains available.
Object List parameter-modifier rows also expose the filament selector, read
native modifier assignments, and submit `parameter-modifier` targets. Default
clears the modifier's filament override. Its row shows a neutral Default label
and its popup selects Default using `explicitSlot == 0`, independently of the
parent object's effective filament. Ordinary model-part row selectors offer
only numbered filaments, matching Orca's `BitmapChoiceRenderer`; inherited
model parts continue to display their effective slot. Mixed part and
modifier selections use each volume's native target kind; negative and support
volumes are excluded. Part rows omit the printable checkbox and continue to
inherit object printability; the object row retains its printable control.

Auxiliary volumes follow Orca's `color_from_model_volume` rather than filament
or paint colours: negative volumes are RGB (0.3, 0.3, 0.3) at alpha 0.4,
parameter modifiers are yellow at alpha 0.6, support blockers are red-tinted
and enforcers blue-tinted at alpha 0.4. Selection adds 0.25 HSL lightness while
preserving alpha. Prepare uses front-face rendering and depth writes in the
transparent pass, matching `GLVolumeCollection::render`. Model parts retain
their filament/paint materials; imported segmentation does not override an
auxiliary volume's category material. Native unprintable flags still take
precedence over category colours.


Standalone Add Primitive offers Cube, Cylinder, Sphere, Cone, Disc and Torus.
Add Handy models reads the bundled native catalogue; these are ordinary
model additions with native naming, current-plate placement and history.
Text/SVG gizmos remain outside the delivered menu.

Both menu surfaces share the same command and target rules. Viewport right
drag remains pan; right click distinguishes model bodies from empty beds,
ignoring overlay hits. See [Viewport Interaction](Viewport%20Interaction.md).

### Menu targeting and rename constraints

Rename is inline in Object List only; the viewport has no Rename command or
rename modal. Renaming a single-volume object also renames its sole part;
renaming a multipart object preserves part names. While an inline editor is
active, neither its row nor its ancestors may start a drag. Multiple full
objects do not expose Rename.

Split eligibility follows native disconnected-shell / multipart rules.
Assemble requires at least two full objects and uses the selected set only;
there is no empty-list Assemble menu. A printable command applies to the
complete applicable selection, with its label derived from the clicked target.
Row context events stop propagation; hovering preserves the current selected-row
highlighting. Part-set preservation follows the projected-row rule above,
not geometric inclusion in a selected parent.

### Bundled model constraints

The handy-model catalogue order is Orca Cube, OrcaSliced Combo, Orca Badge,
Orca Tolerance Test, 3DBenchy, Cali Cat, Autodesk FDM Test, Voron Cube, Stanford
Bunny, and Orca String Hell. The shared application owns the resource manifest;
binary `.drc` / `.3mf` files come from the pinned native submodule and are copied
by asset staging. Do not commit a second binary catalogue. URLs remain relative
to the host base. Multi-file entries preserve their declared file order and
components.

Handy-model insertion does not invoke native auto-arrangement for the two
multi-file entries, nor open String Hell's native preset-edit dialog. It must
not temporarily alter profiles. Additions use the same operation admission,
settled-transform, history and current-plate contracts as ordinary imports.

## 10. Related specifications

- [Multi-Plate Support](Multi-Plate%20Support.md): plate grouping and membership.
- [Multi-Filament Support](Multi-Filament%20Support.md): native assignments and rack.
- [Project and Scoped Configuration](Project%20and%20Scoped%20Configuration.md): settings.
- [Model Arrangement](Model%20Arrangement.md): native placement.
