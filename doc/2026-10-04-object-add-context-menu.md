# Object Add Context Menus

Date: 2026-10-04
Status: Delivered

## Accepted behavior

The object list and viewport share the object/part context menu. Add Part,
Add Negative Part, Add Modifier, Add Support Blocker, and Add Support Enforcer
appear in that order in the object menu for a single full object or a single
full instance only. The viewport uses the object menu for complete instances;
Object List instance rows retain the native instance-menu scope.
Partial parts and multiple-object/instance selections do not offer them.
This follows `MenuFactory::append_menu_items_add_volume` and
`ObjectList::is_instance_or_object_selected` in the pinned Orca sources.

Each submenu offers Load..., a separator, Cube, Cylinder, Sphere, Cone, Disc,
and Torus. Text, SVG, precise seam, and height-range editing are omitted until
implemented. Additions use native model volumes, preserve the owning object
and its instances, and participate in the existing project history and plate
invalidation flow. Primitive placement follows `load_generic_subobject`;
file placement follows `load_modifier`, including source mesh offsets.

Change Filament becomes a submenu. It is hidden with one filament or for
negative/support volumes. Objects and full instances assign their owning
object; model parts and parameter modifiers retain the native assignment
boundary. Existing model-part Default/inherit support remains available.

## Architecture and support

The typed client owns heap uploads and bridge calls; application commands use
the shared runtime. No pinned submodule edits are required. Both desktop Web
and Electron use the same component and host model picker. Mobile context-menu
interaction remains deferred under the shared architecture. Mesh parsing and
construction stay off the UI thread; uploads require the existing temporary
file and WASM heap copy, with no additional persistent cache.

## Validation

Passed:

- `pnpm test` and `pnpm typecheck` (all workspace packages).
- Focused Electron mock E2E: seven object/scene menu journeys.
- Real threaded Web E2E: `apps/web/e2e/add-volume.e2e.ts`, including browser
  Load..., primitive addition, owning-object preservation and Undo/Redo.
- `scripts\build-windows.bat quick --variant serial` and `--variant threaded`.
- `add-volume-smoke.mjs` on both variants: all six primitives/five volume
  kinds, stable IDs, rejection without mutation, native Undo/Redo, STL Load...
  and upload cleanup.
- Comprehensive `bridge-smoke.mjs` on serial.
- `git diff --check` and changed documentation link review.

The full dual-host release matrix was intentionally not run. The filament
Electron cases are real-only and skipped in the mock E2E selection; component
tests validate submenu assignment dispatch and queued revision handling.
