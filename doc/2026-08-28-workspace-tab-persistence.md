# Workspace Tab Persistence

**Date:** 2026-08-28

**Status:** Implemented

**Scope:** Shared `packages/slicer-app` workspace tabs

## Decision

The workspace keeps exactly one scene surface and exactly one Device surface
mounted for the lifetime of the application. Home, Prepare, and Preview share
the scene surface; changing among them does not recreate the WebGL viewport.
The Device panel likewise remains mounted when another tab is active, which
keeps its ephemeral printer selection, configuration dialog, and embedded
iframe/Electron `<webview>` guest alive.

Inactive surfaces use the native `hidden` attribute together with
`aria-hidden` and `inert`. They therefore do not receive focus or pointer
input and do not consume layout space, while remaining in the React tree.
Toolbar triggers and panel containers are linked with stable ARIA IDs.

## Verification

`packages/slicer-app/src/components/workspace/Workspace.test.tsx` renders the
real Workspace/Device composition with a fake WebView host and checks the
Home → Prepare → Preview → Device cycle. It verifies a single guest mount,
zero disposal during tab changes, stable panel/iframe identity, preserved
configuration-dialog state, and active/inactive hidden/inert semantics.
