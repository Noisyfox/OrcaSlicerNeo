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

- `packages/slicer-app/src/components/workspace/viewport/GizmoToolbar.tsx` — new overlay
  component. Consumes the controller through the explicit-controller
  `useSceneInteractionVersion(sceneInteraction)` overload (the toolbar renders
  **outside** the R3F Canvas, like `MovePanel`).
- `packages/slicer-app/src/components/workspace/viewport/SceneInteractionController.ts` —
  `toggleGizmo()`; `syncGizmoToSelection()` becomes close-if-empty.
- `packages/slicer-app/src/components/workspace/viewport/Viewport.tsx` —
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

- Clicking an object selects it; **no gizmo and no move panel** — the move
  panel is part of the gizmo UI (amended 2026-08-21, below).
- Clicking **Move** arms the gizmo (button highlights, `aria-pressed`); the
  gizmo **and the move panel** appear if something is selected.
- Toggling Move off hides both; the selection persists.
- With Move armed, clicking empty space (deselect), Clear Scene, or a model
  reload auto-closes the gizmo (and with it the panel); re-selecting does not
  reopen it — the user toggles Move again.

## Testing

- **Unit (vitest)** — `SceneInteractionController.test.ts`:
  - Selecting does not open the gizmo; `toggleGizmo()` arms/disarms;
    `clearSelection()` auto-closes; prune-to-empty auto-closes; armed gizmo is
    required for `beginGizmoDrag()`.
  - Existing gizmo-drag tests gain a `toggleGizmo()` before the drag setup.
- **e2e (Playwright Electron, mock build)** — `apps/desktop/e2e/app.e2e.ts`:
  - After the first selection, assert the move panel stays hidden (it rides
    with the gizmo) and hover the shaft point — `__orcaE2e.gizmoAxis` stays
    `null` (no auto-activation).
  - Click `gizmo-btn-move`: the panel appears with the gizmo; the remaining
    gizmo-axis / pointer-owner / X-arrow-drag assertions run armed.

## Docs & plan updates

- `spec/Grand Plan.md` — new "Gizmo Toolbar" milestone entry.
- `doc/high_level_dev_plan.md` — matching roadmap entry.

## Amendments

### 2026-08-21 — the move panel rides with the gizmo

The sidebar move panel is part of the move-gizmo UI: it renders only while
the gizmo is armed (`MovePanel` returns null unless `gizmo === 'move'`), so
it appears with the gizmo on the toolbar toggle and hides with it on disarm
or an emptied selection. Because arming requires a non-empty selection (prior
amendment), panel visibility exactly tracks gizmo visibility. This supersedes
the M5 behavior where the panel appeared with any selection, independent of
the gizmo.

### 2026-08-21 — arming requires a non-empty selection

The Move toggle can only **arm** the gizmo while the selection is non-empty.
`toggleGizmo()` returns false (no state change, no emit) on an empty
selection, and the toolbar button is `disabled` until something is selected.
Disarming is unaffected. This tightens the activation model above: the gizmo
opens only via the toolbar toggle **and** only with a selection to act on
(an armed gizmo with nothing selected would render nothing anyway — no pivot).

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

## Implementation notes (delivered 2026-08-21)

Branch `feat/gizmo-toolbar` (commits `2f3cf2b`, `b52bea5`, `cfeae35`, `56b1e3e`,
plus this note and the e2e update).

Delivered as designed with one substantive bug found in e2e:

- **Controller**: `toggleGizmo()` arms/disarms; `syncGizmoToSelection()` is
  close-if-empty; `clearSelection()`/`resetForModel()` keep their existing
  gizmo-close writes. Unit tests rewritten accordingly (14 pass) — see the
  `SceneInteractionController.test.ts` test names for the pinned semantics.
- **Toolbar**: `GizmoToolbar.tsx` renders outside the Canvas and subscribes via
  the explicit-controller `useSceneInteractionVersion(sceneInteraction ?? undefined)`
  overload (the `MovePanel` pattern), so the aria-pressed state and the
  controller stay in sync without an R3F subscription.
- **e2e race (the fix worth remembering)**: after arming via the toolbar
  button, the original single `page.mouse.move(xStart)` then
  `expect.poll(gizmoAxis).toBe('X')` failed with `axis` stuck at `null`.
  Three's `TransformControls` registers a native `pointermove` listener on the
  canvas and refreshes `axis` **only inside that handler** (three r185,
  `onPointerHover` → `_intersect`), so one pointermove that arrives before the
  gizmo's first demand-mode frame leaves `axis` `null` forever — no re-raycast
  ever happens. Arming through a DOM button (outside the Canvas) is faster
  than the old auto-open-on-canvas-click path (which had two polling
  assertions' worth of settle before the mouse moved), so the single move
  could win the race against the frame that mounts and matrices the gizmo.
  Fix (test-side): poll `gizmoAxis` with a fresh `page.mouse.move(xStart)` on
  each iteration — once a pointermove lands on a rendered gizmo the axis
  registers, and the cursor always ends at `xStart` for the drag below. No app
  change needed: a real user always generates fresh pointermoves after
  arming, and each emit already invalidates the demand-mode canvas via
  `syncPivot`.
- **Verification**: `pnpm test` (14 controller + suite green), `pnpm typecheck`
  (all workspaces), `pnpm --filter desktop test:e2e` — 3 passed / 1 skipped
  (slice-error, intentional), including the updated gizmo test (no
  auto-activation, toolbar arming, gizmo-axis drag, pointer-owner
  arbitration, multi-instance move, slice sync, reset). WASM quick build not
  required — no bridge or build-scaffold changes.
