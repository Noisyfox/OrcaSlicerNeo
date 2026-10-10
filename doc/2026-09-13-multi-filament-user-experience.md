# Multi-Filament and Multi-Plate User Experience

**Date:** 2026-09-13

**Status:** Final accepted product behaviour

**Scope:** The complete multi-filament, multi-plate, Prime Tower, history, and
G-code preview experience shared by the Electron and Web applications.

This is the single current product record for this feature. It describes the
experience users can rely on; implementation history and internal interfaces
are intentionally not recorded here.

## Plate list cards

- The existing Plates list uses square model thumbnails beside each plate's
  name, state, valid slice totals, and plate actions. Its surrounding sidebar
  layout, configuration editor, and viewport remain unchanged. Within Plates,
  the options section reserves a fixed 170px for options, its header, and
  expanded search, capped at half the shared scrollable area
  below the top title and plate toolbar (those controls are excluded).
  Filtering options does not shrink this section. The plate list takes its
  content height up to the remaining-space limit: short lists place options
  below the list, with 8px between the last card and divider and 4px between
  the divider and options, while long lists scroll independently.
  The height budget includes expanded search, but collapsed search leaves no
  empty placeholder between the header and options.
- Selecting a plate uses its card content, name, or thumbnail. Action buttons operate on their
  explicit plate target and do not also select a plate.
- Thumbnails use a fixed orthographic isometric view of printable model parts,
  without selection overlays, modifiers, Prime Towers, or bed decorations.
  They are transient session images; normal project saves do not embed them.
  Cards are 108px tall with 96px square thumbnails and equal 6px top, bottom,
  and left insets; sidebar resizing changes
  only horizontal space. Images render at a fixed 256px resolution and are not
  regenerated for display-size or device-pixel-ratio changes.
  Only the current plate has an inset highlighted outline; unselected cards have no
  extra border ring.
  Card edges align horizontally with the options area below the list.
  The first card starts 4px below the plate toolbar's action buttons.
- The list toolbar retains New Plate and Arrange, with Delete Plate in its menu
  and a plate-name search. Send All and Print All are not displayed.
- Each card reports Not Sliced, Slicing, Sliced, Error, Empty, or Out of bounds.
  Slicing progress overlays the model image; errors belong to that plate and
  input revision. Invalidated results do not show their former totals.
- Slice and Cancel act on their named plate. Review opens its error details
  with explicit Select plate and Retry slice actions. Print uses the existing
  Send & Print dialog; the adjacent Send action uploads without starting.
  Captured output receipts are revalidated before upload, and output actions
  wait until slicing has finished. These actions do not change plate selection.

## Material rack

- The Prepare view presents one ordered, one-based rack of filament slots. A
  normal single-filament printer has one slot; supported material-switching
  printers may use up to OrcaSlicer's 64-slot limit, and fixed multi-nozzle
  printers retain the slots required by their physical nozzles.
- Bambu dual-nozzle printers may delete or merge down to one material, as in
  Orca's Sidebar. Physical nozzle count remains two; the material rack and
  native colour/mapping arrays retain one slot, with one flushing-matrix plane
  per nozzle. Native preset-helper padding does not create extra project
  materials. Delete, Merge, Undo/Redo, and adding a slot preserve the surviving
  source preset, native colours, and identity.
- The upper device/material panel presents a collapsible Material area with
  a slot count and plus/minus buttons. Slots use a compact two-column grid:
  each single-line row has a rectangular colour/number block and a searchable
  preset selector. Long preset names are truncated and available on hover.
  Clicking the colour block changes its colour; Edit, Merge, and Delete are
  available in the slot context menu. Minus removes the last slot through the
  same reference-impact confirmation as the Delete command.
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
  Before rendering, an all-channel near-black colour is lifted to the native
  Orca-visible 0.2 gray; selection, disabled, transparency, and boundary
  overlays remain visible on top of that colour.
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
- Switching to a Printer with a shorter remembered rack normalizes removed-slot
  references inside that same native history transaction. Out-of-range object
  assignments use slot 1; stale part assignments inherit the object. Project
  support/feature routes use Default, while scoped routes regain inheritance.
  Native volume normalization limits imported painting; tool events for removed
  slots are discarded and plate maps/sequences follow the slot-count policy.
  Surviving slot references stay unchanged. Undo/Redo restores the entire rack,
  assignments, routing, painting, tool events, and plate settings together.
  Model-level layer events are retained in the native history model manifest,
  alongside the existing object archives, so removed events are also undoable.

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
- Slice consumes the current native tower coordinates. Cached Settings values
  for `wipe_tower_x` and `wipe_tower_y` are excluded through a centralized
  slice-request blacklist so they cannot restore a pre-drag position. This
  also applies after Undo/Redo and plate navigation. The 2026-10-02 correction retains the existing
  rectangular bounding-box clamping; polygon-aware automatic placement is
  outside this fix.
