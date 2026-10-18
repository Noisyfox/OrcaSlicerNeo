# Extruder Switch and Variant Editing

**Date:** 2026-10-17

**Status:** Implemented in the shared Electron and Web application. Native
mappings, atomic resets, the diameter-editing boundary, and Printer, Filament
and Project Print selection are delivered. Objects-mode Scoped element editing
has passed both independent acceptance gates in section 10.1. Integrated
verification of those editor surfaces is complete under section 10.
Sidebar project-flow selection, repair, preferences and history are implemented
in section 3.4; final integrated acceptance is tracked in section 10.2. Improved
delayed rejection feedback after editor navigation remains deferred.

**Scope:** Extruder and variant selection for the shared Printer and Filament
preset editors, Project Print settings, and Objects-mode Scoped Print settings
for objects/instances and parts/modifiers. The dedicated Plates page remains
outside the element-editing extension. This is a peer specification to
[Grand Plan](Grand%20Plan.md), which remains the single delivery roadmap.

## 1. Ownership and accepted direction

This specification owns the relationship between an editor's selected extruder
or variant, the fields it presents, and their native configuration elements.
The [Preset Editor](Preset%20Editor%20Dialog.md) continues to own Printer/Filament
drafts, generic controls, and sparse element overrides.
[Project and Scoped Configuration](Project%20and%20Scoped%20Configuration.md)
continues to own Project Print configuration and its existing history root.

The accepted implementation direction is a native mapping projection with a
shared React interface:

- The Neo bridge reuses Orca's existing variant definitions and
  `DynamicPrintConfig::get_index_for_extruder()` to resolve native elements.
  TypeScript does not independently reproduce those mapping rules.
- The bridge supplies lightweight selection choices and field-binding metadata.
  Existing typed vector projections and element mutation mechanisms remain the
  foundation. This direction does not require a prerequisite Orca core change.
