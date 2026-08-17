# 2026-08-17 — Model load centering (STL opens off-center)

## Bug

Opening an STL with an arbitrary origin (e.g. a cube spanning `[100, 200]^3`)
showed the model off the viewport origin. OrcaSlicer centers a loaded model
on the build plate; the app did not.

## Root cause

`read_from_file` never centers — the centering is GUI-layer code. In
`Plater::_load_files` (submodule `src/slic3r/GUI/Plater.cpp:7691-7706`) every
non-project object gets, after loading:

1. `center_around_origin(false)` — shifts the **volumes** so the raw-mesh bbox
   center lands on the origin (XYZ),
2. `ensure_on_bed(false)` — translates **instances** with `auto_drop` by
   `-min_z()`, resting the object on the bed (Z = 0).

The WASM build has no wxWidgets GUI, so `orc_load_model` skipped both steps and
the model kept its raw STL coordinates (instance offset 0).

Second defect, same code path: `orc_get_model_mesh` exported
`ModelObject::mesh()`, which **bakes instance transforms into the vertices**
and merges all instances, while also reporting instance 0's offset — the
renderer applies the offset again (group position). Zero offset hid it at load
time, but any non-zero offset (e.g. the `ensure_on_bed` Z lift, or a committed
move + reload) double-offsets the model. The mock module already documents the
correct contract ("local coordinates, offset reported separately").

## Fix (`packages/slicer-wasm/src/bridge.cpp`)

- `orc_load_model`: after `read_from_file(AddDefaultInstances)`, replicate the
  Plater steps per object: `center_around_origin(false)` +
  `ensure_on_bed(false)`.
- `orc_get_model_mesh`: export `obj->raw_mesh()` (volume transforms applied,
  instance transforms NOT) so the renderer's `position = offset` stays correct.

Net renderer-visible behavior: model XY bbox center at the viewport origin,
resting on the bed — exactly OrcaSlicer. Slicing uses the same centered model,
so G-code matches the preview.

## Tests (`packages/slicer-wasm/harness/bridge-smoke.mjs`)

- New check 4b: after loading `cube.stl` (spans `[0,20]^3`), the exported
  vertices must be centered (`[-10,10]^3`, bbox center ≈ origin), the instance
  offset must carry the bed drop (Z = half height, XY = 0), and world min Z = 0.
- Floating-box check (empty-first-layer error surfacing): load-time centering
  drops the box on the bed, so the check now re-floats it
  (`set_instance_offset(offset.z + 0.3)`) before slicing — it keeps testing
  error surfacing, not raw coordinates surviving the load.

Also fixed by the rebuild: `out/` was stale (predated commit 7613166's
error-surfacing fix — `bridge-smoke` check 10 failed on the old module even
before this change).
