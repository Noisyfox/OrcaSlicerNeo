# Titlebar and Native Menu Implementation

**Date:** 2026-08-25  
**Status:** Implemented; 2026-10-01 layout verified by unit/typecheck and focused mock Electron E2E.
**Scope:** Shared titlebar branding and File/Help menu behavior for Web and
Electron custom/native surfaces.

## Delivered behavior

- `packages/platform-contract` owns the versioned menu model, complete state
  snapshot, command IDs, and `PlatformMenu` synchronization boundary.
- `packages/slicer-app` builds one pure model and state projection. File items
  are startup-disabled, Clear Scene/Slice require a model, Export G-code
  requires a completed result, and all four File business actions are disabled
  while slicing.
- Windows/Linux Electron and Web place one hamburger application menu at the
  far left of the titlebar. File/Help are submenus; Electron exposes `Exit`,
  while Web omits Quit/Exit. The shared/native menu model remains flat.
- macOS Electron suppresses the shared dropdown and installs the File/Help
  application menu through the typed preload/main boundary. Its titlebar keeps
  the traffic-light safe inset and drag region alongside shared navigation and
  quick actions.
- The 32px titlebar contains, in order, the application menu (except native
  macOS), icon-only Save Project, Undo, Redo, Home, Prepare, Preview, Device,
  and the current project name/dirty marker. Save uses the same guarded command
  and enabled state as File → Save Project.
- Titlebar actions use 28px square hit areas and 16px icons. Actions, page-tab
  contents, and the project name share the vertical center of the active tab's
  highlight (y=18.5px in the 32px bar). Tab surfaces are 27px tall, flush with
  the bottom edge; quick-action contents and the project name move down 2.5px
  to match that center. Navigation scrolling hides its scrollbar
  to avoid shifting the centerline.
- Page tabs use a transparent titlebar background and a gray selected surface
  (`#54545A`) with rounded top corners and a square bottom edge. Home is
  icon-only. Tabs use 12px horizontal padding and retain the 10px icon/text gap.
  Page-tab labels and the project name use 13px text with a 20px line height.
  In constrained widths the navigation scrolls within the titlebar.
- Vertical separators appear immediately after the hamburger button and on
  both sides of the page-tab group. Their orientation styling uses the installed
  Base UI separator's `data-orientation` attribute. The separator before Home
  has no right margin; Home's 12px tab padding provides the icon clearance.
  The separator after Device has no left margin; Device's 12px tab padding
  provides its clearance, followed by 12px before the project name.
  Selecting Home hides the tab group's left divider; selecting Device hides
  its right divider. Hidden dividers retain their space to prevent layout shifts.
  All titlebar divider lines share an explicit 1px width, 20px height, and
  fully opaque border color, including the dividers between inactive tabs.
- Undo/Redo left-click performs one operation; right-click opens the directional
  history list on the same icon. No separate dropdown buttons or visible action
  labels remain. Prepare-only availability and existing restore/painting/runtime
  guards are preserved. Slice/Export/Send actions remain in the toolbar.
- Desktop native window controls follow the 32px titlebar height; macOS traffic
  lights use y=9. Windows/Linux reserve the native overlay area. All shared
  interactive titlebar controls are no-drag.
- Mobile product support remains deferred. These changes add no Worker/WASM
  operations or persistent page instances; touch uses the existing context-menu
  long-press interaction.
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

For the 2026-10-01 layout update:

- `pnpm test` passed across the workspace, including 102 slicer-app files /
  874 tests. History navigation coverage moved from Toolbar to its titlebar
  component; Save command dispatch/state and native macOS surface were updated.
- `pnpm typecheck` passed across the workspace.
- `VITE_USE_MOCK=1 pnpm --filter @orca/desktop exec electron-vite build --mode e2e`
  and `pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs` passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/titlebar-menu.e2e.ts`
  passed, 2 tests. Checks include nested File/Help actions, File Manager,
  32px height, shared icon centerline, 1px divider widths, edge-divider hiding,
  and Save availability.
- `pnpm --filter @orca/desktop exec playwright test e2e/titlebar-menu.e2e.ts e2e/app.e2e.ts --grep 'custom titlebar|File Manager|starts on blank Home|full v1 flow|shared titlebar history'`
  verified the Home/page lifetime, import/slice/export, and right-click history
  cases. The two menu cases were subsequently rerun with corrected submenu
  pointer paths and two-level Escape dismissal, passing as recorded above.
- `git diff --check` passed.

Menu E2E uses the hamburger's expanded state and waits for the previous popup
unmount before reopening it. File submenus are entered horizontally before
choosing a lower command, avoiding an unintended hover over Help. Menu
submenus share the titlebar popup layer so File Manager cannot cover them.

Real Web/WASM, the full host release matrix, and macOS manual checks were not
run: this change affects shared chrome and rendered interaction, with no
browser adapter, deployment, Worker, or WASM changes. Prior results below are
historical rather than evidence for the new layout.

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
