# Multi-Plate Support

**Status:** Draft — interaction model accepted; implementation and persistence details remain under review

**Date:** 2026-09-05

**Scope:** The shared Electron and Web application's Prepare workspace, up to
36 plates.

## Accepted interaction model

- Prepare renders all plates simultaneously in an OrcaSlicer-style, automatically
  reflowed grid. The first release supports at most **36** plates, matching
  OrcaSlicer's product/UI limit.
- One plate is the current plate. Selecting a plate through plate UI changes
  the current plate and supplies the context for plate-scoped operations.
- Clicking a model on a non-current plate does **not** automatically select
  that plate.
- Object selection and editing remain global across the visible grid. Users may
  select objects or instances from different plates together and move, scale,
  rotate, or delete them in one operation.
- Plate membership is not an editing restriction. After each committed geometry
  or transform edit, the application recomputes each affected instance's plate
  membership from its resulting placement. An instance outside every printable
  plate is reported as unprintable rather than silently assigned to a plate.
- Slice, G-code export, and send-to-printer operate on the current plate only
  in the first implementation. Batch "Slice all" and multi-plate export/send
  behaviour are deferred decisions.

## Plate lifecycle and grid reflow

- The first implementation exposes only **Add plate** and **Delete plate**.
  Plate duplication, reordering, and renaming are deferred.
- Adding a plate automatically makes that new plate the current plate.
- At least one plate always remains; the sole remaining plate cannot be
  deleted.
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

- Each plate retains its own completed G-code and preview result when the user
  switches to another plate. Returning to an unchanged plate restores that
  result without a new slice.
- A committed edit invalidates the results of every plate that contained an
  affected instance immediately before or immediately after that edit. Results
  for all other plates remain available.
- The first implementation uses one shared printing configuration for every
  plate. Per-plate configuration controls are explicitly out of scope.
- The plate-session data model and bridge contract must nevertheless reserve a
  per-plate settings/override slot, so a later release can add Orca-compatible
  per-plate configuration without changing plate identity or result ownership.

## Project persistence

- Project 3MF files must persist and restore the complete multi-plate model:
  plate count, layout, instance membership, and the information needed to
  reconstruct every plate's editing state.
- The project file does not embed per-plate G-code or preview data. Those
  derived slice artifacts remain session-only data.
- On project reload, every plate is treated as unsliced. A user must slice the
  selected plate again before preview, export, or send-to-printer is available.

## Architectural direction

The implementation will mirror OrcaSlicer's state model without importing its
wxWidgets/OpenGL GUI classes: a headless, WASM-owned plate session maintains
per-plate membership, metadata, settings, and slice-result state, while the
shared React layer renders the grid and controls. The existing platform
contracts remain host-neutral.

Further decisions are intentionally pending: membership calculation rules at
plate boundaries, compatibility behaviour for imported project files, and the
detailed bridge/client contract.
