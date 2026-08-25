# Titlebar and Native Menu Implementation

**Date:** 2026-08-25  
**Status:** Implemented; focused cross-host verification is recorded below.  
**Scope:** Shared File/Help menu behavior for Web and Electron custom/native
surfaces.

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
- Native selections and titlebar clicks use the same guarded command
  dispatcher. Source opening is an allowlisted `openSource()` operation; the
  host owns the fixed repository URL and does not accept arbitrary URLs.

## Commit boundaries

The implementation was intentionally split before this follow-up:

- `72b1892` — platform menu contract and pure model.
- `ca092c5` — shared command dispatcher and titlebar integration.
- `71260cd` — Electron IPC/preload boundary and macOS native menu controller.

This Step 6 follow-up adds focused cross-host coverage and documentation only.
The pre-existing dirty
`packages/slicer-wasm/cpp` submodule state is unrelated and was not changed.

## Verification

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
