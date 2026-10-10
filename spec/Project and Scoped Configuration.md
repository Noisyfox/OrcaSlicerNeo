# Project and Scoped Configuration

**Status:** Final user experience; delivered in the shared Electron and Web application.
**Last updated:** 2026-10-10

This specification records the final behavior visible to users. Project-wide and
selection-scoped configuration share one settings surface and follow OrcaSlicer's
configuration behavior.

## 1. Project and Scoped modes

The `Project | Scoped` switch appears inside the configuration panel, above
the target label and configuration options. Immediately below the switch,
Project shows the Process preset selector; Scoped shows the object list.

The first accepted Process parameter change that changes the effective value
creates and selects a native project-embedded child of the selected source
profile. Process edits belong to that child; they must not be moved into the
original source profile's edited preset. The child's native identity and values
remain authoritative for slicing, Undo/Redo, and 3MF save/reopen.

The Process selector displays that selected child in its source profile's row,
using the source's native label and full name for the trigger and item tooltips.
Process display labels use the native alias/name without the native dirty
`(modified)` decoration. This also applies when an ordinary 3MF restores its
Process differences directly into an installed preset's edited copy. The
imported parameter differences and native preset identity remain unchanged.
It retains native source order and does not add a separate `(Project)` row.
Commands still target the child identity. Editing a Filament parameter, such as
`filament_soluble`, may refresh the complete profile snapshot but must preserve
this display and the Process edits. An embedded profile without an available,
visible, compatible source retains its independent selector entry.

The workspace sidebar has two panels with a draggable horizontal divider.
The upper device/material panel scrolls its content. In the lower panel, only
the options below the category tabs scroll; the mode, preset/search row, and
category tabs stay fixed, and the scrollbar starts below the tabs. The upper
panel contains the Printer selector and filament
slots; the lower panel contains configuration. The initial height split is
35% / 65%, and adjusting it affects only the current workspace session.

The lower panel uses compact, aligned parameter rows. The preset row contains
an icon for Reset All at the left and a search toggle at the right. In Scoped
mode the object list appears immediately below the mode switch and the target
label replaces the process preset. Search expands into a text field and finds
options across all pages in the current mode.

The Project page tabs are Quality, Strength, Speed, Support, Multi., and
Other. Objects adds the leading Frequent page from Orca `TabPrintModel::build()`;
Plates uses the dedicated Plate Settings page from `TabPrintPlate::build()`.
Only pages containing eligible options are displayed. Cross-page Objects
search lists each option once in its full process-page context. The selected tab
is indicated by its underline; selection alone does not colour the text orange.
Orange is reserved for indicators of local modifications. Page and group
order follows the pinned Orca `TabPrint::build()` layout, explicitly defined
in React as a UI allow-list. Unmapped options and options commented out in
Orca are omitted, including from search. Groups are collapsible dark heading
bars with native labels and ordering, including Top/bottom shells. Native
compound Overhang speed and Bridge lines render as compact sections; their
headings precede the first visible field after scope/search filtering.
Labels occupy the left column and controls align in the right column. Boolean controls use
square checkboxes, enums use dropdowns, and numeric controls have minus/plus
buttons. Each increment uses the existing configuration mutation path and
respects native metadata bounds. Field Reset is an orange icon beside its
label; category Reset remains available through a group header's context menu,
explicitly naming the native category it resets.

- **Project** edits and displays project-wide values, regardless of the current
  selection. Its value path is `Preset → Project`.
- **Scoped** edits the target resolved from the current model selection. Its
  header names that target.
- A new, opened, or reset project starts in Project mode. Changing the selection
  never changes the selected mode.
- The mode is temporary editing context. It is not saved in the project, does
  not participate in Undo/Redo, and does not make the project dirty.

Scoped resolves its target as follows:

| Current selection | Scoped target | Values shown in the settings surface |
| --- | --- | --- |
| No object or volume selected | Active plate | `Preset → Project → Plate` |
| Whole object or instance selection | Selected object(s) | `Preset → Project → Object` |
| Part or modifier selection | Selected part(s) or modifier(s) | `Preset → Project → Object → Part/Modifier` |

