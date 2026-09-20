# Quit app when the main window is closed

Date: 2026-08-16

## Decision

Closing the last window quits the app completely, on all platforms — including
macOS.

Electron's default macOS behavior keeps the app running in the dock after the
last window closes (the classic Cmd+Q-less stay-alive pattern, with `activate`
recreating the window). OrcaSlicerNeo does not want that: it is a single-window
tool, and the slicer worker + renderer server should not linger in the
background. Quitting matches the original OrcaSlicer desktop behavior.

## Implementation

- `apps/desktop/src/main/index.ts` intercepts the native window close event and
  asks the renderer's lifecycle bridge for a decision. During startup, before
  the runtime has a project-history session, the shared app immediately allows
  the close request; once boot is ready, dirty projects use the existing
  close-confirmation flow.
- `apps/desktop/src/main/index.ts`: `window-all-closed` now calls `app.quit()`
  unconditionally (was `if (process.platform !== 'darwin')`).
- The `app.on('activate')` handler was removed — with quit-on-close the app
  never reaches a running-with-no-windows state, so it is dead code.
- `will-quit` already closes the loopback renderer server; `app.quit()` goes
  through the normal quit path, so that cleanup still runs.
