# Preset Editor Dialog

**Date:** 2026-09-23

**Status:** Approved — phase-one implementation basis. Sections below record
accepted decisions only; unresolved product decisions are discussed before they
are added.

**Scope:** A shared React preset editor for Printer and Filament presets. It
extends [Multi-Filament Support](Multi-Filament%20Support.md) without porting
the wxWidgets editor.

## 1. Product intent

Neo will provide the equivalent of OrcaSlicer's preset-parameter editing
surface for the selected Printer and Filament material slots. Accepted field
values take effect in the active project immediately; an explicit save to the
user-preset repository is a later phase.

The first implementation phase provides editing sessions and runtime drafts. It
does not add user-preset creation, rename, deletion, direct draft serialization,
or cross-project profile persistence. Those actions are phase two.

## 2. Draft ownership and lifetime

### 2.1 Immediate effective configuration

Once a field value has passed native validation, it is immediately included in
the next slice configuration. The mutation invalidates every affected plate and
cancels an in-flight slice for an affected plate. Closing the editor does not
discard an accepted value.

Each accepted field edit or field reset is one project-history entry. A
category reset and `Reset preset` are each one atomic project-history entry.
Incomplete text, rejected input, and uncommitted editor-local text never enter
history. This deliberately reuses Neo's current scoped Project Configuration
history granularity rather than Orca's preset-page-only dirty state.

The React state is a presentation projection only. The authoritative draft and
effective configuration live in the C++/WASM session, and all mutations use the
typed Worker/runtime boundary.

### 2.2 Filament drafts are preset-local

One runtime filament draft belongs to one source filament preset identity, not
to one material slot. All slots that select that same preset share its accepted
edits and effective slice configuration. Editing any one of them creates, on
first change, one copy-on-write runtime overlay of that source preset; every
slot that selects the source resolves through that overlay.

Slots that select different source presets have independent drafts. Thus slot 1
and slot 2 share a draft when both select `PLA A`, while slot 3 selecting
`PETG B` has a separate draft. The identity used for this mapping must be the
native collection's canonical preset name, rather than a translated display
label. The draft key is the preset type plus that canonical name, so a Printer
and a Filament with the same name remain distinct while all Filament slots with
the same canonical name share one draft. Phase one relies on the collection's
existing canonical-name uniqueness rule; it does not add a separate opaque
source-ID protocol.

Consequently, all of the following are independently addressable by edited
source preset:

- effective configuration used for slicing;
- editor dirty state and reset-to-base behavior;
- Undo/Redo state; and
- reconstruction from a saved project's active effective configuration.

The native slice configuration resolves the source preset plus its runtime
overlay. This retains standard native configuration assembly while avoiding the
one-global-edited-preset limitation inherited from OrcaSlicer's
`PresetCollection` model.

### 2.2.1 Native registry and configuration assembly

`PresetDraftRegistry` lives in Neo's C++ bridge/runtime session, not in
`libslic3r::PresetCollection` and not in React. It maps the key described in
section 2.2 to a sparse override set and its effective configuration
projection. On an accepted mutation, the bridge validates and updates that
entry without changing the source preset or any collection's
`m_edited_preset`.

The bridge exposes `effective_full_config()` and
`effective_full_config_secure()` as the only Neo-facing configuration-assembly
adapters. They resolve the active Printer and every selected Filament canonical
name through `PresetDraftRegistry`, then supply their effective configuration
to the ordinary native configuration assembly. Slicing, 3MF export, Prepare
projections, and material/flush calculations must all use these adapters rather
than call `PresetBundle::full_config()` directly. This changes Neo bridge call
sites but must not alter the pinned `packages/slicer-wasm/cpp` submodule or
generalize upstream `PresetCollection` into a multi-edited-preset container.

The adapters substitute only the active Printer and selected Filament sources.
They retain Neo's existing Print/Process `m_edited_preset`, project-embedded
Print behavior, and scoped Project Configuration path unchanged. Print/Process
preset editing and management are outside this feature's phase-one scope.

To assemble a result, an adapter copies the active source Printer and each
selected source Filament, applies the corresponding sparse registry overrides
to those temporary copies, and calls
`PresetBundle::construct_full_config(...)` with the existing Print edited
preset and Project Configuration. It never temporarily writes, swaps, or
otherwise changes a collection's `m_edited_preset`; temporary effective copies
therefore cannot leak between slicing, export, projection, or history restore.

