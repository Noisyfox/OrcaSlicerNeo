# Multi-Filament and Multi-Plate User Experience

**Date:** 2026-09-13

**Status:** Final accepted product behaviour

**Scope:** The complete multi-filament, multi-plate, Prime Tower, history, and
G-code preview experience shared by the Electron and Web applications.

This is the single current product record for this feature. It describes the
experience users can rely on; implementation history and internal interfaces
are intentionally not recorded here.

## Material rack

- The Prepare view presents one ordered, one-based rack of filament slots. A
  normal single-filament printer has one slot; supported material-switching
  printers may use up to OrcaSlicer's 64-slot limit, and fixed multi-nozzle
  printers retain the slots required by their physical nozzles.
- Each slot shows its number, effective colour, and selected filament preset.
  Users can add, delete, merge, choose a compatible preset, and edit the slot
  colour directly in the rack. The ordinary Presets controls do not contain a
  separate legacy filament dropdown.
- Changing Printer or Process keeps compatible slots in place, applies the
  native compatible fallback for incompatible slots, and ensures the required
  slot count. The rack remains coherent throughout the transition and never
  appears empty as an intermediate state.
- Add, delete, merge, preset, and colour operations are all-or-nothing. Every
  affected object assignment, feature route, support choice, painting mark,
  flushing value, and custom tool-change event remains consistent. If a
  referenced value cannot be safely updated, the operation is rejected without
  changing the project.
- Flushing values follow OrcaSlicer's native calculation. The product does not
  expose a separate flushing-matrix editor or an alternate calculation mode.

## Assignment and colour

- Users can assign a filament from the Object List or an object/part context
  menu to an object, its instance entry, a model part, or a parameter modifier.
  An instance entry changes its owning object, so all instances retain the
  same assignment. Negative volumes and support-only volumes do not offer a
  filament assignment.
- Model parts visibly distinguish inheriting the object assignment from an
  explicit override. Assigning an object resets its model-part overrides;
  parameter-modifier assignments remain independent.
- The Object List slot picker uses the application's standard styled select
  control. Choosing a value changes only the assignment; it does not select a
  different row or unexpectedly open a context menu. Ineligible rows show no
  misleading selector.
- Prepare colours printable model volumes by their effective filament colour.
  Selection, disabled, transparency, and boundary overlays remain visible on
  top of that colour.
- A valid user colour is retained when the slot's preset changes. Colour edits
  change the project slot, not the global filament preset.

## Projects, profiles, and remembered racks

- Opening a compatible 3MF restores its complete project-owned filament rack,
  colours, assignments, feature routing, support choices, flushing data,
  painting, tool changes, printer/process settings, and plate layout.
  Imported multi-colour painting is preserved and used for slicing and preview
  even though Neo does not provide a painting editor.
- A loaded project's rack always takes precedence over remembered defaults.
  A new project uses the last rack remembered for its selected printer.
  Remembered racks are independent for each printer.
- On application startup and after switching Printer, the selected printer's
  remembered rack is restored before the new state is presented. A new project
  starts clean: restoring that rack does not create an Undo entry or make the
  project dirty.
- Explicit rack edits, including an Undo/Redo restoration that changes the
  rack, update the remembered rack for the selected printer without affecting
  another printer's defaults.

## Slicing and G-code preview

- Each slice and preview is tied to its selected plate. In a multi-plate
  project, the generated toolpath, preview geometry, and exported G-code use
  the target plate's own position and coordinate frame; they never reuse plate
  1's Prime Tower or G-code coordinates.
- Slicing a plate preserves the actual tools used by the project. The
  Filament/Tool preview uses the active project slot palette, so objects using
  different slots appear in their different colours (for example, black and
  gold) and both tools remain visible in the result.
- Imported per-face painting and imported tool changes affect slicing and
  preview even without an editing surface for creating new paint marks or
  layer changes.
