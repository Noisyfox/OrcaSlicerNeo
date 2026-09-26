# Painted Facet Model Rendering

**Date:** 2026-09-26

**Status:** Approved design; implementation pending.

**Scope:** Display existing MMU filament facet painting on model shells in
Prepare and Preview for the shared Web and Electron application.

This specification extends [Multi-Filament Support](Multi-Filament%20Support.md),
[Workspace Prepare and Preview Modes](Workspace%20Prepare%20and%20Preview%20Modes.md),
and the [shared application architecture](Web-Electron%20Shared%20Application%20Architecture.md).
Facet-paint creation and editing remain deferred; this feature displays
painting already present in the native model, including imported 3MF projects.

## Accepted behavior

- Ordinary model rendering covers `mmu_segmentation_facets`, including painting
  already present in an imported project. Support, seam, and fuzzy-skin facet
  annotations remain outside this rendering feature. Creating or editing facet
  painting is outside this scope.
- The renderer uses one grouped, multi-material paint geometry for a painted
  model. Prepare and Preview share that paint geometry and resolve its colours
  from the current model's filament assignments and slot colours.
- A Preview model shell preserves the Prepare model's unselected facet colours
  with shell opacity `0.15`. Preview toolpaths retain their independent
  slice-result colour source; the shell does not obscure them.
- In Prepare, selecting a painted model brightens each colour group using
  Neo's existing selection treatment, so the groups remain distinguishable.
- Facet state `0` uses the part's current effective filament assignment.
  Explicit facet states `1`, `2`, and so on use those numbered filament slots.
  An explicit state beyond the available slots is displayed using slot 1's
  colour, without rewriting the stored facet state. Native filament deletion
  continues to remap painting references.
- A printable painted model first becomes visible with its facet colours in
  both Prepare and Preview. Loading or restoring the model must not briefly
  show it as a single-colour model while its paint geometry is still being
  prepared.
- In Prepare, an instance marked unprintable temporarily uses the ordinary
  single-colour unprintable appearance; its facet painting remains stored.
  Preview omits unprintable instances from the model shell. A printable model
  that is out of bounds retains its facet colour groups, with Neo's existing
  out-of-bounds dimming applied to each group.
- The original, unpainted mesh is the sole source of any model BVH and model
  picking. The painted geometry is display-only and has no BVH.

## Accepted data and lifecycle rules

- Extend the existing model-loading response so one Worker interaction carries
  the original geometry and the current facet-paint geometry or references to
  versions already retained by the renderer. Publish a painted model only when
  both required resources are ready; fetching paint in a second interaction is
  not part of this design.
- Apply that same response rule to initial loading, incremental scene patches,
  and history restoration. A response must identify the current paint version
  independently of the original mesh version so the renderer cannot reuse stale
  paint after a paint-only change.
- A paint-only change rebuilds the paint display resource while retaining the
  original geometry and its BVH. A source-mesh change may rebuild both.
- Instances of the same model volume share one paint geometry resource and
  retain separate instance transforms and display state.

## OrcaSlicer reference and Neo boundary

OrcaSlicer's `FacetsAnnotation::get_facets` uses `TriangleSelector` to restore
split triangles and produce meshes for facet states 0 through 16. Ordinary
`GLVolume::simple_render` checks `mmu_segmentation_facets` and its timestamp,
builds per-state render meshes, and selects a colour for each state. This is
distinct from the `TriangleSelectorPatch` drawing used by painting Gizmos.

Preview loads printable model instances as `GLVolume`s and renders those shells
through the same ordinary facet path at transparency 0.15. It skips unprintable
instances, while `simple_render` also skips the painted branch for an
unprintable volume. Neo follows these model-shell semantics but uses its
existing per-colour selection brightening and out-of-bounds dimming.

Neo must keep the C++ submodule pinned. The new native adaptation belongs in
the existing WASM bridge. Only `packages/slicer-wasm/src/client/` may touch the
Emscripten module; application code receives typed data through the Worker and
runtime boundary.

## Geometry and protocol design

1. The native bridge uses `ModelVolume::mmu_segmentation_facets.get_facets`
   to obtain the split triangles for every occupied state. It must not infer
   one colour per original triangle: a painted boundary can split one source
   triangle. Concatenate the resulting state meshes into one paint-only
   indexed geometry with contiguous draw groups carrying facet state IDs.
2. Extend the current full-model and incremental scene-patch responses. Each
   renderable identifies its original geometry and its paint resource version;
   unpainted volumes identify the absence of paint explicitly. A response
   includes any resource whose version the client has not retained. Original
   geometry and paint may therefore change independently without another
   Worker request. The typed client validates, copies, and frees every native
   buffer in the response, including after a decode failure.
3. A paint resource version must change when its facet data or source mesh
   changes, even when a restored model reuses the same volume ID. The original
   geometry version and paint version are separate. A palette or effective
   assignment change updates materials without rebuilding either geometry.
4. The scene projection resolves both versions before publishing a painted
   model. The renderer retains shared resources while instances use them and
   releases them when the last instance is removed. History restore, project
   import, model mutation, and plate changes must not bind an old paint
   resource to a current model.

## Viewport rendering

- An unpainted printable volume keeps the existing ordinary mesh path. A
  painted printable volume draws the grouped paint geometry with one material
  per occupied facet state. State 0 resolves through the part's effective
  assignment; a positive state resolves directly to that numbered slot.
- In Prepare, a non-rendering original-mesh surface handles model picking and
  dragging using the original BVH. The visible paint mesh performs no
  raycasting. Both surfaces use the same instance and volume transforms, so
  painting does not alter hit positions or selection identity.
- In Preview, the same paint resource receives unselected, transparent shell
  materials with opacity 0.15 and no depth writing. Preview remains passive,
  shows only printable instances on the current plate, and keeps toolpath
  colours and draw order independent of model-shell colours.
- For an unprintable instance, Prepare draws the ordinary unprintable model
  appearance using the original mesh and keeps the stored paint intact.
  Printable out-of-bounds instances keep their groups and dim each group.

## Implementation and verification

Implement in independently testable pieces: extend the native bridge and
typed client response; add paint resource ownership and independent version
handling to scene projection; then mount the paint display and original pick
surfaces in Prepare and Preview. Keep the source mesh and paint geometry in
the same full-model or scene-patch response for every piece.

Verification must cover a repository-owned imported 3MF with split-triangle
painting, state 0 and explicit slot colours, invalid-slot fallback, multiple
instances, selection and dragging, out-of-bounds and unprintable states, and
Prepare-to-Preview colour continuity. Check that the first visible frame is
already coloured, Preview transparency and toolpath visibility are correct,
palette changes avoid geometry and BVH rebuilds, paint-only changes preserve
the original BVH, and history/scene patches do not show stale paint. Validate
the bridge on applicable WASM variants and the affected shared-host paths
according to the [testing guidelines](../doc/testing_guidelines.md).
