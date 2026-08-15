# Frameless window on Windows/Linux — 2026-08-15

**Decision:** the BrowserWindow is frameless on Windows/Linux
(`titleBarStyle: 'hidden'`), so the only visible title bar is the renderer's
custom one (`TitleBar.tsx`, M2). macOS keeps its native title bar for now.

## Why

The app ships its own window controls (minimize / toggle-maximize / close in
the renderer's `TitleBar`, wired through `Ipc.windowMinimize` etc.), so the
native bar is pure duplication. A frameless window makes the custom bar the
single chrome surface, matching the design of OrcaSlicer's real GUI and
typical Electron editors (VS Code et al.).

## What changed

- `apps/desktop/src/main/index.ts` — `titleBarStyle: 'hidden'` in the
  `BrowserWindow` options, applied only when `process.platform !== 'darwin'`.
  On macOS, `'hidden'` would float the traffic lights over our custom bar
  (two control sets); full macOS treatment (traffic light embedding,
  `trafficLightPosition`) is a separate follow-up.
- `apps/desktop/src/renderer/src/components/layout/TitleBar.tsx` —
  `-webkit-app-region: drag` on the header (the only drag affordance on a
  frameless window; Windows also provides double-click-to-maximize on drag
  regions natively) and `no-drag` on the window-control button container so
  clicks still register.

## Notes

- `autoHideMenuBar: true` is retained: harmless on a frameless window, and
  macOS still has a global menu bar.
- Windows 11 snap-layout flyout on the maximize button is lost (no native
  maximize button) — acceptable for now.
- No unit/e2e tests touch the title bar, so nothing needed updating there.
