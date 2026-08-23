# Object List: Add instance / Remove instance

Date: 2026-08-23

Branch: dev/object-list-and-parts

## What was added

The object row context menu now includes **Add instance** and **Remove instance**.

- **Add instance** adds a new default instance to the object (via
  `orc_add_instance`, which calls `ModelObject::add_instance()`), returning the
  new stable instance ID. The renderer can then move it.
- **Remove instance** removes the **last** instance of the object (via
  `orc_remove_instance`), disabled when the object has only one instance (an
  object must keep at least one instance). The bridge guards the last-instance
  case and surfaces "cannot remove the last instance".

Both paths use the unified post-mutation refresh (slice invalidation, structure
and mesh reload).

## Implementation

- Bridge: `orc_add_instance(objectId)`, `orc_remove_instance(objectId, instanceId)`.
- Client: `addInstance`, `removeInstance` + result types.
- Mock module: matching behavior (and `buildStructure` now derives `instanceCount`
  from the actual instance metadata so added/removed instances stay consistent).
- `structuralActions.ts`: `addInstanceInList`, `removeInstanceInList`.
- Real-WASM smoke: `bridge-smoke.mjs` checks add (instance count 1→2), remove
  (2→1), and the last-instance guard.

## Verification

- `@orca/slicer-wasm` test: 68 pass (4 new add/remove cases).
- `@orca/slicer-app` test: 127 pass (2 new action cases); typecheck clean.
- Live WASM smoke (threaded + serial): add/remove checks pass.
- Desktop mock e2e: 13 passed, 1 skipped.
