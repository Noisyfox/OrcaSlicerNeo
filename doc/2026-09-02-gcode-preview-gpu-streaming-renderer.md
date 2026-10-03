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

Travel segments retain the native SegmentTemplate geometry path but use
libvgcode's default travel radius (`0.1 mm`) for both rendered height and
width. Their slicer-provided extrusion dimensions are not used, so travel is
visibly a thin line while extrusion segments retain their physical solid
geometry. Travel color, visibility, dimming, and opaque depth testing remain
independent and unchanged.

If WebGL2 capabilities, shader compilation, allocation, source validation,
budget, selection initialization, or context lifetime cannot satisfy the
contract, the preview reports an unavailable diagnostic. It does not construct
an alternate path renderer or silently reduce the active inspection range.
All renderer-owned textures, buffers, materials, and planner references are
released exactly once on invalidation, unmount, failure, or context loss.

## Actions and markers (2026-10-03)

Travel and Wipe use independent thin-line rendering and visibility. Wipe uses
native yellow in categorical and non-speed schemes, the speed ramp in Speed,
and the native 0.1 mm dimensions with a 0.05 eye-space depth bias.
Retract, Unretract, Seams, and Filament changes use the native sixteen-sided
OptionTemplate diamond at the event endpoint, with native option colours,
1.5 shape scaling, and a 0.1 eye-space depth bias. Existing Color change,
Pause Print, and Custom G-code events use the same marker path when present.
Events without positive width/height use a 0.4/0.2 mm marker shape so initial
control moves remain visible. Positive native dimensions are preserved.

The action legend lists only move types present in the accepted result. Its
visibility state is independent of role/tool filters and the colour scheme;
layer range, move end, and earlier-layer dimming apply to both paths and
markers. Preview reset restores action visibility. These are read-only display
controls and do not insert or modify G-code events. Mobile support remains
outside the desktop preview scope; the controls use ordinary accessible buttons.

Each page partitions its existing enabled-index texture between segment and
marker draws. Both draws share the static textures; toggles change only index
contents and draw counts. One shared 96-vertex marker geometry and a marker
instance buffer sized to the page's event count supplement the segment path.
Invalidation and context loss release both draw resources exactly once.

The internal selection contract requires an action-visibility map, a category
visibility map, and an explicit category field. Empty maps mean no overrides;
callers must supply them rather than relying on omitted legacy arguments.
Move-type constants are imported from their defining module. Renderer shape
data comes from the current typed client contract; unsupported historical
palette indexing and speculative angle/bias aliases are not accepted.
An injected template factory must supply the complete current geometry; an
incomplete template is rejected rather than repaired by the renderer.

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
