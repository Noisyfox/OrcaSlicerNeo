# Painted Facet Model Rendering

**Date:** 2026-09-26

**Status:** Design discussion in progress; the decisions below are accepted.

**Scope:** Display existing MMU filament facet painting on model shells in
Prepare and Preview. This design will become a major specification in `spec/`
alongside `Grand Plan.md` when the remaining design questions are settled.

This design extends [Multi-Filament Support](../spec/Multi-Filament%20Support.md)
and [Workspace Prepare and Preview Modes](../spec/Workspace%20Prepare%20and%20Preview%20Modes.md).

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

## OrcaSlicer reference

OrcaSlicer's ordinary `GLVolume::simple_render` reads
`mmu_segmentation_facets` and renders the resulting per-colour meshes. Preview
loads its model shells as `GLVolume`s, so those shells follow the same facet
rendering path. It loads only printable instances into the Preview shell, and
`simple_render` skips the painted branch for unprintable volumes. The other
facet annotations are rendered by their respective painting Gizmos.
