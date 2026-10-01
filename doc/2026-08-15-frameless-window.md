# Frameless window with native controls — 2026-08-15

**Decision:** the BrowserWindow is frameless on **all** platforms
(`titleBarStyle: 'hidden'`), so the only visible title bar is the renderer's
custom one (`TitleBar.tsx`, M2). Window controls stay native:

- **Windows/Linux:** the native min/max/close buttons are drawn by the OS in
  the top-right via the **Window Controls Overlay**
  (`titleBarOverlay: { color, symbolColor, height }`), themed to match the
  bar (`#181818` = the dark `--card` token, `#e6e6e6` symbols, 32px = the
  `h-8` bar). Bonus: Windows 11 snap-layout flyout on the maximize button
  works again.
- **macOS:** the traffic lights float over the top-left of the custom bar
  (`trafficLightPosition: { x: 12, y: 9 }` centers the 14px lights in the
  32px bar). The renderer exposes `window.orca.platform` (preload) and pads
  the label `pl-20` on darwin so it clears the lights.

## Current shared titlebar layout (2026-10-01)

The shared titlebar is now 32px high (`h-8`). Windows/Linux overlay height is
32px with the existing `#262E30` background, and macOS traffic lights use
`{ x: 12, y: 9 }`. Shared page tabs and Save/Undo/Redo controls are no-drag;
Windows/Linux reserve the native window-control area. macOS retains the native
flat application menu and traffic-light safe inset. See
[`2026-08-25-titlebar-native-menu-implementation.md`](2026-08-25-titlebar-native-menu-implementation.md)
for the current layout. The original implementation notes below provide the window-control background. Focused mock Electron layout/menu verification passed on Windows; macOS
traffic-light placement remains a manual platform check.

## Why

The app needs a custom top bar anyway (it carries the slicer's brand chrome),
but hand-rolled window buttons were a regression: they lost OS-native hover
states, snap layouts, and accessibility. The Electron custom-title-bar
pattern (https://electronjs.org/docs/latest/tutorial/custom-title-bar) keeps
the custom bar while delegating the controls back to the OS.

## What changed

- `apps/desktop/src/main/index.ts` — `titleBarStyle: 'hidden'` unconditionally;
  `titleBarOverlay` on non-darwin, `trafficLightPosition` on darwin.
- `apps/desktop/src/renderer/src/components/layout/TitleBar.tsx` —
  `-webkit-app-region: drag` on the header; no-drag was only needed for the
  (now removed) custom buttons; darwin-only `pl-20` for the traffic lights.
  No `env(titlebar-area-*)` CSS needed: the label is left-aligned and never
  collides with controls on either platform.
- Removed the custom window-control chain as dead code: the three buttons,
  `Ipc.windowMinimize/ToggleMaximize/Close`, the preload
  `minimize/toggleMaximize/close` methods, and the main-process handlers.
- `apps/desktop/src/preload/index.ts` — exposes `platform: process.platform`
  (used by the TitleBar for the traffic-light clearance).

## Notes

- macOS traffic-light placement is tuned by eye from the formulas above and
  needs confirmation on a real Mac.
- Windows `titleBarOverlay` colors are hardcoded to the current dark theme;
  when the app grows a light theme the main process must match it
  (`env(titlebar-area-*)` + a theme-aware color are the natural follow-up).
- `TitleBar.test.tsx` and `apps/desktop/e2e/titlebar-menu.e2e.ts` cover the
  shared titlebar menu and its no-drag controls. Real macOS traffic-light
  placement still needs manual verification.
