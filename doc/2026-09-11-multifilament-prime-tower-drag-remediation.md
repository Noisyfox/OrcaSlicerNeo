# Multi-Filament Prime Tower Drag Remediation

**Date:** 2026-09-11
**Status:** Implemented — locally verified

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
- The fix does not change the pinned upstream submodule or weaken Worker
  revision validation, gesture reservation, FIFO ordering, or asynchronous
  projection fences.

## Verification target

- A focused application regression proves a filament receipt updates the
  cached plate input revision consumed by the Prime Tower move port.
- The real serial and threaded WASM Prime Tower smoke creates two cubes,
  assigns them distinct filament slots, moves the eligible tower, and verifies
  one history entry plus coordinate Undo/Redo.

## Verification record

- Focused filament-store regression passes, and the complete
  `@orca/slicer-app` suite passes (73 files, 523 tests).
- `pnpm --filter @orca/slicer-app typecheck` passes.
- The updated real-WASM Prime Tower smoke passes against the available serial
  and threaded artifacts. Both runs created two Cube objects with different
  filament slots, accepted the move using the published plate revision, and
  verified the coordinate history entry plus Undo/Redo.
