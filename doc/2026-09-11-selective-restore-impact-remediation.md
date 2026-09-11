# Selective Restore Impact Remediation

**Date:** 2026-09-11
**Status:** Implemented

## Accepted behaviour

- Each successful native Undo, Redo, or directional restore emits a versioned
  `impact` descriptor in the same JSON receipt as its atomically committed
  cursor and `HistoryStatus`.
- A normal model/transform/structural or direct-filament restore is deliberately
  conservative: it requests the complete model structure and GL projection,
  plate session, context, overlay, rack, and preview invalidation.
- An adjacent direct Prime Tower restore is explicit: it has no model impact,
  refreshes the affected plate/session, overlay, stable selection context, and
  tower projection, and preserves unrelated preview results. It does not read
  model structure or await a GL mesh replacement.
- The typed client validates the descriptor. Missing, invalid, or future/old
  artifact data falls back to the complete safe projection path. Revision and
  publication fences remain active around either path, so a late projection
  cannot overwrite a newer restore.

## Verification boundary

- Unit/component coverage proves narrow Prime Tower restore avoids
  `getModelStructure`, while ordinary impacts still use the full path and a
  superseded revision remains rejected by the coordinator.
- The real serial/threaded Prime Tower WASM smoke asserts the receipt shape
  for adjacent narrow Undo/Redo and for mixed structural restores, and reports
  zero direct Prime Tower model reloads versus the counted full restores.

## Verification record

- `pnpm test` passed: 139 slicer-wasm, 514 slicer-app, and all remaining
  workspace tests.
- `pnpm typecheck` and `git diff --check` passed.
- `scripts\\build-windows.bat quick --variant both` rebuilt the changed bridge
  for both artifacts. The direct real-artifact Prime Tower smoke passed in
  serial (7.39 ms move) and threaded (10.59 ms move), reporting
  `directPrimeTowerModelReloads: 0` and `fullRestoreModelReloads: 2`.
- The real serial/threaded multi-filament command smoke passed with the full
  restore descriptor assertions (19.4 s serial; 22.1 s threaded).
