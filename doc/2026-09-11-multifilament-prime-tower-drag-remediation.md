# Multi-Filament Prime Tower Drag Remediation

**Date:** 2026-09-11
**Status:** Implemented — interaction convergence verified

## Accepted behaviour

- A committed filament mutation publishes the Worker-authoritative per-plate
  input revisions to the plate-session projection before dependent scene
  work can run.
- Prime Tower pointer-up obtains its request revision from that coherent
  projection while it owns the shared project-mutation FIFO. A prior filament
  assignment therefore cannot cause a valid tower move to be rejected as
  stale.
- One completed Prime Tower drag still creates exactly one native history
  entry; its authoritative coordinate remains projected, and Undo/Redo restore
  it correctly.
- When a Worker move receipt retains the selected tower's stable identity but
  changes its final X/Y (for example after native clamping), the scene
  controller republishes that retained selection. The tower mesh, selection
  bounds, and attached Move-gizmo pivot therefore all consume the same
  Worker-confirmed coordinates; no timing delay is used.
- Rejected/stale releases reconcile from the Worker projection, and direct
  Prime Tower Undo/Redo uses that same authoritative projection refresh before
  its scene publication fence is released.
- Prime Tower and ordinary model volumes enter the same pointer-down pending
  hit, DragControls threshold, pointer-owner, cancel/release, selection-bounds,
  and TransformControls-pivot state machine. There is no tower-specific
  DragControls enablement or parallel pointer/drag state.
- The only intentional difference after a shared local draft is its adapter:
  normal model transforms commit through the history transaction adapter,
  while the scene-only tower render transform commits X/Y through its Worker
  mutation adapter. Current-plate/locked eligibility and Prime Tower's
  move-only render capability remain selection/render constraints, not a
  second interaction owner.
- The fix does not change the pinned upstream submodule or weaken Worker
  revision validation, gesture reservation, FIFO ordering, or asynchronous
  projection fences.

## Verification target

- A focused application regression proves a filament receipt updates the
  cached plate input revision consumed by the Prime Tower move port.
- A focused controller/collection regression returns a deliberately different
  authoritative receipt position after a local draft and proves the final
  selected bounds and pivot are republished from that receipt.
- The mock Electron canvas path performs real body and TransformControls
  pointer gestures and asserts the rendered tower bounds and attached gizmo
  target match the Worker-projected tower coordinates after release.
- The real serial and threaded WASM Prime Tower smoke creates two cubes,
  assigns them distinct filament slots, moves the eligible tower, and verifies
  one history entry plus coordinate Undo/Redo.

## Verification record

- The focused controller/collection regression passes, including receipt
  replacement, stale reconciliation, and projected Undo/Redo coordinates. The
  complete `@orca/slicer-app` suite passes (73 files, 526 tests), with shared
  app and desktop typechecks passing.
- The focused mock Electron Prime Tower canvas E2E passes with real body and
  TransformControls gestures, one history entry per completed release, and
  matching tower/bounds/gizmo coordinates.
- The mock Electron interaction-matrix E2E drives an unselected ordinary model
  and an unselected Prime Tower through the same body and Move-gizmo gesture
  transitions (`none -> body/gizmo -> none`).
- The real-WASM Prime Tower smoke passes against the available serial and
  threaded artifacts. Both runs created two Cube objects with different
  filament slots, accepted the move using the published plate revision, and
  verified the coordinate history entry plus Undo/Redo.
- The interaction-convergence regression passes with 69 focused controller/
  tower tests and the complete `@orca/slicer-app` suite (73 files, 528 tests).
  Root workspace typecheck passes. The focused Electron `prime-tower.e2e.ts`
  run passes its three mock cases (one unrelated real-artifact warning case is
  skipped), including the model-and-tower shared owner matrix.
