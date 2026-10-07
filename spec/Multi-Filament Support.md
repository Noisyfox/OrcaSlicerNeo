# Multi-Filament Support

**Date:** 2026-09-08

**Status:** Approved and accepted through Step 15 (2026-09-11). The baseline
implementation was acceptance-verified at `07f276d` (2026-09-09); the
Prepare-view prime-tower model extension in Section 10.2 was acceptance-
verified by the Step 15 acceptance record with threaded real Electron evidence,
deterministic warning/invalidation coverage, and the 50.300-second threaded
checklist.

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

The first release does not expose an advanced manual filament-to-physical-
extruder mapping editor. It uses the selected printer preset and OrcaSlicer's
native configuration rules to map material slots to physical extruders,
nozzles, and variants.

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

The advanced mapping UI is deferred, but the typed contract must preserve the
native mapping result so it can be displayed or edited by a later milestone.

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
a missing multi-colour list, and solid type `1` for a missing type. Existing
stored racks with only a HEX colour normalize to these solid native fields at
the preference boundary. Internal rack commands require the complete fields.
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
- multi-material painting state, including imported painting that Neo cannot
  yet edit;
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
ordered colours. Existing swatch dimensions, borders, radii, hover behaviour,
and layout remain unchanged. The slot number retains the original direct text
styling and representative-colour luminance contrast rule. The colour block
tooltip names the mode and complete colour sequence. The slot editor uses the
shared opaque solid or two-endpoint gradient picker. Imported dual/multi-colour
partitions and gradients with extra stops open as a draft from their first and
last displayed colours. Cancel leaves all raw metadata untouched; Confirm commits a
two-endpoint gradient and discards intermediate colours and the partition type,
even when those endpoints were not changed in the draft. An unchanged canonical
solid or two-endpoint gradient does not create a mutation. A change to any slot
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

The first release does not provide a flushing-volume matrix editor or an
All/Colour/None automatic-calculation preference. Neo always uses the native
OrcaSlicer calculation after an input that affects flushing changes, including:

- a slot's filament preset, material properties, or effective colour;
- slot Add, Delete, Merge with, or renumbering; and
- the support/raft base or support/raft interface filament selection.

The Worker recalculates and returns the complete matrix atomically with the
filament session. React neither derives individual values nor applies partial
matrix edits.

Opening a 3MF is not itself a flushing-input edit. Neo initially preserves the
project's stored matrix exactly for OrcaSlicer interoperability. The first
subsequent change to a flushing input unconditionally replaces that imported
matrix with a complete native recalculation. Project save persists the current
effective matrix even though Neo does not expose direct editing in this
release.

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

All eligible plates display their tower in Prepare. Only the current plate's
tower is pickable and movable. The tower is a scene-only special object: it is
not a `ModelObject`, does not appear in Object List, and has no delete, copy,
scale, rotate, or context-menu commands. Selection retains the coloured bands
and adds the ordinary selection bounds plus an X/Y-only Move gizmo. Direct body
dragging and the Move gizmo edit the same per-plate position. Switching plates,
disabling the tower, or otherwise removing the selected proxy clears its
selection without producing history.

The proxy exists only in Prepare. Preview continues to render the generated
toolpath and never overlays the Prepare proxy.

#### 10.2.2 Position, history, and invalidation

When a new plate or project has no explicit tower coordinates, the Worker uses
OrcaSlicer's native default placement. Direct dragging constrains the rotated
tower footprint plus effective brim margin to the current plate's printable
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
prime-tower code. If Arrange is introduced later, tower participation requires
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

### 10.5 Deferred multi-colour editors

The first release creates and edits multi-colour model intent only through
object, `MODEL_PART`, and `PARAMETER_MODIFIER` assignment plus the feature-path
controls above. It does not provide:

- facet-level multi-material painting; or
- Preview layer-slider creation or editing of colour-change and tool-change
  events.

Imported facet painting and layer/tool-change events remain lossless project
state: Neo must preserve, slice, preview, save, and atomically remap them during
slot Delete or Merge with. Their absence from the UI must never clear or
normalize them merely by opening and saving a project.

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

## 12. Feasibility and Implementation Sequence

The feature is feasible without porting wxWidgets or changing the pinned C++
submodule. The pinned core already provides native multi-material preset
composition, slot-count updates, assignment configuration, flushing
calculation, validation, painting/tool-change persistence, slicing, and G-code
preview attribution. The principal work is exposing those facilities as an
atomic typed Worker session and integrating that session with the shared React
application, project persistence, and history.

Implementation is divided into independently testable pieces. The dated living
implementation document created when coding begins must refine file lists and
commands, but must not reopen accepted product behaviour silently.

1. **Filament session projection.** Add one authoritative bridge snapshot for
   ordered slots, presets, effective colours, maps, flushing state,
   capabilities, effective assignments, and relevant revisions. Extend the
   client/runtime types and mock module before application code consumes it.
