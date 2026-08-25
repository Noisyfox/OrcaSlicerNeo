# 2026-08-15 — Resizable sidebar

## Why

The settings sidebar was a fixed `w-72` column. Users need to widen or narrow
the panel to see long preset names and option controls, especially on larger
displays.

## What changed

- `packages/slicer-app/src/components/workspace/Workspace.tsx`
  - Replaced the fixed `w-72` aside width with a React-managed pixel width.
  - Added a vertical resize separator between the sidebar and the viewport.
  - Pointer and mouse drag resizing listen on `window` so the drag
    continues outside the separator.
  - The width is clamped to `220px`–`560px` and persisted through the platform
    preferences contract (`ui.sidebarWidth`) — `userData/preferences.json` on
    Electron, `localStorage` on Web — so the user's preferred sidebar width
    survives restarts.
  - The separator is keyboard accessible (`ArrowLeft`/`ArrowRight` adjust by
    `16px`) and exposed with `role="separator"` plus
    `data-testid="sidebar-resizer"`.

## Behavior

- Default width remains `288px` (the old `w-72`).
- Drag the separator left/right to resize.
- Width is saved on pointer release and after keyboard changes.
