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
4. Project-local changes may update the current printer's remembered defaults
   for future new projects, but they do not alter another printer's defaults.

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
support-material or region-setting controls may configure related print
options in a later milestone without changing this target rule.

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

## 8. Decisions Still to Be Clarified

The living specification will be extended in coherent batches after decisions
are made for:

- object and part assignment and inheritance;
- add, delete, replacement, and imported-state remapping;
- detailed sidebar and Object List interaction;
- Undo/Redo transaction contents and dirty-state behaviour;
- 3MF interoperability, fallback, and conflict handling; and
- acceptance fixtures and verification scope.
