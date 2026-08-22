# Scene context menu: Add Cube primitive

**Date:** 2026-08-22

**Status:** Implemented

## Goal

Match OrcaSlicer's scene right-click menu: offer an **Add Cube** entry that
appends a 20 mm cube primitive to the plate, sitting at the scene origin on
the build bed. The cube behaves exactly like an imported model — it is
selectable, transformable, sliceable, and exportable.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primitive mesh source | A binary STL generated in the shared app and fed through the existing `runtime.addModel(bytes, 'stl')` path | The verified load pipeline (parse → `center_around_origin` → `ensure_on_bed` → add to the live `Model`) already places an STL cube exactly like OrcaSlicer's primitive: 20 mm, centered on X/Y, resting on the bed. No bridge, client, or WASM build changes — the cube works identically in mock, threaded, and serial builds. |
| Cube dimensions | 20 × 20 × 20 mm (OrcaSlicer's default primitive size) | Matches OrcaSlicer's Add Cube default. |
| Menu placement | **Add Cube** above **Clear Scene**, disabled while slicing | OrcaSlicer puts primitive creation at the top of the scene menu; the existing Clear Scene item stays below. |
| Menu item naming | "Add Cube" (`btn-add-cube`) | Mirrors OrcaSlicer's menu label; the mock module's cube fixture is already 20 mm, so e2e assertions hold in both modes. |

## Flow

`SceneContextMenu` renders a second menuitem. Clicking it calls the shared
`addCube(platform, sceneInteraction)` action in
`packages/slicer-app/src/components/toolbar/sceneActions.ts`, which reuses the
same post-add choreography as `addModel` (wait for any settled transform
commit → `runtime.addModel` → invalidate the sliced result, record the
display name (`Cube`), flip `modelLoaded`, reset scene interaction).

The STL is produced by `packages/slicer-app/src/lib/cubeStl.ts`: a 684-byte
binary STL (12 triangles, 8 vertices) with the cube spanning -10..10 in X/Y
and 0..20 in Z. After the bridge's centering/bed-rest steps the rendered
result is the OrcaSlicer placement: X/Y centered at the origin, Z from 0..20.
The 12 triangles are wound outward (positive signed volume), and the mesh is
watertight, so libslic3r's importer and the slicer treat it like any STL.

## Files

- `packages/slicer-app/src/lib/cubeStl.ts` — `createCubeStl()` binary STL
  generator (pure, no three.js).
- `packages/slicer-app/src/lib/cubeStl.test.ts` — STL structure, bounds,
  watertightness, and orientation unit tests.
- `packages/slicer-app/src/components/toolbar/sceneActions.ts` — extracted
  `addModelBytes` commit helper; new `addCube` action.
- `packages/slicer-app/src/components/viewport/SceneContextMenu.tsx` — Add
  Cube menuitem above Clear Scene.
- `apps/desktop/e2e/app.e2e.ts` — context-menu Add Cube e2e coverage.

## Tests

- Unit: STL header/triangle count, AABB = 20 mm³, every edge shared by
  exactly two triangles (watertight), positive signed volume (outward
  winding).
- Electron e2e (mock + real): right-click empty scene space opens the menu;
  **Add Cube** enables Slice; mock mode additionally selects the added
  instance and asserts its world bounds are 20 mm.
- `pnpm test` + `pnpm typecheck` (all workspaces) green; no WASM quick build
  needed — no bridge or build-scaffold changes.
