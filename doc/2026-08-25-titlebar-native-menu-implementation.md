# Titlebar and Native Menu Implementation

**Date:** 2026-08-25  
**Status:** Implemented; focused cross-host verification is recorded below.  
**Scope:** Shared titlebar branding and File/Help menu behavior for Web and
Electron custom/native surfaces.

## Delivered behavior

- `packages/platform-contract` owns the versioned menu model, complete state
  snapshot, command IDs, and `PlatformMenu` synchronization boundary.
- `packages/slicer-app` builds one pure model and state projection. File items
  are startup-disabled, Clear Scene/Slice require a model, Export G-code
  requires a completed result, and all four File business actions are disabled
  while slicing.
- Windows/Linux Electron uses the shared no-drag titlebar menu and exposes
  `Exit`; Web uses the same File/Help renderer without Quit/Exit.
- macOS Electron suppresses the shared dropdown and installs the File/Help
  application menu through the typed preload/main boundary. Its titlebar keeps
  only the traffic-light safe inset and drag region.
- Custom Electron and browser titlebars show the Orca icon to the left of the
  shared menu. Native macOS menu mode hides the icon with the renderer menu,
  using the same native-menu condition.
- This scope intentionally excludes View, gizmo, Add Cube/Add Primitive, and
  keyboard-shortcut menu entries.
- Native selections and titlebar clicks use the same guarded command
  dispatcher. Source opening is an allowlisted `openSource()` operation; the
  host owns the fixed repository URL and does not accept arbitrary URLs.
- React Strict Mode replays effects during development. Dispatcher activation
  and disposal therefore share the native-command subscription lifecycle, so
  replay cleanup cannot leave the memoized dispatcher inactive.

## Bug fix (2026-08-25 follow-up): completed slice never re-enabled the native menu

On macOS the native Slice/Export items stayed disabled after a slice completed.
Root cause: `App.tsx` fed the slicer store's raw 0–100 percent into
`MenuStateSnapshot.slicer.progress`, while the host boundary (`cloneState` in
`apps/desktop/src/main/nativeMenu.ts`) validates progress as a 0–1 fraction.
The bridge publishes 0–100 (terminal 100), so the first progress tick above 1%
invalidated every subsequent snapshot; `syncState` fell back to the
startup-disabled state and Slice/Export never re-enabled.

Fix: `buildMenuStateSnapshot` in `packages/slicer-app/src/menu/menuModel.ts` now
normalizes the store's percent to the snapshot's 0–1 fraction at the single
projection point. Regression coverage:

- `menuModel.test.ts` — completed slice (progress 100) projects to exactly 1.
- `nativeMenu.test.ts` — host keeps native items enabled for a completed-slice
  snapshot.
- `apps/desktop/e2e/native-menu.e2e.ts` — macOS-only e2e that slices with the
  mock module (which drives 0–100 progress like the real bridge) and asserts
  the native application menu re-enables Slice/Export. Fails without the fix.

## Commit boundaries

The implementation was intentionally split before this follow-up:

- `72b1892` — platform menu contract and pure model.
- `ca092c5` — shared command dispatcher and titlebar integration.
- `71260cd` — Electron IPC/preload boundary and macOS native menu controller.

This Step 6 follow-up adds focused cross-host coverage and documentation only.
The pre-existing dirty
`packages/slicer-wasm/cpp` submodule state is unrelated and was not changed.

## Verification

For the Orca icon follow-up on 2026-09-24, `pnpm --filter @orca/slicer-app typecheck`
and `git diff --check` passed. UI tests were not run for this follow-up.

The following checks were actually run from the repository root:

- `pnpm --filter @orca/slicer-app exec vitest run src/menu src/components/layout/TitleBar.test.tsx` — passed, 4 files / 20 tests.
- `pnpm --filter @orca/web test -- src/browserAdapter.test.ts` — passed, 1 file / 3 tests.
- `pnpm --filter @orca/desktop test -- src/main/nativeMenu.test.ts src/preload/index.test.ts src/renderer/src/platform/electronAdapter.test.ts` — passed, 3 files / 18 tests.
- `apps/desktop/e2e/titlebar-menu.e2e.ts` — passed in the focused mock-Electron run.
- `pnpm test` — passed.
- `pnpm typecheck` — passed.
- `git diff --check` — passed; only Git's LF/CRLF normalization warnings were reported.

The full desktop E2E suite did not pass because the pre-existing
`app.e2e.ts` rotate/scale gizmo tests fail stably (`expected Z axis, received
null`). That failure has no file overlap with this titlebar step and is not
caused by the added titlebar E2E. The mock Electron titlebar test avoids real
WASM and covers custom File/Help activation,
Exit, empty/model/result state transitions, clear-scene behavior, and no-drag
controls. The Web E2E extends the existing real-artifact flow with no-Quit,
menu-state, and fixed-source assertions.

Real macOS packaged-app manual verification remains incomplete. It must still
be performed on macOS for traffic-light placement, exactly-one native File/Help
surface, native menu pointer behavior, Quit, source opening, and state reset
after closing/reopening a window.
