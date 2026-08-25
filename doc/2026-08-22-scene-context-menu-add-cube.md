# Scene context menu: Add Cube primitive

**Date:** 2026-08-22

**Status:** Implemented

## Goal

Match OrcaSlicer's scene right-click menu: offer an **Add Cube** entry that
appends a cube primitive to the plate, sitting at the scene origin on the
build bed. The cube behaves exactly like an imported model — it is
selectable, transformable, sliceable, and exportable.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primitive source | Built in the engine: the bridge's `orc_add_shape("Cube", name)` mirrors OrcaSlicer's `ObjectList::load_shape_object` → `create_mesh` → `load_mesh_object` — `its_make_cube(20, 20, 20)`, added directly to the live `Model` | Matches OrcaSlicer's Add Cube exactly: no STL file, no staging path, no filename-derivation, no extension strip — the mesh and names are created by the slicer core itself. The canvas helpers (nearest-empty-cell placement, snapshot) are GUI and not compiled into the WASM build, so the shape lands at the scene origin resting on the bed, like the uploaded-file result. |
| Add-surface call | `addCube` calls `runtime.addShape('Cube', 'Cube')` through the shared `commitAdded` choreography | Same post-add sequence as file imports (settled-transform wait → add → invalidate slice → `modelLoaded` → select), so the cube can never be added while a transform commit is in flight. |
| Primitive naming | The engine sets the object *and* its part name to the primitive label ("Cube") | `load_mesh_object` sets object and volume name alike — no staged extension can leak into the name because no file was staged. |
| Cube dimensions | 20 × 20 × 20 mm | The app's established primitive size. (OrcaSlicer computes `get_size_proportional_to_max_bed_size(0.1)` — 10 % of the max bed size; on this app's scale the fixed 20 mm is kept by decision.) |
| Menu placement | **Clear Scene** first, then a separator, then **Add Cube** above **Add Model**; all disabled while slicing | User request: the destructive scene action sits at the top of the menu, separated from the add actions; OrcaSlicer's primitive/import entries follow it. |
| Menu item naming | "Add Cube" (`btn-add-cube`) | Mirrors OrcaSlicer's menu label; the mock module's cube fixture is already 20 mm, so e2e assertions hold in both modes. |

## Flow

`SceneContextMenu` renders the Add Cube menuitem after Clear Scene +
separator and before Add Model. Clicking it calls the shared
`addCube(platform, sceneInteraction)` action in
`packages/slicer-app/src/components/toolbar/sceneActions.ts`, which reuses the
same post-add choreography as `addModel` (wait for any settled transform
commit → `runtime.addShape('Cube', 'Cube')` → invalidate the sliced result,
record the display name (`Cube`), flip `modelLoaded`, reset scene
interaction).

The bridge side mirrors OrcaSlicer's primitive path (`orc_add_shape` in
`packages/slicer-wasm/src/bridge.cpp`): `TriangleMesh(its_make_cube(20, 20,
20))` — the same 12-triangle, outward-wound, watertight cube Orca's
`create_mesh` builds — then `Model::add_object` → `add_instance` →
`add_volume` with the object and its part named "Cube", a default extruder,
mesh centered at the origin, and rested on the bed (`ensure_on_bed`, the Z
lift carried in the instance offset like the file-import path). The rendered
result is the OrcaSlicer placement: X/Y centered at the origin, Z from 0..20
at the chosen size.

File imports keep going through `runtime.addModel(bytes, ext)`; only the
primitive path skips the file entirely.

## Files

- `packages/slicer-wasm/src/bridge.cpp` — `orc_add_shape(type, name)`
  (engine-side `create_mesh` + `load_mesh_object` mirror; `"Cube"` only for
  now, the other `create_mesh` shapes follow the same switch pattern).
- `packages/slicer-wasm/src/client/client.ts` + `types.ts` — `addShape`
  contract (name defaults to the primitive type).
- `packages/slicer-wasm/src/client/testing/mock-module.ts` — `orc_add_shape`
  mirror: one named object + one named, non-splittable part.
- `packages/slicer-app/src/components/toolbar/sceneActions.ts` — extracted
  `commitAdded` helper; `addCube` calls `addShape('Cube', 'Cube')`; the
  earlier JS STL generator (`lib/cubeStl.ts`) is removed.
- `packages/slicer-app/src/components/workspace/viewport/SceneContextMenu.tsx` — menu
  layout (Clear Scene / separator / Add Cube / Add Model).
- `apps/desktop/e2e/app.e2e.ts` — context-menu Add Cube e2e coverage.

## Tests

- Client contract: `addShape('Cube', 'Cube')` reports a single object and a
  single part named "Cube" with the 8-vertex cube mesh; omitting the name
  keeps the type; an unsupported type is rejected.
- Electron e2e (mock + real): right-click empty scene space opens the menu;
  **Add Cube** and the context-menu **Add Model** entry both enable Slice;
  mock mode additionally selects the added instance, asserts its world
  bounds are 20 mm, and asserts the object list names it "Cube".
- `pnpm test` + `pnpm typecheck` (all workspaces) green; WASM quick build
  required (new bridge export).
