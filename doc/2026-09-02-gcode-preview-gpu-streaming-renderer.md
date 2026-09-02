# G-code preview GPU streaming renderer

**Date:** 2026-09-02
**Status:** Accepted implementation record; promoted architecture is in
[`spec/G-code Preview GPU Streaming Renderer.md`](../spec/G-code%20Preview%20GPU%20Streaming%20Renderer.md)

## Accepted behavior

The shared Web and Electron preview uses the native Orca/libvgcode-style
SegmentTemplate renderer as its only toolpath backend. Each segment is drawn
from one shared template with eight logical vertices and 24 vertex invocations.
The camera-aware shader implements native pointy caps and twist correction.
Toolpaths are opaque and use depth testing/writes; selection and filtering do
not introduce alpha blending.

Static segment data remains GPU-resident for the lifetime of an accepted slice
result. Layer-aligned pages store endpoint, shape, category, and color data in
float textures. Each page has a page-local integer enabled-index texture. Layer
range, move-end, travel, and feature changes rebuild only those index streams;
camera gestures update uniforms and do not rebuild path data. Page-local IDs
are translated by each page's source offset before static data is fetched.

The source adapter retains the typed structure-of-arrays buffers from the
client and derives immutable layer ranges. Normal layers are kept intact when
building pages. A layer may be split only when a declared hard capacity makes
that necessary, and every piece remains visible and carries the same layer ID.

If WebGL2 capabilities, shader compilation, allocation, source validation,
budget, selection initialization, or context lifetime cannot satisfy the
contract, the preview reports an unavailable diagnostic. It does not construct
an alternate path renderer or silently reduce the active inspection range.
All renderer-owned textures, buffers, materials, and planner references are
released exactly once on invalidation, unmount, failure, or context loss.

## Verification scope

Focused tests use small deterministic sources and cover page completeness,
layer alignment, hard-capacity splitting, page-local selection, cross-page
source addressing, travel/feature visibility, native template cardinality,
opaque depth state, capability failures, and resource release. Large-slice
performance measurements are manual browser diagnostics and are not runtime
fixtures or normal startup work.

The approved product behavior and performance goals remain in
[`spec/G-code Preview v2.md`](../spec/G-code%20Preview%20v2.md); the renderer
architecture and lifecycle contract remain in the GPU renderer specification.