Part and modifier selections use the same configuration behavior; the target
label still identifies the selected kind. Plate values are not shown as the
inherited source while an object, instance, part, or modifier is selected.

Scoped follows Neo's existing selection rules. Whole objects or instances may
be selected together. A part/modifier selection may contain sibling volumes
from one object and one instance only. Different hierarchy levels cannot be
mixed. If a non-empty selection is not valid for Scoped editing, the controls
are disabled with an explanation; the selection never silently falls back to
the active plate. A selection such as the prime tower that is not an editable
model target also has no Scoped target.

## 2. Values, sources, and multi-selection

For slicing, the effective value follows this order:

```text
Printer / process / filament presets
  → Project
  → Plate
  → Object
  → Part or Modifier
```

An explicitly set value at a later level overrides an earlier one. Parts and
modifiers have equal precedence. Overlapping volumes continue to follow the
slicer's existing region and slicing behavior; this feature adds no separate
overlap-priority control.

The settings surface shows only the value path relevant to its mode and
selection. Each value's nearest visible source is explained in a tooltip when
the user hovers over the value. Shared-app tooltips use one consistent shadcn
tooltip presentation; the settings surface does not use a separate source
badge beside each option.

Editable option labels are orange (`#F1754E`) when the displayed scope has a
local override. Inherited values, value controls, and `Mixed` placeholders are
not highlighted. For a multi-selection, the label is highlighted if at least
one target owns a local value. The existing object list also shows a
non-interactive marker for model items with supported local overrides; editing
and reset remain in the settings surface.

The `Project | Scoped` switch does not indicate override state. Only the
displayed mode's categories are evaluated for highlighting; hidden Scoped
targets are not scanned while Project mode is displayed. A category heading
is orange when any option in that category has a local override for the current
target(s).
Category highlighting considers the full catalogue, even while search hides
the overridden option. Reset clears each highlight when its last qualifying
local override is removed.
`Reset All` is enabled only when the current mode and target(s) have supported
local overrides; a category's Reset is enabled only when that category has
one. An explicit local value counts even when it equals the inherited value.

Scoped presents the complete set of options supported for the resolved scope,
grouped by category, with search across categories. For a same-scope
multi-selection, equal values are shown normally and differing values are
shown as `Mixed`. Setting a value applies it to every selected target in one
action; Reset removes that option from every selected target. When values are
equal but their sources differ, the common value remains visible and the
tooltip reports that the source is mixed.

## 3. Editing, validation, and reset

Each scope offers only options that have a meaningful, supported setting at
that level. The generic Project/Scoped surface does not replace the existing
filament, rack, or extruder assignment controls. Custom G-code, Layer Range,
unknown options, and other options without a supported generic editing path do
not appear there. Existing native settings outside the visible catalogue are
not thereby exposed to generic reset.

Scalar options use their appropriate controls. Other supported option types
use an editable text field that preserves the value format used by the slicer.
Text remains a draft until Enter or blur commits it; Escape discards the draft.
If the slicer cannot parse the submitted value, the field keeps the draft and
shows an error without changing the project.

The native Print element API additionally exposes typed Source/Effective vectors
and sparse per-index `overrideValues` (`null` inherits; `{value}` explicitly owns
the element, including `{value: null}` for native nullable nil)
through `getPrintConfigEditor()`. Its required `indexCount` gives the native
valid element range even when a serialized vector is short. Project
`set-element` submits one typed value with its type, index and expected revision;
`reset-elements` clears ownership at that index for an explicit set of unique
option keys and restores Source. Other indices retain their ownership, even
when they equal Source; an all-inherited vector removes its override key.
The batch is validated on temporary configuration before publication, and all
other elements remain unchanged. Element values outside native bounds are
rejected; whole-option numeric edits retain their existing clamping behavior.
These operations use the same Project-owned Print preset and enclosing history
transaction as ordinary scoped edits. They currently accept one Project target;
Object, Part and Plate element editing and Variant selection UI are deferred.

The initial validation behavior is intentionally limited:

- Option types, allowed enum values, and deterministic minimum/maximum bounds
  are enforced. A numeric value outside a known bound is silently clamped to
  that bound.
