# Preset Editor Dialog

**Date:** 2026-09-23

**Status:** Delivered runtime editor, including indexed vector overrides;
user preset repository management remains deferred.

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
sites without generalizing upstream `PresetCollection` into a multi-edited-preset
container. The runtime-only Print ownership adapter described below is the
intentional submodule change for the generic vector extension.

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

On load, Neo uses the ordinary project-difference metadata and imported
effective configuration to reconstruct sparse overlays only for the active
Printer and the Filament source selected by each slot. Slots resolving to the
same canonical source name share the reconstructed overlay; distinct selected
sources remain independent. Difference data for presets that are not selected
is not used to recreate dormant drafts. The existing BBS project loader remains
authoritative for compatibility and embedded-preset resolution; Neo preserves
the embedded archive source configuration and keeps reconstructed overlay
values separate from that source.

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

The phase-one action surface has a top-right X icon for `Close` as its only
primary dialog action.
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
group definitions. An explicit React manifest lists each page, group, option
key, field order, and Phase-one editability. It is the authoritative layout and
exposure allow-list: a newly introduced native option is not shown until it is
intentionally added to the relevant Filament or Printer manifest.

The Phase-one manifest marks topology-changing Printer fields as read-only.
This includes `extruders_count`, `single_extruder_multi_material`, Printer
technology and source-identity fields and material-default lists such as
`default_filament_profile`. These fields require a future dedicated native
capability-topology transaction; an ordinary draft-field mutation never
silently reshapes material slots or rewrites related options.

Native option metadata remains authoritative only for facts about a listed
option: its label, type, tooltip, constraints, and native validation. It does
not infer a page, group, ordering, or whether an option may be edited.

Field tooltips include Orca's `parameter name`; scalar controls bound to native
vectors show `key[index]`. `Default` comes from the edited preset's native
parent configuration, never from the current draft or static option defaults.
Numeric defaults use Orca's number and unit formatting, boolean defaults use
`true`/`false`, and empty string defaults display `Empty string`. Enum and
specialized types omit Default. Without a parent value, Default and Range are
both omitted. The tooltip is available on both the field and its label.
Numeric field tooltips append Orca's `Range: [min, max]` only when both native
bounds are strictly inside the `FLT_MAX` sentinels. Endpoints use up to four
decimal places without trailing zeros and the native unit suffix; `layers`
gets a preceding space, and float-or-percent fields use the parent value's
unit choice. This includes scalar controls bound to native vector options.

Phase one intentionally omits Orca's Simple/Advanced/Expert visibility-mode
filter.
It also does not port Orca's dynamic GUI `toggle_field` / `toggle_line`
predicates: every manifest-listed field remains visible regardless of other
current option values.

Phase one supplies editable generic controls for scalar numbers, booleans,
enums, text, and colours. A manifest-listed option requiring a specialized Orca
control (for example compound arrays or structured
custom G-code) is read-only until its control is implemented. It has no
separate unsupported-feature notice in phase one.

Where the native option is a vector of ordinary scalar values, the generic
editor binds its first native element as one scalar control and preserves the
remaining elements. Its displayed numeric, boolean, percent, nullable, and
closed-enum semantics come from native element metadata; the stored option
remains in its existing serialized vector form. Filament scalar G-code and
notes fields use multiline text controls and are editable through that native
element binding. Printer scalar machine G-code remains read-only.

Printer Extruder pages use complete typed native Source and Effective vectors.
The internal snapshot contract requires these vectors; native no longer sends
the previous first-element `editor_bindings` payload. The typed client derives
generic first-element views from vectors for the Filament controls. All producers,
consumers, mocks, and tests use the same contract, without legacy payload fallbacks.
Page numbering is one-based; reads and writes use the corresponding zero-based
index. Nonempty short vectors fall back to their first element, matching native
`get_at`; empty vectors retain their empty state. Ordinary parameters, nullable
values, enums and percentages are editable through single-value indexed native
requests. Offsets use one X,Y coordinate; printable regions use one coordinate
pair per line, with an empty region allowed. Native validation checks types,
finite coordinates, ranges and the native valid element count. Sparse vector
composition fills inherited short-vector entries from Source before applying
explicit entries, preserving every other index. Trailing empty region groups survive native serialization.

The common native `ConfigElements` implementation serves Printer and Filament
drafts and the Project-owned Print configuration. Every projected vector
requires `index_count` (`indexCount` in the typed client). This is the valid
zero-based element range, independent of serialized length: physical Printer
options use the nozzle count, variant options use the preset's native variant
list, and Printer motion limits use two values per variant. Other supported
vectors use their own length. Short values retain native first-element
semantics; null is preserved and an empty printable-region group remains valid.
`configVectorElementAt` supplies the same bounded read to presentation code.

Draft `set-element`, indexed `reset-field`, and indexed `reset-category` share
that implementation for both Printer and Filament. Resets restore only the
specified element from Source by clearing its override entry; only a vector
with no explicitly owned entries removes its draft key. Explicit batch keys are validated before any history/state
mutation. Scalar or structured options without an element editor are rejected.

