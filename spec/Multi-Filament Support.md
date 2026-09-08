# Multi-Filament Support

**Date:** 2026-09-08

**Status:** Living specification; product decisions are being clarified.

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

The advanced mapping UI is deferred, but the typed contract must preserve the
native mapping result so it can be displayed or edited by a later milestone.

## 4. Project and Preference Ownership

A loaded project's filament slots are project-owned state. The project stores
the ordered preset selections, slot colours, native mappings, and other
eligible multi-filament configuration required to reproduce its slice.

Project state has priority over remembered defaults:

1. Opening a compatible 3MF restores the project's complete slot state.
2. Creating a new project or working without an opened project restores the
   last-used slot state for the selected printer.
3. Remembered state is namespaced by printer and never replaces explicit slot
   state loaded from a project.
4. The current effective slot state is mirrored to the selected printer's
   remembered defaults after a successful explicit slot edit and after an
   Undo/Redo restoration that changes that state. It never alters another
   printer's defaults.

The existing single selected-filament preference is therefore a compatibility
projection of slot 1 during migration, not a second source of multi-filament
truth.

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

## 6. Architectural Boundary

The authoritative multi-filament state lives in the stateful C++/WASM Worker
session alongside `PresetBundle`, model configuration, plate state, and project
configuration. Application code must use the typed slicer runtime/client and
must not compose filament profile configurations in TypeScript.

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
  64.
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

A collapsible **Filament** area near the top of the Prepare settings sidebar
owns material-rack operations. Each slot presents:

- its one-based slot number and effective colour;
- the selected filament preset;
- a searchable compatible-preset picker;
- an action menu containing the applicable Edit, Merge with, and Delete
  commands; and
- enough state to identify incompatible fallback, pending work, or a rejected
  mutation without constructing a partial optimistic session.

The slot area uses two columns when the current sidebar width can present the
controls without truncating their primary content and one column otherwise.
This is responsive layout, not a host-specific implementation. Electron and
Web render the same component and command model.

Add, Delete, and other commands are enabled from the capability fields in the
Worker-provided filament-session snapshot. The UI does not infer device type
or native slot-count constraints.

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
inferred solely from the number of slots. The first release exposes these
basic controls:

- `enable_prime_tower`;
- per-plate X and Y position; and
- `prime_tower_width`.

All other prime-tower parameters retain their Process-preset values and remain
round-trippable without a first-release editing surface. The session applies
OrcaSlicer's normalization and validation for the actual used-filament count,
print sequence, G-code flavour, layer constraints, and build-volume bounds.
The UI presents returned corrections, errors, and warnings; it does not force
the tower on merely because the project has multiple slots.

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

Project save writes every effective slot preset, colour, native map, flushing
configuration, and model/plate assignment needed for native OrcaSlicer and Neo
to reproduce the project. Derived G-code and preview buffers remain outside
normal project persistence.

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
strings: restoring it must re-establish `PresetBundle` and its validated full
configuration before the restored project can be sliced.

### 11.3 Per-printer remembered rack

The selected printer has a versioned remembered-rack preference used only to
seed a new project or a session without explicit project slot state. The live
project remains authoritative while it is open.

The remembered rack always mirrors the current effective filament session:

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

## 12. Decisions Still to Be Clarified

The living specification will be extended in coherent batches after decisions
are made for:

- Web and Electron resource limits and recovery behaviour; and
- acceptance fixtures and verification scope.
