# Project and Scoped Configuration

**Status:** Final user experience; delivered in the shared Electron and Web application.
**Last updated:** 2026-09-23

This specification records the final behavior visible to users. Project-wide and
selection-scoped configuration share one settings surface and follow OrcaSlicer's
configuration behavior.

## 1. Project and Scoped modes

The `Project | Scoped` switch appears immediately below the printer and process
preset selectors in the settings panel.

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

The initial validation behavior is intentionally limited:

- Option types, allowed enum values, and deterministic minimum/maximum bounds
  are enforced. A numeric value outside a known bound is silently clamped to
  that bound.
- No dependency graph is checked and no dependent value is hidden, disabled,
  or automatically corrected. Other questionable combinations are reported
  by normal slicing validation.
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
