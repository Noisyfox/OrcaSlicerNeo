# Shared shadcn Context Menu migration

**Date:** 2026-08-24
**Status:** Implementation note
**Scope:** Replace the shared React application's hand-built object-list and
viewport context menus with the project's shadcn/ui Base UI Context Menu
components.

## Decision

Both menu surfaces use `ContextMenu` and `ContextMenuTrigger` for native
right-click anchoring and keyboard/outside-press behavior. Menu content uses
the generated shadcn primitives (`ContextMenuContent`, `ContextMenuItem`,
`ContextMenuSeparator`, and the submenu primitives) instead of local `div`,
`button`, and manual positioning markup.

The viewport keeps its existing model-body hit detection and selection rules.
The trigger opens on the browser/Electron `contextmenu` gesture, which occurs
after a right-button drag has been distinguished from a click, so
`OrbitControls` right-button panning remains available. The object list keeps
its row-level selection and target resolution while the shared trigger owns
menu dismissal and focus management.

The native browser/host context menu remains suppressed by the existing shared
app policy outside editable controls and the viewport's Context Menu trigger.
