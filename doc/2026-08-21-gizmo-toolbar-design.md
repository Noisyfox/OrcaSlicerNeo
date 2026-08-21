# Gizmo Toolbar Design

Date: 2026-08-21
Status: Approved (implementation plan review, 2026-08-21)
Scope: Gizmo activation UI — a horizontal toolbar overlaid on top of the 3D
viewport with a single Move toggle; the move gizmo stops auto-activating on
selection.

## Summary

OrcaSlicer exposes its transform tools through a small toolbar overlaid on the
3D scene. OrcaSlicerNeo currently has only the move gizmo (Milestone 5) and it
auto-activates on any selection — there is no way to select an object without
the gizmo appearing, and no toolbar.

This milestone:

- Adds a **horizontal gizmo toolbar on top** of the viewport (overlay, not part
  of the sidebar or app toolbar).
- Ships **one button: Move** — it toggles the move gizmo on/off.
- Makes gizmo activation **explicit**: selecting an object never opens the
  gizmo. The gizmo opens only via the toolbar toggle and auto-closes when the
  selection becomes empty (deselect-all via canvas miss, Clear Scene, model
  reload).

Rotate/scale gizmos, a Select tool button, and keyboard shortcuts (G/R/S/Esc)
are follow-ups, not part of this milestone.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Toolbar placement | **Horizontal, top edge of the viewport** (absolute overlay, centered) | User choice; keeps the right edge free for the viewcube/right-docked tools later; the app toolbar row above stays untouched |
| Toolbar contents | **Single Move icon button** (toggle) | User choice; only the move gizmo exists today — no placeholder buttons |
| Activation model | **Toggle-only, close-on-empty**: `openGizmo` is written only by the toolbar toggle; it auto-closes when the selection empties | User requirement: "not automatically activated when object selected, must be explicitly opened", with auto-close on empty selection retained |
| Rendering gate | Selection emptiness gates gizmo **rendering** via the existing pivot (no gizmo pivot ⇒ no gizmo) | No Scene.tsx change needed — `SelectionMoveGizmo` already renders only when a pivot exists |
| Shortcuts | None in this milestone | User scope; recorded as follow-up |

## Architecture

The scene controller keeps its single-writer role for `openGizmo`:

```
Viewport (overlay sibling of LayerScrubber)
└─ GizmoToolbar (sceneInteraction prop)
   └─ Button[Move] ── toggleGizmo() ──► SceneInteractionController
                                        openGizmo: 'move' | null
                                         ▲  auto-close on empty selection
                                        └─ selectFromHit / pruneSelection /
                                           clearSelection / resetForModel
Scene (inside Canvas)
└─ SelectionMoveGizmo ── gizmo === 'move' && pivot ? <MoveGizmo/> : null
```

### Component files

- `packages/slicer-app/src/components/viewport/GizmoToolbar.tsx` — new overlay
  component. Consumes the controller through the explicit-controller
  `useSceneInteractionVersion(sceneInteraction)` overload (the toolbar renders
  **outside** the R3F Canvas, like `MovePanel`).
- `packages/slicer-app/src/components/viewport/SceneInteractionController.ts` —
  `toggleGizmo()`; `syncGizmoToSelection()` becomes close-if-empty.
- `packages/slicer-app/src/components/viewport/Viewport.tsx` —
  `sceneInteraction` prop; renders `<GizmoToolbar>`.
- `packages/slicer-app/src/App.tsx` — passes the already-owned
  `sceneInteraction` state down to Viewport.

## Controller changes (`SceneInteractionController`)

- Add `toggleGizmo(): boolean` — flips `openGizmo` between `'move'` and `null`,
  emits, returns the new state.
- `syncGizmoToSelection()` — replaces the auto-open
  (`empty ? null : 'move'`) with close-if-empty only:
  `if (this.selection.empty) this.openGizmo = null;`. It remains called from
  `selectFromHit` / `pruneSelection`, so a selection that empties (e.g. a model
  reload pruning stale IDs) closes the gizmo; a non-empty selection never opens
  it.
- `clearSelection()` / `resetForModel()` — unchanged (already null the gizmo).
- `beginGizmoDrag()` — unchanged; its `openGizmo === null` guard now means
  "not toggled on".

## Interaction

- Clicking an object selects it; the move panel appears; **no gizmo**.
- Clicking **Move** arms the gizmo (button highlights, `aria-pressed`); the
  gizmo appears if something is selected.
- Toggling Move off hides the gizmo; the selection persists.
- With Move armed, clicking empty space (deselect), Clear Scene, or a model
  reload auto-closes the gizmo; re-selecting does not reopen it — the user
  toggles Move again.

## Testing

- **Unit (vitest)** — `SceneInteractionController.test.ts`:
  - Selecting does not open the gizmo; `toggleGizmo()` arms/disarms;
    `clearSelection()` auto-closes; prune-to-empty auto-closes; armed gizmo is
    required for `beginGizmoDrag()`.
  - Existing gizmo-drag tests gain a `toggleGizmo()` before the drag setup.
- **e2e (Playwright Electron, mock build)** — `apps/desktop/e2e/app.e2e.ts`:
  - After the first selection, hover the shaft point and assert
    `__orcaE2e.gizmoAxis` stays `null` (no auto-activation).
  - Click `gizmo-btn-move` before the existing gizmo-axis / pointer-owner /
    X-arrow-drag assertions.

## Docs & plan updates

- `spec/Grand Plan.md` — new "Gizmo Toolbar" milestone entry.
- `doc/high_level_dev_plan.md` — matching roadmap entry.

## Amendments

### 2026-08-21 — supersedes the M5 "no toolbar buttons" decision

`doc/2026-08-16-move-gizmo-design.md` reserved a `tool` field in the settings
store and explicitly deferred toolbar buttons ("gizmo-on-selection; no toolbar
buttons"). This design replaces that model: the gizmo opens **only** via the
toolbar toggle, never on selection. No settings-store `tool` field is added —
the controller's `openGizmo` remains the single source of truth.

## Follow-ups (not in this milestone)

- Rotate/scale gizmos and their toolbar buttons (Grand Plan "Gizmos: rotate/
  scale/cut/measure/arrange/orient").
- Select tool button (explicit "no gizmo" mode is already the default state).
- Keyboard shortcuts: G (move), Esc (close gizmo); R/S when those gizmos land.
- Numeric rotate/scale panels in the sidebar.