Print uses `getPrintConfigEditor()` for complete typed Source/Effective vectors
and the same range contract. It remains outside `PresetDraftRegistry`.
`mutateNativeScopedConfig` accepts Project `set-element` (one typed value, its
scalar type and index) and `reset-elements` (explicit unique keys and an index).
Both require the revision returned by the read. They retain the existing
Project Print owner, embedded-preset materialization, configuration publication,
and enclosing application history transaction. They do not introduce a second
Print draft or history root. Whole-option operations remain distinct actions.

This increment supplies element mechanisms only. Filament/Print variant pickers,
per-field Extruder-to-Variant mapping, motion-mode controls, and cross-extruder
copy remain separate work. A valid vector index is not a physical Extruder ID.

Diameter edits reuse the native toolhead transition, including exact profile
combination matching, and the editor follows the resulting canonical source.
The open Extruder page remains selected through that canonical source change.
Source, Effective, tooltips, search and history refresh all use the same page
index. Field reset restores only that element; Extruder category reset restores
that index across the page in one atomic history entry. Extruder field/group/tab
highlights reflect native ownership of the selected element, including explicit
Source-equivalent values.
These typed vectors are response projections, not additional native history or
project-file state. Both hosts retain their desktop input model; mobile support
remains deferred.

The editor provides three reset scopes: an overridden editable field has a
field Reset that removes its draft override and inherits the source preset;
each category page has `Reset category`; and the dialog has `Reset preset`.
Every manifest-listed option with a runtime draft override highlights its label
using the same modified-option color as the Print configuration overlay,
including phase-one read-only fields. Removing that override clears the
highlight; the input control itself remains unhighlighted.

An explicit write remains an override when its value equals Source; only Reset
resumes inheritance. Editable vector overrides are sparse arrays: `null` means
inherit Source at that index, while `{ "value": <typed element> }` explicitly
owns it. `{ "value": null }` is an explicit native nil for a nullable parameter;
it is distinct from inheritance. Scalar and opaque-list overrides retain native
serialized text. A whole-option vector Set explicitly owns every valid index.

Each typed vector requires `override_values` (`overrideValues` in the client),
with one entry per `indexCount`. React reads ownership at the displayed index;
it does not compare Source and Effective. Reset field/category clears only the
selected index. Once that page has no owned entries, its highlights and Reset
are cleared even when other indices remain modified. Sidebar modified markers
remain active while any entry is owned. All-null arrays remove the key; field
and category Reset retain the empty draft, while Reset preset removes it.

Printer/Filament sparse entries belong to `PresetDraftRegistry` and its existing
history root. Print sparse entries belong to the native project-embedded Print
preset through runtime-only `Preset::neo_vector_overrides`, captured in the
existing `nativePrintPreset` history root. Undo/Redo restores both effective
values and ownership, including equal values and explicit nil. The Orca
submodule adapter is edited and committed directly on `dev/orcaslicerneo-wasm`.

Ordinary 3MF export continues to flatten effective native config without a
Neo-private draft format. On import, ordinary changed vector options reconstruct
explicit ownership of all their valid indices. This preserves effective values;
per-index masks and explicit Source-equivalent writes cannot be recovered from
that flattened archive. Live history preserves those masks exactly.

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

## 4.2 Mutation, projection and cache constraints

- Sidebar Printer and Filament preset labels use the existing orange modified
  color when their canonical source has a nonempty native draft overlay. Every
  slot sharing the same Filament source highlights together. Empty drafts do
  not highlight; reset, selection changes, project replacement, and Undo/Redo
  refresh the projection through the existing atomic profile snapshot path.
  The snapshot carries required modified-source lists rather than fetching
  full editor metadata per sidebar slot. Dropdown choices and slot swatches
  retain their existing colors.
- Undo/Redo of a Printer transition invalidates every plate even when Process,
  rack, and project settings remain identical. A geometry-only history restore
  does not recalculate unchanged profile compatibility. Historical selections
  are restored exactly before compatibility flags are refreshed.
- Internal restore receipts require the current complete descriptor. Missing
  fields and unknown versions are errors, not compatibility fallbacks. Native
  history roots require their captured Printer and draft revision. Renderer
  command context remains distinct from native-owned historical roots.
- Native option metadata is immutable for the lifetime of the loaded module and
  is constructed once. Source values and effective draft values remain fresh.
- Notes-only draft changes retain one history entry and the existing all-plate
  result invalidation contract, but do not recompute bed geometry or tower
  placement. Reset operations use the actual changed override keys.
- Material usage scans reuse the native painting cache on the authoritative
  model across temporary plate-model copies. Cache validity remains governed by
  the native segmentation timestamp; history/model replacement does not retain
  pointers to discarded objects. Other configuration changes still recompute
  their required placement and validity state.
- The rollback Model copy remains necessary for atomic failure recovery;
  do not remove it as an unvalidated performance shortcut.
- Draft mutation receipts publish the complete committed Filament session,
  including recalculated flushing values. Updating only the revision token on
  the old renderer snapshot is insufficient for material configuration edits.

No persistence migration, new file format, host-specific behavior, or mobile
interaction is introduced. Both hosts retain their current desktop layout.

## 5. Deferred user preset management

Phase two may add Save As, rename, delete, user-repository persistence, and
preset-management surfaces. It must convert a selected runtime draft into an
explicit user action; phase one never performs that conversion implicitly.
