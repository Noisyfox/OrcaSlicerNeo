# Multi-Filament Support

**Outstanding validation observation:** Printer-transition verification on
2026-10-06 recorded a failing structural member/out-of-bounds assertion in
`history-smoke.mjs`. Later focused H2D/rack checks do not establish resolution
of that history case. Preserve this boundary until a matching real-WASM run
closes it.

**Date:** 2026-09-08

**Status:** Delivered native rack, assignments, flushing editor, Prime Tower and history behavior.
Section 14 records the accepted nozzle-mapping design. Its native read-only
projection, atomic edits and Plate-aware slicing are delivered; persistence extensions and UI remain pending.

**Scope:** Multi-filament material slots for the shared Electron and Web application.

## 1. Goal

Add OrcaSlicer-compatible multi-filament preparation, slicing, preview, and
project persistence without porting the wxWidgets GUI. The C++/WASM session
owns filament compatibility and slice configuration. React renders typed
session projections and dispatches explicit commands through the existing
client and Worker boundary.

This specification extends
[`Web-Electron Shared Application Architecture.md`](Web-Electron%20Shared%20Application%20Architecture.md),
[`Profile Compatibility and Preset Selection.md`](Profile%20Compatibility%20and%20Preset%20Selection.md),
[`ObjectList-and-Parts.md`](ObjectList-and-Parts.md), and
[`3MF Project Persistence.md`](3MF%20Project%20Persistence.md).

## 2. Product Model

The product exposes one unified ordered list of filament material slots. The
same slot model covers:

- single-nozzle multi-material systems, including AMS/MMU-style and manual
  filament switching;
- multi-nozzle, IDEX, and toolchanger printers; and
- ordinary single-filament printers, represented by one slot.

Filament combo triggers and list entries use native `Preset::label(false)`:
the profile alias when available, otherwise its complete name. Their tooltips
show complete canonical names, including suffixes. Equal aliases remain
separate canonical choices; selection, editing, and persistence use full names.
Display labels are required in the internal catalogue and slot snapshot
contracts. Missing labels are rejected rather than reconstructed by React.
Filament lists group entries by native `filament_vendor`, independently of the
profile resource vendor id. Vendor names are retained verbatim, including
`Bambu Lab`; empty vendors display as `Unspecified`. Native catalogue order
retains empty-vendor and Generic priority, then PLA/PETG/ABS/TPU priority
and canonical-name ordering. Bambu vendor priority and named Bambu profile
priorities are omitted. Group and item order preserve that projection.
The first menu level contains vendor submenu triggers; each second-level
menu contains that vendor's
profiles. Pointer hover/click and keyboard navigation open vendor submenus.
Search retains only vendors and profiles with matching display labels.
Selecting a profile closes the menu and returns focus to its slot trigger.
Current imported or incompatible slot profiles remain available in their own
vendor group.

