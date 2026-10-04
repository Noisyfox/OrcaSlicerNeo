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

Both standalone primitives and primitive parts use Orca's shared sizing rule:
`side = 0.1 * max(printable-area bounding-box width, height)`. This uses the
current printer bed, not the selected object's dimensions. Disc thickness
remains 0.2 mm; other proportions follow the native mesh builders. Existing
objects retain their size when the printer changes. Measured Cube/Cube Part
sizes are 25.6 mm for P1P, 18 mm for A1 mini, and 25 mm for Prusa MK4.
The mock's fixed 20 mm geometry remains a deterministic fixture; real sizing
is validated against both WASM variants.

Change Filament becomes a submenu. It is hidden with one filament or for
negative/support volumes. Objects and full instances assign their owning
object; model parts and parameter modifiers retain the native assignment
boundary. Existing model-part Default/inherit support remains available.

Auxiliary volumes follow Orca's `color_from_model_volume` rather than filament
or paint colours: negative volumes are RGB (0.3, 0.3, 0.3) at alpha 0.4,
parameter modifiers are yellow at alpha 0.6, support blockers are red-tinted
and enforcers blue-tinted at alpha 0.4. Selection adds 0.25 HSL lightness while
preserving alpha. Prepare uses front-face rendering and depth writes in the
transparent pass, matching `GLVolumeCollection::render`. Model parts retain
their filament/paint materials; imported segmentation does not override an
auxiliary volume's category material. Native unprintable flags still take
precedence over category colours.

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
  The sizing regression also measures the standalone Cube and newly selected
  Cube Part world bounds as 25.6 mm on P1P.
  Render-material assertions cover selected/unselected negative-volume grey
  with unchanged alpha 0.4 and selected modifier yellow at alpha 0.6; the
  selected negative-volume screenshot was visually reviewed.
- `scripts\build-windows.bat quick --variant serial` and `--variant threaded`.
- `add-volume-smoke.mjs` on both variants: all six primitives/five volume
  kinds, stable IDs, rejection without mutation, native Undo/Redo, STL Load...
  and upload cleanup.
- Comprehensive `bridge-smoke.mjs` on serial.
- `git diff --check` and changed documentation link review.

The full dual-host release matrix was intentionally not run. The filament
Electron cases are real-only and skipped in the mock E2E selection; component
tests validate submenu assignment dispatch and queued revision handling.
The auxiliary-rendering follow-up changes shared renderer code only; no WASM
rebuild or additional Electron host-seam qualification was required.
