# Preview Shell Material Transition

**Date:** 2026-09-01

**Status:** Implemented

**Scope:** Eliminate the visible opaque frame when opening Preview from Home or
Device.

Preview model shells must render with their `0.15` opacity from their first
visible WebGL frame. When a hidden Workspace is opened directly in Preview,
the browser can otherwise show the Canvas's previously painted opaque Prepare
buffer before React Three Fiber renders the new scene. For a Home/Device →
Preview navigation, Workspace renders its Preview presentation while still
hidden, then completes navigation after that render loop has produced a frame.
The existing Canvas is never temporarily hidden after the tab becomes visible.

The shared Canvas, model geometry, camera, selection, and other Workspace
resources remain mounted and unchanged by this transition.
