# Scene toolbar actions: Add Model in the gizmo toolbar, Clear Scene in the scene context menu

**Date:** 2026-08-22

**Status:** Implemented

## Goal

Match OrcaSlicer's scene toolbar organization:

1. **Add Model** moves from the app toolbar row into the top-of-viewport gizmo
   toolbar, at the first position (before Move / Rotate / Scale).
2. **Clear Scene** moves from the app toolbar row into a right-click context
   menu that opens on the empty space of the 3D scene.

The app toolbar row then carries only Slice and Export.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Add Model placement | First button of the gizmo toolbar, icon-only (title/aria-label "Add Model") | User request; matches OrcaSlicer's scene toolbar "Add" action |
| Add Model gating | Stays gated on presets being loaded, **not** on selection emptiness | The gizmo toggles require a selection; importing a model must work on an empty plate |
| Clear Scene placement | Right-click context menu on empty scene space | User request |
| "Empty space" definition | The topmost scene raycast hit under the cursor is **not** a model body | The bed/plate and the background are empty; right-clicking a model keeps doing nothing |
| Menu trigger timing | Open on right-button **release** without meaningful movement (4 px) | Right-drag still pans the camera (`OrbitControls` RIGHT=PAN); a context menu that opens on right-button-down would break panning |
| Native context menu | Suppressed (`preventDefault`) for the whole canvas | The host/browser default menu must never appear inside the 3D scene |

## Flow

### Add Model

`GizmoToolbar` renders the labeled Add Model button first. Clicking it calls
the shared `addModel(platform, sceneInteraction)` action extracted from the
old `Toolbar` (`packages/slicer-app/src/components/toolbar/sceneActions.ts`):
host file picker → wait for any settled transform commit → `runtime.addModel`
→ invalidate the sliced result, record the display name, flip `modelLoaded`,
reset scene interaction. Disabled until the boot preset lists arrive.

### Clear Scene (context menu)

`SceneContextMenu` wraps the R3F canvas with a pointer-events-none sensor:

1. `contextmenu` on the canvas is intercepted and `preventDefault`ed (no
   host/browser menu anywhere in the scene).
2. On a right-button `pointerdown`, the sensor raycasts the scene at the
   cursor (via the shared `RootState`) and records whether the topmost hit is
   a model body.
3. On right-button `pointerup`, if the pointer moved less than 4 px and the
   press did not start on a model body, the menu opens at the cursor.
4. The menu shows a single **Clear Scene** item (disabled while slicing or
   with no model loaded), reusing the shared `clearScene` action.
5. The menu closes on an outside pointer press, Escape, or selecting the
   item.

## Files

- `packages/slicer-app/src/components/toolbar/sceneActions.ts` — shared
  `addModel` / `clearScene` actions (extracted from `Toolbar.tsx`).
- `packages/slicer-app/src/components/viewport/GizmoToolbar.tsx` — Add Model
  button at the first position.
- `packages/slicer-app/src/components/viewport/SceneContextMenu.tsx` — the
  empty-space right-click menu.
- `packages/slicer-app/src/components/viewport/Viewport.tsx` — wraps the
  canvas with `SceneContextMenu`.
- `packages/slicer-app/src/components/toolbar/Toolbar.tsx` — now Slice +
  Export only.
- `apps/desktop/e2e/app.e2e.ts` — full-flow test clears via the context
  menu; shortcuts test asserts the disabled menu item after Delete.

## Tests

- Electron e2e (mock): the full flow right-clicks empty space (top-right of
  the canvas), opens the context menu, and clears the scene through it.
- Electron e2e: after Delete empties the plate, right-click opens the menu
  with **Clear Scene** disabled.
- `btn-add-model` keeps its test id in its new toolbar position, so the
  remaining add-model e2e paths (web, preferences, packaged smoke) are
  unchanged.
- `pnpm test` + `pnpm typecheck` (all workspaces) green; no WASM quick build
  needed — no bridge or build-scaffold changes.
