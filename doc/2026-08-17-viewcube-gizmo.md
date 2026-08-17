# Viewcube gizmo (drei GizmoViewcube) in the viewport

Date: 2026-08-17

## What

Orientation viewcube in the bottom-left corner of the 3D viewport
(`Viewport.tsx`): drei `GizmoHelper alignment="bottom-left"` wrapping
`GizmoViewcube`. Clicking a face / edge / corner tweens the main camera to
look along that axis; the cube's orientation tracks the camera.

## Composition (drei 10.7.8)

- `GizmoHelper` — positions the gizmo in a `Hud` portal (an orthographic
  camera + separate scene rendered on top of the main scene at
  `renderPriority` 1). `alignment` + `margin` place it in screen space.
- `GizmoViewcube` — the 3D cube: `FaceCube` (a `boxGeometry` with 6 canvas
  textures) plus edge/corner cubes. Face clicks call `tweenCamera(e.face.normal)`;
  the cube is `stopPropagation`'d and the portal takes pointer events at
  priority 2, so orbit-drag, drag-gizmo, and `onPointerMissed` deselect are
  untouched.

## Demand-render compatibility

`Viewport.tsx` runs `frameloop="demand"` (see
`doc/2026-08-16-demand-render-viewport.md`). Verified against the installed
source:

- `Hud`'s `RenderHud` (priority 1) takes over frame rendering: it renders the
  default scene, then the portal scene, every invalidated frame. No other
  `useFrame` priorities exist in the renderer, so it owns rendering safely.
- The click tween invalidates each frame until the rotation lands
  (`q1.angleTo(q2) < 0.01`), so the animation drives its own frames.
- Nothing renders while idle — same as before.

## Z-up handling

The scene is Z-up (slicer convention, `doc/2026-08-15-viewport-z-up-convention.md`).

- `GizmoHelper`'s tween rotates about the camera's current up vector and
  restores `camera.up` to the saved default (`[0, 0, 1]`) when the animation
  completes, so OrbitControls keep orbiting around Z afterwards.
- **Face labels are remapped**: drei's defaults map `['Right','Left','Top',
  'Bottom','Front','Back']` onto box materials (+X, −X, +Y, −Y, +Z, −Z), a
  Y-up convention — "Front" would print on the top face and "Top" would sit
  below the build plate. The viewcube passes
  `faces={['Right', 'Left', 'Back', 'Front', 'Top', 'Bottom']}` so the top
  face reads "Top" (+Z) and the printer front (−Y, the direction the initial
  camera looks from per `Viewport.tsx`) reads "Front". The click handler
  rotates by `e.face.normal`, independent of the label, so the remap only
  changes text.

## Notes / limits

- The cube overlays at ~42 px in the corner (group scale 60 inside an
  ortho frustum sized in screen pixels); `margin={[40, 40]}` keeps it clear
  of the bottom-center layer scrubber.
- Verified manually in dev (`pnpm --filter desktop dev`): cube visible
  bottom-left, face/edge/corner clicks snap to axis-aligned views, camera up
  is Z after every tween.
