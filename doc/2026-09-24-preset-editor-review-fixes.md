# Preset editor review fixes

**Date:** 2026-09-24
**Status:** Implementation
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
