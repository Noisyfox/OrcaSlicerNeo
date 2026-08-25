# M9 Step 4 — Static Web Host

**Date:** 2026-08-20
**Status:** Implemented and verified
**Scope:** Add the Vite static Web host and browser platform adapter while
keeping Electron's host and runtime behavior unchanged.

The Web entry gates startup on WebGL 2 and wasm64 support, injects browser file
selection/download and in-memory preferences, and uses the shared application
and runtime packages. Browser resources remain deployment-base relative. The
Web host deliberately does not add drag-and-drop, persistence, cloud/backend
calls, PWA behavior, or the dual-artifact Chrome E2E covered by Step 5.

Verification: `pnpm --filter web test` (2 passed), `pnpm --filter web build`,
`pnpm test` (all workspace tests passed), `pnpm typecheck`, and Electron E2E
(3 passed, 1 intentional skip: rejecting-model error test). The WASM quick
build and real threaded/serial Chrome E2E remain Step 5 work.

**Update (2026-08-20):** the Web layout is now fully fluid. The fixed
minimum-viewport floor was removed from `apps/web/src/styles.css` (after first
being reduced from 1024 × 700 to 640 × 480). The shell was already
shrink-friendly — sidebar clamps at 220 px (`Workspace.tsx`
`MIN_SIDEBAR_WIDTH`), `<main>` is `min-w-0 flex-1`, BrandBar/toolbar/status bar
have no fixed widths — so the app adapts to any window size, and the settings
panel and 3D viewport scroll/clip internally when constrained. No page-level
scrolling is needed, which also removes the earlier caveat that `#root`'s
scrollbars could extend past the viewport edge. Spec and implementation plan
updated to match.

Follow-up (same day): the web wrapper is `height: 100%` rather than
`min-height: 100vh`. `min-height` would not establish a definite containing
block, so AppShell's `h-full` root resolved to `auto` and the shell sized to
content — window height changes did not propagate (bottom clipped, dead space
below). The percentage chain html → body → #root → `.web-app-shell` →
AppShell `h-full` keeps the flex column viewport-tall; the canvas is
`absolute inset-0` and fills the `flex-1` main row.
