# Orientation gizmo (drei GizmoViewport) in the viewport

Date: 2026-08-17

## What

Orientation gizmo in the bottom-left corner of the 3D viewport
(`Viewport.tsx`): drei `GizmoHelper alignment="bottom-left"` wrapping
`GizmoViewport` (the X/Y/Z axes style — originally the viewcube was used,
swapped for the axes on request). Clicking an axis head tweens the main
camera to look along that axis; the gizmo's orientation tracks the camera.

## Composition (drei 10.7.8)

- `GizmoHelper` — positions the gizmo in a `Hud` portal (an orthographic
  camera + separate scene rendered on top of the main scene at
  `renderPriority` 1). `alignment` + `margin` place it in screen space.
- `GizmoViewport` — a group scaled 40 with three colored axis cylinders
  (X `#ff2060`, Y `#20df80`, Z `#2080ff` — the standard X red / Y green /
  Z blue) and sprite heads labeled X/Y/Z. Head presses
  (`onPointerDown`, not click) call `tweenCamera(e.object.position)` —
  the head's local position is the axis direction. Events are
  `stopPropagation`'d and the portal takes pointer events at priority 2,
  so orbit-drag, drag-gizmo, and `onPointerMissed` deselect are untouched.

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
- The axis labels are X/Y/Z, which are orientation-agnostic — unlike the
  viewcube's face names (drei's defaults are Y-up: "Front" on the top face),
  no remapping is needed. Clicking the Z head looks down +Z; the X head
  looks along +X, etc. Colors follow the standard X red / Y green / Z blue.

## Notes / limits

- The gizmo is ~40 units inside an ortho frustum sized in screen pixels;
  `margin={[40, 40]}` keeps it clear of the bottom-center layer scrubber.
- On screen the axes appear as: X (red) horizontal = camera right, Y
  (green) into the screen = view direction, Z (blue) vertical = camera up
  (world +Z in the initial view). The Z head therefore sits on the world
  +Z axis — the same head a slicer user expects under "top".
- Verified in the built app via Playwright Electron pixel + projection
  probes: gizmo visible bottom-left; clicking the Z head yields a
  top-down view (bed plate projects as a square, a point 40 mm above the
  origin projects at canvas center); clicking the X head yields an
  edge-on view; gizmo re-syncs after each tween. Existing e2e suite
  (2 tests) still passes — their canvas-pixel assertions clip the bottom
  130 px of the canvas, outside the gizmo's region.