- Displayed values, Source values, tooltips, edits, override highlighting, and
  resets must resolve through the same field binding. A physical extruder ID
  is not assumed to equal an option's vector index.
  The dedicated Filament Setting Overrides page's inherited reference display
  and dependencies use its deliberately simplified
  [reference policy](Preset%20Editor%20Dialog.md#reference-values); this does not
  change the binding of the Filament value being edited.
- Category reset must support fields that resolve to different indices in one
  atomic operation, including shared fields in the same category.
- Print retains its existing Project-owned preset; this feature does not add a
  parallel Print draft or history root.
- Scoped element edits retain the selected objects' or volumes' native
  `ModelConfig` ownership and the existing atomic project transaction/history.
  They do not create a Print preset, another sparse sidecar, or an export domain.

The editor snapshot must provide enough native mapping metadata for all
presented choices to navigate using the existing typed Source/Effective vectors.
Category, extruder, and editing-flow navigation must not require a mutation or
a new native lookup before presenting the selected binding. Mapping metadata
identifies shared fields, resolved native elements, and unavailable mappings;
it does not duplicate complete value vectors for each choice.

The [shared architecture](Web-Electron%20Shared%20Application%20Architecture.md)
remains authoritative for package and host boundaries. Both Electron and Web
use the same feature implementation. Direct Emscripten access remains confined
to the typed client, with application features using the runtime boundary.
Mobile product support remains deferred.

## 2. Native Orca reference

The behavioral baseline is the native OrcaSlicer checkout reviewed at commit
`337460fea51e038adcca2b1a4eacac7ce5699591`, particularly
`Tab::update_extruder_variants()`, `Tab::generate_extruder_options()`,
`Tab::switch_excluder()`, and `Tab::update_variant_sizer_visibility()` in
`src/slic3r/GUI/Tab.cpp`.

This baseline differs from the GUI in Neo's currently pinned Orca submodule.
Its Printer editor uses one Extruder page and a switch labelled
`Extruder 1` through `Extruder N`. Neo adopts that single-page structure;
the older separate `Extruder N` pages are not the target interaction.

The reference establishes behavior to reproduce in the shared application;
wxWidgets controls and GUI code are not ported or built for WASM. Later upstream
changes do not silently revise the accepted behavior recorded here.

The Scoped extension also follows native `TabPrintModel::update_model_config()`
and `on_value_change()` in the pinned
[Tab.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/Tab.cpp): selected owners are
updated together, non-nil vector slots are local, resetting a slot writes nil,
and an all-nil option is erased. Neo retains its existing visible inheritance
paths; the native GUI's Plate overlay does not add Plate inheritance to Neo's
object/part editor. Native
[PrintConfig.cpp](../packages/slicer-wasm/cpp/src/libslic3r/PrintConfig.cpp)
and [PrintObject.cpp](../packages/slicer-wasm/cpp/src/libslic3r/PrintObject.cpp)
already apply these sparse object/region vectors during slicing, and
[bbs_3mf.cpp](../packages/slicer-wasm/cpp/src/libslic3r/Format/bbs_3mf.cpp)
serializes/deserializes the owners' existing configurations. This supports a
bridge-only extension; delivery must prove persistence and effective slicing,
not just editor receipts.

## 3. Selection model

| Editing surface | Meaning of selection |
| --- | --- |
| Printer preset editor | A physical extruder and its independently selected editing flow type; fields may bind to physical-extruder or variant elements. |
| Filament preset editor | A native Filament variant, identified by drive and nozzle-volume type rather than a physical extruder ID. |
| Project Print settings | A physical extruder and its applicable nozzle-volume variant; native Hybrid choices can expose separate SF/HF entries. |
| Objects-mode Scoped Print settings | The same project-flow-driven nozzle/variant context, applied to the selected object or sibling part/modifier owners; each target retains its own inheritance and local slots. |

The Filament switch exposes every variant in the edited preset's native
`filament_extruder_variant` list, in native order. It does not filter those
choices by the project's current Printer, so a variant that is unused by that
Printer can still be edited. This choice list belongs to the browsed Filament
preset and does not change project material assignments.

Each editing surface owns its selection independently. Selecting an extruder
in Printer does not select a corresponding entry in Filament or Project Print.
A Filament variant may serve multiple physical extruders and does not imply a
unique project-wide extruder selection.

Scoped owns one presentation selection for its current target set, independently
of Project, Printer and Filament views. Changing selected objects/instances or
sibling parts/modifiers retains the valid semantic nozzle/variant, with native
first-choice fallback, without a per-target cache. Hiding the switch or entering
another configuration mode retains that Scoped selection. A new/opened/reset
project and explicit Process preset entry initialize it to the first choice.
Ordinary receipts and Undo/Redo retain valid semantic identity as in section 3.3.

Within one editing surface, category navigation retains the selected entry.
For example, navigating between Printer Extruder and Motion ability continues
to address the selected extruder. This retention also applies while navigation
temporarily hides the switch.

Selection is presentation state: selecting an entry changes which native
elements are presented for editing and does not itself edit configuration,
change material assignments, or create a project-history entry.

### 3.1 Project flow and Printer editing flow

Project Print's nozzle choices and field bindings always follow the actual
project `nozzle_volume_type` context, including the native SF/HF choices for a
Hybrid nozzle. Printer-editor browsing cannot change that context.
The same rule governs Scoped choices; object/part overrides do not edit nozzle
flow, topology or material assignment.

The Printer preset editor instead keeps an editing flow choice for each
physical nozzle. Selecting a nozzle presents fields for that nozzle's editing
flow; selecting another editing flow changes that nozzle's parameter view.
Choices, defaults, and field mappings come from the browsed Printer preset's
native metadata, including its current draft. The project's actual flow is an
initialization input when entering its current Printer preset, not the source
of choices for every browsed preset.

The editing-flow choices are the SF/HF parameter variants actually supported
by that nozzle in the browsed preset. Hybrid is not a separate editing choice
or parameter group. A Hybrid project flow or native default initializes the
editing flow as SF, following Orca's native preset-index normalization.

These per-nozzle flow choices are presentation state. They do not change
project flow, edit the Printer draft or its default-flow fields, select a
different project preset, or create history entries. Each nozzle retains its
editing flow when another nozzle or category is selected.

### 3.2 Opening and preset changes

Opening or reopening an editor starts at its first available extruder/variant.
Closing discards its presentation selections; this feature adds no persistent
or per-preset selection cache.

When the Printer editor opens on or explicitly enters the project's current
Printer preset, initialize each nozzle's editing flow from the project's actual
flow, subject to that preset's native available choices and defaults. The user
can then select another editing flow independently. Ordinary receipt refreshes
do not repeat this initialization or overwrite a valid user choice. Returning
from another preset to the project's current preset initializes from project
flow again.

When switching to any other Printer preset, retain the currently selected
physical nozzle and per-nozzle editing flows wherever they remain available.
An unavailable physical nozzle falls back to the first available nozzle; an
unavailable editing flow falls back to the target nozzle's native default,
using the existing native normalization rules. Opening on another preset has
no previous choices to retain and starts with its native default flows. This
retention carries the current view forward rather than restoring an earlier
view cached for that preset.

An explicit Filament or Project Print preset change still selects its first
available variant/nozzle entry. All surfaces retain selection on category
navigation. Editing a Printer diameter in the dialog does not automatically
change its canonical source, as specified in section 5.3.

### 3.3 History and refreshed choices

Undo/Redo retains the currently viewed extruder/variant and Printer editing
flows while they remain available in the restored configuration. History does
not restore earlier presentation selections. An unavailable extruder/variant
falls back to the first available entry; an unavailable Printer editing flow
uses the nozzle's native default as above. Ordinary receipt publication does
not reset otherwise valid presentation choices.

Choice availability and a field's native mapping are distinct. A missing mapping
for an individual field does not select another nozzle or flow to make that
field editable. Section 5.2 governs its unavailable presentation, including when
native default-flow normalization cannot produce a valid field mapping.

### 3.4 Sidebar project-flow selection

The Sidebar flow combo changes the project's actual per-extruder
`nozzle_volume_type`, independently of the Printer editor's presentation-only
editing flows in section 3.1. The scope includes single- and multi-extruder flow
selection, Hybrid where offered by the native Sidebar rules, and the associated
project and Plate filament-volume mapping updates. Manual sub-nozzle quantity
editing, quantity badges and new device-synchronization capabilities are outside
this extension.

The implementation is bridge-owned native policy matching Orca's
Sidebar candidate rules. It does not require extracting a shared policy into
`libslic3r` or changing Orca GUI callers. TypeScript consumes the native choices
and does not reproduce the flow-eligibility rules. The reference is
`Sidebar::update_presets()` in
[Plater.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp), including its
per-extruder candidate construction and combo selection.

Preserve native Sidebar candidate order and actual enum values rather than
using dropdown positions as values. The HF and E3D HF diameter filters use the
effective Printer's `printer_variant` string, not each extruder's physical
`nozzle_diameter`: HF is excluded for `"0.2"` and for the X1E model exclusion;
E3D HF is offered only for `"0.4"` or `"0.6"`, subject to the other native candidate
rules. Editing a physical diameter alone does not redefine those filters.

When candidates exist but the current project flow is unavailable, Neo must
repair the actual project flow and associated mappings. Prefer that extruder's
`default_nozzle_volume_type` if it is an available candidate; otherwise choose
the first candidate in native Sidebar order. This intentionally differs from
Orca's combo-refresh path, which displays the last candidate without writing
that display fallback to the project.

When no candidates exist, hide the flow combo and preserve the current project
flow. Do not invent an available flow or perform an automatic repair without
a candidate.

Changing one extruder's actual flow updates the associated filament-volume
mappings on all Plates without changing other extruders' mappings. Hybrid remains
the project's selected flow but uses Standard in the corresponding concrete
filament-volume mappings, following Orca. Flow-driven flushing recalculation
respects the existing automatic-flushing policy: only the `all` policy recalculates
the affected extruder's flushing values; `color change` and `disabled` do not
trigger recalculation for a flow change. Other extruders' flushing values remain
unchanged. The reference is the flow branch of `Tab::on_value_change()` in
[Tab.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/Tab.cpp).

Automatic repair is silent: update the project state and its displayed values
without a toast or confirmation for the repair itself. Existing unsaved-project
protection still applies when the operation changes project state.

Remember the per-extruder flow vector across sessions, keyed by the base Printer
preset name, following Orca's
[Printer load and flow-selection paths](../packages/slicer-wasm/cpp/src/slic3r/GUI/Tab.cpp).
When creating a project or explicitly switching base Printer, restore its
remembered flows if present, otherwise use its defaults; validate restored values
against the candidates and apply the repair rule above. Persist Hybrid as Standard
in this preference only, leaving the current project's Hybrid flow unchanged.
Only an explicit user flow selection updates this preference. Project opening,
automatic repair, and Undo/Redo do not overwrite it. Flow preferences are global
application state and are not rolled back by project history.

Opening a 3MF gives the file's valid project flows priority over local flow
preferences. Do not overwrite a valid imported flow with a remembered value.
An unavailable imported flow is silently repaired using the same default-then-first
candidate rule, with associated mappings updated; an empty candidate list still
preserves the imported value. A repair on project open marks the project as having
unsaved changes instead of treating the repaired state as a clean load baseline.
Only an explicit successful project save writes the repair to a file, through the
existing [project persistence contract](3MF%20Project%20Persistence.md#project-identity-and-unsaved-changes).

A manual flow selection creates one project-history entry covering the flow,
associated mappings and flushing configuration together. Automatic repair creates
no separate history entry. When a user operation such as a diameter or Printer
change requires repair, include that repair in the initiating operation's atomic
state transition and restore its before/after state together on Undo/Redo. For
example, changing `0.4 / HF` to `0.2 / SF` through a diameter change and repair
undoes to `0.4 / HF`, not `0.4 / SF`. Repair during project opening likewise creates
no history entry, while still preserving the unsaved-change rule above. These
rules use the existing [project history](Undo%20and%20Redo.md) ownership boundary.

Undo/Redo restores the associated Printer configuration, project flows and mappings
together; it does not run an additional repair after restoring the historical
state. A flow that was available in a captured state must remain available when
that complete state is restored. A mismatch caused by incomplete capture or
restore is an implementation defect, not a reason to normalize history silently.

Repair belongs to project opening and committed configuration transitions that
change the active project's flow candidates. Reading snapshots or refreshing
controls must not mutate project state. Printer-editor flow browsing remains
presentation-only under section 3.1.

Acceptance must cover candidate order and enum identity, `printer_variant` versus
physical diameter filtering, Hybrid and nullable nozzle-count rules, empty
candidates, default-then-first repair, all-Plate mapping updates and affected-head
flushing under every policy. Real native history and 3MF tests must prove atomic
Undo/Redo, no independent repair entry, repaired-open dirty state, and preservation
of valid imported flows. Preference tests must distinguish explicit selections
from import, repair and history, including Hybrid-to-Standard persistence. Both
shared hosts use the same implementation; mocked UI results alone do not establish
native mapping, persistence or history correctness.

Current delivered Sidebar layout is described by
[Application Shell](Application%20Shell.md#native-toolhead-selection-and-editing).

## 4. Switch visibility

Project Print uses a compact, full-width horizontal nozzle strip. Each choice
shows its one-based physical nozzle number above the effective project diameter
and native flow label (SF, HF, XHF, or another supported flow). Hybrid entries
for the same physical nozzle remain separate SF/HF choices. The strip uses the
primary selected colour, scrolls horizontally with ordinary wheel input under the
[global horizontal-list rule](Application%20Shell.md#overflowing-tab-bars), supports keyboard
focus and activation, and keeps the selected choice visible after selection or
resize. Its leading nozzle glyph has no action; cross-extruder sync/copy remains
deferred. Pure Printer/Filament variant selectors use the same horizontal strip
and navigation behavior with text-only variant choices, without physical
nozzle numbers or diameters. The native choice labels and ordering are retained.

Project Print and Objects-mode field labels reserve an aligned nozzle-icon gutter
only when there are multiple native extruder/variant choices. A printer with
only one effective choice shows neither option glyphs nor their empty gutter.
Glyphs stay close to their labels in a narrow gutter, with a small downward
optical offset to center them against each row's text.
Only native `per_selection` fields receive the glyph, including an individually unavailable
mapping; shared fields leave the gutter empty. Object/Part views use their
existing native owners with this same strip and aligned glyph gutter. The
dedicated Plates page retains its current presentation.

Printer and Filament preset field labels use the same nozzle glyph and aligned
gutter only while their extruder/variant selector is visible, including in
search results. Only native `per_selection` fields receive the glyph, including
unavailable mappings; shared fields leave the gutter empty. Hiding the selector
also removes the field glyphs and their gutter.

A switch is visible when selection is applicable and the active category
contains fields that participate in its extruder/variant mapping. Visibility is
derived from those bindings rather than a hard-coded list of category names.

Printer Extruder and Motion ability are examples of applicable categories.
Categories containing only shared fields, such as Printer Notes, hide the
switch. Hiding it does not clear the selected entry; returning to an applicable
category restores the same selection while it remains valid.

Shared fields retain their shared configuration meaning when displayed beside
mapped fields. Selecting an extruder does not manufacture per-extruder copies
of those fields.

The Printer selector is applicable when the edited preset has multiple physical
nozzles or its single nozzle has multiple supported editing flows. A single
nozzle with only one editing flow hides the selector. Hidden selectors still
use their valid selection/default for field binding.

### 4.1 Multiple Printer nozzles

For multiple nozzles, the Printer switch uses one selectable card per physical
nozzle, following the sidebar nozzle-card presentation owned by
[Application Shell](Application%20Shell.md#native-toolhead-selection-and-editing).
The card keeps the nozzle number and effective diameter, with a flow dropdown
replacing the lower flow-text line. That dropdown displays the nozzle's current
editing flow rather than the project's actual flow.

Selecting the card presents that nozzle using its retained editing flow.
Choosing a flow from a card's dropdown also selects that nozzle and immediately
presents its corresponding parameters, including when another nozzle was
previously selected. Opening the dropdown alone does not change selection.
The immediate navigation rules in section 7 also apply to flow selection.

### 4.2 Single Printer nozzle

When a single nozzle supports multiple editing flows, present the editing-flow
choices in a flat horizontal list using the shared nozzle-strip selected style,
keyboard navigation, wheel scrolling and selected-item visibility on resize.
It shows only the editing-flow choice, with no nozzle number, diameter, or
nozzle-card layout. Its choices, initialization, isolation from project flow,
and immediate navigation follow the same contracts as the multi-nozzle flow
dropdowns. The complete Filament variant list uses this same presentation.

## 5. Native field binding

Field indices follow Orca's current native rules. In particular, motion-limit
parameters retain their native two-element stride per variant. A single group
of visible controls does not change that stride, compact the vectors, or make
the physical extruder number the motion-limit index.

### 5.1 Motion-limit presentation

The interface exposes one group of motion-limit values for the current
selection, without any Silent-related option, toggle, selector, or additional
column. The native reference defaults `silent_mode` to false and treats it as
obsolete during configuration import; retained two-column GUI code does not
establish a requirement to expose that capability in Neo.

Reads, edits, tooltips, highlighting, and resets for the visible motion fields
use their resolved native indices. Other native elements retain their values
and ownership when those fields are edited or reset.

### 5.2 Unavailable mappings

A field with no native element mapping for the current selection remains in
the category as a read-only, unavailable field. Its presentation explains that
the selection has no corresponding mapping. Other fields with valid bindings
remain usable under their ordinary editing rules.

The unavailable field must not display, edit, highlight, or reset an element
belonging to another selection. It offers no field reset and contributes no
target to category reset. The category's other valid, resettable bindings still
participate in their normal atomic reset.

Missing mapping is distinct from a short serialized vector: once native mapping
has resolved a valid index, the existing bounded first-element fallback for a
nonempty short vector remains authoritative. Missing mapping must not invent
index zero or otherwise substitute another selection's binding.

### 5.3 Diameter-editing entry points

Sidebar toolhead-size dropdowns retain their existing automatic Printer-preset
matching and toolhead-transition behavior, owned by
[Application Shell](Application%20Shell.md).

Editing `nozzle_diameter` directly in the Printer preset dialog instead changes
the corresponding element of the current preset's draft, under the existing
native field validation and mutation contract. The editor retains the same
canonical preset identity; the field edit does not search for or automatically
select another Printer preset. Accepted values remain effective through the
existing draft and explicit preset-save lifecycle.

The native editor mutation writes the active or browsed source's draft directly.
The sidebar command owns its separate toolhead transaction and automatic
matching. These entry points remain distinct when selection controls are added.

### 5.4 Process dirty indicators

Project Print nozzle choices show both label lines in the semantic modified
colour when that choice owns a per-selection override on the active supported
settings page. The marker scans that page's unfiltered fields, so search does
not conceal an override merely by hiding its field. Other pages and shared
settings do not mark that nozzle; selecting a dirty choice retains the primary
selected background.

The complete Process profile's modified indicator and Reset All availability
are independent of the selected nozzle, active page, search and individual
mapping availability. They aggregate native Print-owned local settings and
all explicit vector element ownership, including an explicit Source-equivalent
or null value and unexposed Print options. Other domains in the native Project
map, such as bed type and Printer flow/routing, do not make Process dirty.
Missing mappings do not mark another choice, and short-vector value fallback
does not supply ownership for an unowned index. Field, group and tab highlights
retain their existing selected-binding scope; field/category resets still
preserve every other selection's ownership. Reset All keeps its existing
native whole-Process reset rules.

Scoped uses the same marker presentation, but only local ownership of the
selected target set counts: a nozzle is dirty if any selected target owns a
mapped slot on the active supported page. Inherited Project or Object edits do
not mark a child target as locally dirty. Whole-target dirty/Reset All aggregates
supported local ownership across the selected targets, nozzles and pages,
independently of search, selected nozzle and missing individual mappings. Shared
local fields affect whole-target dirty without marking all nozzle choices.

Scoped nil slots mean inheritance. They are projected as unowned `null` entries
in `overrideValues`, never as Project's explicitly owned `{value: null}`.
Non-nil local values equal to Source remain explicitly owned. Missing/short
slots cannot acquire ownership through a display-value fallback. A native
already-local non-nil singleton, however, applies to every variant: before a
single-slot edit/reset the bridge preserves that existing native ownership by
normalizing its local values, not by copying inherited parent values into nil
slots. A parent change must still flow through every slot that remains inherited.

## 6. Category reset

`Reset category` restores the category's resettable fields from their existing
Source/inheritance baseline as one atomic, undoable operation:

- Each extruder/variant field resets only the element resolved for the current
  selection. Other selections retain their edits and ownership.
- Shared fields in that category reset once along with those mapped elements.
  Because a shared field has one configuration value, restoring it affects all
  extruders that use that value.
- Fields outside the category are not part of the reset. The operation does
  not become an all-extruder or whole-preset reset.

For example, with independently modified T1 and T3 retraction parameters,
resetting Extruder while T3 is selected retains T1's modifications. Resetting
Motion ability while T3 is selected also restores that category's shared
settings, such as `emit_machine_limits_to_gcode`.

The explicit batch must express each target field's resolved index, or its
shared-field reset, and validate the complete request before changing state.
Partial success is not an accepted outcome. Existing native ownership and
history remain authoritative; issuing a sequence of independent field resets
does not meet the category-reset contract.

For Scoped multi-selection, that same explicit field batch applies atomically
to every captured target. Indexed resets clear only those local slots; shared
resets erase the selected owners' shared keys. Reset All removes supported
local settings from the selected owners only. Parents and unselected targets
are preserved. One accepted command is one undoable operation; a missing target,
unsupported field, malformed/duplicate target or field, invalid type/index/value,
or stale revision rejects the whole command before publication/history.

## 7. Input and navigation ordering

Extruder/variant switching follows Neo's setting-category tabs. With an
available editor snapshot and a valid destination, switching is immediate even
after editing a field, while a field submission is pending, or when a field
contains invalid input. Field validation and pending mutations are not reasons
to disable the extruder/variant switch. Existing snapshot-loading and refresh
availability rules remain applicable.

The existing Enter/blur submission behavior still applies. If leaving a field
starts a submission, navigation does not wait for its result, require another
click, or become a deferred navigation request. Invalid input does not block
navigation or become an accepted configuration value. Field-local input and
validation feedback must not migrate to the same option on another
extruder/variant.

An already dispatched mutation remains bound to the preset, option, and native
element index captured for that submission. Changing the viewed selection does
not cancel the mutation or retarget it to the newly viewed element. Its result
updates the authoritative editor/configuration snapshot without restoring the
previously viewed selection. Field-local success or failure feedback must not
be applied to a different binding after navigation.

Immediate navigation does not permit concurrent writes against stale revisions;
the existing mutation serialization and edit-control busy behavior remain in
force. Switching to a different preset retains the preset picker's existing
pending-submission and invalid-input guards; those guards are not imposed on
category or extruder/variant navigation.

### 7.1 Revisions, failures, and deferred feedback

Revision validation, mutation serialization, rollback, and receipt publication
retain the existing [Preset Editor](Preset%20Editor%20Dialog.md) and
[Project and Scoped Configuration](Project%20and%20Scoped%20Configuration.md)
contracts. A view change does not retry an operation against another revision
or change its captured targets. A refreshed snapshot revalidates current
presentation choices under section 3 rather than resetting valid selections.

Scoped submissions also capture their object/part IDs, target-set identity and
native revision. Target navigation changes the view immediately; any required
read for the new target set uses the existing command FIFO without redirecting
an earlier write. Until that read is current, old-target values are not editable
as the new target. Late reads/receipts cannot restore an old target/nozzle or
transfer field drafts/errors to another binding. Nozzle navigation within a
loaded Scoped snapshot requires no native lookup or write.

An edit that committed before projection resynchronization failed remains a
committed edit. The existing editor recovery contract continues to acknowledge
its receipt, report the refresh error, and disable further edits until reopening;
the mutation is not resubmitted. This feature does not introduce another
recovery path.

Ordinary rejection feedback after leaving a field follows the current
category-tab behavior. A new cross-selection notification, retained rejection
store, or restoration of rejected field text on return is deferred. Delivery
does not require such feedback to remain visible after navigation. This deferral
does not permit rejected values to enter configuration or old feedback to appear
on another selection's field.

## 8. Scope boundaries

Selection is implemented for Printer, Filament, Project Print and Objects-mode
object/instance and part/modifier element editing under the existing selection
rules. Dedicated Plate element
editing, invalid/mixed-hierarchy selections and new assignment/topology controls
remain outside scope; an invalid Objects selection never falls back to Project.
The existing manifest/catalogue still determines which fields are exposed;
mapping metadata does not expose every native option automatically.

Orca's adjacent cross-extruder synchronization/copy button is a separate
capability and is not included in this accepted direction. The switch also
does not add preset management, material-to-extruder assignment controls, or
printer topology editing.

## 9. Acceptance and verification

Implementation must establish the following behavior; these are required checks,
not evidence that the feature has been delivered:

| Area | Required coverage |
| --- | --- |
| Native bindings | A real multi-nozzle preset such as U1 distinguishes physical, variant, and motion indices for SF/HF. Other nozzles, flow variants, and unexposed motion slots retain their values and ownership. |
| Consistent projections | Source, Effective, tooltips, edits, resets, search, and selected-field/group/category highlighting address the same binding. Explicit Source-equivalent element ownership remains observable. |
| Flow isolation | Each Printer nozzle retains its own editing flow. Viewing another flow creates no configuration/history change and cannot change Project Print's actual flow choices. Hybrid initializes the editor as SF. |
| Selection transitions | Project-current Printer entry initializes from project flow; other Printer presets retain valid choices and use native defaults when unavailable. Filament exposes its complete native variant list. Category navigation, Undo/Redo, and close/reopen follow section 3. |
| Presentation | Multi-nozzle cards, the pure-variant horizontal strip, the single-choice hidden state, and category-dependent visibility follow section 4. Hidden state retains its selection. |
| Immediate navigation | Valid input, invalid input, and a pending submission do not require a second click to change nozzle/flow. Delayed receipts affect their captured bindings and do not redirect the view or leak local field state. |
| Atomic reset | A category containing mixed native indices and shared fields resets once, preserves other selections, and creates one undoable operation. Rejection cannot leave a partially reset category. |
| Missing data | Missing native mappings are read-only and excluded from reset. A valid mapping with a short vector retains the existing bounded value fallback; missing mappings never substitute index zero. |
| Diameter entry points | Direct editor diameter changes retain the current canonical preset and draft. Sidebar toolhead-size changes retain automatic preset matching and their existing transition behavior. |

The existing [indexed-editor smoke coverage](../packages/slicer-wasm/harness/extruder-indexed-editor-smoke.mjs)
checks real native mappings, mixed-index reset, ownership and history. Shared
component tests cover selection transitions, presentation, and controlled
pending/rejected responses. The [Electron editor journeys](../apps/desktop/e2e/preset-editor.e2e.ts)
and [Web settings journeys](../apps/web/e2e/project-settings.e2e.ts) exercise the
native-exported Hybrid fixture through their respective host boundaries, with
artifact identity and runtime-variant checks. Mocked UI evidence does not
replace real native index/ownership verification.

Sidebar flow coverage uses the [native picker policy harness](../packages/slicer-wasm/harness/printer-picker-smoke.mjs)
and [native transition/lifecycle harness](../packages/slicer-wasm/harness/native-printer-transition-smoke.mjs)
for enum identity, mapping/flushing policy, atomic rejection/history, repair and
native 3MF round trips. The [real Electron flow journey](../apps/desktop/e2e/project-flow.e2e.ts)
uses a small native-exported two-head, two-Plate fixture with the current serial
artifact. It checks rendered Project/Scoped contexts, manual flow history,
valid-file priority, repaired-open dirty state, explicit save/reopen, and global
preference boundaries. The [Web settings journey](../apps/web/e2e/bed-type-selector.e2e.ts)
checks browser preference persistence through reload and the qualified serial
fallback runtime. Threaded native startup/shared-memory and focused flow
policy/command parity supplement that primary-host journey. This focused
coverage does not claim the full dual-host, dual-variant release matrix.

Verification scope follows the [testing guidelines](../doc/testing_guidelines.md):
affected package checks during implementation; repository checks, a primary-host
journey, and affected real-WASM host integration before code handoff. Common
bridge changes require both WASM quick builds, comprehensive contract coverage
on one variant, and variant-specific smoke on the other. Full release
qualification remains the repository's release gate. Documentation-only work
does not claim any of this product coverage.

## 10. Implementation and acceptance steps

Implementation proceeds in the following independently verifiable increments,
on the dedicated feature branch. One `gpt-6.1-sol` agent with `high` reasoning
implements every increment, including repairs and self-verification. The parent
independently reviews the resulting diff and verifies the acceptance criteria.
Only after parent acceptance may that increment be committed and the same agent
receive the next increment. The implementation agent must not commit, start a
later increment early, or delegate to another agent. Rejected increments return
to the same agent for repair and renewed verification.

| Step | Complete deliverable | Acceptance gate | State |
| --- | --- | --- | --- |
| 1. Native mapping projection | Native Printer, Filament, and Project Print snapshots expose complete selection/default metadata and shared/indexed/unavailable field bindings. Typed client, runtime, mocks, and fixtures use one contract. Existing UI remains functional. | Real-WASM checks distinguish U1 physical/variant/motion indices, browsed versus project Printer context, native defaults/Hybrid normalization, full Filament variants, missing mappings, and valid short vectors. Affected package suites/typechecks and the applicable quick build pass. Parent reviews the mapping oracle and independently exercises the projection. | Accepted |
| 2. Atomic mutations and diameter boundary | Add one validated mixed-index/shared-field category-reset operation for preset drafts and Project Print. Direct Printer-editor diameter changes edit the current draft instead of entering sidebar matching. | Real native edits/reset preserve other elements and explicit ownership; invalid batches are atomic; one accepted reset is one history entry and Undo/Redo restores it. An editor diameter edit keeps canonical identity even when another matching preset exists; sidebar matching retains its current behavior. Affected package checks and native build/smoke pass, then parent independently verifies both boundaries. | Accepted |
| 3. Printer editor | Deliver the single Extruder page, native bindings throughout the field presentation, multi-nozzle cards, single-nozzle variant strip, independent per-nozzle editing flows, selection transitions, and mapped category reset. | Component tests and a focused primary-host journey cover SF/HF isolation, active/inactive presets, fallback defaults, category visibility, single-nozzle cases, selected ownership/highlights, immediate navigation during invalid/pending edits, and captured mutation bindings. Parent reviews state lifetime and independently tests the rendered interaction. | Accepted |
| 4. Filament and Project Print surfaces | Apply the shared variant/binding presentation to the complete Filament variant list and Project Print nozzle choices. Print retains its current native owner and uses actual project flow; other scoped element extensions remain deferred. | Tests demonstrate no project-Printer filtering of Filament variants, Project-flow-driven Print choices including Hybrid, independent surface selections, correct reads/edits/reset/highlights, and native history/ownership. Affected package checks and focused host integration pass before independent parent acceptance. | Accepted |
| 5. Integrated delivery | Complete the real-runtime regression journeys and reconcile delivery statements in existing specifications. Repair any integration findings through the same implementation agent. | Repository tests/typechecks, the primary shared-UI journey, affected real-WASM host integration, both quick builds, comprehensive native coverage on one variant, and variant-specific smoke on the other meet section 9 and the testing guidelines. Parent independently reviews the complete feature and reruns decisive integration checks before the final commit. | Accepted |

Each step also requires `git diff --check` and verification of changed local
links/commands. Required evidence and unresolved failures are reported at its
handoff; execution logs remain in test artifacts and commit messages rather than
this document. Update each state only after the corresponding acceptance event.
Existing specifications are updated in place; this work adds no planning or
verification documents. Grand Plan changes only if delivered work changes its
roadmap or milestone status.

### 10.1 Objects-mode Scoped extension

These two accepted gates extend the delivered feature. Increment A's native/client
contract and increment B's production UI integration have passed independent
acceptance. The single-agent, parent-acceptance and commit ordering rules above
were retained; increment B started after A was accepted and committed.
The read/mutation boundary is specified in
[Scoped Configuration section 3.1](Project%20and%20Scoped%20Configuration.md#31-objectpart-indexed-contract).

| Increment | Complete deliverable | Independent acceptance gate | State |
| --- | --- | --- | --- |
| A. Native Scoped indexed contract | Add one typed selected-target editor read with native project-flow choices and per-target inherited Source, Effective, local ownership and source scopes. Extend the canonical `set-element`/`reset-fields` commands to Object/Part target sets using native nullable `ModelConfig` storage, preserving the existing owner/history/export path. Update bridge, typed client/runtime, mocks and fixtures together. Existing whole-option Scoped UI remains functional. | Real native regressions and native-to-typed-client decoding prove multi-object and part/modifier Source composition, distinct SF/HF/Hybrid mappings, mixed indexed/shared atomic writes/resets, full-batch rollback including a late invalid target, revision checks, one history entry/Undo/Redo, nil versus Source-equivalent ownership, native singleton normalization and sparse/short/unavailable handling. Change parents after edit/reset to prove unowned slots still inherit. Native 3MF export/reopen and actual slicing verify persisted sparse values/ownership and effective object/region results. Affected package suites/typechecks, both native quick builds, comprehensive scoped contracts on one variant and startup/thread/fallback smoke on the other pass before parent review. | Accepted |
| B. Scoped surface and integrated delivery | Wire the shared strip/glyphs/native fields to Objects-mode single/multiple objects/instances and valid sibling parts/modifiers. Preserve per-target Source/mixed handling, union local dirty markers, selection lifetime, current-element/shared category resets, whole-selected-target Reset All, immediate target/nozzle navigation and captured pending writes. Keep Project/Printer/Filament and dedicated Plates behavior intact. Reconcile delivery prose. | Component/runtime tests cover mixed values and source scopes, parent versus local ownership, two dirty targets/nozzles, category/all reset and history, search/page scope, single-choice/hide/overflow, missing/short bindings, semantic reconciliation, invalid/pending target changes and delayed receipts. Repository suites/typechecks and a fresh real primary-host journey prove native multi-selection editing/reset/history, current assets/variant and rendered icon/orange behavior. Existing Project/Printer/Filament/Plate regressions remain green. Parent independently reviews and reruns decisive integration before commit. | Accepted |

Native build/test procedure follows the existing driver help and testing guide:
quick-build both variants with the Windows driver, extend the existing indexed
editor and native scoped mutation/precedence/interoperability harnesses rather
than introducing another runner, and stage/build/copy before real-host testing.
Production changes stay in the Neo bridge unless a demonstrated native-core
blocker requires a separately accepted submodule change. Mock results never
stand in for native storage, slicing or 3MF round-trip evidence.

### 10.2 Sidebar project-flow extension

Section 3.4 is implemented in the following independently verifiable increments
on `dev/extruder-flow-combo-spec`. One `gpt-6.1-sol` agent with `medium` reasoning
implements every increment, including repairs and self-verification. This is the
flow extension's execution policy; the already accepted earlier increments retain
their historical execution policy above. The implementation agent must not commit,
delegate, or begin a later increment before the parent accepts and commits the
current one. A failed self-check or parent acceptance returns to the same agent
for repair and renewed verification. Parent acceptance requires independent source
review and execution of decisive checks, not only the agent's report.

| Increment | Complete deliverable | Independent acceptance gate | State |
| --- | --- | --- | --- |
| 1. Read-only native flow choices | Project each physical extruder's Sidebar flow candidates, actual flow and base Printer identity from effective native configuration. Update the typed client/runtime, mocks and fixtures as one contract. Keep the current flow controls read-only. | Native tests prove ordered enum identities, drive matching, Hybrid/nil gates, `printer_variant` rather than physical diameter filtering, X1E, sparse/empty lists, and pure reads without project/history changes. Affected package suites/typechecks and one variant's quick build/focused harness pass. Parent independently checks the policy against Orca and reruns decisive native cases. | Accepted |
| 2. Atomic manual flow mutation | Add one validated, revision-checked native flow command through the typed client/runtime. Commit project flow, all-Plate filament-volume mappings, policy-controlled affected-head flushing, invalidation and the complete publication receipt atomically. Do not switch Printer presets or alter editor-only browsing selections. | Real native tests prove head isolation, Hybrid-to-Standard concrete mappings, all flushing policies and unaffected planes, invalid/stale request rollback, one history entry and exact Undo/Redo. Affected package suites/typechecks and native quick build/focused harness pass. Parent independently exercises mutation, failure and history cases before commit. | Accepted |
| 3. Preferences, repair and project lifecycle | Implement base-Printer flow memory and its host-neutral storage contract. Restore memory only for new projects/explicit base-Printer changes; write it only for manual selections, with Hybrid stored as Standard. Integrate silent default-then-first repair into candidate-changing transactions and project opening, preserving valid file flows, marking repaired opens dirty, and creating no standalone repair history entry. Reads and history restores never repair. | Unit tests cover preference admission, lifetime, shared-host serialization and failed persistence boundaries. Real native cases prove repaired/empty candidates, active versus browsed drafts, transaction-coupled Undo/Redo, valid import priority, repaired-open dirty state without extra history, unchanged preferences on import/repair/history, and save/reopen round trips. Affected package checks and native quick build/harness pass, followed by parent review and independent lifecycle tests. | Accepted |
| 4. Shared Sidebar controls | Enable existing single-nozzle and selected-toolhead flow Selects using native candidates and the flow command. Hide empty controls, retain existing layout and operation guards, publish one coherent receipt, refresh Project/Scoped flow contexts, and persist only an explicit accepted selection. Preserve independent Printer editing-flow browsing and other surfaces' valid selections. | Component tests and focused primary-host interaction cover both controls, actual enum values, empty choices, pending/rejected operations, flow context refresh, head/tab retention, project dirty state and preference writes. Affected package suites/typechecks and a primary-host journey pass. Parent independently reviews and exercises rendered integration before commit. | Accepted |
| 5. Integrated delivery | Extend existing regression journeys for the complete flow lifecycle, repair integration findings through the same agent, and reconcile delivered/deferred statements in existing specifications. Add no planning or verification document. | Repository `pnpm test`/`pnpm typecheck`, both native quick builds, comprehensive flow/native contracts on one variant and startup/threading/fallback smoke on the other pass. A fresh real primary-host flow journey and affected Web/Electron host seams prove current artifacts, flow edits, history, import/save and preference boundaries under the testing guidelines. Parent independently inspects the complete diff and reruns decisive integrated checks before the final commit. | Accepted |

Every increment also requires `git diff --check` and verification of changed
local documentation links and commands. Record execution evidence in commit/PR
handoff results, not a new document. Mark an increment accepted only after parent
acceptance. Both hosts and both WASM variants share one current contract; no
legacy aliases or temporary response formats are introduced between increments.
Grand Plan changes only if delivered work changes roadmap or milestone status.
