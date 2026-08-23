# ObjectList Highlight Matches OrcaSlicer

Date: 2026-08-23

Branch: dev/object-list-and-parts

## Requirement

`spec/ObjectList-and-Parts.md` §6 records that the ObjectList is a projection
of the viewport selection and highlights the matching rows. This note verifies
that projection (and the shared selection classifier it depends on) against
OrcaSlicer's `Selection::update_type()` and `ObjectList::update_selections()`,
and documents the one deliberate divergence.

## What OrcaSlicer does

- `Selection::EMode` is binary: `Volume` (part) / `Instance`. An object
  selection is the `Instance`-mode selection of every volume of all of its
  instances, never a third mode.
- `Selection::EType` (`Selection.hpp`) classifies the current selection into
  `SingleModifier`, `MultipleModifier`, `SingleVolume`, `MultipleVolume`,
  `SingleFullObject`, `MultipleFullObject`, `SingleFullInstance`,
  `MultipleFullInstance`, `Mixed`, etc. `Selection::update_type()`
  (`Selection.cpp:2294`) computes it.
- `ObjectList::update_selections()` (`GUI_ObjectList.cpp:4796`) highlights list
  rows for the current type:
  - Full object with 1 instance → object row; full object with several
    instances → the instance rows (unless the object row is already selected).
  - Full instance(s) → instance row(s).
  - Part / modifier(s) → the volume row(s) (for a single-part object the volume
    row *is* the object row, because no separate part row exists).
  - Mixed → a per-volume scatter (never editable).

## The shared classifier is mode-based

`SceneInteractionController.classifyVolumeIds()` maps `ids` to
`'object' | 'instance' | 'part' | 'mixed' | 'empty'`. The homogeneity rule is
**mode-based**, matching Orca's two `EMode`s:

- An **instance is a full object at the instance level**, so a full instance and
  a full object are both `Instance`-mode and **may be mixed**.
- A **part** is `Volume`-mode and is valid only as a lone set within a single
  instance. Mixing it with an instance/object, or spanning several instances, is
  Orca's `Mixed` (invalid for edits) and is refused by the guard.

So `{a full instance of a multi-instance object, another object}` is valid — it
is `'object'` (all whole-instance selections) — and:

- a full instance of a multi-instance object alone is `'instance'`;
- all instances of a single object are `'object'`;
- a lone partial part set is `'part'`;
- a part mixed with a full instance/object, or parts across instances, is
  `'mixed'` and refused.

Earlier in this branch the classifier had been tightened to Orca's granular
`update_type` `sels_cntr` rule, which wrongly classified the object+instance mix
as `Mixed`; that has been reverted. The mode-based rule (which also matched
Orca's `Selection::add`: `Volume` mode resets on a different object/instance,
`Instance` mode appends across objects) is the correct one, and matches the
requirement that an instance is a full object as well.

## The highlight projection (most-relative level, per object)

`projectSelection()` maps the viewport selection to its most-relative row,
resolved **per object** so a mix of full objects and full instances renders
correctly:

- a fully selected object (all volumes x instances) → its object row, **unless it
  was selected via the `Instances` group line**, in which case its instance rows;
- a not-fully-selected object whose touched instances are whole → those instance
  row(s);
- a partial set of one instance → the selected volume row(s);
- empty → nothing.

For `{a full instance of object A, the full object B}` this highlights A's
instance row and B's object row — the single-part object is no longer missed
(the previous global gating left it un-highlighted).

The `Instances` group under a multi-instance object has an expand/collapse caret
like the object line (which toggles the instance sub-list). Clicking the group's
header label selects every instance of the object (Orca's `itInstanceRoot` →
parent object), and the ObjectList records a per-object "row kind that last drove
selection" (`highlightLevel`) so the projection shows the instance rows for that
group selection while an object-row selection still shows the object row. This
mirrors Orca's `root_is_selected` / `m_selection_mode` granularity.

## Deliberate divergence from Orca's raw update_selections

For a **fully selected multi-instance object**, Orca's `update_selections()`
highlights its *instance rows* unless the object row was already selected in the
list. We highlight the **object row** instead, per `spec` §6 and the explicit
requirement "if I select the entire object (with multiple parts), then only the
object line should be highlighted / only the most-relative level is highlighted
to make it more readable." Clicking the object row is the normal way to reach a
full-object selection, and Orca keeps the object row in that interactive path
(`root_is_selected`), so the two agree in practice; this is a readability choice
when the selection is built in the scene instead.

## Verification

- `@orca/slicer-app` test: 137 pass (added the object+instance mixable case, the
  per-object mixed highlight case and the `Instances`-group highlight case);
  typecheck clean.
- Desktop mock e2e: 16 passed, 1 skipped (slice-error requires a rejecting
  model fixture).
