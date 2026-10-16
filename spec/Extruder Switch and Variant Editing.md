# Extruder Switch and Variant Editing

**Date:** 2026-10-16

**Status:** Accepted design direction and selection/navigation behavior;
remaining editing, lifecycle, and acceptance decisions are open. Not implemented.

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
  atomic operation. The detailed reset scope remains an open decision.
- Print retains its existing Project-owned preset; this feature does not add a
  parallel Print draft or history root.

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
| Printer preset editor | A physical extruder whose fields may bind to physical-extruder or variant elements. |
| Filament preset editor | A native Filament variant, identified by drive and nozzle-volume type rather than a physical extruder ID. |
| Project Print settings | A physical extruder and its applicable nozzle-volume variant; native Hybrid choices can expose separate SF/HF entries. |

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

Selection lifetime across closing/reopening an editor, changing the edited
preset, or changing printer topology is not established by category-navigation
retention and remains open.

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

## 5. Scope boundaries

The accepted feature covers Printer, Filament, and Project Print selection.
Object, Part, and Plate element-editing extensions are outside this scope.
The existing manifest/catalogue still determines which fields are exposed;
mapping metadata does not expose every native option automatically.

Orca's adjacent cross-extruder synchronization/copy button is a separate
capability and is not included in this accepted direction. The switch also
does not add preset management, material-to-extruder assignment controls, or
printer topology editing.

## 6. Open decisions

The following contracts still require clarification before implementation:

- Detailed field binding and flow/motion-mode presentation, category-reset
  scope, and treatment of shared and hidden fields during reset.
- Selection initialization and invalidation when an editor or preset changes,
  pending/invalid input behavior, revision changes, and failure recovery.
- Required behavioral acceptance cases and applicable native/host verification.

Open decisions are not implemented guarantees. The existing editor and scoped
configuration contracts remain in force until an explicitly accepted extension
replaces the relevant behavior. Verification scope follows the
[testing guidelines](../doc/testing_guidelines.md).
