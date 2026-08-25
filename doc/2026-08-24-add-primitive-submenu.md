# Scene context menu: Add Primitive submenu

**Date:** 2026-08-24

**Status:** Implemented

**Extends:** `doc/2026-08-22-scene-context-menu-add-cube.md` (the engine-built
Add Cube primitive). The single menu item becomes an **Add Primitive** submenu
carrying the rest of OrcaSlicer's primitive set.

## Goal

Match OrcaSlicer's scene right-click **Add Primitive** submenu: the same six
engine-built shapes with the same object/part naming and the same resting-on-
bed placement, added through the same `commitAdded` choreography as Add Model.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primitive set | Cube, Cylinder, Sphere, Cone, Disc, Torus | Exactly the items OrcaSlicer puts in the scene menu's **Add Primitive** submenu (`MenuFactory::append_submenu_add_generic`, `ModelVolumeType::INVALID` — `GUI_Factories.cpp`). Text / SVG entries are skipped: they open the text/SVG gizmos which are not ported to the WASM build; Slab is in `create_mesh` but not exposed by the menu; "Add Handy models" ships bundled resources and stays out of scope. |
| Engine mesh construction | `orc_add_shape` switches over the six types, mirroring Orca's `create_mesh` (`GUI_ObjectList.cpp`) body | Same libslic3r builders, same parameterization: Cube `its_make_cube(side³)`, Cylinder `its_make_cylinder(0.5·side, side)`, Sphere `its_make_sphere(0.5·side, PI/90)`, Cone `its_make_cone(0.5·side, side)`, Disc `its_make_cylinder(0.5·side, 0.2)`, Torus `its_make_torus(0.5·side, 0.125·side, PI/60)`. The step angles are Orca's exactly, which fixes the tessellation (and thereby the vertex/index counts the harness asserts). |
| Size | `side = 20 mm` for every shape, keeping Orca's proportions (radius = ½ side, torus tube = ⅛ side) | Prior decision (`2026-08-22` note): the app keeps its established 20 mm instead of Orca's `get_size_proportional_to_max_bed_size(0.1)` (a canvas helper in the desktop build). Orca's proportions at `side` are preserved. |
| Naming | Object and part named after the primitive label, which equals the type string | Orca passes the translation of the type label to `load_mesh_object`; the app is English-only, so the label is the type (`Cube` … `Torus`). |
| Placement | Mesh centered at the origin, rested on the bed via `ensure_on_bed` (Z lift in the instance offset) — unchanged from Add Cube | Orca's cooling-orientation step (`orient_for_cooling`) is a desktop-build canvas helper; the WASM build keeps the plain centered/on-bed path for all shapes. |
| Menu layout | Clear Scene, separator, **Add Primitive** (flyout: the six shapes), **Add Model** | The established layout, with the Add Cube row replaced by the submenu at its position — Orca's order too (Add Primitive, then Add Models). All disabled while slicing. |
| Client surface | `addShape(type, name?)` unchanged; name defaults to the type | The submenu entries call `addShape(type)`; the engine already names the object/part after the type. The former "unsupported type" probe in tests changes from `Sphere` to `Pyramid` (a shape Orca has no `create_mesh` case for). |

## Flow

`SceneContextMenu` renders an **Add Primitive** trigger (testid
`btn-add-primitive`) at the current Add Cube position in the empty-scene
menu. Clicking it unpacks a flyout with the six shape items
(`btn-add-cube`, `btn-add-cylinder`, `btn-add-sphere`, `btn-add-cone`,
`btn-add-disc`, `btn-add-torus`); clicking an item closes the menu and calls
`addPrimitive(platform, sceneInteraction, type)` in
`packages/slicer-app/src/components/workspace/actions/sceneActions.ts` — the same
`commitAdded` choreography as `addModel`/`addCube` (wait for a settled
transform commit → `runtime.addShape(type)` → invalidate the sliced result,
record the display name, flip `modelLoaded`, reset scene interaction).

The bridge (`orc_add_shape` in `packages/slicer-wasm/src/bridge.cpp`) switches
on the type and builds the matching `TriangleMesh` with the libslic3r
`its_make_*` builders, then applies the identical post-create sequence as
Add Cube: object + instance + part named after the label, default extruder,
centered, rested on the bed, stale `Print` cleared.

## Files

- `packages/slicer-wasm/src/bridge.cpp` — `orc_add_shape` type switch
  (Cube/Cylinder/Sphere/Cone/Disc/Torus; still errors on anything else).
- `packages/slicer-wasm/src/client/testing/mock-module.ts` — per-type
  primitive geometry mirror (JS port of the libslic3r builders' tessellation:
  same segment counts, same vertex/index counts) stored per added object and
  returned by `orc_get_model_mesh`.
- `packages/slicer-app/src/components/workspace/actions/sceneActions.ts` —
  `PRIMITIVE_TYPES` + `addPrimitive(platform, sceneInteraction, type)`
  (replaces `addCube`).
- `packages/slicer-app/src/components/workspace/viewport/SceneContextMenu.tsx` —
  Add Primitive flyout submenu.
- `packages/slicer-wasm/src/client/client.test.ts` — per-type `addShape`
  tests (name + vertex count per shape).
- `packages/slicer-wasm/harness/bridge-smoke.mjs` — per-type mesh checks on
  the live module (name, vertex/index counts, cylinder placement) and the
  `Pyramid` unsupported probe.
- `apps/desktop/e2e/app.e2e.ts` — submenu flow (open flyout, pick a shape);
  the Add Cube test walks the submenu; new Add Sphere coverage reuses the
  mock primitive checks.

## Tests

- Client contract: every `addShape(type)` returns a single object + single
  named part; vertex counts match the engine (`Cube` 8, `Cylinder`/`Disc`
  362, `Cone` 182, `Sphere` 16022, `Torus` 14400); unknown type rejected.
- Harness (both WASM variants): per-type count/name/placement assertions.
- Electron e2e (mock + real): context menu → Add Primitive → Cube keeps the
  existing 20 mm assertions; Sphere names the object "Sphere".
- `pnpm test` + `pnpm typecheck` green; WASM quick build required (bridge
  changed).