Registry state is authoritative for runtime history capture and restore. React
only renders native snapshots and submits typed commands; it neither computes
effective preset configuration nor retains an independent draft copy.

System, external, and project-embedded Printer and Filament presets are all
eligible editor sources in phase one. An edit of a project-embedded source
creates the same runtime overlay and never rewrites its embedded source record
or offers Save As / user-preset management. Its current effective values follow
the ordinary project persistence path described in section 2.3.

### 2.3 Session lifetime and 3MF reconstruction

Closing the editor retains an accepted draft for the lifetime of the open
project session. A 3MF does not serialize a draft object, runtime draft
identity, or source-to-draft map. It saves the normal current source selections
and their effective configuration, including the modification-difference
information used by Orca's ordinary project-config load path. Loading
reconstructs the currently active Printer and Filament drafts from those saved
effective values; drafts are not written into the user preset repository in
phase one.

The preset-editor feature adds no draft-specific cross-version migration,
fallback-source behavior, or source-identity persistence. Ordinary project
loading remains responsible for interpreting its saved configuration and
selections; the editor only creates new runtime drafts for the resulting active
sources in the opened session.

A Filament draft remains available when no current slot references it for the
rest of the open session. Selecting its source preset again reuses that draft
rather than creating a new one. Such unreferenced drafts are not stored in a
3MF and therefore do not reappear after reopening the project. They are removed
by an explicit `Reset preset`, project replacement, or a history restoration
that removes them.

The slot picker always displays the source preset name. A visible `Modified` /
`Project draft` marker identifies a source preset with at least one runtime
override, including when multiple slots share that draft. An empty retained
overlay has no modified marker.

### 2.4 Compatibility changes

Neo follows Orca's two-step policy when a Printer becomes active. First, for a
new project or an explicit Printer transition, it restores that Printer's
application-preference remembered material rack: source preset selections and
actual slot colours. The remembered rack is a per-Printer convenience seed; it
does not contain a runtime draft, its overrides, or a draft identity, and it
does not supersede the complete slot state while a 3MF is being opened. After
that initial project restoration, an explicit user Printer selection restores
the selected Printer's remembered rack; a project does not lock its original
rack across an explicit Printer transition.

Second, native compatibility normalization runs over every restored slot. A
source that remains present and compatible is retained. A missing or
incompatible source is automatically replaced with a compatible source,
preferring the active Printer's corresponding `default_filament_profile` entry
and otherwise a compatible fallback. This is the Orca behavior of restoring
the prior association and then calling compatibility update in `Always` mode.

Each replacement observes the normal source-selection rules: it activates an
existing runtime draft for the replacement source when one exists, otherwise it
uses the unmodified source. The displaced source's draft remains dormant for
the current session, including when no slot continues to reference it. The
replacement initializes the slot's actual colour from the newly effective
material default as specified in section 2.5.

After a successful compatibility normalization, Neo writes the normalized
source selections and actual slot colours back to the active Printer's
remembered rack. Consequently, a stale incompatible remembered source is not
retried on every later selection of that Printer. This best-effort preference
write is not part of project history and never writes a runtime draft, draft
identity, or draft option values.

An explicit Printer selection is one native composite project transaction. It
selects or reactivates the target Printer draft, restores its remembered rack,
normalizes every slot for compatibility, and publishes one committed effective
configuration snapshot. It creates exactly one project-history entry and one
slice invalidation; no intermediate selection or partially restored rack is
observable to React. Undo and Redo restore the Printer, complete rack, actual
slot colours, and the runtime drafts effective at that point. The independent
remembered-rack preference write deliberately does not participate in Undo or
Redo.

Editing a field in the active Printer draft does not itself restore, replace,
or otherwise normalize the material rack. This includes a field that changes
compatibility declarations: Phase one may refresh compatibility presentation in
the future, but it retains the selected material sources and their actual slot
colours. Restore-then-normalize runs only for an explicit Printer-source
selection.

### 2.5 Filament default colour and slot actual colour

The Filament preset editor owns `default_filament_colour`: it is the material
default and participates in the shared source-preset draft. The actual colour
of a material slot is a separate project-owned value, represented by the
slot-indexed `filament_colour`, `filament_colour_type`, and
`filament_multi_colour` arrays. Editing an actual slot colour never changes a
Filament draft, and editing a material default colour never overwrites an
already stored slot actual colour.

