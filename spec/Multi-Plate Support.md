# Multi-Plate Support

**Status:** Implemented — Steps 1–9 accepted

**Date:** 2026-09-05

**Scope:** The shared Electron and Web application's Prepare workspace, up to
36 plates.

## Accepted interaction model

- Prepare renders all plates simultaneously in an OrcaSlicer-style, automatically
  reflowed grid. The first release supports at most **36** plates, matching
  OrcaSlicer's product/UI limit.
- Grid column counts and plate-origin ordering exactly follow native OrcaSlicer
  so add, delete, and project reload reproduce the same layout.
- One plate is the current plate. Selecting a plate through plate UI changes
  the current plate and supplies the context for plate-scoped operations.
- Clicking a non-current plate's empty bed selects it. Switching plates keeps
  the current camera position and zoom; it does not automatically frame the
  selected plate.
- Clicking a model on a non-current plate does **not** automatically select
  that plate.
- Object selection and editing remain global across the visible grid. Users may
  select objects or instances from different plates together and move, scale,
  rotate, or delete them in one operation.
- Newly imported models start at the center of the current plate, including
  `Plate 1`, and initially belong to that plate. They may overlap existing
  objects there; automatic collision-free placement is an explicit
  [Arrange](Model%20Arrangement.md) command.
- The object list groups entries by plate and has a separate Unprintable group;
  choosing an entry does not change the current plate. For this first release,
  a multi-instance model appears only in the group of its first instance rather
  than being split across every plate containing an instance.
- Plate membership is not an editing restriction. After each committed geometry
  or transform edit, the application recomputes each affected instance's plate
  membership from its resulting placement. An instance outside every printable
  plate is reported as unprintable rather than silently assigned to a plate.
- Membership follows native OrcaSlicer's convex-hull bounding-box intersection
  rule. If an instance intersects multiple plates, it belongs to the
  lowest-numbered matching plate.
- Membership and printability are separate states. A printable instance that
  intersects a plate but is partly outside its printable volume remains a
  member of that plate, is visibly marked as out of bounds, and makes that plate
  unavailable for slice, export, and send until the instance is fully back in
  bounds. Instances marked non-printable remain members where their geometry
  intersects, but do not affect the plate's out-of-bounds validity.
- Slice, G-code export, and send-to-printer operate on the current plate only
  in the first implementation. Batch "Slice all" and multi-plate export/send
  behaviour are deferred decisions.

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


## Plate lifecycle and grid reflow

- Plate lifecycle and arrangement use the shared native session. Duplicate
  Plate remains outside the delivered scope.
- Adding a plate automatically makes that new plate the current plate.
- At least one plate always remains; the sole remaining plate cannot be
  deleted.
- Plate add/delete use the common project history. Deletion proceeds without
  a separate confirmation dialog.
- Removing every object from a plate leaves that plate in place; only an
  explicit Delete plate action removes it. An empty current plate cannot be
  sliced, exported, or sent.
- Deleting the current plate selects the plate that compacts into its former
  position; when the deleted plate was last, the preceding plate becomes
  current. Deleting a non-current plate preserves the current plate's identity,
  even if grid compaction changes its index and world position.
- Deleting a plate never deletes its model instances. Its instances move to
  the final vacant grid position and retain their local coordinates relative
  to their deleted plate. They are unprintable until a later editing operation
  places them on a printable plate.
- Deleting an intermediate plate compacts the following plates forward. Each
  moved plate's instances move by the same world-space delta, preserving their
  local coordinates relative to that plate.
- Adding or deleting a plate may change the automatically calculated grid
  dimensions. Whenever that reflow moves an existing plate, its instances move
  with it and preserve their local coordinates.

## Slice results and configuration scope

[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md) owns the
current Print/result lifecycle, world-space application, input stamps,
affected-plate invalidation, cancellation and preview publication. Grid reflow
invalidates plates whose world origins change; unchanged origins retain valid
results. Threaded jobs permit the defined asynchronous editing/cancellation;
serial execution retains its operation lock.

Project, Plate, Object and Part configuration follow
[Project and Scoped Configuration](Project%20and%20Scoped%20Configuration.md).
There is no single global-result or shared-only-configuration fallback.

## Project persistence

- Project 3MF files must persist and restore the complete multi-plate model:
  plate count, layout, instance membership, and the information needed to
  reconstruct every plate's editing state.
- Neo-generated multi-plate projects must be reopenable by native OrcaSlicer,
  and native OrcaSlicer projects must be reopenable by Neo with the same plate
  layout and membership.
- The project file does not embed per-plate G-code or preview data. Those
  derived slice artifacts remain session-only data.
- On project reload, every plate is treated as unsliced. A user must slice the
  selected plate again before preview, export, or send-to-printer is available.
- Except for those intentionally omitted derived artifacts, unsupported native
  per-plate metadata is retained as opaque data and written back unchanged so
  an open/save cycle does not discard it.
- Plate add/delete, model edits, and shared configuration changes mark the
  project unsaved. Slice results, preview changes, and current-plate selection
  do not. The existing save-prompt flow applies before closing or replacing a
  project with unsaved multi-plate changes.

## Project import compatibility

- Importing a multi-plate project produced by native OrcaSlicer must preserve
  its plate layout and object membership; it must not be flattened into one
  plate.
- A plain 3MF or ordinary native 3MF project with no plate metadata imports into one default
  plate, `Plate 1`. Instance membership is then recalculated from current
  coordinates.
- A project with duplicate, missing, or out-of-order `plate_index` values is
  normalized like native OrcaSlicer: record order becomes a contiguous plate
  order, rather than rejecting the project.
- Import rejects a project with more than 36 plates with a clear error. This
  deliberately replaces native OrcaSlicer's unsafe over-limit load path while
  retaining its 36-plate product limit.

## Compatibility verification

The dedicated manual compatibility suite validates both production WASM
variants. It checks multi-plate save/load canonical state, imports a
checksum-pinned project generated by native OrcaSlicer, and validates Neo output
through the pinned native Orca 3MF parser without a GUI. Fixture checksum
tampering must fail validation.

Canonical comparisons cover plate order, instance membership, local
coordinates, names, locks, and retained opaque metadata. They also cover the
ordinary-3MF fallback, rejection above 36 plates, and intentionally omitted
derived G-code/preview artifacts.

This suite remains an explicit manual verification tool. It is not part of
normal tests, PR checks, nightly runs, or release gates until a later decision
explicitly schedules it; generic repository verification guidance does not
change this feature-specific boundary.

## Architectural direction

The implementation mirrors OrcaSlicer's state model without importing its
wxWidgets/OpenGL GUI classes: a headless, WASM-owned plate session maintains
per-plate membership, metadata, settings, and slice-result state, while the
shared React layer renders the grid and controls. The existing platform
contracts remain host-neutral.

React consumes an authoritative `PlateSessionSnapshot` from WASM and never
maintains or derives instance membership independently. Plate selection,
addition, deletion, and post-edit membership recomputation are bridge commands.
An add/delete or shared-configuration response atomically includes the session
snapshot and every instance world transform changed by grid reflow; the
frontend applies these returned transforms rather than calculating movement
itself.

Slicing applies the authoritative world-space Model with the selected plate's
origin through its native Print, following the per-plate specification.

Within a running session, each plate has an immutable opaque `plateId`.
Frontend selection, preview ownership, and slice jobs use this identity rather
than the display index, which may change during compaction. Project 3MF remains
native-compatible and persists plate order with `plate_index`; fresh internal
IDs are created on load. A slice job records its target `plateId` and input
revision, and its result is accepted only if both still match on completion;
cancelled or stale completions are discarded.
