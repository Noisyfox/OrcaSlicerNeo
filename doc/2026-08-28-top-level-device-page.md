# Top-level Device page

**Date:** 2026-08-28

**Status:** Implemented

**Scope:** Correct the shared app page hierarchy after the initial Device UI
implementation.

## Decision

`Workspace` owns only the profile/settings sidebar and the 3D scene. `Device`
is a sibling top-level page selected by the shared app navigation. The app
shell owns the two page containers and their lifecycle, rather than embedding
Device as a second panel inside Workspace.

Both page trees stay mounted while navigation changes. The inactive page uses
`hidden`, `aria-hidden`, and `inert`, so the WebGL scene and printer console
guest retain local UI state without receiving focus or input. Home, Prepare, and
Preview continue to share the one Workspace scene surface.

The navigation trigger and page container pairs use stable ARIA relationships:
the active Workspace tab (`app-tab-home`, `app-tab-prepare`, or
`app-tab-preview`) → `app-panel-workspace`, and `app-tab-device` →
`app-panel-device`.

## Verification

The Workspace structural test asserts that Device is not rendered inside the
Workspace tree. The AppShell lifecycle test asserts that both page trees stay
mounted, preserve node identity and local state, and toggle the expected
hidden/inert/ARIA state. Existing Device component and Electron fixture tests
continue to cover printer-console lifecycle and CRUD behavior.
