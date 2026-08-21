# Rotate & Scale Gizmos Design

Date: 2026-08-21
Status: Approved (user Q&A, 2026-08-21)
Scope: Milestone 11 — rotate and scale tools for the 3D viewport, extending
the M10 gizmo toolbar and the M5 move-gizmo architecture. Includes the
sidebar rotate/scale panels, a scale world/local coordinate toggle, and the
Euler-convention alignment between the JS renderer and the C++ slicer.

## Summary

The move gizmo (M5) and its toolbar (M10) establish the pattern: a non-
rendering aggregate-selection pivot is manipulated by drei `TransformControls`;
the scene controller applies the pivot delta to every selected instance.

This milestone:

- **Rotate gizmo**: drei `TransformControls` mode `rotate`, world space —
  X/Y/Z rings. The drag rotates the whole selection around the selection-
  center pivot; each instance's offset orbits the pivot and its rotation
  (Euler ZYX, radians) is recomposed from the world rotation delta.
- **Scale gizmo**: drei `TransformControls` mode `scale` with a **world/local
  coordinate toggle**. World (default): handles world-aligned, factors
  written to instance `scale` componentwise (exact for unrotated objects;
  OrcaSlicer-style local-factor approximation for rotated ones). Local:
  handles align to the selected object's axes and factors apply exactly along
  them. Multi-selection always scales in world coordinates and disables the
  toggle.
- **Gizmo toolbar**: three exclusive toggles — Move, Rotate, Scale.
- **Sidebar panels** (render with their gizmo, like `MovePanel`):
  - **Rotate panel**: X/Y/Z inputs in degrees + Reset. Single selection shows
    the object's rotation; multi-selection shows **0** and edits apply as
    relative deltas to every selected object.
  - **Scale panel**: World/Local toggle, X/Y/Z scale-factor inputs (%), X/Y/Z
    size inputs (mm, the dimensions the object is scaled to), Reset. Single
    selection shows the actual factor/size; multi-selection shows **100%**
    for factors (edits apply relatively) and the aggregate bounding-box size
    for dimensions (edits scale the whole selection to that size).
- **Euler-convention fix**: the renderer composes instance/volume rotation
  with three.js Euler order `'ZYX'`, matching the C++ slicer's
  `T · [Rz·Ry·Rx] · S` (`Geometry::assemble_transform`). Previously the
  renderer used three's default `'XYZ'` — invisible while every rotation is
  `[0,0,0]`, but a rotate gizmo would otherwise render differently from the
  sliced result.

No bridge/WASM changes: commits flow through the existing
`persistSettledModelTransforms` → `setModelTransform` path, which already
carries `rotation` and `scale`.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Gizmo tech | drei `TransformControls`, `mode` prop on a shared `TransformGizmo` | Same battle-tested machinery as move; one component, three modes |
| Rotate space | **World only** (`space="world"`) | OrcaSlicer rotates around world axes; no rotate-space toggle requested |
| Scale space | **Toggleable world/local**, default world | User requirement; implemented via the pivot's pre-drag orientation (TC scale is always local to the target) |
| Multi-select scale space | **World, toggle disabled** | No single orientation exists for a group; user decision |
| Rotate delta math | `offset' = pivot + R·(offset−pivot)`; `rotation' = eulerZYX(R·quatZYX(rotation))` | Rotates the selection rigidly around the aggregate pivot; data model stays `T·R·S` |
| Scale delta math | `offset'` displaced along the scale-space axes around the pivot; `scale' = scale·factor`; rotation/mirror untouched | Scale factors are local-frame in the data model (`T·R·S`), so the rendered view equals the sliced result |
| Negative/zero scale | Clamped to a small positive floor (1e-3) | `mirror` is the sanctioned flip mechanism; zero/negative scale would degenerate the mesh |
| Toolbar | Move/Rotate/Scale exclusive toggles | Extends the M10 toolbar; arming still requires a non-empty selection |
| Rotate panel | X/Y/Z degrees + Reset; multi-select shows 0, edits are relative deltas | OrcaSlicer-style manipulation panel; user decision |
| Scale panel | World/Local toggle + factor % + size mm + Reset; multi-select factors show 100%, edits relative; size shows aggregate bbox | User decision ("with inputs and reset, also the size current object is scaled to"; "100% instead") |
| Panel value rule | Single selection shows real values; multi-selection shows a neutral baseline (0° / 100%); edits apply delta from the baseline | Preserves relative orientations/factors across a group |
| Euler convention | Renderer uses `'ZYX'` everywhere instance/volume rotation is consumed | Matches C++ `Rz·Ry·Rx`; required for rotate correctness (latent mismatch, harmless today) |
| Snap / shortcuts / rotate numeric follow-ups | Not in this milestone | M10 design queued them; only the panels the user pulled forward are added |
| Git | No branch/commits (user note: "not a git repo, skipping") | Explicit user preference overrides the repo's default workflow for this task |