The delivered application does not yet expose an advanced manual
filament-to-physical-extruder mapping editor. It uses the selected printer
preset and OrcaSlicer's native configuration rules. The accepted entry points
and behavior of the planned editor are owned by
[section 14](#14-nozzle-filament-mapping-design).

The slot list has an ordered, one-based material identity matching the native
model `extruder` configuration convention. Removing a slot may therefore
renumber later slots and must be treated as an atomic project mutation rather
than as a React list edit.

## 3. Printer and Process Transitions

Changing the Printer or Process revalidates the complete slot list in the
C++/WASM session and returns one atomic replacement snapshot to the UI.

- A slot whose filament preset remains compatible is retained in the same
  position.
- An incompatible slot is replaced through OrcaSlicer's native compatible
  fallback policy.
- The session adds slots when necessary to satisfy the selected printer's
  minimum physical-extruder requirement.
- React does not independently filter candidates, select fallbacks, resize the
  slot list, or infer physical mappings.

An explicit Printer transition, including remembered-rack restoration and any
resulting compatibility replacement, is one native project-history transaction
and one slice invalidation. Undo/Redo restores the complete transition state;
the independent remembered-rack preference update is not undoable.

The typed contract preserves the native mapping result for the planned
[mapping editor](#14-nozzle-filament-mapping-design); that editor is not yet
delivered.

## 4. Project and Preference Ownership

A loaded project's filament slots are project-owned state. The project stores
the ordered preset selections, slot colours, native mappings, and other
eligible multi-filament configuration required to reproduce its slice.

Project state has priority over remembered defaults:

1. Opening a compatible 3MF restores the project's complete slot state. This
   priority applies to project loading only; a later explicit Printer selection
   restores that selected Printer's remembered rack.
2. Creating a new project or working without an opened project restores the
   last-used slot state for the selected printer.
3. Remembered state is namespaced by printer and never replaces explicit slot
   state loaded from a project.
4. The current effective slot state is mirrored to the selected printer's
   remembered defaults after a successful explicit slot edit and after an
   Undo/Redo restoration that changes that state. It never alters another
   printer's defaults.

The remembered rack records source-preset selections, a valid effective HEX
colour, and each slot's raw native representative, multi-colour list, and
colour type (including unknown strings and null entries). A raw null entry
is retained in the preference; restoring to a full native slot array uses
the effective colour for a missing representative, that representative for
a missing multi-colour list, and solid type `1` for a missing type. Stored racks
with absent or incomplete native metadata are discarded at the preference
boundary; old HEX-only racks are not migrated. Internal rack commands require
the complete fields.
The rack never records a Preset Editor runtime draft or its overrides. Restoring a
remembered rack is always followed by native compatibility normalization. A
compatible restored source is retained; a missing or incompatible source is
replaced using the selected Printer's corresponding default filament profile,
then the ordinary compatible fallback. This matches Orca's restore-then-
normalize behavior. After successful normalization, the corrected source
selections and actual slot colours replace that Printer's remembered rack, so a
stale incompatible selection is not retried. Runtime drafts and their
overrides are never written to remembered state.

There is no single selected-filament preference or compatibility projection.
`selectedProfiles` contains only the Printer and Process names. A remembered
rack is a per-printer seed for a new project; the open project's native rack,
session, and slot state are authoritative. No legacy single-filament field,
API, sidecar member, or migration path is part of this release.

## 5. Slot Colour Semantics

Each material slot has an editable colour representing the filament currently
loaded in that slot.

- Selecting a filament preset initializes the slot with that preset's default
  colour when no user colour is retained.
- The user may override the colour independently of the preset so the project
  can represent the actual spool colour.
- The effective slot colour participates in project save/load, the per-printer
  remembered slot state, Prepare-mode object presentation, and the
  Filament/Tool G-code preview palette.
- A preset transition must not silently discard an existing valid user colour.

Colour editing does not edit or create a filament preset. It changes the
project/session slot only.

### Native multi-colour projection

The slot snapshot retains `colour.effective` as the representative colour used
by existing single-colour consumers. It also exposes the exact project-array
entries for `filament_colour`, `filament_multi_colour`, and
`filament_colour_type` as `colour.native.representative`, `multi_colour`, and
`type`. A missing entry is `null`, distinct from an empty string; reading a
snapshot never repairs or rewrites the project config. The typed client maps
`multi_colour` to `multiColour` without changing the stored value.

The separate `colour.display` projection contains ordered HEX colours and a
`solid`, `multicolor`, or `gradient` mode. Native type `0` with two or more
valid colours means a gradient; type `1` with two or more means partitioned
multi-colour. Invalid tokens, unknown or missing types, and fewer than two
colours display as a solid representative. If the representative is invalid,
the display falls back to `#26A69A`. These display fallbacks leave the raw
project entries intact, including values that a future native version might
understand. The typed client requires complete wire fields and validates the
display shape and HEX tokens. The display order remains the native list order;
visual sorting, if wanted, belongs solely to the future swatch component.

Slot transitions keep the three project colour arrays aligned. The Neo bridge
restores existing raw entries after Orca's native slot resizer, which otherwise
replaces each `filament_multi_colour` entry with its representative. Adding a
slot retains every existing colour entry and initializes only the new slot as
solid. Deleting or merging removes the source entry at the same index as the
native slot; a merge retains the destination entry. A compatible Printer
transition retains the complete current colour entry when the preset and
representative still match that slot; a changed source or representative starts
with a solid entry using the selected colour. Preset changes likewise retain a
user's full colour override even when its representative matches the old
preset. History restoration preserves the arrays when only the rack root
changes and the project-config root is unchanged. An explicit solid edit
writes the representative and one-colour list with type `1`. An explicit
gradient edit writes its first endpoint as the representative, its two ordered
endpoints as the list, and type `0`. Both edits are one atomic native history
operation; rejected edits leave the prior three fields intact.

## 6. Architectural Boundary

The authoritative multi-filament state lives in the stateful C++/WASM Worker
session alongside `PresetBundle`, model configuration, plate state, and project
configuration. Application code must use the typed slicer runtime/client and
must not compose filament profile configurations in TypeScript.

The native engine owns candidate compatibility and fallback. The application
does not expose a second filament selector or reproduce compatibility rules in
React. The profile snapshot carries `filament_catalog` only; catalogue entries
have no selected flag. Printer and Process selection may revalidate the rack,
but only the rack/session commands change filament state.

All successful slot mutations invalidate affected slice results. Shared slot
configuration changes affect every plate unless a later specification defines
an explicitly plate-local material model.

## 7. Object and Part Assignment

Filament assignment follows OrcaSlicer's native object-list model. The bridge
stores assignments in native `ModelConfig`; React only projects and edits that
state through typed commands.

### 7.1 Assignment hierarchy

- Every object has an effective filament slot. An absent or zero object value
  is normalized to slot 1 when the object is explicitly assigned.
- A `MODEL_PART` volume normally inherits its parent object's slot and may
  carry an explicit part-level override.
- The UI represents an inherited model-part assignment distinctly from an
  explicit assignment, even when both currently resolve to the same slot.
- Assigning a filament to an object clears explicit `MODEL_PART` filament
  overrides below that object. All of its model parts then inherit the newly
  assigned object slot, matching native OrcaSlicer.
- A `PARAMETER_MODIFIER` may carry its own filament assignment. Assigning its
  parent object does not clear that modifier configuration.

### 7.2 Eligible targets

Direct filament assignment is available for:

- objects;
- instances, as an interaction alias for their owning object;
- `MODEL_PART` volumes; and
- `PARAMETER_MODIFIER` volumes.

`NEGATIVE_VOLUME`, `SUPPORT_BLOCKER`, and `SUPPORT_ENFORCER` volumes do not
produce a direct filament assignment and do not expose the command. Dedicated
support-material and feature-path controls configure related print options
without changing this target rule.

### 7.3 Instance and multi-selection semantics

Filament assignment is not an instance-level model property. Invoking the
command from an instance row assigns its owning object, so every instance of
that object receives the same effective object/part assignment. Neo does not
invent per-instance filament state or duplicate an object implicitly.

Homogeneous multi-selection supports one atomic assignment across eligible
objects or eligible volumes. Instance entries are deduplicated to their owning
objects. Ineligible entries are not silently mutated; command availability and
the eventual typed result must make the accepted target set explicit.

Selecting the inherit value for a `MODEL_PART` removes its explicit `extruder`
configuration and resolves the effective slot from the object. Object targets
cannot select inherit because there is no higher model assignment level.

## 8. Slot Addition, Deletion, and Remapping

Slot-count mutations follow OrcaSlicer's device capabilities and native data
updates. They execute as one Worker-side project transaction; React never
renumbers assignments or edits flush arrays independently.

### 8.1 Device constraints

- A project always retains at least one filament slot.
- Single-extruder multi-material and supported material-switcher/AMS printer
  configurations may add and remove slots up to OrcaSlicer's native maximum of
  64. Electron and Web use the same limit; Neo does not derive a lower Web
  limit from browser or device-memory estimates.
- A fixed multi-extruder printer retains at least the number of slots required
  by its physical extruders. Neo does not expose a deletion command that would
  violate that requirement.
- Command availability comes from the authoritative session snapshot. React
  does not infer a printer category from profile names or vendors.

### 8.2 Adding a slot

Adding a slot matches native OrcaSlicer:

1. copy the final existing slot's filament preset into the new slot;
2. assign the next colour from the native filament colour sequence;
3. extend filament colour, multi-colour, colour-type, extruder/nozzle/volume
   mapping, and related project arrays through the native preset bundle;
4. calculate the new slot's default flushing volumes; and
5. return the complete updated slot and plate-session projection.

The new slot is immediately editable. Creation does not wait for a separate
preset-selection dialog.

### 8.3 Delete and Merge with

Neo exposes the same two semantic operations as native OrcaSlicer:

- **Delete** removes the slot without choosing a destination. Direct object and
  part assignments to the deleted slot fall back to slot 1. Painting marks and
  custom tool-change events that cannot exist without that slot are removed.
- **Merge with** removes the slot while remapping its assignments, painting
  marks, and eligible tool-change events to a user-selected surviving slot.

Both commands show a pre-operation impact summary when the slot is referenced.
The summary distinguishes assignments that will be remapped from data that
will be removed. Cancelling the confirmation leaves the complete project and
history unchanged.

After either operation, every reference above the deleted slot is decremented
to preserve its logical material. The atomic native mutation covers at least:

- `PresetBundle::filament_presets`, slot colours, filament maps, nozzle maps,
  volume maps, flush multipliers, vectors, and matrices;
- object, `MODEL_PART`, and `PARAMETER_MODIFIER` configurations;
- multi-material painting state, including imported painting;
- global and object-scoped support filament references;
- per-plate filament maps and first/other-layer print sequences; and
- custom per-plate tool-change events.

Imported but unsupported state must not be silently corrupted. If the Worker
cannot prove that all known references can be updated, it rejects the command
atomically and reports the blocking reference rather than performing a partial
delete.

Every add, Delete, or Merge with operation marks the project dirty, invalidates
all plate slice results, and creates one Undo/Redo entry.

## 9. Prepare UI and Visual Feedback

Neo follows OrcaSlicer's two-surface interaction model while adapting its
layout to the shared responsive React sidebar.

### 9.1 Filament slot area

A collapsible **Material (count)** area in the upper device/material sidebar
panel owns material-rack operations. Each slot presents:

- its one-based slot number and effective colour;
- the selected filament preset;
- a searchable compatible-preset picker;
- an action menu containing the applicable Merge with and Delete commands; and
- enough state to identify incompatible fallback, pending work, or a rejected
  mutation without constructing a partial optimistic session.

The rack uses a compact two-column grid. Each slot is a single 24px-high row
with a rectangular colour/number block, a truncated preset name, and a dropdown
chevron. The full preset name is available on hover. Clicking the colour block
opens the native colour picker; the preset dropdown remains searchable. Edit,
Merge with, and Delete are available in the slot's context menu. The rack's
minus and plus buttons sit above the grid at the right; minus removes the last
slot using the existing reference-impact confirmation. Electron and Web render
the same component and command model.

Colour blocks use the native filament-session display projection. Solid slots
show one colour, dual and multi-colour slots show equal hard-edged partitions
in source order, and gradient slots interpolate continuously through their
ordered colours. The rack keeps two columns of 24px-high rows: each colour
fills a 24px square with rounded outer-left corners, no inset border, and a
straight edge against the dark preset name field; the small dark dropdown
remains at the right. Existing row layout and hover behaviour remain unchanged.
The slot number retains the original direct text styling and
representative-colour luminance contrast rule. The colour block
tooltip names the mode and complete colour sequence. The slot editor uses the
[shared color picker](Reusable%20Color%20Picker.md) with solid colors, alpha,
and gradients of 2 to 7 ordered colors. Imported gradients within this limit
retain every color and alpha byte in the editor. Imported partitions and
longer gradients show a preservation notice and open from the first color;
Cancel and unchanged Confirm retain all raw metadata. Explicit edits replace
the native tuple with the selected solid or complete ordered gradient. An
unchanged canonical solid or gradient does not create a mutation. A change to any slot
colour metadata closes an open draft. Model and toolpath rendering continue to
use the representative colour.

Add, Delete, and other commands are enabled from the capability fields in the
Worker-provided filament-session snapshot. The UI does not infer device type
or native slot-count constraints.

The slot **Edit** action opens the shared Filament preset editor defined by
[`Preset Editor Dialog.md`](Preset%20Editor%20Dialog.md). It targets the slot's
source preset (and therefore its shared project draft), without changing the
slot command model. Imported project-embedded filament preset edits remain
active and round-trip unchanged.

### 9.2 Object List assignment surface

The Object List adds a filament column that always displays the effective slot
colour and number for assignable object and volume rows. An inherited
`MODEL_PART` value remains visually distinguishable from an explicit override.

Filament assignment is available through both native-style entry points:

- activating the filament column edits the focused eligible row; and
- **Change Filament** in the object/part context menu applies to the current
  eligible selection, including a homogeneous multi-selection.

Both entry points dispatch the same typed atomic command and produce the same
history entry. The context menu does not maintain a separate selection or
assignment model.
The assignment cell and both assignment menus reuse the same native slot
display swatch. MMU painting filament choices also show that swatch; painting
geometry and its cursor continue to use the slot's representative colour.

### 9.3 Prepare viewport colour

Prepare mode colours every printable model volume by its effective filament
slot immediately after assignment or slot-colour changes. Modifier and wipe-
tower geometry do not use the ordinary printable-volume colour projection.

Selection, disabled, transparent, and out-of-bounds visual treatments remain
overlays on top of the slot colour and are not destroyed by recolouring. A
missing or out-of-range assignment is normalized by the Worker before the
projection is returned; React does not silently select a fallback colour.

Prepare colouring is distinct from G-code Preview colouring:

- Prepare projects the model's configured effective assignment.
- Preview projects the extruder/tool recorded on actual generated toolpath
  segments and uses the completed result's filament palette.

The two views should normally agree, but the UI does not reuse Prepare colours
as fabricated evidence when a slice result lacks a tool or palette entry.

## 10. Flushing, Prime Tower, and Feature Routing

### 10.1 Flushing-volume policy

The Material toolbar exposes **Flushing Volumes** to the left of Add/Delete
when at least two actual materials exist and the native printer is SEMM
(`single_extruder_multi_material`) or a Bambu vendor, matching Orca's
`Sidebar::show_SEMM_buttons`. Neo reuses `capabilities.flexible` for this
native condition. Fixed-material toolchangers/IDEX printers such as U1 hide
the entry. A single-material rack has no
material-pair flushing editor, regardless of physical nozzle count. An orange
entry outline marks a non-default matrix or multiplier.

The shared React dialog edits a From-row / To-column matrix for each native
nozzle plane. Two planes use Left/Right extruder labels; other multi-head
printers use numbered extruders. Diagonal cells remain zero and read-only.
Headers show the material number and shared colour swatch. The table scrolls
inside the dialog with sticky headers, including at the 64-slot limit.
Desktop mouse/keyboard operation is supported; mobile remains deferred.

Project configuration stores the **raw** `flush_volumes_matrix` and one
`flush_multiplier` per nozzle. Displayed cells are rounded raw volume times
multiplier, capped at the core's maximum; explicit cell editing divides by the
current multiplier with Orca's integer rounding. Changing a multiplier does not
rescale the stored raw matrix. Multipliers are in [0, 3]; zero shows zero and
disables cell editing without discarding raw values. The typical [0, 700] mm³
text is guidance, not the allowed upper limit. The core supplies the maximum
and suggested minimums; modified values are orange and values below the
suggested minimum are red, without making that suggestion a hard lower bound.

Opening and **Re-calculate** are read-only Worker calculations. Re-calculate
replaces only the selected plane in the local draft and retains its multiplier.
Cancel/Escape discard the draft. OK validates the captured session revision,
visible dimensions, finite nonnegative volumes, zero diagonals and multipliers
in C++. It expands actual-material rows/columns onto the native preset-sized
planes while retaining padded entries, applies the maximum with the multiplier,
and commits matrix and multipliers in one history operation. Rejection rolls
back all state; stale drafts require closing and reopening. Unchanged OK adds
no history entry and invalidates no plate result. A real edit marks the project
dirty and invalidates all shared-configuration plate results; Undo/Redo restores
matrix and multipliers together.

Preferences provides Orca's **All / Color / None** policy, stored by the host
outside project history and applied before restoring startup selections:

- All (default) calculates after material/preset, colour, support-routing and
  material/Printer draft input changes. A colour edit updates only that slot's
  row and column in each plane; preset changes rebuild the full matrix.
- Color calculates only after explicit colour edits, retaining unrelated
  hand-edited pairs.
- None retains hand-edited pairs after colour/material edits.
- Adding a slot always initializes its new pairs with native calculation while
  retaining existing pairs. Delete/Merge remap surviving rows and columns.
  Printer/topology transitions keep dimensions legal; new planes/pairs receive
  native defaults, and surviving pairs follow the selected calculation policy.

The Worker uses effective Printer/Filament drafts, native support flags,
colour/alpha/multicolour inputs, nozzle datasets and minimum-flush calculation.
React performs display conversion only, never predicts flushing volumes.
Opening a 3MF preserves its native matrix and multipliers. Subsequent changes
follow the preference above; project save persists current native values without
an additional Neo flushing format.

### 10.2 Prime tower controls

Prime tower remains native Process configuration rather than a property
inferred solely from the number of slots. The Settings surface exposes these
basic controls:

- `enable_prime_tower`;
- `prime_tower_width`.

Per-plate X and Y remain project-owned native configuration, but are edited
only by dragging the tower in the Prepare scene. Settings must not expose
separate X or Y fields. All other prime-tower parameters retain their Process-
preset or imported-project values and remain round-trippable without an editing
surface. In particular, an imported `wipe_tower_rotation_angle` is rendered but
is read-only: the tower has no rotate or scale interaction.

#### 10.2.1 Prepare-scene proxy

Prepare renders a special prime-tower scene object when the native effective
configuration enables the tower and OrcaSlicer's eligibility conditions hold.
Ordinary plates require at least two actually used filaments; native forced
cases such as smooth timelapse or wrapping detection remain eligible. An empty
plate has no tower, and native By Object restrictions continue to apply. Neo
does not force a tower merely because the project rack contains multiple slots.

The Worker calculates the proxy independently for every plate from native
OrcaSlicer state. It owns the native estimated width, depth, and height, the
plate-local used-filament order, the effective colours, the saved position and
rotation, and the effective brim margin. React must not duplicate those
calculations. A zero estimated height is represented by the native minimum
visible proxy height of 0.1 mm.

The proxy deliberately remains the estimated pre-slice representation for its
entire lifetime. Completing a slice does not replace it with the generated
tower mesh or brim. The proxy body is split into equal depth-wise bands in the
native used-filament order, using the effective filament colours with Orca-like
dark-colour adjustment and approximately 0.66 opacity. Brim geometry is not
drawn, but its native effective width participates in placement and boundary
calculations.

All eligible plates display their tower in Prepare. Any displayed eligible
tower is pickable and movable, including one on a non-current plate. The tower
is a scene-only special object: it is
not a `ModelObject`, does not appear in Object List, and has no delete, copy,
scale, rotate, or context-menu commands. Selection retains the coloured bands
and shows ordinary selection bounds only. The X/Y-only Move gizmo appears only
after the user explicitly activates Move. Direct body dragging and that gizmo
edit the same per-plate position. A dragged tower remains assigned to its own
plate: crossing another plate never changes the current plate, transfers the
tower, or changes another plate's coordinates. Switching plates,
disabling the tower, or otherwise removing the selected proxy clears its
selection without producing history.

The proxy exists only in Prepare. Preview continues to render the generated
toolpath and never overlays the Prepare proxy.

#### 10.2.2 Position, history, and invalidation

When a new plate or project has no explicit tower coordinates, the Worker uses
OrcaSlicer's native default placement. Direct dragging constrains the rotated
tower footprint plus effective brim margin to its owning plate's printable
area. Z movement is unavailable.

One completed pointer drag produces exactly one project-history entry. Pointer
moves within that gesture do not write intermediate history. Undo and Redo
restore only the affected elements of the single native project
`wipe_tower_x`/`wipe_tower_y` arrays (resolved by stable plate identity at the
current display index) through the narrow project delta; plate settings and
per-plate overlay buckets are not coordinate storage. They must not copy or
restore a complete `PresetBundle` or retain any slice product. Moving a tower invalidates that plate's slice result, and the
same target-plate result remains invalid after Undo and Redo. A completed
result for an unaffected plate remains available through the move and its
Undo/Redo navigation.

Loading a project or changing Printer may make saved coordinates invalid for
the new printable area. When a legal placement exists, Neo silently clamps the
effective and persisted in-memory coordinates to the nearest legal placement.
That normalization creates no history entry and does not by itself mark the
project dirty. Rendering and slicing must consume the same normalized
coordinates; a later explicit project save persists them.

An explicit setting, assignment, painting, or filament mutation may change the
estimated width, depth, rotation, or brim footprint without directly editing X
or Y. If the new footprint can fit but the old position is no longer legal, the
necessary position clamp is part of that same project transaction and history
entry. It must not create a second automatic-move entry. Undo and Redo restore
the triggering state and the corresponding tower coordinates atomically.

If the rotated tower footprint plus brim is too large to fit anywhere, Neo does
not shrink the tower, disable it, or invent a different process configuration.
It keeps the native dimensions at the best available position and reports a
non-blocking outside-boundary warning. Slicing may continue.

Changing `enable_prime_tower` updates the proxy immediately. Disabling removes
it and clears tower selection; enabling recreates it when the plate is eligible.
An explicit enable/disable setting edit remains an ordinary project-history
operation with its existing invalidation scope.

#### 10.2.3 Collision policy

Manual tower movement does not snap around or avoid models. Model, exclusion-
area, and wrapping-detection-area intersections are evaluated during slice
validation, not continuously during dragging. The tower retains its filament
colours while moving.

Neo intentionally differs from OrcaSlicer for exclusion and wrapping-detection
areas: every tower intersection is reported as a warning and none of these
intersection warnings alone blocks slicing. OrcaSlicer treats ordinary model
proximity as a warning but returns hard validation errors for the two dangerous
area types. This divergence is accepted product behaviour and must be tested
explicitly rather than inherited accidentally from an unmodified native error.

Neo currently has no Arrange feature. This specification therefore defines no
Arrange interaction and implementation must not add dormant Arrange-specific
prime-tower code. Arrange tower participation follows the arrangement specification and requires
a separate product decision.

The proxy is part of the existing desktop-layout product scope. Mouse and
precision-pointer dragging are supported in Electron and desktop Web. Mobile
touch interaction is deferred and is not claimed by this extension; a narrow
viewport may still render the proxy read-only under the existing fluid desktop
layout. Native estimation adds Worker CPU work proportional to plate count and
used-filament bands, while the renderer adds only the projected box-band meshes;
neither path may trigger slicing merely to display the proxy.

The session continues to apply native normalization and validation for actual
used-filament count, print sequence, G-code flavour, and layer constraints. The
UI presents the effective proxy state and returned warnings without
reconstructing them from slot count or renderer geometry.

### 10.3 Support and raft filament

The Support settings expose OrcaSlicer's two independent simple controls:

- **Support/raft base** maps `support_filament`; and
- **Support/raft interface** maps `support_interface_filament`.

Each control offers `Default` plus every current filament slot. Native value
zero (`Default`) means that no filament is forced and the currently active
object/part filament is used; it does not mean slot 1. An explicit value is a
one-based slot reference.

The two settings may exist at Process and object override scope wherever the
existing settings architecture permits the corresponding native option.
Delete and Merge with update them in the same atomic slot-remapping
transaction. A deleted explicit value with no merge destination falls back to
`Default`, not slot 1.

### 10.4 Feature-path filament routing

The first release exposes all six native advanced filament-routing options in
a collapsed **Advanced filament routing** group for eligible object and
`MODEL_PART` settings:

- outer walls and inner walls;
- sparse infill and internal solid infill; and
- top surface and bottom surface.

Each selector offers `Default` plus every current slot. Here `Default` means
inherit the active object/part filament. It remains distinct from the support
controls' "use the currently active filament" behaviour.

These options participate in project persistence, one-step Undo/Redo, slice
invalidation, and atomic slot Delete/Merge remapping. A deleted explicit value
with no merge destination becomes `Default`; a Merge with operation replaces
it with the selected surviving slot before later slot IDs are renumbered.

### 10.5 Painting and layer-event editing

Object/part assignment and facet-level multi-material painting are delivered.
[Surface Painting Architecture](Surface%20Painting%20Architecture.md) defines
the native painting adapter, tools, history and save/reopen guarantees.
Interactive per-layer colour/tool-change editing remains deferred. Imported
facet painting and layer/tool-change events remain project state: rack removal
and remapping must update their native references without discarding them.
The read-only preview does not introduce an event editor.

### 10.6 Slice lifecycle and native validation

Multi-filament edits use the existing slice lifecycle defined by
[`Workspace Prepare and Preview Modes.md`](Workspace%20Prepare%20and%20Preview%20Modes.md)
and [`Multi-Plate Support.md`](Multi-Plate%20Support.md). They do not introduce
eager auto-slicing or a separate progress, cancellation, Preview-overlay, or
error-presentation system.

- Slot preset, colour, Add, Delete, and Merge with operations invalidate every
  plate because they change the shared full configuration or flushing matrix.
- Process-scoped support, feature-path, and prime-tower settings invalidate
  every plate.
- Object- or volume-scoped assignment, support, and feature-path changes
  invalidate only plates that contained an affected instance immediately
  before or after the edit.
- A prime-tower X or Y change invalidates only the plate whose position entry
  changed.
- An invalidating edit cancels an in-flight slice only when that job's plate is
  affected. A new slice begins only through the existing Slice command or by
  entering Preview for a plate without a valid result.

The existing compatible-preset projection remains the only candidate list for
ordinary slot selection. React does not add a second printer-compatibility
filter or attempt to reproduce cross-filament validation.

Before processing a slice, the bridge applies the authoritative configuration
and calls native `Print::validate()`. For a single-nozzle task that actually
uses multiple filaments, the first release retains the core's default mixed-
temperature restriction:

- invalid recommended temperature ranges and incompatible mixed-temperature
  combinations block slicing;
- Neo does not expose OrcaSlicer's global option for removing that restriction
  in the first release; and
- only filament slots actually used by the current plate, or by each object in
  by-object printing, participate in the check. Unreferenced rack slots do not
  block slicing.

The native validation message is surfaced through the existing slice error
status. Neo does not parse that text to make a second decision, show a modal,
or convert the error into a bypassable warning. Slot fallback caused by project
load or a Printer/Process transition continues to use the rack and project-load
reporting rules defined elsewhere in this specification.

### 10.7 Host parity and resource failure

Electron and Web expose the same multi-filament commands, slot limit, project
semantics, and native validation. The additional slot vectors and flushing
matrix are not used as a proxy for total slicing memory pressure; Neo does not
silently lower the slot count, discard references, or substitute presets in
response to a resource failure.

A recoverable allocation or command failure follows the atomic mutation rules
in this specification: the pre-command filament session, model, plate state,
history cursor, and result validity remain unchanged, and the command may be
retried after the user changes the workload.

A fatal WASM Worker OOM or trap follows the shared runtime's fatal-error flow.
Multi-filament does not add a second Worker-recovery protocol, autosave, or
reconstruction of unsaved project state. This preserves the crash-recovery
boundary in [`3MF Project Persistence.md`](3MF%20Project%20Persistence.md).

## 11. Project Persistence and History

### 11.1 3MF project authority

An opened multi-filament 3MF restores its complete ordered slot state through
the existing upstream BBS project reader and preset-loading path. Embedded
filament presets are project-session resources:

- modified filament or printer G-code and missing corresponding system presets
  use the existing project safety warning and confirmation flow;
- confirmation permits the embedded presets only for the lifetime of the
  opened project and never installs them in the global system library;
- compatible embedded presets retain their exact project configuration;
- a slot that cannot be used after native compatibility evaluation receives
  OrcaSlicer's compatible fallback, and the load result reports every changed
  slot before the project is accepted by the UI; and
- rejecting the warning or failing restoration leaves the previous project,
  history, and remembered rack unchanged.

After preset restoration, project import follows OrcaSlicer's post-load
normalization: `filament_map`, `filament_nozzle_map`, and `filament_volume_map`
are resized to the project colour count. Existing entries are retained, excess
trailing entries are removed, and missing entries use the native defaults
(`1`, `0`, and Standard respectively). This runs before publishing the project;
geometry-only import does not apply it to the current project's mappings.

Project save writes every effective slot preset, colour, native map, flushing
configuration, and model/plate assignment needed for native OrcaSlicer and Neo
to reproduce the project. Derived G-code and preview buffers remain outside
normal project persistence.

The project archive contains only the ordered slot state, native mappings,
flushing configuration, and other values emitted by the standard BBS/Orca
project writer. Rack/session state used by history is an in-memory history
root and is never serialized as a Neo-private 3MF member. No load path
performs a legacy single-filament migration.

### 11.2 History coverage

Every exposed project-level filament mutation creates exactly one semantic
Undo/Redo entry:

- object, instance-as-object, part, and parameter-modifier assignment;
- support/raft base, support/raft interface, and advanced feature-path
  filament selection;
- prime-tower enable, position, and width changes;
- changing a slot's filament preset or effective colour;
- adding a slot;
- deleting a slot; and
- merging a slot into another slot.

The history frame must restore the complete native filament session, not only
its React projection. It includes the ordered preset names, colours, colour
metadata, filament/extruder/nozzle/volume maps, flush arrays and matrices, and
all affected model, painting, custom-G-code, support, and plate references.
Restoration is atomic with the model and plate-session history state. A failure
leaves the current history cursor and live project unchanged.

Filament session state is not represented solely as generic project-overlay
strings: restoring it re-establishes the mutable filament state in the live
`PresetBundle` and validates the full configuration before the restored project
can be sliced. History never copies the complete preset catalogue/bundle.
`fullPresetBundleCopyCount` is a guard: the only permitted full copy is the
staged candidate used by project import so embedded-preset loading remains
transactional.

### 11.3 Per-printer remembered rack

The selected printer has a versioned remembered-rack preference used only to
seed a new project or a session without explicit project slot state. The live
project remains authoritative while it is open.

The remembered rack mirrors the current filament session's effective colours
and unmodified native colour metadata:

- a successful explicit slot preset, colour, Add, Delete, or Merge with
  operation writes the resulting projection;
- Undo, Redo, and history jump write the restored projection after the native
  restoration succeeds; and
- failed, cancelled, or aborted mutations do not write preferences.

This synchronization is a deliberate narrow exception to Neo's normal rule
that Undo/Redo never rewrites global preferences. History still does not store
or restore a global-preference snapshot. It restores project state first and
then publishes that current state as the selected printer's last-used rack.
No unrelated UI, host, printer, process, or global preference is changed.

Preference persistence failure is non-fatal. The restored project state remains
active, the failure is reported through the existing preference-error channel,
and a later new project may fall back to the last successfully stored rack.

No preference migration is attempted. Unrecognized legacy filament-selection
fields are not read, projected, or written.

## 12. Acceptance and Verification

### 12.1 Fixture policy

The first-release compatibility suite uses deterministic synthetic fixtures
only. It does not download or pin external real-world OrcaSlicer projects and
therefore does not claim external-corpus compatibility evidence. Compatibility
means that the project follows the native state and 3MF behaviour of the pinned
`libslic3r` core.

Synthetic fixtures must not rely solely on exporting and reopening with the
same path under test. At least one independently assembled multi-filament 3MF
fixture exercises the reader, and bridge-generated projects exercise the
writer and round-trip path.

### 12.2 Required behavioural fixtures

The deterministic fixture set covers at least:

- ordinary one-slot printing as a regression baseline;
- single-nozzle two-material printing, including object and part assignment,
  manual/native tool changes, flushing recalculation, and prime tower;
- fixed multi-nozzle printing, including minimum slot count and native mapping;
- support base/interface and all six feature-path filament selectors;
- inherited part values, explicit overrides, parameter modifiers, and
  instance-as-object assignment;
- Add through 64 slots, rejection of slot 65, complete 64-slot matrix and 3MF
  persistence, and Delete/Merge remapping at the first, middle, and last slot;
- imported painting and per-layer colour/tool-change preservation and remap;
- imported solid, partitioned multi-colour, and ordered gradient metadata
  retained through snapshots, slot transitions, remembered racks, Printer
  transitions, 3MF export/reopen, and Undo/Redo; explicit editing validates
  opaque endpoints, converts partitions or extra stops only on confirmation,
  and rolls back all three native colour fields on rejection;
- shared rack and assignment swatches render partitions and gradients while
  model/toolpath colours retain the representative; focused Electron and both
  real Web runtime variants verify browser storage, reload, and first/last
  endpoint editing;
- imported custom flushing-matrix and multiplier preservation, followed by
  policy-dependent automatic updates; read-only recalculation, raw/display
  rounding, zero multiplier, per-nozzle independence, stale rejection, no-op OK,
  failure rollback, Undo/Redo, 3MF round trip and H2D single-material projection;
- Prepare-only estimated prime-tower proxies for every eligible plate,
  including native dimensions, band order and colours, read-only imported
   rotation, one-gesture history, non-current-plate selection and movement
   without changing plate ownership, explicitly activated Move gizmos, and
  plate-local slice invalidation;
- direct-drag boundary clamping with brim margin, silent non-history
  normalization after project load or Printer change, and the too-large-to-fit
  non-blocking warning case;
- footprint-changing settings, assignment, painting, and filament edits that
  atomically include any required position clamp in their existing single
  history transaction;
- non-blocking slice-time warnings for prime-tower intersections with models,
  exclusion areas, and wrapping-detection areas, including explicit evidence
  that the latter two do not leak OrcaSlicer's native hard-error behaviour;
- project save/open, embedded preset retention, compatible fallback reporting,
  remembered-rack priority, and Undo/Redo of every exposed mutation;
- mixed-temperature rejection for used slots and non-rejection for otherwise
  incompatible but unreferenced rack slots;
- command rejection with an unsupported reference or injected failure,
  proving no partial project, history, preference, or result mutation; and
- multi-plate invalidation scope, in-flight revision rejection, cancellation,
  and retained unaffected results.

The 64-slot state boundary is tested separately from representative slicing.
Release acceptance does not require a plate that actively prints all 64
materials.

### 12.3 G-code and Preview assertions

Tests do not compare complete G-code byte-for-byte. They parse generated output
and assert stable multi-filament semantics, including applicable tool or
filament-change order, per-feature slot use, temperature commands, flushing and
prime-tower structure, and the Preview result's tool IDs and filament palette.
This avoids coupling acceptance to unrelated comments, timestamps, or pinned-
core formatting changes while still proving that assignments affect output.

### 12.4 Layered release gates

During implementation, each piece runs the smallest deterministic bridge,
client/runtime, store, component, or native fixture checks that cover its
changed boundary. Before an independently testable piece is committed, its
affected package tests and typecheck plus applicable WASM quick build, smoke,
or boundary guard must pass.

Final milestone acceptance follows
[`testing_guidelines.md`](../doc/testing_guidelines.md) Level 4 and includes:

- root `pnpm test` and `pnpm typecheck`;
- threaded and serial WASM quick builds and smoke suites;
- the complete synthetic multi-filament bridge/3MF/G-code fixture suite;
- Electron E2E; and
- real Web E2E with both threaded and serial wasm64 runtimes.

The final acceptance record names the exact commands and results, including
every unavailable, intentionally skipped, or failing gate. Roadmap documents
may mark the milestone delivered only after this complete matrix passes.

The prebuilt real-WASM multi-filament acceptance runner
(`packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs`)
must complete its full dual-variant run within 120 seconds. Developer runs may
select `--threaded-only`; release acceptance runs both serial and threaded
variants. This runner budget does not replace the other release gates above.

## 13. Rack normalization and interaction

Bambu dual-nozzle printers can delete or merge down to one material while
retaining two physical nozzles. `filament_colour.size()` defines actual rack
slots, command bounds and remembered identities. Native preset-name padding
and variant arrays are not extra material slots. Flushing planes retain their
native dimensions and project only actual-material rows/columns to the UI.

Switching to a shorter remembered rack normalizes removed-slot references in
the same transaction: objects fall back to slot 1, stale model-part assignments
inherit, Project feature/support routes use Default and scoped routes regain
inheritance. Native normalization limits imported paint; removed-slot tool
events are discarded. Undo/Redo restores all affected model-level layer events,
assignments, routing, painting and plate settings with the rack.

The Material panel uses compact two-column single-line slots with rectangular
colour/number blocks and searchable preset selectors. Add/Delete/Merge retain
the reference-impact confirmation and atomicity rules. Context menus provide
Edit, Merge and Delete; the minus button removes the last slot through the same
command. Model-part row pickers show numbered effective slots; parameter
modifier rows expose Default/inherit. Their category materials and printability
rules follow [Object List and Object Parts](ObjectList-and-Parts.md).

Prime Tower move-then-slice consumes current native coordinates, never cached
`wipe_tower_x`/`wipe_tower_y` settings. Placement clamping is rectangular;
polygon-aware automatic placement is not delivered. Regressions compare actual
extruding G-code XY endpoints, including brim margin, rather than only exported
configuration. Prepare dimensions remain estimates; Preview renders toolpaths.

## 14. Nozzle filament mapping design

**Status:** Implementation in progress, 2026-10-25. Section 14.1
records accepted product decisions; section 14.3 describes the implementation
direction and section 14.4 preserves existing integration contracts.
Section 14.6 defines independently verifiable implementation steps. Steps 1–6's
native projection, atomic edit commands, typed runtime boundary, Plate-aware
slicing, 3MF persistence, remembered capacities, Sidebar editors and mandatory
manual-slice confirmation are delivered. Step 7's integrated qualification
remains required before this extension is complete.
Existing delivered behavior elsewhere in this specification remains
authoritative until the extension is implemented and verified.

### 14.1 Accepted scope and entry points

- Provide manual project-filament-to-nozzle mapping for printers that combine
  SEMM (`single_extruder_multi_material`) with multiple physical extruders,
  including Bambu H2D. Model the capability generically, without Bambu checks
  in the shared mapping UI. Preserve the current preset/editor restrictions
  that presently limit creation of this combination to Bambu printers.
  When this capability is absent, hide the Filament Mapping tab, slicing-mode
  menu items and new slot-capacity input. Keep existing Settings and Multi.
  functionality available under their current rules.
- Configure the total available filament-slot capacity of each nozzle directly.
  Do not expose or store a user-edited decomposition into feeder types, feeder
  counts or slots per feeder. Capacity is project-global and shared by all
  Plates. Edit capacity in the upper Sidebar's existing Multi. tab, reusing
  its nozzle selector to identify the nozzle whose capacity is being edited.
  Mode and mapping are edited per Plate.
- Use the existing Sidebar Plates scope as the mapping editor's entry point.
  Convert its lower Properties editor into two tabs, in this order: Settings
  and Filament Mapping. Settings contains the existing Plate settings editor;
  Filament Mapping edits the selected Plate's mode and material mapping.
- Do not provide a global mapping editor, a mapping tab in the Filament
  section, or mapping editing in the Printer Device/Multi. section. The Plate
  Properties tabs replace the proposed Plate-list mapping button and floating
  editor. A separate, editable confirmation dialog is shown before manual
  slicing as specified in section 14.1.5, not opened from a Plate-list button.
- Add slicing-mode selection to the slice-button dropdown, using Orca's
  behavior as a reference. Do not add a mapping-editor entry to that dropdown;
  mapping is edited in Plates > Filament Mapping.
- Exclude send/print-time assignment to the printer's actual AMS slots.
  Live device synchronization and account/provider integration are not required
  for this manual configuration feature.

#### 14.1.1 Plate ownership, mode selection and editing

Each Plate has its own editable slicing mode and mapping. The slice-button
dropdown selects the current Plate's mode; the Filament Mapping tab selects
the same Plate's mode. Both surfaces consume and mutate the same native state.
There is no global mapping-mode selector or Follow global interaction.
Underlying project mapping fields and native fallback rules remain a project
import/composition concern, not an independently editable UI scope. Their
mode normalization follows section 14.1.4 and persistence follows section 14.4.

Users explicitly select the mode before editing a manual mapping. Only manual
mode displays the mapping-editing interface; automatic modes hide that
interface rather than display disabled mapping controls. Editing must not
implicitly switch an automatic mode to Manual.

Both `fmmManual` and imported `fmmNozzleManual` use the same manual editing
interface. Viewing the latter does not mutate its saved mode or mappings.
The first mapping edit converts it to `fmmManual` in the same atomic operation
as the edit; there is no separate read-only or physical-sub-nozzle editor.

The manual editor lists only filaments used by the selected Plate, using
native usage discovery including painted assignments and support-related
uses. Each filament occupies one row with its own target-nozzle dropdown.
Do not require a separate selected-nozzle context for mapping, and do not
present unused project filaments as editable rows. The upper Multi. tab's
nozzle selection remains the context for capacity editing, not for these
per-filament assignments. Mapping controls do not edit nozzle diameter, flow
settings or global capacity.

Completed Sidebar edits take effect immediately through atomic native commands,
with Undo available. The Sidebar has no Apply/Cancel controls or retained
multi-edit drafts. Temporary text/number input before a completed edit does
not become a second project state owner. Switching tabs does not discard
already committed edits. The pre-slice confirmation dialog is the explicit
exception in section 14.1.5. Mode transitions follow section 14.1.3.

Selecting a Plate through the existing Plates UI changes the Properties
target. An in-flight edit remains bound to the Plate identity and revision
captured when it was dispatched; it must never be redirected to the newly
selected Plate. Retain the active Properties tab when selecting another Plate
while that tab remains available; use Settings when mapping is hidden. With
no valid target, use the existing empty Properties state and reject stale
commands. These are local UI states, not Plate settings persisted in 3MF.

The accepted current-Plate dropdown behavior does not introduce a slice-all
action or a bulk overwrite of independently configured Plates.

#### 14.1.2 Hardware coverage and slot capacity

Manual mapping supports the physical-extruder counts allowed by the native
printer configuration, without a fixed two-head assumption in the shared
model or UI. Automatic filament-saving mode is offered only where the existing
native implementation supports the topology. Availability is projected as a
capability; React must not reproduce native vendor checks. Generalizing the
automatic grouping algorithm to additional vendors or head counts is outside
this extension.

For an eligible printer, if import or a printer transition leaves a Plate in
Auto For Flush but the native algorithm is unavailable, retain the mode and
show why it is unavailable. Require the user to select Manual before slicing;
do not silently convert it or invoke an unsupported algorithm. Outside the
SEMM-plus-multiple-extruders feature scope, existing native normalization and
slicing behavior remain authoritative; hidden mapping controls must not create
a new blocker for ordinary single-extruder or fixed multi-extruder printing.

The new editor assigns project filaments to physical extruders and cooperates
with existing flow-type configuration. It does not add a physical sub-nozzle
inventory editor or expose fully manual assignment to individual sub-nozzles.
Imported Nozzle Manual configurations use the manual interface and transition
rule in section 14.1.1; this does not add physical-sub-nozzle editing capability.

For each nozzle, users edit one total slot-capacity value. All Plates consume
the same project-global capacity vector, including Plates with their own
mapping or mode. There is no Plate-local capacity override and no AMS-specific
equipment model in the UI. Conversion to Orca's native configuration format
belongs below the shared UI and must not invent actual device identities.

Total slot capacity is a positive integer with a minimum of one. A single
external spool counts as one available slot; zero is not a nozzle-disable
control. Initial defaults and remembered settings follow section 14.1.4.
Do not impose a fixed product or feeder-count upper limit; accept positive
integers within the native representation's safe range. Assigning more
Plate-used filaments to a nozzle than its capacity shows
a warning but does not block slicing. Capacity is not a new hard slicing limit
or a guarantee of physical print feasibility.

#### 14.1.3 Mode transitions and topology repair

Automatic mode retains the Plate's manual mapping inputs but ignores them for
automatic assignment. Its computed mapping remains derived slice-result state
and must not overwrite the editable Plate or project mapping. Switching back
to manual mode uses the retained manual inputs; there is no separately saved
last-manual backup. If no prior manual mapping exists, initialize it through
the native default-mapping rules, never from a previous automatic slice result.
Imported mode initialization follows section 14.1.4; mapping compatibility and
normalization follow section 14.4.

When a topology change removes a target nozzle, preserve assignments that
remain valid and repair only invalid targets to nozzle 1, including the linked
flow selection. Notify the user of the repair. The repair belongs to the same
atomic operation and Undo entry as the topology change, rather than a later
React-side adjustment. Existing single-extruder normalization remains part of
the native topology transition when the printer leaves this feature's scope.

New project filaments default to nozzle 1 with its corresponding native flow
selection; existing filament mappings remain unchanged. Deletion continues
the existing atomic reference-remapping contract in section 8.3 and removes
the deleted filament's map entries while preserving surviving assignments.
Merging adopts the destination filament's existing mapping independently on
each Plate. If source and destination use different nozzles, include that
change in the existing merge-impact confirmation; do not require the user to
align mappings before merging. These changes share the material operation's
Undo entry and native normalization.

#### 14.1.4 Initialization and remembered capacities

Remember total slot capacities by printer preset for new-project initialization,
not by connected physical device. A value saved in an existing project takes
precedence over the remembered value. When neither is available, each nozzle
starts with one slot; do not introduce preset-authored capacity defaults.
Remembered values seed project inputs rather than acting as live overrides.

An explicit printer-preset switch also restores the target preset's remembered
capacities, falling back to one per nozzle when no remembered value exists.
Capacity restoration belongs to the same atomic operation and Undo entry as
the preset switch. This rule does not override capacities saved in a project
when opening it.

A newly created Plate defaults to Auto For Flush when the existing native
capability supports it. Otherwise it starts in Manual with the native default
mapping. This new-Plate policy is distinct from importing saved Plate modes.

On ordinary project import, a missing Plate mode or an explicit Default mode
is normalized to `fmmAutoForFlush`. Preserve other saved modes and existing
mapping fields. Do not resolve the project mode and expand project fallback
maps into explicit Plate values as an import normalization step. An unavailable
Auto For Flush mode follows section 14.1.2; Auto For Match follows the rule below.

Preserve an imported `fmmAutoForMatch` mode and its mapping data. Device-material
synchronization is outside this feature, so present the mode as unavailable
and require an explicit user choice of Manual or supported Auto For Flush
before slicing. Do not silently replace it with Auto For Flush.

#### 14.1.5 Confirmation before manual slicing

Every slice request in Manual or Nozzle Manual opens an editable mapping
confirmation dialog for the target Plate. Reuse the manual mapping component
from the Properties tab, with the same Plate-used material rows and choices.
Automatic modes do not acquire this manual confirmation step.

Unlike Sidebar edits, dialog edits remain temporary until the user chooses
Confirm and Slice. Confirm commits the edits atomically with Undo support,
then starts slicing with the committed configuration. Cancel discards dialog
edits and does not start slicing. For imported Nozzle Manual, an actual mapping
edit converts the mode to Manual only when committed; viewing or canceling
must not trigger that conversion.

The dialog retains its captured Plate identity and revision. Validation and
commit must succeed before slicing starts; a changed or deleted target must
not cause edits or slicing to be redirected to another Plate. The draft is
temporary UI interaction state, not a second authoritative project owner.
Capacity excess remains a warning and does not prevent confirmation or slicing.

### 14.2 Existing native behavior and limits

The reference is the Orca submodule at
`c936ee9a5ce2979b96a80b47783ab4c29d369227`, not an assertion about every public
Orca release. Recheck the relevant implementation when implementing the design
or changing the pin.

- [PrintConfig](../packages/slicer-wasm/cpp/src/libslic3r/PrintConfig.hpp)
  distinguishes `Manual` (filament to extruder, with volume selection) from
  `Nozzle Manual` (assignment to a physical sub-nozzle). H2D's ordinary
  one-nozzle-per-extruder mapping does not require implementing the complete
  sub-nozzle inventory editor.
- [FilamentGroupPopup](../packages/slicer-wasm/cpp/src/slic3r/GUI/FilamentGroupPopup.cpp)
  exposes Filament-Saving, Convenience and Custom modes. Convenience uses
  actual printer material information. The popup edits the current Plate's
  mode, or sets each Plate's mode for its slice-all path. When opened without
  a connected printer, it replaces Auto For Match with Auto For Flush; Neo's
  accepted import behavior instead retains the mode pending user selection.
- [PartPlate](../packages/slicer-wasm/cpp/src/slic3r/GUI/PartPlate.cpp)
  contains separate native fallback rules: Default mode uses the project mode,
  and an absent/empty Plate map uses the project map. New Plates initialize
  their mode to Auto For Flush. These fields and fallbacks do not establish
  a user-facing global mapping editor or active inheritance control.
- [Plater](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp)
  reads the current Plate's effective maps into its mapping dialog, writes
  confirmed manual choices back to that Plate and composes Plate mappings
  into the actual slice configuration. This is an editable native behavior,
  not merely an unused serialization field. Both current
  [mapping-dialog](../packages/slicer-wasm/cpp/src/slic3r/GUI/FilamentMapDialog.cpp)
  call sites disable the Same as Global control. The pre-slice dialog fixes
  `sync_plate` to true, and FilamentGroupPopup sets `m_sync_plate` to true when
  opened. Their global setter branches are therefore not evidence of an
  enabled global editing workflow. The mapping dialog displays both Manual
  and Nozzle Manual on its Custom page, then returns Manual on confirmation.
  Neo adapts that confirmation boundary to the first committed mapping edit,
  immediate in the Sidebar or deferred until pre-slice confirmation.
- [BackgroundSlicingProcess](../packages/slicer-wasm/cpp/src/slic3r/GUI/BackgroundSlicingProcess.cpp)
  copies the assembled full configuration and overlays the current Plate's
  configuration before applying it to Print. Automatic grouping results are
  explicitly written back to that Plate by the Orca GUI. This composition does
  not overwrite the saved project configuration merely to run a slice.
  Neo's [slicing pipeline](../packages/slicer-wasm/src/bridge_slicing_pipeline.cpp)
  instead applies a composed configuration to Print and materializes derived
  results without copying computed maps back into Plate inputs. Section 14.1.3
  preserves that separation; the Orca GUI writeback is not adopted.
- [PresetBundle](../packages/slicer-wasm/cpp/src/libslic3r/PresetBundle.cpp)
  and the [3MF reader/writer](../packages/slicer-wasm/cpp/src/libslic3r/Format/bbs_3mf.cpp)
  retain project-global mapping in `Metadata/project_settings.config` and
  Plate-local mapping in Plate metadata. Ordinary project loading restores
  global mapping options. Published-project loading has a separate restricted
  import policy; it must not be assumed to restore the same author settings.
- Orca stores feeder counts in `PresetBundle::extruder_ams_counts` and injects
  them into its ordinary full configuration. Neo's
  [effective configuration assembler](../packages/slicer-wasm/src/bridge_preset_drafts.cpp)
  calls the static constructor without that independent member. A new editor
  must establish an explicit path from its authoritative capacity state to
  slicing, persistence and history.
- [ToolOrdering](../packages/slicer-wasm/cpp/src/libslic3r/GCode/ToolOrdering.cpp)
  includes a non-Bambu fixed-mapping branch in automatic grouping.
  [FilamentGroupUtils](../packages/slicer-wasm/cpp/src/libslic3r/FilamentGroupUtils.cpp)
  and the grouping implementation also contain two-extruder assumptions.
  Removing a UI brand check alone does not establish generic automatic
  grouping for arbitrary extruder counts.
- Orca sums slots-per-unit times unit-count into each extruder's capacity,
  with an external-single-filament fallback when that sum is zero. Automatic
  grouping uses that capacity, but some paths prefer capacity-respecting
  solutions and others relax the limit when total capacity is insufficient.
  Ordinary single-nozzle-per-extruder Manual mode constructs the result from
  the user's map directly. Capacity is therefore not universally a hard limit
  on successful slicing, nor an assignment to actual feeder slots.

### 14.3 Proposed implementation direction

The existing native mapping fields, grouping entry point and Plate settings
make this extension feasible without introducing a second slicing engine or
printer-provider dependency. The missing work is the shared editing contract,
capacity state ownership and end-to-end configuration composition. Generic
automatic grouping remains outside scope; manual higher-head-count behavior
must still be proven by the fixtures in section 14.5.

Keep authoritative inputs in the C++/WASM session. The shared component consumes
typed native projections and dispatches commands through the runtime/client
boundary. Use the effective printer configuration for eligibility and target
enumeration. Do not conflate the existing flexible-rack capability with SEMM
plus multiple physical extruders, and do not hard-code a left/right pair in
the public model.

The recommended editor contract identifies a stable Plate target, its effective
values, available choices and native diagnostics. The shared React editor
belongs in the existing Plate Properties area and uses the current selection
without coupling mapping to object selection. Render the accepted material-row
layout with one target-nozzle dropdown per used filament. Reuse the existing
upper Multi. nozzle selector for global capacity editing. Immediate commands
retain their captured target, and React must not
become a second authoritative project configuration.
The pre-slice dialog reuses this component with temporary editing and one
atomic confirmation command, rather than dispatching its edits immediately.

The native projection needs feature eligibility, physical nozzle identities,
available modes and their reasons, the target Plate's saved/effective mode and
maps, native-used filament IDs, project-global capacities, diagnostics and the
revision required for mutation. Keep eligibility for SEMM plus multiple
extruders separate from eligibility for automatic grouping. Application code
uses typed runtime/client operations for Plate mode, Plate mapping and global
capacity changes. A dialog confirmation sends one completed change set for
native validation and commit, followed by slicing the committed revision.

Use project-owned native capacity state with preference seeding from section
14.1.4, including it in the existing history root. The proposed representation
uses the standard `extruder_ams_count` field as its only mutable project owner.
Decode imported feeder entries to total slots; expose only those totals to the
UI. A canonical entry such as `1#N` represents capacity N to the native sum,
not N discovered physical devices. Empty/zero supply has the one-slot external
fallback. This preserves the standard format without a Neo-private 3MF member
or a second editable feeder inventory.

Extend ordinary project restoration and secure save composition to carry that
field, without widening the published-project allowlist. Inject the same
project value into Neo's static full-config assembly; do not rely on the
desktop GUI's separate PresetBundle member. Validate numeric conversion and
arithmetic before publication. Round-trip tests must demonstrate equal effective
capacities in Neo and native Orca rather than preservation of feeder decomposition.

Plate map/mode inputs remain in Plate settings and standard Plate metadata.
Resolve a Plate's effective mapping before material/flow expansion and apply
its mode and maps to the temporary slicing config consistently. A missing local
map may still resolve through the preserved native project fields; the first
edit writes a complete valid Plate mapping, preserving entries not shown by
the used-filament filter. Do not copy auto-generated Print mappings back into
either input owner or serialize them in place of retained manual intent.

Mapping mutations must follow the existing transaction, revision, history and
result-invalidation contracts. Resolve the effective target mapping before
dependent extruder/variant configuration expansion. Slot addition, deletion,
merge, printer changes and flow changes need a consistent mapping transition
policy. Apply section 14.1.3 through native transitions, reusing existing
diameter/flow compatibility and normalization rather than adding renderer-side
replacement rules. Update native producers, the typed client/runtime contract,
consumer projections and fixtures together. Implement and verify state/history
and configuration composition before wiring the shared editor and pre-slice
dialog; qualify the complete flow with actual native slicing and 3MF round trips.

### 14.4 Existing integration contracts retained

The [shared Prepare/Preview workspace](Workspace%20Prepare%20and%20Preview%20Modes.md)
keeps the sidebar mounted and editable in both modes. The mapping editor follows
that rule. Invalidating the visible result clears its preview without navigating
away; changing a mapping does not add eager auto-slicing. Manual confirmation
applies to an actual slice request, including the existing Preview-entry request
when no valid result exists, not to viewing an already valid result. Cancel
must not be bypassed by an automatic retry of the pending request.

Follow the lifecycle and history contracts in sections 10.6 and 11.2. A real
Plate map/mode edit invalidates that Plate's result; a global capacity edit
invalidates all Plate results. Shared material and printer operations retain
their existing invalidation scope. Invalidating an affected in-flight job
cancels it. A failed or stale command publishes no partial edit or history
entry, and a no-op confirmation can slice without creating a spurious edit.

Ordinary project save/load must round-trip retained mapping inputs, Plate modes
and effective total capacities using the standard native project fields and
Plate metadata. Preserve project fallback fields without a global editor, and
apply the existing post-load length/default normalization from section 11.1.
The mode-specific normalization in section 14.1.4 remains distinct from those
mapping-vector repairs. Derived automatic results never replace editable inputs.

The native BBS archive reader/writer additionally retains Plate nozzle-tip
assignments as optional `filament_nozzle_maps` metadata alongside the existing
`filament_maps` and `filament_volume_maps`. Archives without this field retain
native fallback behavior. Older Orca readers ignore this additive field and
therefore cannot guarantee round-trip retention of Plate nozzle-tip assignments.
This does not add a Neo-private ZIP member. Ordinary project ownership includes
`extruder_ams_count`; published imports keep their existing restricted allowlist.


The [3MF import policy](3MF%20Project%20Persistence.md) remains authoritative:
geometry-only import retains the current project's configuration, and published
imports retain their native restricted option policy. Do not apply ordinary
project restoration indiscriminately to either path or introduce a new import
choice. Existing native printer, diameter and flow validation remains in effect;
warning-only slot capacity does not weaken unrelated slicing errors.

### 14.5 Verification boundary

Implementation acceptance must prove behavior with native inputs and actual
slicing, not only component state. Required risk coverage includes H2D,
single-extruder SEMM, fixed multi-extruder printers and a synthetic non-Bambu
SEMM multi-extruder fixture to detect brand coupling. Include a higher-count
manual fixture and prove unavailable automatic modes cannot be invoked.
Verify that unsupported Auto For Flush modes remain visible with a reason
within the eligible feature scope until explicitly changed, and that printers
outside that scope hide only the new controls without gaining a slicing blocker.
Imported Nozzle Manual fixtures must prove that viewing preserves data and
the first mapping edit converts to Manual atomically, with Undo restoring the
original state. They do not imply a new sub-nozzle editor. Imported Auto For
Match must remain intact until explicit user selection and cannot be sliced
while unavailable.

Cover native project/Plate fallback compatibility and Plate ownership, isolation between Plates,
invalid/stale commands, slot/topology changes, feeder capacity semantics,
Undo/Redo, 3MF round-trip and the resulting native extruder/variant assignments.
Exercise both Properties tabs, synchronization with the slice-mode dropdown,
and captured-target behavior when changing the selected Plate. Prove that
paint/support usage is included in the material rows, unused project materials
are omitted, and row-level nozzle choices are independent of the upper Multi.
selection. Capacity edits must target the selected physical nozzle and retain
their project-global ownership when switching Plates.
Verify automatic-to-manual transitions preserve manual intent without copying
automatic results into editable inputs or introducing a second backup. Cover
first manual initialization with no prior mapping, warning-only capacity excess,
the minimum capacity of one and topology repair that preserves valid targets.
Undo must restore the topology and repaired mappings together.
Cover default mappings on material addition, preservation of surviving maps on
deletion, per-Plate destination mappings on merge and nozzle-change impact
notices. Preset-switch Undo must restore capacities together with the printer
and affected mappings; project loading must retain saved capacity precedence.
Cover project capacity precedence over remembered values, the one-slot fallback,
new-Plate mode capability selection and import normalization of missing/Default
modes without rewriting other saved modes or existing mapping fields.
Exercise both immediate Sidebar edits and temporary pre-slice dialog edits.
Prove cancel leaves inputs unchanged and does not slice, confirmation commits
atomically before slicing, stale targets cannot be redirected, and capacity
warnings do not block. Cover safe numeric boundaries without hardware-specific
capacity caps.
Include Preview-triggered manual slicing and verify cancel does not immediately
reopen the dialog. Prove the standard 3MF capacity encoding round-trips its
effective totals, imported fallback mappings retain their meaning, and geometry
or published imports preserve their existing configuration boundaries.
The shared Electron/Web boundary remains unchanged; no printer connection is
needed. Mobile product support remains deferred under the shared architecture;
the editor must remain scrollable and keyboard-operable. Performance impact
should be bounded to small topology/material projections and existing native
slice work, without renderer-side grouping or continuous device polling.

Select build, host and WASM checks using the existing
[testing guidelines](../doc/testing_guidelines.md). This design-only extension
does not claim any of those product checks have passed.

### 14.6 Implementation and acceptance steps

Each step is a complete reviewable change with its own acceptance gate, not an
instruction to expose unfinished controls. Steps 1–4 are independently testable
through the native bridge/runtime without a mapping UI. Steps 5–6 expose the
accepted interactions only after their backend dependencies pass. Completing a
step does not claim delivery of the whole feature; section 14.5 remains the
overall acceptance boundary. Steps 1–3 are accepted; steps 4–7 remain planned.

| Step | Deliverable | Depends on | Acceptance evidence |
| --- | --- | --- | --- |
| 1 — accepted | Native capability and read-only mapping projection | Existing project/Plate contracts | Native projection fixtures and typed client/runtime checks |
| 2 — accepted | Atomic mapping/capacity edits, history and lifecycle transitions | 1 | Real-WASM mutation, rejection and Undo/Redo harness |
| 3 — accepted | Effective Plate configuration in real slicing | 2 | Native slice/G-code assignments and input/result isolation |
| 4 | Standard 3MF persistence and per-preset capacity memory | 2; uses 3 for reopen-and-slice acceptance | Archive/native round-trip, preference precedence and history checks |
| 5 | Shared mapping component and Sidebar surfaces | 3, 4 | Component tests and focused Sidebar journey using the runtime |
| 6 | Editable confirmation on every manual slice request | 5 | Dialog transaction and Slice/Preview lifecycle tests |
| 7 | Integrated feature qualification and delivery documentation | 1–6 | Cross-layer acceptance matrix in section 14.5 |

Steps 3 and 4 can be developed separately after step 2; step 4's final gate
uses the verified slicing path from step 3. Keep each step in a separate
reviewable commit or small cohesive commit series. If a step changes the Orca
submodule, validate and commit that source change on `dev/orcaslicerneo-wasm`
before deliberately updating the superproject pin. Update producers, consumers,
mocks and type fixtures together rather than staging incompatible API versions.
Every implementation gate also includes the applicable Level 2 checks from
[testing guidelines](../doc/testing_guidelines.md), including an affected-variant
quick build when bridge/native code changes. The gates below name the additional
behavior each step must prove, not exemptions from those baseline checks.

#### Step 1 — Native capability and read-only projection

**Deliverable:** Define the projection and codec boundary in the native bridge,
typed client and runtime. Report feature eligibility separately from automatic
mode availability; expose physical nozzle identities, Plate identity/revision,
saved and effective mode/maps, native-used material IDs, capacity totals and
diagnostics. Decode the existing native capacity format safely without adding
a mutable renderer owner or exposing feeder decomposition. Establish reusable
fixture builders for subsequent steps.

**Acceptance:** Real native queries distinguish H2D, single-extruder SEMM,
fixed multi-extruder, synthetic non-Bambu SEMM multi-extruder and higher-head-count
fixtures. The synthetic configurations are test fixtures, not an expansion of
the preset editor's supported combinations. Paint/support usage is included;
unused materials are omitted only from the editor projection, not deleted from
the underlying maps. Queries preserve project state, history and result validity.
Unsupported automatic modes have native reasons, and projection/serialization
does not assume exactly two nozzles. Reading another Plate cannot reuse stale
selected-Plate data.

**Gate:** Focused native projection harness plus affected client/runtime tests
and typechecks. No mapping controls or edit commands are delivered by this step.

#### Step 2 — Atomic edits, history and lifecycle transitions

**Deliverable:** Establish the project-owned capacity input and native commands
for Plate mode, a complete Plate mapping change set and selected-nozzle capacity.
Route them through the current client/runtime contract. Implement validation,
revision guards, dirty state, result invalidation and atomic Undo/Redo. A mapping
change set is the same mutation boundary used later by immediate Sidebar edits
and deferred dialog confirmation. Add mode-retention, Nozzle Manual conversion,
new-Plate defaults, material addition/deletion/merge, removed-target repair and
printer/flow transition handling. Preference restoration itself is step 4.

**Acceptance:** A real edit creates one history entry; a no-op or rejected edit
creates none. Stale/deleted Plate targets, invalid nozzle IDs, malformed map
lengths and unsafe capacity values leave inputs unchanged. Capacity excess
warns without rejecting valid edits. Unshown material entries and other Plates'
maps survive a local edit. Automatic mode retains manual intent; the first
actual Nozzle Manual mapping edit converts atomically and Undo restores it.
Add/delete/merge and nozzle removal follow section 14.1.3, including linked flow
repair and impact notices. Local edits invalidate only their Plate; global
capacity edits invalidate all Plates and cancel only affected running jobs.

**Gate:** Real-WASM command/history harness plus affected package tests and
typechecks. Compare complete before/after input snapshots on rejection and
Undo/Redo; projection assertions alone do not prove atomic restoration.

**Delivered boundary:** `mutateNozzleMapping` accepts a target Plate, project and
Plate revisions, editing context and one mode/mapping/capacity change. Successful
receipts publish the committed projection, history and affected Plate lifecycle;
no-ops preserve history. Capacity is a native project-owned input, included in
scoped history. The serial mutation harness verifies rejection and late-failure
rollback, Nozzle Manual conversion, local/global invalidation, retained manual
maps, material merge and removed-head repair with Undo/Redo. User-facing repair
and merge-impact messages are delivered with the consuming UI in step 5.
The serial projection harness, 710 client/runtime tests (four existing skips),
and repository typechecks passed. Real slicing and archive qualification belong to
steps 3–4; no UI or dual-variant qualification is claimed here.

#### Step 3 — Plate-aware slicing and result isolation

**Deliverable:** Feed the same authoritative capacity state into full-config
composition and resolve effective Plate mapping before material/flow expansion.
Apply the target Plate's mode/maps to the temporary Print configuration. Reject
unavailable automatic modes for eligible printers before processing; retain
existing behavior outside feature scope. Preserve the separation between
editable inputs and automatic slice results.

**Acceptance:** A two-Plate fixture assigns the same used materials to different
nozzles and produces the expected extruder/variant assignments for each Plate.
Check native results and actual extruding G-code tool usage, not only the config
sent to Print. Prove generic manual slicing on the synthetic non-Bambu and
higher-head-count fixtures, along with the unchanged single-extruder/fixed-tool
paths. Prove capacity reaches automatic grouping without treating it as a hard
manual slicing limit. After automatic slicing, input snapshots and manual maps
remain unchanged, and switching back to Manual restores the original intent.

**Gate:** An affected-variant quick build and focused real slicing harness;
affected client/runtime tests and typechecks. Capture source/artifact identity
with evidence so a stale WASM build cannot count as acceptance.

**Delivered boundary:** Plate mapping is resolved before full-config assembly;
the eligible slicing path retains all material variants until native Print
resolves the mapping, matching Orca's `full_config(false, ...)` path. Native
capacity is read from project inputs. Mode availability is checked before
processing, while out-of-scope printers retain their slicing path. The same
Plate-aware composition feeds Prepare usage queries without mapping writeback.
For Nozzle Manual on one-nozzle-per-head printers, a missing session-only native
nozzle inventory is derived from the effective topology/flows in the temporary
Print config. Explicit inventory is preserved; multi-nozzle clusters are not
invented and require their native inventory.

Serial native acceptance covers two Plates using the same material on different
nozzles, deposited G-code tool use, different Standard/High Flow temperatures,
Nozzle Manual, automatic/manual input isolation, unavailable modes, ordinary
single/fixed extruders and a synthetic generic three-head SEMM printer. The
Klipper fixture explicitly defines physical-tool G-code using native placeholders
and manual material loading; generic UI eligibility does not supply a firmware's
feeder/tool-change protocol. Direct preset-switch head removal is also repaired
inside its existing transaction and verified through Undo/Redo. Projection and
mutation harnesses, affected package tests and repository typechecks pass.
The serial artifact used for this gate has SHA-256
`0123986b466e672a0c90cdead958b14dcd0774ef68c00e9de44e9548a65542ef`.


#### Step 4 — 3MF persistence and remembered capacities

**Deliverable:** Extend ordinary project save/load to retain Plate mode/maps and
the standard capacity field, including existing native fallback inputs and
post-load normalization. Implement per-printer-preset capacity memory, the
one-slot default, project-value precedence and explicit preset-switch restoration.
Keep capacity restoration inside the existing preset-switch transaction and
history. Retain the native published/geometry-only import boundaries.

**Acceptance:** Save a project with different Plate mappings, reopen it and use
step 3 to reproduce the expected tool assignments. Check standard archive fields
and a native Orca read/save comparison for effective capacities, without requiring
feeder-decomposition preservation. Imported missing/Default modes normalize to
Auto For Flush; other modes and mapping data follow section 14.1.4. Switching
presets restores the target's memory/default; opening a saved project overrides
memory; Undo restores the prior project capacities with the preset transition.
No Neo-private 3MF mapping member is introduced. Automatic slicing followed by
save/reopen retains manual input intent. Geometry-only and published import
fixtures prove their existing configuration exclusions remain effective.

**Gate:** Focused real-WASM persistence/preference/history harness, native archive
comparison and affected package tests/typechecks. Report any unavailable native
comparison as unverified; a JS mock round-trip is not a replacement.

#### Step 5 — Shared component and Sidebar editing

**Deliverable:** Implement the shared mode/mapping component and mount it in
Plates Properties: Settings first, Filament Mapping second. Add the current-Plate
mode selection to the slice dropdown. Add capacity editing to upper Multi.,
reusing its nozzle selector. Sidebar changes commit immediately through step 2.
Use only native capabilities and diagnostics; preserve current Prepare/Preview
sidebar lifetime and target selection. The same component must support temporary
controlled values for step 6 without introducing an authoritative project store.

**Acceptance:** Mode selectors stay synchronized; only Manual/Nozzle Manual
shows the material editor. Each native-used filament has an independent target
dropdown, unrelated to the upper nozzle selection. Capacity edits affect the
selected physical nozzle globally. Outside feature scope, only the new controls
hide. Imported unavailable modes remain identifiable with a corrective mode
choice. Plate/tab changes preserve committed edits and reject stale commands.
Preview edits clear invalid results without navigation or eager slicing. Undo
restores visible values, and rendered choices cannot be supplied by mock-only
state absent from the native projection.

**Gate:** Shared component tests, affected package tests/typechecks and one
focused primary-host Sidebar journey. Add a real-runtime check for projection
and mutation wiring; component mocks alone do not qualify the backend. The
feature is not complete until step 6 adds mandatory manual-slice confirmation.

#### Step 6 — Editable confirmation and slice orchestration

**Deliverable:** Reuse the component in a temporary editing dialog before every
eligible Manual/Nozzle Manual slice request. Route explicit Slice and existing
Preview-entry slicing through the same confirmation flow. Confirm validates and
commits one change set, then slices that exact committed Plate revision. Cancel
discards temporary edits. Prevent duplicate requests and prevent an automatic
retry from bypassing cancellation. The dialog does not create a second mapping
command format or a separate backend state owner.

**Acceptance:** Opening, changing temporary values and canceling leave native
inputs/history untouched and start no slice. Confirm produces one atomic edit
and one slice using the chosen mapping; unchanged confirmation adds no spurious
history entry. An unchanged Nozzle Manual mode stays intact. Capacity warnings
allow confirmation. Validation failure, a changed/deleted target, or a mutation
between commit and slice cannot start a job using stale or another Plate's
configuration. Preview-triggered cancellation does not immediately reopen the
dialog; viewing an existing valid preview does not prompt. Automatic modes do
not enter the manual dialog, and unavailable modes cannot bypass their guard.

**Gate:** Component/orchestrator tests and focused Slice/Preview E2E, with native
job/result evidence for confirm/cancel and revision binding. Reuse step 3's
output checks to prove the confirmed map reaches actual slicing.

#### Step 7 — Integrated qualification and delivery status

**Deliverable:** Complete the section 14.5 acceptance matrix against current
artifacts and remove any temporary integration scaffolding. Exercise the full
journey: select printer, set capacity, configure two Plates, confirm manual
slicing, inspect tools, Undo/Redo, save/reopen and reslice. Include automatic-to-
manual transitions and imported special modes. Update delivered-status language
only after evidence supports it; update Grand Plan only if milestone status
actually changes.

**Acceptance:** All earlier gates have concrete results, and the cross-layer
journey covers both normal behavior and the failure cases that cannot be proven
within a single step. Report Electron/Web and threaded/serial evidence separately;
do not equate a mock UI journey with native slicing or a primary-host pass with
all-host qualification. No printer account, live device or send-time AMS mapping
is required for this feature's acceptance.

**Gate:** Apply [testing guidelines](../doc/testing_guidelines.md) Level 3 for
implementation handoff: repository tests/typechecks, both WASM quick builds,
comprehensive bridge coverage on one variant and variant-specific smoke on the
other, the primary shared UI journey and affected host seams. Because this
feature crosses real WASM composition, include real Web integration coverage.
Use Level 4 for release/milestone acceptance rather than repeating the complete
release matrix at every step. Record exact commands, source/artifact identity,
results and intentionally unrun checks in the implementation handoff.
