# Bambu P1P slice-preview reliability

**Date:** 2026-08-30

**Status:** Implemented and verified

**Scope:** Ensure a Bambu Lab P1P slice produces a visible toolpath preview,
and surface every failure that prevents preview generation in the shared app.

## Accepted behaviour

- The WASM bridge applies the active preset bundle's Bambu-vendor identity to
  the `Print` before validation and slicing, matching OrcaSlicer's native
  background-slicing path.
- A valid cube sliced with the `Bambu Lab P1P 0.4 nozzle` system printer
  produces a non-empty G-code preview.
- If preview-result generation fails after slicing, the common UI changes to
  its error state and shows the returned error instead of leaving the user at
  a successful-looking slice with an empty viewport.

## Verification

- The native bridge smoke includes a full bundled-profile regression using
  `Bambu Lab P1P 0.4 nozzle` and a cube on the P1P plate centre. It requires
  a successful slice plus a non-zero layer and toolpath-vertex count.
- The shared UI test verifies that an `orc_get_slice_result` failure changes
  the status to `Error` and renders the bridge error in the status bar.
- `pnpm test`, `pnpm typecheck`, and the serial `scripts\\build-windows.bat
  quick --variant serial` build pass. The standard desktop E2E suite passes
  22 tests; its two existing platform/real-WASM-gated cases are skipped.