## Architecture

```
GizmoToolbar (overlay, outside Canvas)
└─ Move | Rotate | Scale buttons ── toggleGizmo(mode) ──► Controller
                                                         openGizmo: 'move'|'rotate'|'scale'|null
                                                         scaleSpace: 'world'|'local'

Scene (inside Canvas)
└─ SelectionPivot (group)
   └─ armed && <TransformGizmo mode target={pivot}/>   ← TC mutates pivot

SettingsPanel
├─ MovePanel    (gizmo === 'move')
├─ RotatePanel  (gizmo === 'rotate')
└─ ScalePanel   (gizmo === 'scale')   ← World/Local toggle, factors, size, Reset
```

### Transform delta math (`transformDeltaMath.ts`, pure)

All gizmo/panel edits reduce to pure functions over `ModelTransform`:

- `applyRotationDelta(transform, deltaQuat, pivot, spaceQuat)` —
  `offset' = pivot + spaceQuat·(factor⊙(spaceQuat⁻¹·(offset−pivot)))` for
  scale; for rotate `offset' = pivot + deltaQuat·(offset−pivot)` and
  `rotation' = eulerZYX(deltaQuat · quatZYX(rotation))`.
- `applyScaleDelta(transform, factor, pivot, spaceQuat)` —
  `offset' = pivot + spaceQuat·(factor⊙(spaceQuat⁻¹·(offset−pivot)))`;
  `scale' = scale·factor`; rotation/mirror unchanged. `spaceQuat` is identity
  for world, the selection orientation for local.
- Euler helpers: `quatZYX(rotation)`, `eulerZYX(quat)`, radians↔degrees.

The controller captures the pivot's start quaternion/scale in
`DragSnapshot`; deltas are `next·start⁻¹` so gestures are always relative to
their own start.

### Pivot orientation management (`Scene.tsx`)

`syncPivot` writes the pivot position on every controller change and resets
its rotation/scale **between gestures** (`owner === 'none'`):

- rotate armed → pivot identity (world rings).
- scale armed + world → pivot identity.
- scale armed + local + exactly one instance selected → pivot quaternion =
  the instance's world rotation (instance ZYX × volume ZYX), so TC's
  local-mode handles align with the object axes.
- multi-selection → identity (world), toggle disabled.

During an active gesture `syncPivot` only writes position — TransformControls
owns quaternion/scale until release.

## Interaction

- Clicking an object selects it; nothing opens automatically (M10 model).
- **Rotate** armed: rings around the selection center; dragging a ring
  rotates the selection rigidly around the pivot (offsets orbit + rotations
  recompose). Release commits via `persistSettledModelTransforms`.
- **Scale** armed: handles appear at the pivot; center handle = uniform,
  shafts = per-axis; world or local per the panel toggle. Release commits.
- Rotate/Scale panels appear with their gizmo and hide with it; the move
  panel is unchanged.
- Editing a rotate value with a single selection sets absolute degrees
  (delta from the displayed value); multi-selection shows 0 and rotates all
  selected objects by the entered delta. Editing scale factors/sizes behaves
  the same with 100%/aggregate-size baselines. Reset restores the load-time
  rotation/scale from `buffer.instanceTransform`.

## Testing

- **Unit (vitest)**:
  - `transformDeltaMath.test.ts`: rotate delta (offset orbit + ZYX
    recomposition round-trip), scale delta world/local, positive clamp,
    display helpers (degrees, percent, size).
  - `SceneInteractionController.test.ts`: `toggleGizmo(mode)` exclusivity;
    rotate/scale drag deltas over multi-selection; `scaleSpace` setter with
    multi-select world forcing; panel ops (rotate delta, factor %, size mm,
    resets); existing move tests unchanged except the toggle signature.
- **e2e (Playwright Electron, mock build)** — extend `app.e2e.ts`:
  - Toolbar shows three buttons; arming each shows the right panel.
  - Rotate: arm → drag a ring → rotate panel values change → slice sync.
  - Scale: arm → drag a shaft → scale panel factor changes; World/Local
    toggle flips; multi-select disables the toggle.
  - Panel inputs commit (mock `setModelTransform` round-trip) and Reset.
- **Typecheck** (CI). No WASM build — no bridge/build-scaffold changes.

## Docs & plan updates

- `spec/Grand Plan.md` — new "Rotate & Scale Gizmos" milestone entry.
- `doc/high_level_dev_plan.md` — matching roadmap entry.
- Implementation notes appended to this doc on delivery.

## Follow-ups (not in this milestone)

- Cut/measure/arrange/orient gizmos; Select tool button; G/R/S/Esc
  shortcuts; rotation snapping; uniform-scale lock UX (center handle covers
  the common case).
