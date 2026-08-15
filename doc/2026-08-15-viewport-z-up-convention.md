# Viewport coordinate convention: Z-up (slicer space)

Date: 2026-08-15

## Decision

The 3D viewport uses the slicer coordinate convention: **Z axis up, X axis
right, Y axis into the screen** (right-handed, identical to libslic3r's
coordinates). The scene is not in three.js's default Y-up space; scene
coordinates are slicer coordinates, so everything that crosses the bridge
(model vertices, instance offsets, toolpaths) passes through unmodified.

## What changed

- `Viewport.tsx` — camera `up: [0, 0, 1]`, height on Z, position in the front
  (+X, −Y) octant so the initial view reads the convention: X right, Y into
  the screen, Z up. three r185 OrbitControls derives its orbit axis from
  `camera.up`, so no separate controls wiring.
- `BedPlate.tsx` — bed is the XY plane at Z=0 (`planeGeometry` needs no
  rotation); grid at `z = 0.01` with `rotation={[-Math.PI / 2, 0, 0]}` —
  drei's `Grid` is a *ground* grid whose vertex shader swizzles to local XZ
  (`position.xzy`), so an unrotated grid stands vertical in the Z-up scene;
  Rx(−90°) maps its local XZ onto the world XY.
- `BedPlate.tsx` (grid visibility) — two grid bugs fixed on 2026-08-15,
  both verified empirically with an e2e-mode pixel harness (grid-colored
  pixel counts per camera elevation):
  - `side={THREE.DoubleSide}` — drei's default `BackSide` culls the grid
    from the default camera elevation (only steep top-down views rendered
    it). Both single-sided orientations tested (Rx(−90°)+BackSide and
    Rx(+90°)+FrontSide) cull at the default view; DoubleSide renders from
    every view above the bed. Tradeoff: the grid also renders when the
    camera orbits below the bed plane (the bed itself stays FrontSide, so
    it disappears from below) — acceptable; PrusaSlicer-style camera
    clamping is a possible follow-up.
  - `fadeDistance={Infinity}` — drei's fade is measured from the camera's
    projection onto the grid plane. The default camera sits 283–420mm off
    the bed, so any finite fadeDistance (we had 500; drei's default is
    100) washed the grid to a fraction of its alpha from the default
    view. The fade exists for infinite grids; a bounded bed grid never
    needs it.
- `ModelMesh.tsx` — drag plane is `(0,0,1)` at `BED_Z = 0`.
- `Scene.tsx` — directional light height on Z.

The `axesHelper` needs no change: its X=red / Y=green / Z=blue colors match
the convention once the camera is Z-up.

## Why

- The WASM core (libslic3r) emits Z-up coordinates; previously the scene was
  Y-up, so models were displayed tipped 90° from the slicer convention.
- The instance-offset drag math in `ModelMesh.tsx` mixed Y-up scene space with
  the Z-up core space — drag offsets are now correct by construction
  (scene space == slicer space == core space).
