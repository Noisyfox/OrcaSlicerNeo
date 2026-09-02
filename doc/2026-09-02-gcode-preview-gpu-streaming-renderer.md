# G-code Preview GPU streaming renderer

**Date:** 2026-09-02
**Status:** Living implementation entry; architecture accepted for step 1
**Scope:** GPU streaming/indexed-segment redesign for the shared G-code preview

## Purpose and boundary

This document records the first implementation step for the large-slice
renderer redesign. It establishes the implementation contract and deterministic
performance fixture; it does not replace the current renderer, change visible
behaviour, or change the WASM bridge. The normative architecture is
[`spec/G-code Preview GPU Streaming Renderer.md`](../spec/G-code%20Preview%20GPU%20Streaming%20Renderer.md).

The renderer remains a shared `packages/slicer-app` feature for Web and
Electron. `packages/slicer-wasm/src/client` remains the only JavaScript layer
that receives WASM data, and `libslic3r` plus
`packages/slicer-wasm/cpp` remain untouched. The fixture added in this step
contains metadata only; it deliberately does not allocate positions, band
geometry, Three.js objects, WebGL resources, or a mock GPU.

## Accepted architecture

- Convert the source-neutral preview segment stream into immutable static
  segment attributes: endpoints, width/height/angle (and any bias needed for
  stable band rendering), categorical IDs, and palette references. The source
  stream owns the values; the renderer owns no per-frame copy.
- Reuse one indexed segment template for every segment. The template is the
  eight-vertex, six-face/pointy-cap prism pattern used by libvgcode's
  `SegmentTemplate`; the segment instance is selected by an enabled index.
- Store static attributes in WebGL2-compatible page-local 2D texture atlases
  (integer textures for IDs, float textures for geometry) or an equivalent
  WebGL2 buffer layout proved by the implementation tests. Store the changing
  enabled segment indices in a dynamic `R32UI` index stream per page.
- Partition pages on layer boundaries whenever possible. A filter, layer
  range, move-end, travel toggle, or feature visibility change rebuilds only
  the enabled index stream and draw counts. Camera movement changes uniforms
  only; it never rewrites segment attributes, reconstructs bands, or rebuilds
  the index stream.
- Render one draw for a page, and a small number of draws for a large result.
  A page may bind its static atlas once and issue
  `drawElementsInstanced` against the shared template. The implementation must
  make the page count and index-stream lengths observable for tests.

The fixture contract is intentionally CPU-only. It validates deterministic
layer/page partitioning and enabled-index semantics without claiming a frame
rate. Real FPS, upload time, GPU memory, and driver compatibility require a
later browser benchmark on representative hardware.

## libvgcode reference points

The design extracts the following behaviour, without copying native ownership
or adding a native dependency:

- `SegmentTemplate.hpp/.cpp`: a static VAO/VBO template, 24 byte-sized index
  entries (eight vertices, six faces), and instanced drawing. The WebGL2 plan
  maps this to one shared Three/WebGL template and page-local instance indices.
- `ViewerImpl.hpp/.cpp`: endpoint position, height/width/angle and colour data
  are static after `load`; enabled segment IDs are rebuilt by
  `update_enabled_entities`; camera matrices and position are uniforms in
  `render_segments`. Its ES path already proves that 2D texture pages plus
  `usampler2D` are viable when buffer textures are unavailable.
- `ShadersES.hpp` and `Shaders.hpp`: `gl_InstanceID` indexes the enabled
  stream, `texelFetch` reads static attributes, and the shader derives a
  camera-facing rectangular band from segment direction, width, height and
  angle. The WebGL2 implementation must preserve the endpoint/cap and
  near-vertical fallback semantics, while using GLSL ES 3.00 rather than the
  desktop `samplerBuffer`/GLSL 1.50 path.
- `ViewRange.hpp/.cpp`: full, enabled, and visible ranges are clamped in that
  order. The shared preview contract keeps inclusive layer and move-end
  semantics; rebuilding an index stream must never emit outside the visible
  range.
- `Layers.hpp/.cpp`: layer records are sequential ranges with Z and duration;
  layer lookup is ordered. The page index follows the same sequential layer
  order, and a layer change must not retain an invalid move end.