- The move-then-slice regression compares actual extruding Prime Tower XY
  paths in exported G-code with the pre-slice Prepare position, including its
  brim margin. A second move must translate every tower path endpoint by the
  same displayed X/Y delta; exported configuration values alone are
  insufficient evidence. Prepare dimensions remain pre-slice estimates.
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

## Printer transition verification (2026-10-06)

- `pnpm test`: passed, 1,735 tests. `pnpm typecheck`: passed.
- `scripts\build-windows.bat quick --variant serial -j 4` and
  `scripts\build-windows.bat quick --variant threaded -j 4`: passed.
- `pnpm exec node packages/slicer-wasm/harness/native-printer-transition-smoke.mjs
  packages/slicer-wasm/out/serial/orca_slice.js`: passed; the same command with
  `out/threaded/orca_slice.js` passed. Covers shorter remembered racks,
  assignments/routing, imported painting/tool events/plate maps, and Undo/Redo.
- `pnpm exec node packages/slicer-wasm/harness/bridge-smoke.mjs
  packages/slicer-wasm/out/serial/orca_slice.js
  packages/slicer-wasm/fixtures/cube.stl`: passed.
- `pnpm exec node packages/slicer-wasm/harness/history-editing-session-smoke.mjs
  packages/slicer-wasm/out/serial/orca_slice.js`: passed.
- `pnpm exec node packages/slicer-wasm/harness/bed-type-memory-smoke.mjs
  packages/slicer-wasm/out/threaded/orca_slice.js`: passed before the layer-event
  history manifest addition; final threaded Printer transition coverage passed.
- `pnpm exec node packages/slicer-wasm/harness/history-smoke.mjs
  packages/slicer-wasm/out/serial/orca_slice.js`: failed at the structural fixture's
  member/out-of-bounds assertion (line 822). This check remains unresolved.
- `git diff --check`: passed. Host UI E2E was not run: this correction changes
  shared native state normalization and history, without host or UI wiring edits.

## H2D single-material verification (2026-10-10)

- The new `h2d-single-filament-smoke.mjs` reproduced
  `native filament colours are unavailable` against the old serial artifact.
- `pnpm test`: passed, 1,837 tests; three existing runtime tests skipped.
  `pnpm typecheck`: passed.
- `scripts\build-windows.bat quick -j 4`: passed for threaded and serial.
- `pnpm exec node packages/slicer-wasm/harness/h2d-single-filament-smoke.mjs
  packages/slicer-wasm/out/threaded/orca_slice.js`: passed; the same command
  with `out/serial/orca_slice.js` passed. Covers both Delete/Merge directions,
  distinct source presets, native solid/gradient colours, identity, object and
  support routing, late rollback, Undo/Redo, adding after deletion, final-slot
  rejection, exported material/nozzle dimensions, and a real one-material
  H2D 0.4 slice.
- `pnpm exec node packages/slicer-wasm/harness/multi-filament-command-smoke.mjs
  --module packages/slicer-wasm/out/threaded/orca_slice.js`: passed.
- `pnpm exec node packages/slicer-wasm/harness/bridge-smoke.mjs
  packages/slicer-wasm/out/threaded/orca_slice.js
  packages/slicer-wasm/fixtures/cube.stl`: passed.
- `pnpm stage:assets`: passed. `git diff --check`: passed.
  Host GUI E2E was not run; the correction has no renderer or host wiring
  changes and is exercised directly through both real WASM variants.
