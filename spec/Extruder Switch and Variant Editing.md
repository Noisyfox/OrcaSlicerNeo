# Extruder Switch and Variant Editing

**Date:** 2026-10-16

**Status:** Accepted design; not implemented. Improved delayed rejection
feedback after navigation remains deferred.

**Scope:** Extruder and variant selection for the shared Printer and Filament
preset editors and Project Print settings. This is a peer specification to
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
- Category reset must support fields that resolve to different indices in one
  atomic operation, including shared fields in the same category.
- Print retains its existing Project-owned preset; this feature does not add a
  parallel Print draft or history root.

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

## 3. Selection model

| Editing surface | Meaning of selection |
| --- | --- |
| Printer preset editor | A physical extruder and its independently selected editing flow type; fields may bind to physical-extruder or variant elements. |
| Filament preset editor | A native Filament variant, identified by drive and nozzle-volume type rather than a physical extruder ID. |
| Project Print settings | A physical extruder and its applicable nozzle-volume variant; native Hybrid choices can expose separate SF/HF entries. |

The Filament switch exposes every variant in the edited preset's native
`filament_extruder_variant` list, in native order. It does not filter those
choices by the project's current Printer, so a variant that is unused by that
Printer can still be edited. This choice list belongs to the browsed Filament
preset and does not change project material assignments.

Each editing surface owns its selection independently. Selecting an extruder
in Printer does not select a corresponding entry in Filament or Project Print.
A Filament variant may serve multiple physical extruders and does not imply a
unique project-wide extruder selection.

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

## 4. Switch visibility

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

When a single nozzle supports multiple editing flows, use an ordinary variant
dropdown, following the sidebar's single-nozzle control presentation. It shows
only the editing-flow choice, with no nozzle number, diameter, or nozzle-card
layout. Its choices, initialization, isolation from project flow, and immediate
navigation follow the same contracts as the multi-nozzle flow dropdowns.

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

This is an accepted change to the delivered editor's current forwarding into
the sidebar-style toolhead transaction, and is not yet implemented. The two
entry points must remain distinct when the switch feature is delivered.

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

The accepted feature covers Printer, Filament, and Project Print selection.
Object, Part, and Plate element-editing extensions are outside this scope.
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
| Presentation | Multi-nozzle cards, the single-nozzle variant dropdown, the single-choice hidden state, and category-dependent visibility follow section 4. Hidden state retains its selection. |
| Immediate navigation | Valid input, invalid input, and a pending submission do not require a second click to change nozzle/flow. Delayed receipts affect their captured bindings and do not redirect the view or leak local field state. |
| Atomic reset | A category containing mixed native indices and shared fields resets once, preserves other selections, and creates one undoable operation. Rejection cannot leave a partially reset category. |
| Missing data | Missing native mappings are read-only and excluded from reset. A valid mapping with a short vector retains the existing bounded value fallback; missing mappings never substitute index zero. |
| Diameter entry points | Direct editor diameter changes retain the current canonical preset and draft. Sidebar toolhead-size changes retain automatic preset matching and their existing transition behavior. |

Extend the existing [indexed-editor smoke coverage](../packages/slicer-wasm/harness/extruder-indexed-editor-smoke.mjs)
with real native mapping and mixed-index reset checks. Shared component tests
cover selection transitions, presentation, and controlled pending/rejected
responses. Mocked UI evidence does not replace real native index/ownership
verification.

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
| 1. Native mapping projection | Native Printer, Filament, and Project Print snapshots expose complete selection/default metadata and shared/indexed/unavailable field bindings. Typed client, runtime, mocks, and fixtures use one contract. Existing UI remains functional. | Real-WASM checks distinguish U1 physical/variant/motion indices, browsed versus project Printer context, native defaults/Hybrid normalization, full Filament variants, missing mappings, and valid short vectors. Affected package suites/typechecks and the applicable quick build pass. Parent reviews the mapping oracle and independently exercises the projection. | Not started |
| 2. Atomic mutations and diameter boundary | Add one validated mixed-index/shared-field category-reset operation for preset drafts and Project Print. Direct Printer-editor diameter changes edit the current draft instead of entering sidebar matching. | Real native edits/reset preserve other elements and explicit ownership; invalid batches are atomic; one accepted reset is one history entry and Undo/Redo restores it. An editor diameter edit keeps canonical identity even when another matching preset exists; sidebar matching retains its current behavior. Affected package checks and native build/smoke pass, then parent independently verifies both boundaries. | Not started |
| 3. Printer editor | Deliver the single Extruder page, native bindings throughout the field presentation, multi-nozzle cards, single-nozzle variant dropdown, independent per-nozzle editing flows, selection transitions, and mapped category reset. | Component tests and a focused primary-host journey cover SF/HF isolation, active/inactive presets, fallback defaults, category visibility, single-nozzle cases, selected ownership/highlights, immediate navigation during invalid/pending edits, and captured mutation bindings. Parent reviews state lifetime and independently tests the rendered interaction. | Not started |
| 4. Filament and Project Print surfaces | Apply the shared variant/binding presentation to the complete Filament variant list and Project Print nozzle choices. Print retains its current native owner and uses actual project flow; other scoped element extensions remain deferred. | Tests demonstrate no project-Printer filtering of Filament variants, Project-flow-driven Print choices including Hybrid, independent surface selections, correct reads/edits/reset/highlights, and native history/ownership. Affected package checks and focused host integration pass before independent parent acceptance. | Not started |
| 5. Integrated delivery | Complete the real-runtime regression journeys and reconcile delivery statements in existing specifications. Repair any integration findings through the same implementation agent. | Repository tests/typechecks, the primary shared-UI journey, affected real-WASM host integration, both quick builds, comprehensive native coverage on one variant, and variant-specific smoke on the other meet section 9 and the testing guidelines. Parent independently reviews the complete feature and reruns decisive integration checks before the final commit. | Not started |

Each step also requires `git diff --check` and verification of changed local
links/commands. Required evidence and unresolved failures are reported at its
handoff; execution logs remain in test artifacts and commit messages rather than
this document. Update each state only after the corresponding acceptance event.
Existing specifications are updated in place; this work adds no planning or
verification documents. Grand Plan changes only if delivered work changes its
roadmap or milestone status.
