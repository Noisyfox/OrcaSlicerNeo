# Default viewport camera looks at the plate center (45° front view)

Date: 2026-08-22

## Change

On app launch the 3D viewport now frames the build plate the slicer way:

- the camera looks at the **center of the plate** — `(110, 110, 0)` for the
  220×220 mm bed, which spans `[0, 220]²` in the XY plane with Z up;
- the plate's **X axis is horizontal** on screen;
- the plate plane sits at **45° to the screen plane** (camera elevation 45°).

## Geometry

The scene follows the Z-up / X-right / Y-into-screen slicer convention
(`threeZUp.ts`, `BedPlate.tsx`). For the plate plane (XY, normal Z) to make
45° with the screen plane, the view direction must sit at 45° elevation:
`f ∝ (0, 1, -1)` when the camera is in the front (−Y) octant. With camera
up = Z, the screen-right vector is `f × up ∝ (1, 0, 0)`, so X is exactly
horizontal and points right.

Camera constants (in `Viewport.tsx`):

- target: `(BED_SIZE/2, BED_SIZE/2, 0)` = `(110, 110, 0)`
- position: `(BED_SIZE/2, BED_SIZE/2 - d/√2, d/√2)` with `d = 450`
  → `(110, -208.2, 318.2)`
- fov 45°; `OrbitControls target` is the plate center so orbit and the
  viewcube gizmo rotate around the plate center too.

The distance 450 mm frames the whole plate with margin (models can sit tall
on top of it).

## Verification

Numeric check with the repo's three.js r185: plate-corner projections show
the X edges share the same NDC y (horizontal), `X · screen-up = 0`,
`X · screen-right = 1`, and the angle between the plate normal and the view
direction is 45.00°. The whole plate fits inside the viewport with margin at
1280×800. The e2e gizmo drags aim via `__orcaE2e.projectWorldToScreen`, so
they track the live camera and do not hardcode the old position.

## Files

- `packages/slicer-app/src/components/viewport/Viewport.tsx` — camera
  position/fov, OrbitControls target, constants.
- `packages/slicer-app/src/components/viewport/BedPlate.tsx` — comment only
  (default-camera distance range no longer accurate).
