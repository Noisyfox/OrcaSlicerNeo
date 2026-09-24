# Preset editor review fixes

**Date:** 2026-09-24
**Status:** Implemented and verified
**Scope:** Correctness and performance fixes identified in the preset-editor
branch review and the real complex-project profile.

The implementation follows [the shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md)
and [Preset Editor Dialog](../spec/Preset%20Editor%20Dialog.md).

## Accepted behavior

- Undo/Redo of a Printer transition invalidates every plate even when Process,
  rack, and project settings remain identical. A geometry-only history restore
  does not recalculate unchanged profile compatibility. Historical selections
  are restored exactly before compatibility flags are refreshed.
- Internal restore receipts require the current complete descriptor. Missing
  fields and unknown versions are errors, not compatibility fallbacks. Native
  history roots require their captured Printer and draft revision. Renderer
  command context remains distinct from native-owned historical roots.
- Native option metadata is immutable for the lifetime of the loaded module and
  is constructed once. Source values and effective draft values remain fresh.
- Notes-only draft changes retain one history entry and the existing all-plate
  result invalidation contract, but do not recompute bed geometry or tower
  placement. Reset operations use the actual changed override keys.
- Material usage scans reuse the native painting cache on the authoritative
  model across temporary plate-model copies. Cache validity remains governed by
  the native segmentation timestamp; history/model replacement does not retain
  pointers to discarded objects. Other configuration changes still recompute
  their required placement and validity state.
- The existing rollback Model copy remains: profiling measured it below 1 ms
  and removing it would weaken atomic failure recovery without useful savings.
- Draft mutation receipts publish the complete committed Filament session,
  including recalculated flushing values. Updating only the revision token on
  the old renderer snapshot is insufficient for material configuration edits.

No persistence migration, new file format, host-specific behavior, or mobile
interaction is introduced. Both hosts retain their current desktop layout.

## Verification

Use focused client tests for malformed restore receipts and real-WASM history
regressions for Printer-only transitions and ordinary object transforms. Run
the preset draft and project persistence harnesses, affected package checks,
both WASM quick builds, repository test/typecheck and focused Electron E2E.

Re-run the 45,586,816-byte Odyssey Helmet project (14 objects/instances, 11
plates) with warmup and repeated get-draft, notes mutation, and Move Undo/Redo
measurements. Validate a slice-relevant edit as well as notes, and retain raw
measurements outside the source tree. Do not substitute the diagnostic cache
prewarm request for the production path.

## Measured result

The final production serial artifact SHA256 is
`3e4db847481e6256c7220b7ead7b9fa13aeceee9d104dfaa6fe475fb2ec723fd`.
The fixture SHA256 is
`6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`.
Times below measure synchronous WASM ABI calls, excluding UTF-8/JSON decoding,
Worker transport and rendering. Draft reads use 4 warmups and 30 samples;
mutations and history use 3 warmups and 16 samples, with nearest-rank statistics.

| Operation | Before median / p95 (ms) | Final median / p95 (ms) |
| --- | --- | --- |
| Get Printer draft | 10.64 / 12.10 | 2.91 / 3.46 |
| Set printer_notes | 432.47 / 444.15 | 15.45 / 15.90 |
| Move Undo | 45.62 / 52.57 | 12.66 / 13.70 |
| Move Redo | 42.49 / 45.38 | 9.96 / 13.92 |

The slice-relevant `printable_height` edit retained full geometry work and
measured 57.61 / 60.34 ms after the cache fix, before adding the complete
Filament receipt. Real-WASM regressions additionally prove that a height of
1 mm invalidates a cube, notes preserve that invalidity, and reset-preset
restores validity. Every draft receipt is compared with a fresh native Filament
session, including its flushing matrix and committed revision.

Raw measurements and scripts are retained locally in
`%TEMP%/orca-preset-perf/`, including `final-serial.json` and
`fixed-geometry.json`; no private model bytes are committed.

Passed checks:

- `pnpm test`: 979 tests across 114 files.
- `pnpm typecheck`.
- `scripts\build-windows.bat quick --variant serial -j 8` and the same command
  with `--variant threaded`.
- `pnpm --filter @orca/slicer-wasm preset-draft-registry-smoke` and
  `preset-draft-registry-smoke:threaded`.
- `pnpm --filter @orca/slicer-wasm native-printer-transition-smoke` and
  `native-printer-transition-smoke:threaded`.
- `pnpm --filter @orca/slicer-wasm native-project-preset-history-smoke`.
- `node packages/slicer-wasm/harness/prime-tower-cache-validity-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js`.
- `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`, then
  `pnpm --filter @orca/desktop exec playwright test e2e/preset-editor.e2e.ts e2e/profile-compatibility.e2e.ts`: 2 passed.
- The E2E mock delay now covers the current atomic Printer command; its
  previous omission made the pending-state assertion miss the transition.
- `pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts -g "shared history toolbar"`:
  1 passed against real threaded WASM. The test now accounts for the separate
  Printer-selection history entry and verifies both keyboard and menu Undo.
- `git diff --check`.

The full release matrix is intentionally not run for this focused repair.