- No dependency graph is checked and no dependent value is hidden, disabled,
  or automatically corrected. Other questionable combinations are reported
  by normal slicing validation.
- Bed type is a narrow native exception: project and plate writes must use
  the selected Printer's supported choices. A printer/capability transition
  selects a valid remembered bed choice when explicitly supplied, otherwise
  its native default, and removes unsupported plate bed overrides,
  restoring inheritance. A printer without bed-type selection cannot own
  local bed overrides. The transition, corrections, and native snapshots
  are committed together as one history action.
  Resetting the project bed type restores the selected printer's supported
  native default; resetting a plate bed type removes its override.
- A field-level Reset, category Reset, or target-wide Reset removes local
  values and resumes inheritance. A bulk Reset is one undoable action and has
  no confirmation prompt.

An explicit set to a value currently inherited from an earlier level creates
a local override even when the displayed numeric/text value is equal. That
local value then remains fixed if the inherited value later changes. If the
submitted value is already explicitly stored on every selected target, the
edit is a no-op: it does not dirty the project or add a history entry. Reset
is the operation that resumes inheritance.

A successful edit or reset is a normal project change: it marks the project
dirty and can be undone/redone. Undoing back to the saved state restores the
clean state. A continuous control produces one history action when its gesture
finishes. Mode, target display, search, and category expansion are temporary UI
state and are not project changes.

## 4. Presets and model/plate operations

Changing the printer, process, or filament preset does not discard a
representable local Project, Plate, Object, Part, or Modifier value, even if
that value is no longer effective or valid for the new preset. The displayed
value and source are recomputed; normal slicing validation reports values the
new configuration cannot use.
Bed type follows the explicit exception in section 3: unsupported local bed
types are removed during printer/capability transitions, and the project bed
type is initialized from the selected printer's native default.

Object and part/modifier settings belong to their model item and apply to all
instances of that item. Moving an item to another plate leaves its settings
with the item; plate settings stay with their plate, and the effective value
is recomputed for the destination. Adding a plate starts with inherited values
and no plate-local override. Deleting a plate removes its local settings but
does not remove settings attached to its model items.

Deleting an object, part, or modifier removes that item's local settings.
Undo/Redo restores or removes the item and its settings together. When deletion
clears the selection, Scoped mode remains selected and resolves the active
plate under the normal empty-selection rule. Copy, split, merge, and replacement
operations use the settings retained by the resulting model items; Neo does not
guess which settings to transfer based on names, indices, or visual similarity.

## 5. Project files and device data

Saving a project stores its supported configuration in standard Orca/Bambu
3MF project data, so the project can be opened and saved by OrcaSlicer without
a Neo-only configuration file. Valid native values that have no editor in
this feature, including Layer Range settings, remain preserved as project
data. A valid embedded project/process preset is not by itself a compatibility
warning; genuine preset compatibility issues continue to use the slicer's
normal warning behavior. A geometry-only model import does not import the
source project's configuration overrides into the current project; model
assignments follow the existing import behavior.

Neo writes no Neo-private session or user metadata to a project 3MF and does
not restore it when opening a project. In particular, a value present only in
an old Neo-private project entry is not recovered; standard project data is
the supported persistence path.

Device and connection settings are managed only by Neo's independent Device
manager and its own local storage. Device records and credentials are not
stored in user or printer profiles, project 3MF, project history, or project
Undo/Redo. A Device-manager change is saved there without dirtying the project.

## 6. Slicing and interaction responsiveness

If a slice is active in the serial runtime, configuration edits are rejected
with the existing busy indication and do not change the project. In the
threaded runtime, an accepted edit takes effect immediately; cancellation of
an affected active slice proceeds asynchronously, while an unaffected plate
continues. A result computed from superseded settings is not shown as current.

Dragging or transforming a model remains directly responsive. The settings
surface and object-list selection display do not recalculate on every transform
frame; they update when selection or configuration actually changes.

On a complex project, Undo and Redo must return the interface to an editable
state within 200 ms per eligible history action, with a warm median target of
100 ms. For deletion/restoration, model-loading time is measured separately;
it is not counted in the history response interval after the restored model is
ready, and the full interaction duration remains separately observable.