2. **Atomic slot commands.** Expose preset selection by slot, colour change,
   Add, Delete, and Merge with as explicit JSON commands. Stage and validate
   the complete `PresetBundle`, model, plate, custom-G-code, painting, support,
   and routing remap before commit.
3. **Assignment and routing commands.** Add object/instance-as-object,
   `MODEL_PART`, and `PARAMETER_MODIFIER` assignment plus support and six
   feature-path selectors. Return effective and inherited values rather than
   reconstructing inheritance in React.
4. **Shared Prepare UI.** Build the responsive rack, Object List filament
   column and context command, impact confirmation, selectors, and Prepare
   colour projection in `packages/slicer-app`. Both hosts consume the same
   components and platform-neutral commands.
5. **Flushing and prime tower.** Wire unconditional native recalculation after
   accepted flushing inputs, imported-matrix preservation before the first
   such edit, basic prime-tower controls, and native error projection.
6. **History and persistence.** Extend the native history context and two-phase
   restore to include the complete filament session. Verify project dirty
   checkpoints, per-printer remembered-rack publication, embedded presets, and
   lossless unsupported-state round-trip.
7. **Slice and Preview integration.** Bind invalidation to configuration scope,
   keep result revisions plate-safe, and project the generated tool/extruder
   palette into Preview without synthesizing it from Prepare state.
8. **Acceptance closure.** Run focused checks after each piece and the complete
   approved release matrix only after all pieces pass their local gates.

No implementation step edits `packages/slicer-wasm/cpp/` ad hoc. If exploration
later proves a core change unavoidable, it requires a documented patch under
`packages/slicer-wasm/patches/` or an intentional pinned-submodule update and a
separate review of that scope.

## 13. Acceptance and Verification

### 13.1 Fixture policy

The first-release compatibility suite uses deterministic synthetic fixtures
only. It does not download or pin external real-world OrcaSlicer projects and
therefore does not claim external-corpus compatibility evidence. Compatibility
means that the project follows the native state and 3MF behaviour of the pinned
`libslic3r` core.

Synthetic fixtures must not rely solely on exporting and reopening with the
same path under test. At least one independently assembled multi-filament 3MF
fixture exercises the reader, and bridge-generated projects exercise the
writer and round-trip path.

### 13.2 Required behavioural fixtures

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
- imported custom flushing-matrix preservation followed by automatic
  replacement after the first flushing-input edit;
- Prepare-only estimated prime-tower proxies for every eligible plate,
  including native dimensions, band order and colours, read-only imported
  rotation, one-gesture history, current-plate-only interaction, and
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

### 13.3 G-code and Preview assertions

Tests do not compare complete G-code byte-for-byte. They parse generated output
and assert stable multi-filament semantics, including applicable tool or
filament-change order, per-feature slot use, temperature commands, flushing and
prime-tower structure, and the Preview result's tool IDs and filament palette.
This avoids coupling acceptance to unrelated comments, timestamps, or pinned-
core formatting changes while still proving that assignments affect output.

### 13.4 Layered release gates

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

## 14. Implementation closure and acceptance boundary

The Step 15 implementation record is the accepted multi-filament boundary:

- Prepare exposes the multi-filament rack/session and slot assignment surfaces;
  the old single-filament selector, public API, preference field, project
  selection tuple, native history state, sidecar member, mock field, wire
  `selected` flag, compatibility special case, and migration test are absent.
- The profile wire contains `filament_catalog`; `orc_select_preset` accepts
  only `printer` and `print`. Rack/session/slot state is the only filament
  authority.
- History uses the minimal mutable filament frame. The no-bundle invariant is
  guarded by `fullPresetBundleCopyCount`; the project-import candidate is the
  sole full `PresetBundle` copy. Warmed slot Undo/Redo stays approximately
  1–3 ms in the acceptance smoke.
- Context-only history records do not advance the filament session fence.
  Project mutations remain revision-fenced, and stale commands are rejected
  without changing project, rack, history, or result state.
- Prepare renders the native prime-tower projection only for eligible plates;
  only the current plate accepts a move, each committed drag adds one history
  entry, and disabling the tower clears eligibility without marking the plate
  empty. Collision and outside-boundary warnings are advisory and do not block
  a successful slice or Preview result.
- The complete dual-variant real-WASM acceptance runner most recently finished
  in 95.018 s with `failed: []`; its hard wall-clock limit is 120 s. Developer
  iteration may use `--threaded-only`; release acceptance always runs both
  `serial` and `threaded`.

The recorded acceptance commands include:

```text
pnpm test
pnpm typecheck
node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs --run-real
node packages/slicer-wasm/harness/multi-filament-command-smoke.mjs --module packages/slicer-wasm/out/serial/orca_slice.js
node packages/slicer-wasm/harness/multi-filament-command-benchmark.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --assert-under-ms 20
node packages/slicer-wasm/harness/multi-filament-acceptance-checklist.mjs --run-real --threaded-only
```

The full host/build matrix and its exact results remain recorded in the living
implementation plan. This specification is normative for the zero-legacy
boundary and does not authorize compatibility shims or post-release
migrations.