Selecting or replacing a slot's source preset initializes that slot's actual
colour from the selected preset draft's `default_filament_colour`, matching
Orca. Subsequent slot-colour edits remain project-local overrides until the
slot selects another source preset.

Project history captures runtime draft identities and their configuration, so
Undo/Redo restores them before slot-name resolution. Slot deletion, merge, and
reordering must remap slot references atomically; they do not delete an
unreferenced draft during the session.

### 2.6 Printer drafts are project-owned

Editing a system or external Printer preset creates a copy-on-write runtime
overlay on the first accepted change. The overlay inherits from the selected
source Printer preset and is the effective Printer configuration for the
current session; it does not modify the source preset or the user preset
repository in phase one.

The overlay remains active after the editor closes. Its draft identity and
configuration participate in project history so Undo/Redo restores the same
effective Printer configuration. Saving flattens its current effective values
into ordinary project configuration; project reload reconstructs the active
overlay instead of loading a serialized draft.

Changing to another Printer source preset deactivates but does not delete its
project draft. A later selection of the same source Printer reactivates the
retained draft. Dormant Printer drafts remain available only in the open session
and its project history; they are not saved into a 3MF. They remain until
explicit `Reset preset`, project replacement, or history restoration removes
them.

### 2.7 Reset preset removes the whole draft

`Reset preset` removes every override of the target runtime draft and deletes
that overlay. For a Filament draft, all slots that resolve through that overlay
atomically return to its source preset. For a Printer draft, the active project
Printer returns to its source preset. The operation invalidates the affected
slice results and creates one project-history entry. It executes without a
confirmation dialog.

Individual option and category reset behavior is specified separately; it does
not delete a draft, including when it removes the last override. An empty
runtime overlay remains available until an explicit `Reset preset`, a project
replacement, or a history restoration removes it.

An individual field reset removes that field's runtime-overlay override rather
than copying the current source value into the overlay. A category reset
likewise removes the overrides for all manifest-listed fields in that category.
The resulting value is always resolved from the source preset and the ordinary
native configuration stack. Removing the final override retains an empty
overlay but removes its `Modified` / `Project draft` marker; only `Reset
preset` removes the overlay itself.

## 3. Relationship to OrcaSlicer

OrcaSlicer keeps a single `m_edited_preset` per `PresetCollection`. Its full
FFF configuration resolves a filament slot by preset name, so multiple slots
with the same name resolve to the same edited copy. Neo preserves that useful
same-preset sharing, but removes the global-selection limitation with one
runtime overlay per edited source preset rather than one global edited copy for
all filament presets.

The same distinction applies to Printer editing. Orca's current Printer
selection has one mutable edited copy. Neo materializes a project-session
overlay when a project changes that source Printer, so its lifetime is explicit
rather than being coupled to the global current selection.

Orca's whole-preset reset applies to its current global edited copy. Neo applies
the corresponding reset to one runtime draft and also updates every slot that
resolved through its overlay.

## 4. Editor interaction model

Phase one permits exactly one modal preset editor dialog. Opening it for a
Printer or Filament target blocks opening another editor until the current
dialog closes. This is a UI-concurrency rule only: multiple project drafts may
remain resident and effective in the native session at the same time.

The phase-one action surface has `Close` only as its primary dialog action.
There is no Save, Apply, or Cancel because accepted changes are already
effective for the project session. `Reset preset` is a secondary destructive
title-bar action and executes without confirmation.

The dialog is addressed to a draft owner. Opening it from two slots that share
the same source Filament preset addresses the same draft; opening it for a
different source preset addresses that preset's distinct draft.

The current selected Printer preset control exposes Edit to open its Printer
editor. Each Filament slot action menu exposes Edit to open the editor for that
slot's selected source preset. Neither entry point selects an editor target from
inside the modal dialog.

A Filament editor title displays its source preset name, `Project draft` state
when applicable, and the numbered slots currently referencing that source
preset/draft. This communicates the shared scope before a field is changed.

Discrete controls (for example a picker, toggle, or numeric stepper) submit an
accepted change immediately. Free-text and free-form numeric fields submit only
on Enter or focus loss after native validation succeeds. Invalid and incomplete
intermediate text is local UI state and never enters the effective slice
configuration.

