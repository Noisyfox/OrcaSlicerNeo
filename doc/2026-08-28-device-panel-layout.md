# Device panel layout (2026-08-28)

The top-level Device page follows the same surface language as Workspace while
remaining a sibling page rather than part of the Workspace scene. The saved
printer list and printer console are separate rounded, bordered card surfaces
with a narrow draggable divider between them.

The divider supports pointer/mouse dragging and `ArrowLeft`/`ArrowRight` when
focused. The sidebar defaults to 288px and is clamped between 220px and 560px.
Its width is persisted in `UserPreferences.ui.deviceSidebarWidth`; the
Workspace width remains in `ui.sidebarWidth`, so resizing one page never
changes the other.

The console and printer-selection/WebView lifecycle are unchanged. Resizing is
purely presentational and does not change the ephemeral selected printer or
dispose the embedded console.

Coverage includes card layout classes, dimensions, accessible separator values,
keyboard resizing, and preservation of the Workspace width when persisting the
Device width.
