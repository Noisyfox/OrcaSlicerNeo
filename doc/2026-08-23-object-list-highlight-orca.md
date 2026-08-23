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

## The shared classifier now mirrors update_type

`SceneInteractionController.classifyVolumeIds()` maps `ids` to
`'object' | 'instance' | 'part' | 'mixed' | 'empty'`. The multi-object branch
previously returned `'object'` whenever no instance was partial; that is NOT
Orca's rule. Orca sums `volumes_count * instances_count` over every touched
object (`sels_cntr`) and returns `MultipleFullObject` only when
`sels_cntr + sla == m_list.size()`, i.e. **every touched object is fully
selected**; otherwise it is `Mixed`.

So `{a full instance of a multi-instance object, another object}` is Orca's
`Mixed` (not `'object'`). The classifier now returns `'mixed'` for it and the
homogeneity guard refuses the selection, matching Orca's exclusions. This also
removes a real highlight bug: previously that selection could be created and
the single-part object's row was left un-highlighted (its volume row does not
exist as a separate row).

## The highlight projection (most-relative level)

`projectSelection()` maps a valid (homogeneous) selection to its most-relative
row:

- whole object(s) → the object row(s);
- whole instance(s) → the instance row(s);
- a partial set of one instance → the selected volume row(s);
- empty → nothing.

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

- `@orca/slicer-app` test: 135 pass (added multi-object Mixed classifier case
  and multi-full-object projection case); typecheck clean.
- Desktop mock e2e: 16 passed, 1 skipped (slice-error requires a rejecting
  model fixture).