The editor presents its target through explicit, Orca-style functional page and
group definitions. A versioned React manifest lists each page, group, option
key, field order, and Phase-one editability. It is the authoritative layout and
exposure allow-list: a newly introduced native option is not shown until it is
intentionally added to the relevant Filament or Printer manifest.

The Phase-one manifest marks topology-changing Printer fields as read-only.
This includes `extruders_count`, `single_extruder_multi_material`, Printer
technology and source-identity fields, every per-extruder vector such as
`nozzle_diameter`, and material-default lists such as
`default_filament_profile`. These fields require a future dedicated native
capability-topology transaction; an ordinary draft-field mutation never
silently reshapes material slots or rewrites related options.

Native option metadata remains authoritative only for facts about a listed
option: its label, type, tooltip, constraints, and native validation. It does
not infer a page, group, ordering, or whether an option may be edited. Phase one
intentionally omits Orca's Simple/Advanced/Expert visibility-mode filter.
It also does not port Orca's dynamic GUI `toggle_field` / `toggle_line`
predicates: every manifest-listed field remains visible regardless of other
current option values.

Phase one supplies editable generic controls for scalar numbers, booleans,
enums, text, and colours. A manifest-listed option requiring a specialized Orca
control (for example compound arrays, per-extruder editors, or structured
custom G-code) is read-only until its control is implemented. It has no
separate unsupported-feature notice in phase one.

The editor provides three reset scopes: an overridden editable field has a
field Reset that removes its draft override and inherits the source preset;
each category page has `Reset category`; and the dialog has `Reset preset`.
`Reset category` is one atomic native batch mutation: it either restores every
override of every manifest field in that category, including Phase-one read-only
fields, or makes no change. It produces one Undo/Redo history entry and
invalidates slicing once. Unlisted native options have no category affiliation
and are reset only by `Reset preset`. The project's existing Undo/Redo, not a
second dialog-local initial-value snapshot, restores arbitrary earlier states.

The editor provides preset-local search. It filters the manifest's displayed
fields by label, native key, and tooltip across all pages, retaining each
result's functional page/group context. Read-only listed fields participate in
search; unlisted native options do not.

Phase one commits only the option the user explicitly edits. It relies on
native validation for acceptance or rejection and does not reproduce Orca's
GUI-level cross-option automation, specialized confirmation dialogs, or
implicit companion-option mutations. Such behavior may be added later as an
explicit per-option hook.

Preset-editor fields reuse the Project/Scoped Print Config mutation state
machine in phase one. Discrete controls commit immediately; text fields commit
on Enter or focus loss; Escape restores the uncommitted displayed value. A
successful mutation replaces the displayed value with the native effective
value. A rejected mutation preserves the submitted value and displays the
native error inline; it produces no extra correction notice or preset-editor
specific error policy.

### 4.1 Explicit-layout source

Phase one completely translates the Filament and Printer page, group, and field
ordering from the Orca `TabFilament::build()` and `TabPrinter::build()` layout
at the pinned native-core revision `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`.
Every listed field is present: generic fields are editable and specialized
fields are read-only until their dedicated editor exists.

## 5. Delivery sequence

### 5.1 Phase one: runtime editor

1. Add the typed Worker/runtime contract for opening a source, reading its
   manifest-listed option metadata and effective values, mutating/resetting
   overrides, and returning the committed native/history projection.
2. Implement `PresetDraftRegistry`, its history state, and the effective
   configuration adapters in the Neo bridge. Route all current Neo
   full-configuration consumers through those adapters.
3. Extend the existing atomic Printer transition so it selects/reactivates a
   Printer draft, restores and normalizes the remembered rack, commits one
   history item, then publishes the independent remembered-rack preference.
4. Build the explicit Printer and Filament React manifests and the single
   modal `PresetEditorDialog`, then add the existing Picker and Filament-slot
   Edit entry points.
5. Reuse the current Scoped Project Configuration mutation, error, slice
   invalidation, and Undo/Redo projection path for every accepted editor
   command.

### 5.2 Phase two: user preset management

Phase two may add Save As, rename, delete, user-repository persistence, and
preset-management surfaces. It must convert a selected runtime draft into an
explicit user action; phase one never performs that conversion implicitly.
