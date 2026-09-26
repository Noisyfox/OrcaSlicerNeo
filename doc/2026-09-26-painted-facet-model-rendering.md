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
- The original, unpainted mesh is the sole source of any model BVH and model
  picking. The painted geometry is display-only and has no BVH.

## OrcaSlicer reference

OrcaSlicer's ordinary `GLVolume::simple_render` reads
`mmu_segmentation_facets` and renders the resulting per-colour meshes. Preview
loads its model shells as `GLVolume`s, so those shells follow the same facet
rendering path. The other facet annotations are rendered by their respective
painting Gizmos.
