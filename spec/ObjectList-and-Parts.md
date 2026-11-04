# Object List and Object Parts

**Date:** 2026-08-23

**Status:** The existing object/part-management scope is delivered. Mesh
Boolean remains unimplemented; section 10 records the agreed design and its
implementation/qualification requirements.
Layer ranges, brim points and cut connectors remain deferred.


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

- Mesh Boolean is outside the delivered first-version scope. The
  [agreed design](#10-mesh-boolean-design) covers the Gizmo and
  object-menu paths and the native dependency boundary.
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

Selection restoration must follow stable native identities and the operation
target. Non-destructive operations (rename, change type, reorder, printable
toggle) already restore the previous selection by stable ID. The following
accepted rules remain required but are not yet implemented:

- Operations that create new entities (Split to Objects, Assemble, Clone,
  Separate Instances, Split to Parts) must select the newly created objects or
  parts and remove vanished nodes from selection.
- Delete must move selection to the next visible sibling, then the parent
  object, or clear selection when neither remains.

The current creation/deletion path only retains surviving previous selection
IDs and prunes vanished ones; it does not select new entities or a deletion
neighbour. This implementation gap does not revoke either rule.

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

## 10. Mesh Boolean design

**Decision status:** Implemented with bounded native, host, variant and
model-scale acceptance. The accepted Neo behavior below governs the
explicit differences from the Orca reference behavior.

### 10.1 Accepted constraints

#### Computation and project boundary

- Reuse MCUT for mesh boolean computation and compile the complete original
  `MeshBoolean.cpp` with CGAL and its full GMP/GMPXX, MPFR and CORE dependency
  closure. The CGAL closed-volume and self-intersection prechecks used by
  Orca's object-menu path remain explicitly deferred. Compiling CGAL does not
  select it as a replacement boolean engine.
- Preserve Orca's existing MCUT behavior, including its Union fallback to
  mesh concatenation under the original conditions. Preserve the object-menu
  fallback that retains positive parts when the combined mesh is empty and
  emits the existing failure notification. Typed bridge receipts must preserve
  these semantics rather than reinterpret a native fallback as a rejected edit.
- Both entry points use native model geometry in the existing stateful
  WASM session. React owns interaction and presentation; it does not perform
  boolean geometry or import Emscripten globals. The typed client and runtime
  retain their existing ownership boundaries.
- Follow the existing structural-edit boundary in section 8: settle transforms,
  prepare any painting topology change, use the single history transaction,
  publish stable-ID scene changes and invalidate the affected plate results.
  Reuse native painting remapping when the painting-preservation policy is
  selected; do not copy triangle annotations by their old triangle indices.

Skipping the CGAL prechecks does not establish that MCUT accepts arbitrary
damaged inputs. Input repair and a replacement boolean engine are not part
of the accepted initial direction.

#### Model scale

- Follow Orca's entry-point policy without adding a Mesh Boolean-specific
  triangle-count ceiling. Existing input, index-representation and memory
  constraints still apply; unsupported counts must not be truncated to fit
  the native API.
- Record larger-model latency and memory behavior during implementation
  acceptance. These measurements establish observed qualification scope,
  not a fixed product size limit or a promise that every model will complete.

#### Operation targets and instances

- The object-menu operation preserves the object's separate instances,
  including their stable identities and transforms. Compute the combined
  Part geometry in object coordinates and keep it shared by those instances;
  do not bake the instance copies into one result mesh. This intentionally
  differs from Orca's all-instance baking. Geometry changes affect every
  instance of that object, including instances on other plates, so all
  affected plate results participate in invalidation.
- The Gizmo operates on two distinct volumes within one object. Cross-object
  operations require the existing Assemble command first; direct cross-object
  Gizmo operands are outside this delivery.
- Gizmo operands follow Orca's volume-type scope: model parts, negative
  volumes, parameter modifiers, support blockers and support enforcers may
  occupy either operand slot. The selected Union/Difference/Intersection mode
  determines the geometric operation; operand volume type does not change
  that operator. The object-menu CSG input filter remains a separate concern.

#### Results, configuration and painting

- The object-menu operation replaces all source volumes with one result model
  Part. Only model parts and negative volumes participate in its CSG calculation.
  Parameter modifiers, support blockers and support enforcers are removed
  with the other original volumes even though they do not enter that calculation.
  The instance-preservation decision above still applies.
- Preserve the object's name and object-level configuration. The result Part
  uses the existing native object-default filament inheritance rule; do not
  merge independent configuration overrides from the old Parts or synthesize
  MMU painting from their filament assignments. Existing MMU painting is
  governed separately by the keep-painting preference.
- Gizmo result handling follows Orca: create a result volume in the same
  object and replace A. Union also removes B. Difference and Intersection
  each expose Delete input to control removal of B; both options initially
  default to unchecked. The result inherits A's volume type, configuration
  and material, including its existing filament-inheritance/override setting.
  Append the native operation suffix to A's name. An empty Gizmo result keeps
  the input geometry and uses the native warning.
- Add an application-level, persisted keep-painting preference, defaulting
  to disabled when unset. Expose it in the global Preferences dialog, with
  Save applying the change and Cancel discarding it; the Mesh Boolean Gizmo
  does not expose a separate switch. The default matches Orca's
  [preference](../packages/slicer-wasm/cpp/src/slic3r/GUI/Preferences.cpp) and
  [configuration lookup](../packages/slicer-wasm/cpp/src/libslic3r/AppConfig.hpp).
  Store it through the existing host-neutral
  [preference boundary](Web-Electron%20Shared%20Application%20Architecture.md#7-preferences-and-selection-restoration).
  This delivery connects it to Mesh Boolean only. Pass its value through the
  typed boolean command to native code; do not restore an opaque AppConfig
  bridge or make application UI call native globals.
- When enabled, use native save/restore remapping for support, seam, MMU and
  fuzzy-skin painting. Gizmo Difference maps A; Union and Intersection map A
  and B. Object-menu boolean maps the positive Parts. Preserve the native
  mapping behavior on new or retriangulated surfaces rather than introducing
  a separate cut-surface coloring policy. Because Neo retains instances, the
  object-menu mapping stays in object coordinates and the resulting annotations
  remain shared across its instances; do not bake separately transformed
  instance painting copies into the mesh.
- When the preference is disabled, the new result has no remapped painting.
  Paint on any retained input volume, including B when Delete input is
  unchecked, remains unchanged.

#### Interaction and tool lifecycle

- Keep the existing
  [Prepare tool-card layout](Application%20Shell.md#tool-cards) and one-active-tool
  rule. Activate the Gizmo for one complete selected instance containing more
  than one volume, following Orca's eligibility rule. The panel exposes Union,
  Difference and Intersection, named A/B slots, the applicable Delete input
  option and an explicit operation button.
- Compute and apply the boolean only when that operation button is pressed.
  Picking operands and switching operation modes do not compute a result
  preview. Show operand identification and bounds. Merely picking operands,
  changing a mode or clearing a slot does not create a project-history entry.
- Support both viewport picking and Object List Part-row assignment. While
  a picking slot is active, clicking a volume row of the current target fills
  that slot without turning the normal selection into a partial-instance
  selection that would disable the tool. Keep the target instance anchor.
  A/B assignment is tool state, not a second ordinary scene-selection model.
  This list-assignment entry is an intentional addition to Orca's viewport-only
  operand picking.
- Follow Orca's operand-slot behavior: begin with A, advance to B after picking
  A, allow either slot to be explicitly reselected or cleared, and clear the
  other slot when its volume is assigned to the active slot. Switching between
  Union, Difference and Intersection retains valid operands.
- After success, select the generated result using the normal stable-ID
  selection/publication path, clear both operands and return to picking A.
  Do not automatically fill A with the result. Re-evaluate tool eligibility
  after the operation; close when the current target/selection no longer
  qualifies.
- Ordinary selection of a different eligible object retargets the open Gizmo,
  clears A/B and returns to Union with A active. If the new selection is not
  eligible, close the tool. This also keeps list assignment from becoming a
  cross-object boolean entry: rows outside the current target follow ordinary
  selection and eligibility handling rather than filling its old operand slots.
  Reconcile stable target and operand IDs when model/history changes occur;
  unavailable operands cannot be dispatched.
- While idle, Escape, toggling the active tool off, or switching to another
  Gizmo closes Mesh Boolean and clears its operand picks. Completed operations
  remain committed and are reversed through ordinary Undo; tool closure is
  not a whole-session discard.
- Entering Preview closes the tool, following
  [workspace mode navigation](Workspace%20Prepare%20and%20Preview%20Modes.md).
  Returning to Prepare does not automatically reopen it. Idle navigation to
  Home or Device hides the tool while retaining its target, operands and mode;
  return to Prepare resumes that state after checking target validity. This
  follows the existing
  [hidden-page tool lifecycle](Surface%20Painting%20Architecture.md#33-navigation-and-editing-target-changes).
  Project replacement and application shutdown clear the tool independently
  of ordinary page navigation. The executing-operation rules below take
  precedence over these idle navigation and tool-dismissal rules.

#### Executing operations

- Both entry points show a global modal wait state while the native operation
  runs in its Worker. Display an indeterminate progress indicator; no native
  percentage-progress contract is introduced.
- The initial delivery provides no mid-operation cancellation. The modal
  cannot be dismissed with Escape, an outside click or a close/cancel action.
  Undo remains the ordinary way to reverse a successful completed operation.
- Block application-controlled camera interaction, target selection, tool
  changes and page navigation, including Home, Device and Preview, until the
  operation settles. Also block project edits, configuration/painting edits,
  history actions, project opening/saving, slicing, export and duplicate
  boolean submissions. This is a global modal wait, rather than the idle
  hide/resume behavior described above.
- Reject conflicting commands before posting them to the Worker; do not queue
  edits or navigation to execute after the boolean result. Keep the modal
  active through native completion and publication of the result's history,
  scene and selection changes. Release it after the operation's terminal
  success or error has been reconciled, then apply the accepted result/tool
  lifecycle rules. Preserve native fallback notifications and results.

### 10.2 Orca reference behavior

The references below resolve through the superproject's pinned Orca submodule.
They describe native behavior for review, rather than silently deciding every
Neo product choice.

| Entry point | Selection and operation | Result behavior |
| --- | --- | --- |
| [Mesh Boolean Gizmo](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoMeshBoolean.cpp) | Activates for one complete selected instance with more than one selected volume. Source A and tool B are picked from that object's volumes. Offers Union, Difference A-minus-B and Intersection. | Creates a result volume in the same object and replaces A. Union also consumes B; Difference and Intersection expose a Delete input option controlling B. The shared object's other instances use the changed volumes too. |
| [Object-list Mesh boolean](../packages/slicer-wasm/cpp/src/slic3r/GUI/GUI_ObjectList.cpp) | The menu gate accepts a multipart object or a single splittable volume. It is an immediate object operation, without the Gizmo's operation picker. | Combines model parts and negative volumes, creates a new object with one volume and one instance, preserves the object name/configuration, performs native placement adjustment and selects the result. |

The object-menu path calls
[`Plater::combine_mesh_fff(object, -1, ...)`](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp).
It calculates positive/negative CSG in object coordinates, then applies every
instance transform and merges those copies into the returned geometry. Thus
the native result bakes all instances into one mesh, including instances at
different positions. Preserving separate instances would be a deliberate Neo
behavior difference, not an equivalent implementation of that call.

Orca's object path defaults to CGAL closed-volume/self-intersection validation
in [`check_csgmesh_booleans`](../packages/slicer-wasm/cpp/src/libslic3r/CSGMesh/PerformCSGMeshBooleans.hpp)
before running MCUT. Its CGAL boolean-computation retry is compiled out.
The initial Neo direction omits the former and does not enable the latter;
the existing MCUT and positive-part fallbacks remain as accepted in 10.1.

The Gizmo's result inherits A's volume configuration, type and material; its
name adds the operation suffix. It always replaces A even when Delete input
is unchecked. With Orca's keep-painting preference enabled, Difference maps
A's painting, while Union and Intersection map painting from A and B. The
object-menu path maps painting from positive parts over their instance copies.
The [native preservation helpers](../packages/slicer-wasm/cpp/src/libslic3r/Model.cpp)
cover support, seam, MMU and fuzzy-skin data.

The Gizmo disables the raycaster's model-part-only restriction. Its
[`set_src_volume` and `set_tool_volume` setters](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmoMeshBoolean.hpp)
maintain operand exclusivity: assigning the volume already held by the other
slot clears that other slot. The action is enabled only when both slots are
populated. This prevents the same volume from remaining both A and B.
The object CSG path includes model parts and negative volumes;
parameter/support modifiers do not participate. The accepted result rule in
10.1 removes those auxiliary volumes along with the original Parts.

The native Gizmo performs the operation when its button is pressed, then resets
operand picking after success. It highlights operand bounds but does not
continuously compute a live boolean-result preview. An empty Gizmo result
leaves the input geometry in place and shows the native warning. These
behaviors are separate from the object-menu fallback already accepted above.

Native operand assignment comes from viewport ray hits; the panel selects,
clears and labels the operand slots rather than assigning operands through
Object List rows. The successful-operation path selects the result, clears
A/B and returns to picking A. A target-object change resets the operands and
operation mode to Union.

The [native Gizmo manager](../packages/slicer-wasm/cpp/src/slic3r/GUI/Gizmos/GLGizmosManager.cpp)
closes an ineligible Gizmo and closes Mesh Boolean on Escape. The Preview
transition in Plater explicitly resets active Gizmos; ordinary Home/Device
page switches retain the Prepare page. Closing Mesh Boolean clears its picks
and warning state without reverting already performed model operations.

The native Gizmo buttons and object-menu handler call their boolean routines
synchronously within GUI callbacks. Neither entry point provides a dedicated
percentage-progress or mid-computation cancellation UI. Neo keeps computation
off the renderer thread while using the accepted global modal wait for input.

### 10.3 Native and build boundary

Compile the complete original
[`MeshBoolean.cpp`](../packages/slicer-wasm/cpp/src/libslic3r/MeshBoolean.cpp),
retaining its CGAL and MCUT implementations and the original libigl code.
Update the [WASM source collection](../packages/slicer-wasm/CMakeLists.txt) to
include that translation unit and link its full CGAL dependency closure.
The accepted implementation uses this one Orca source implementation rather
than splitting out MCUT, conditionally deleting CGAL sections or maintaining
a separate WASM copy of the wrappers.

Use the versions pinned by the Orca dependency recipes: CGAL 5.6.3, static
GMP 6.2.1 with GMPXX, and MPFR 4.2.2. CORE is provided through CGAL's
header-only support. These dependencies allow the original libigl square-root
overloads to compile as supplied.

The numerical libraries are cross-compiled to WASM and linked into the WASM
module. Its runtime artifact is shared across host operating systems, with
address width and threading mode selecting the appropriate variant. Integrate
dependency preparation through the existing build-driver conventions and
keep toolchain/configuration matching in dependency-stage validation.

Use `CGAL_ALWAYS_ROUND_TO_NEAREST=1` consistently for CGAL's fixed-rounding
interval implementation in WASM, with the GMPXX exact-number backend enabled
consistently across CGAL translation units. Serial builds disable CGAL's
threading support with `CGAL_HAS_NO_THREADS=1`, use GMP's generic C
implementation with assembly disabled and retain Orca's existing GMP
compiler-compatibility patch. Disable MPFR thread-local and shared caches in
the serial dependency configuration. Select dependency stages by address
width and threading mode; the serial configuration does not qualify the
threaded dependency build.

Using GMP/MPFR/CORE does not remove the floating-point interval requirement:
CGAL still uses double-based filtering before exact arithmetic. The supported
round-to-nearest interval path expands bounds outward and preserves the
inclusion needed for reliable predicates. This changes the filtering mechanism;
it does not establish byte-identical meshes, floating-point constructions or
triangulations across native and WASM targets.

The selected build keeps the CGAL prechecks deferred and the native disabled
CGAL retry disabled, as accepted in 10.1.

Orca wrapper/source changes belong in the committed Orca submodule, followed
by a deliberate pin update when implementation is approved. Changes to the
third-party MCUT scheduler belong to an external dependency patch. Prepare a
build-local copy from the pinned MCUT source, apply that patch to the copy,
and leave the checked-out Orca source unchanged during dependency preparation.
The [native build reference](../doc/2026-08-12-wasm-build-notes.md#source-and-dependency-ownership)
owns source and patch policy.

The MCUT adaptation adds a manager-thread build switch that defaults
to the existing threaded behavior. Serial builds disable both API manager
threads and compute-helper threads. Context creation and shutdown then skip
the manager threads, while task submission executes the existing packaged
task inline on the slicer Worker. Retain its completion event, error status
and cleanup; do not leave tasks queued without an executor.

Serial execution must also preserve the lifetime of the perturbation random
state in [MCUT preprocessing](../packages/slicer-wasm/cpp/deps_src/mcut/source/preproc.cpp).
The original generator is `thread_local`: a fresh native Context's manager
thread starts a fresh stream, while successive dispatches on that Context
continue it. Inline execution on one persistent Worker would otherwise share
the stream across different Contexts. The extended serial probe moves this
generator and distribution into the Context, retaining the original seed,
continuation within a Context and independence between Contexts. The default
manager-thread build retains the original thread-local implementation.

Orca currently requests zero compute helpers but MCUT still creates one API
manager thread. Consequently disabling only the existing compute-helper-pool
option does not make this MCUT version usable in a no-pthreads WASM build.
The relevant scheduler is
[`context_t`](../packages/slicer-wasm/cpp/deps_src/mcut/include/mcut/internal/frontend.h).
The adaptation covers Orca's synchronous API calls, not a promise of
support for asynchronous user events or out-of-order API execution.

Serial execution adapts task submission, Context lifetime and perturbation
state. Enabling CGAL does not remove these separate MCUT requirements.

### 10.4 Feasibility and qualification boundary

An isolated experiment using the pinned MCUT source has established that
inline API task execution is feasible in no-pthreads wasm64 and wasm32.
The synchronous API executed in Node and non-isolated Chrome module Workers
without SharedArrayBuffer or additional Worker creation. Boolean geometry
was compared with the original native manager-thread implementation; the
experiment also exercised repeated Context lifetime and recovery after an
invalid input. The default manager-thread path remained usable in a native
build with the patch applied.

This is dependency-level feasibility evidence. It does not qualify the
Orca wrappers and fallbacks, application integration, painting/history,
threaded WASM, other operating systems, or production-scale meshes.
No prototype timing or fixture result establishes a product performance limit.

The full-dependency probe used CGAL 5.6.3, GMP/GMPXX 6.2.1 and MPFR 4.2.2
from the pinned dependency recipes, with Boost 1.84 and Emscripten 6.0.6.
It built the numerical dependencies for both serial address widths and
generated wasm64 and wasm32 objects from the complete unchanged Orca
`MeshBoolean.cpp` with unmodified libigl.

The full-dependency numerical probe passed large-integer multiplication and
division, rational arithmetic, MPFR directed-rounding enclosure, CORE exact
square-root/cancellation/comparison and the original libigl scalar conversions.
Those checks and the six EPICK/EPECK boolean cases passed in Node Workers and
non-isolated Chrome module Workers for both widths. A wasm64 combined fixture
also linked the existing serial Orca core archives, their Boost dependencies
and the adapted MCUT library, then exercised the original Orca CGAL Union,
Difference and Intersection wrappers, libigl Difference and self-Union, and
MCUT Union, Difference and Intersection. All eight wrapper cases passed in
Node and Chrome Workers with non-shared WASM memory, no thread imports and no
nested browser Workers; SharedArrayBuffer was unavailable in the browser.
The existing Boost archives contribute an atomics target-feature marker to
that combined module. This is evidence for serial execution without shared
memory, not a claim that its binary has no atomics feature requirement.

The combined fixture exposed the random-state lifetime gap described in 10.3:
new Contexts in the initial inline adaptation consumed one continuing
thread-local stream. After the Context-owned serial adaptation, three fresh
Context cases and four calls interleaved between two live Contexts matched
the original native MCUT counts, with maximum float-converted volume
difference below 9e-16 in wasm64 and wasm32. Both widths also passed the
earlier twelve-case geometry suite, 100 repeated Context cycles and invalid
input followed by recovery. The native default manager-thread build remained
consistent with the original in the added perturbation fixture. Analytical
volume alone is not the native reference for inputs which MCUT perturbs;
the original native library exhibits that displacement too.

The full GMP/MPFR/CORE configuration still failed the default WASM interval
rounding check and passed with the fixed-rounding macro. A native control
using the same CGAL headers and matching GMP/MPFR versions compared default
and fixed rounding with both WASM widths. All six box cases matched in
reported volume and vertex/face counts. These comparisons do not establish
coordinate/connectivity identity or general native/WASM equivalence.

These standalone probes establish feasibility; the delivered application gates
are recorded separately in 10.5. Neither establishes arbitrary adversarial-input
support or universal native/WASM mesh identity. The application download-size
increment has not been isolated; a standalone probe's artifact size is not the
application's size increment. Scale measurements cover the reproducible fixture
and runner scope below, rather than every geometry or device.

Implementation verification must cover the accepted entry-point rules,
transformed and mirrored geometry, connected components, disconnected and
contained operands, empty results and Orca's existing fallback behavior.
It must also cover painting, property/filament ownership, selection restoration,
Undo/Redo, project roundtrips and plate-result invalidation under the final
decisions. Follow
[Testing Guidelines](../doc/testing_guidelines.md) for package, host and
WASM-variant gates; mocks cannot replace real MCUT/WASM execution.

Mobile product support remains deferred under the shared architecture. This
design assumes desktop pointer/keyboard input. Boolean operations retain native
input and output geometry in the Worker and can increase peak memory usage;
the bounded scale measurements below are not a universal latency or memory
guarantee, and constrained-device limits remain unqualified.

### 10.5 Implementation sequence and acceptance

The product and source-boundary decisions are agreed. Deliver the following
independently verifiable implementation pieces in order; the dependency probes
in 10.4 do not mark any of these application pieces as delivered.
Each piece must pass its acceptance gate and be committed before implementation
of the next piece starts.

1. **Native dependency and source closure.** Integrate the full pinned CGAL,
   GMP/GMPXX, MPFR and CORE closure into the existing WASM build drivers and
   source collection. Compile the original complete `MeshBoolean.cpp` and
   apply the MCUT serial adaptation to a build-local dependency copy, including
   Context-owned perturbation state. Verify actual linked wrapper execution
   and serial/threaded startup with the intended numerical and thread settings;
   building an unused object alone is insufficient.

   **Accepted foundation scope:** complete wasm64 serial/threaded module
   builds, existing bridge/slicing smoke and real wrapper tests in Node and
   Chrome Workers. The serial Chrome test runs without SharedArrayBuffer or
   internal Workers. Numerical execution covers all four address-width/threading
   combinations; wasm32 also passes the MCUT Context lifecycle/state suite.
   Full wasm32 application and host interaction qualification remain in step 4.
   Rotated float-mesh fixtures can produce self-intersecting MCUT output despite
   closed topology. Tests record that limitation and validate volume/closedness;
   this integration adds no post-result repair or guarantee for arbitrary input.
2. **Native project operations and typed runtime.** Add both entry-point
   operations through the existing bridge/client/runtime boundary. Implement
   object-coordinate transforms, instance preservation, result configuration,
   painting remapping, history/scene publication and plate invalidation under
   10.1. Keep the original MCUT/fallback behavior. Exercise real native/WASM
   operations, Undo/Redo and project roundtrips; update contracts and affected
   mocks together without parallel payload formats.

   **Accepted native command scope:** real wasm64 serial/threaded geometry,
   stable instance IDs/transforms, retained Part ordering, configuration and
   all four painting channels, including partial regions on reflected Parts.
   Winding correction must preserve painting subdivision coordinates; a
   reversed root face must not move paint to another region. Native tests
   cover one-entry Undo/Redo, affected
   plates, scene receipts, 3MF roundtrips, empty/stale input and positive-Part
   fallback. An explicit serial test build injects a publication exception and
   verifies restoration of geometry ownership and plate revisions. The normal
   build excludes that hook. Application admission and modal publication are
   still owned by step 3; direct native tests do not establish those behaviors.
3. **Shared application interaction.** Add the Prepare Gizmo, viewport/list
   operand assignment, object-menu action and persisted painting preference.
   Implement the global modal wait and reject conflicting commands before
   posting them. Verify selection/tool lifecycle, modal input blocking and
   terminal success/error handling through the shared application, then cover
   the distinct Web and Electron host seams.

   **Accepted interaction scope:** real threaded wasm64 journeys on Electron
   and Chrome cover viewport/list picking, mode changes, idle Escape and page
   lifecycle, the persisted painting preference, both entry points, result
   selection, Undo/Redo and instance preservation. The wait blocks navigation,
   keyboard and camera input. Application and transport tests also hold
   publication open after native completion and verify that foreign commands
   are rejected without being queued or posted. Full fallback packaging and
   browser variant qualification remain in step 4.
4. **Integration and model-scale qualification.** Follow
   [Testing Guidelines](../doc/testing_guidelines.md) for package, repository,
   affected-host and WASM-variant gates. Exercise the new variant-dependent
   dependency/scheduler paths in serial and threaded builds, including the
   applicable wasm32 fallback. Use the full release/milestone matrix at its
   defined gate rather than claiming release qualification from a fixture.
   Record representative larger-model input/output sizes, connected-component
   counts, elapsed time and WASM heap-capacity high-water marks, plus host
   process memory where measurable. Name the artifact/configuration and any
   unavailable measurements. Keep no fixed Mesh Boolean face-count ceiling.

   **Accepted qualification scope:** all four production WASM combinations
   execute the native geometry/painting/history suite and reuse one session
   for slicing, Boolean, reslicing and a 3MF roundtrip. Real Electron and Web
   gates exercise the shared interaction; Web verifies actual Memory64
   capability, isolation, selected asset requests and production payload hashes
   for both widths and threading modes. An opt-in large-model Chrome gate
   checks result/history publication after actual Worker linear memory grows
   beyond 4 GiB. A dedicated serial fault build checks
   publication compensation and positive-Part fallback; production artifacts
   exclude its hook. The reproducible
   [scale runner](../packages/slicer-wasm/harness/mesh-boolean-scale.mjs)
   exercises all three operations over progressively refined, overlapping
   closed icospheres with analytical volume checks and indexed-component
   counts. It records native-command/history time, WASM capacity high-water
   since startup and sampled whole-process Node RSS. Capacity is not live
   allocator usage; these observations establish neither a product size cap
   nor an arbitrary-input performance promise. Painting-preservation cost is
   outside that scale runner's measured scope.

Native comparisons must distinguish semantic/geometric agreement from mesh
serialization identity. Include the perturbation-triggering fresh/interleaved
Context cases and preserve native perturbation/fallback results instead of
requiring every output to match unperturbed analytical geometry exactly.
Completion requires the accepted feature behavior and its applicable real
runtime checks; documentation, mocks or the existing standalone probes alone
do not satisfy application acceptance.

## 11. Related specifications

- [Multi-Plate Support](Multi-Plate%20Support.md): plate grouping and membership.
- [Multi-Filament Support](Multi-Filament%20Support.md): native assignments and rack.
- [Project and Scoped Configuration](Project%20and%20Scoped%20Configuration.md): settings.
- [Model Arrangement](Model%20Arrangement.md): native placement.