## Behaviour and source-neutral compatibility

The redesign preserves the accepted Preview v2 semantics: feature/line-type
and travel filtering hide paths; dimming changes brightness but does not turn a
visible segment into a hidden one; single-layer mode keeps a paired layer range
and shows that layer from its first move through the active move end; and the
generic camera-facing marker uses the last move at or before that end. Existing
shell alpha/depth semantics and read-only result invalidation remain unchanged.

The renderer consumes a source-neutral `PreviewSource`/`ClientToolpath` shape:
SoA segment metadata, layer ranges, palettes, optional metrics, and marker/source
mapping. A future external `.gcode` source must parse to exactly that shape and
provide lazy source-text reads; it must not introduce renderer-specific fields
or a second filter/range implementation. External G-code import remains out of
scope for this step and for the current product phase.

## Capability, lifetime, and memory rules

- Require WebGL2, integer texture sampling, vertex texture fetch, and a valid
  `MAX_TEXTURE_SIZE`; WebGL1 is not a fallback. If the streaming backend
  cannot initialize or a page allocation fails, retain the current B2 renderer
  for that result and surface a non-blocking capability status. There is no
  silent loss of the active inspection range.
- Static atlas resources live for one immutable slice result. Dynamic index
  streams are replaced only after a completed selection rebuild. The old
  stream is retired after the draw boundary; all pages, textures, buffers,
  template resources, and material references are disposed on result
  invalidation, unmount, context loss, and backend fallback.
- The initial implementation target is a 64 Ki-segment soft page cap, reduced
  to the largest safe value derived from `MAX_TEXTURE_SIZE` and allocation
  budget. Pages remain layer-aligned unless one layer exceeds the hard
  hardware capacity; that exceptional split is recorded and all pieces remain
  part of the active layer. A page never drops segments merely to fit a
  nominal target.
- Budget accounting is explicit: reserve at most 64 bytes per static segment
  (two endpoint texels, shape/bias, and categorical IDs with alignment) plus
  4 bytes per enabled index, page overhead, and the shared template. The
  implementation reports estimated and allocated bytes. It may evict or lower
  detail only for non-active nearby pages; the active inspection range retains
  true geometry.

## Step-1 fixture and test contract

`gpuStreamingFixture.ts` generates only `layerIds`, `moveOrders`, compact
feature IDs, and move types for exactly 250,000 and 1,000,000 segments. Its
seed, layer count, page target, and expected count are explicit constants. The
generator is deterministic and uses a fixed formula; no wall clock is involved.

`gpuStreamingFixture.test.ts` must prove:

1. both counts and repeated generation are byte-identical;
2. page ranges are contiguous, cover every segment once, and do not split a
   normal synthetic layer;
3. enabled-index rebuild obeys inclusive layer bounds, active-layer move end,
   travel visibility, and feature hide semantics; and
4. a rebuild visits metadata at most once (`O(n)` scan) and does not create
   geometry. The test may assert exact visited counts and output ordering, but
   must not assert FPS or machine-dependent timing.

Browser performance acceptance is a later gate: a real WebGL2 browser harness
must measure FPS during camera gestures, GPU allocations, index rebuilds, and
active-range preservation on the stated representative integrated-GPU target.

## Migration and verification state

1. **Step 1 (this commit):** accept this architecture, add the metadata-only
   fixture/test contract, and add concise links from the existing Preview v2
   documents. No renderer, bridge, or behaviour change.
2. **Step 2:** implement a source adapter and page planner with unit tests,
   while keeping the current backend selected by default.
3. **Step 3:** implement WebGL2 static atlas + dynamic index pages behind a
   feature gate and run shared renderer tests plus browser measurements.
4. **Step 4:** compare same-renderer Web/Electron behaviour and approved native
   references; switch the default only after all acceptance criteria pass.

The current B2 backend remains the fallback until the streaming backend passes
functional, memory/lifetime, capability/fallback, and representative-browser
performance gates. It is not removed in this design step. The step-1 gate is
limited to documentation, the deterministic pure test, existing package
tests/typechecks, and `git diff --check`.