- Rack-wide changes invalidate all affected plate results. Object-local
  changes invalidate the plates containing the affected objects, and a Prime
  Tower move invalidates only its own plate. Undo and Redo preserve these same
  result boundaries.
- The Prepare Prime Tower representation is never overlaid on G-code Preview;
  Preview shows the generated toolpath and its real colours.

## Prime Tower in Prepare

- When enabled and eligible under the native rules, Prepare shows an estimated
  Prime Tower for every eligible plate. Eligibility depends on actual use and
  native forced cases, not merely on the number of rack slots. Empty or
  otherwise ineligible plates show no tower.
- The Settings surface exposes Enable Prime Tower and width. X/Y positions are
  edited in the scene, not through separate settings fields. Imported tower
  rotation is displayed but is not editable.
- The tower is rendered as an estimated, semi-transparent set of equal colour
  bands in the plate's used-filament order. It is not a model in the Object
  List, has no delete/copy/context-menu action, and is not replaced by a
  post-slice mesh or brim.
- Any displayed eligible tower can be selected, including one on a non-current
  plate. Selection shows ordinary bounds only; the Move gizmo appears only
  after the user explicitly enables the move tool. Movement is limited to X/Y,
  with no rotate, scale, or Z interaction.
- Direct body dragging and the explicitly enabled Move gizmo edit the same
  tower position. A tower always remains assigned to its own plate: dragging
  across another plate never moves it there, changes the current plate, or
  changes another plate's coordinates.
- A legal placement is constrained to that plate's printable area, including
  the effective footprint margin. Automatic clamping during project/profile
  loading is silent and does not create history or dirty the project. If the
  tower cannot fit, it remains at the best available native position and shows
  a non-blocking warning.
- Model, exclusion-area, and wrapping-area intersections are reported as
  non-blocking warnings during slicing. The tower is not continuously snapped
  around models while it is being dragged.

## History, undo/redo, and interaction feedback

- Each completed project mutation creates exactly one history entry. A
  continuous colour adjustment or drag is one operation, not a sequence of
  intermediate entries. Cancelled and no-op gestures create none.
- Undo, Redo, and direct history navigation restore the model, rack,
  assignments, plate state, Prime Tower state, selection, and dirty status as
  one coherent project state. Failed or stale operations leave the visible
  project, history, and slice validity unchanged and do not surface a stale
  session error to the user.
- History never contains slice results and never makes the user wait for a
  complete project bundle to be copied. Rack slot changes and their Undo/Redo
  remain millisecond-scale interactions, including on large projects.
- Selecting a plate, selecting an object, restoring a remembered rack, and
  automatic Prime Tower normalization do not create project history. Plate
  navigation is context-only and does not dirty the project.
- During an object or Prime Tower gesture, and while Undo/Redo is completing,
  the sidebar retains its normal presentation. Controls do not briefly switch
  to an unattractive read-only state merely because an operation is in flight.
- Pressing an unselected model selects it and can continue directly into a
  body drag in the same gesture. Right-clicking a model selects it and opens
  its object-specific context menu; clicking empty space clears the ordinary
  scene selection, including a selected Prime Tower.

## Responsiveness

- The application remains interactive while slicing and while background
  project work completes.
- On a complex real multi-colour project with eleven plates, clicking a
  non-current plate updates the selected plate promptly: cold selection
  feedback is expected within approximately half a second, and subsequent
  plate switches normally within approximately a quarter second.
- Switching plates does not require reloading the complete project just to
  update selection, and it does not produce a filament-session revision error.

## Product boundaries

- Electron and Web provide the same rack, assignment, project, slicing,
  preview, Prime Tower, and history experience.
- The first release does not include a facet-painting editor, a layer colour-
  change editor, an advanced physical-extruder mapping editor, a flushing
  matrix editor, or Prime Tower rotate/scale controls. Imported data for these
  areas remains usable and is preserved through project operations.
- The product exposes the unified multi-filament experience only; no separate
  legacy single-filament user flow is retained.
