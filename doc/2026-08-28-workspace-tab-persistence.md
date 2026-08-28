# Workspace Tab Persistence

**Date:** 2026-08-28

**Status:** Implemented

**Scope:** Shared `packages/slicer-app` workspace and top-level page lifecycle

## Decision

The Workspace contains exactly one scene surface: its profile/settings sidebar
and 3D viewport. Device is a top-level page sibling of Workspace, not a child
or tab panel owned by Workspace. The app shell keeps both top-level pages
mounted for the lifetime of the application. Home, Prepare, and Preview share
the Workspace scene surface; changing among them does not recreate the WebGL
viewport. Navigating to Device likewise keeps the printer selection,
configuration dialog, and embedded iframe/Electron `<webview>` guest alive.

Inactive surfaces use the native `hidden` attribute together with
`aria-hidden` and `inert`. They therefore do not receive focus or pointer
input and do not consume layout space, while remaining in the React tree.
Toolbar navigation triggers and app-shell page containers are linked with
stable ARIA IDs. The Workspace panel is labelled by the active Workspace tab
(`app-tab-home`, `app-tab-prepare`, or `app-tab-preview`) and
`app-panel-workspace`; Device uses `app-tab-device`/`app-panel-device`.

## Verification

`packages/slicer-app/src/components/workspace/Workspace.test.tsx` verifies that
Workspace contains only the settings/sidebar and 3D scene. The app-shell test
verifies both top-level page trees remain mounted, stable identity and state
survive navigation, and active/inactive hidden/inert semantics remain linked
through the ARIA IDs. Device-specific lifecycle coverage remains in the
Device component tests.
