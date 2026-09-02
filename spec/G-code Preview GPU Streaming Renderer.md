# G-code Preview GPU Streaming Renderer

**Date:** 2026-09-02
**Status:** Approved architecture; native libvgcode SegmentTemplate GPU backend (2026-09-02)
**Scope:** Shared Web/Electron G-code preview renderer performance redesign

## Relationship to existing preview specifications

[`G-code Preview v2`](G-code%20Preview%20v2.md) remains authoritative for
product behaviour, controls, source-neutral data, and the 250,000/1,000,000
segment performance goals. This document is the implementation-level renderer
architecture for that specification. It does not change the existing preview
behaviour or authorize external G-code import. The dated living implementation
record is [`2026-09-02-gcode-preview-gpu-streaming-renderer.md`](../doc/2026-09-02-gcode-preview-gpu-streaming-renderer.md).

The redesign is shared by static Web and Electron, uses WebGL 2 / Three.js,
and preserves the platform boundary: only the typed client/Worker path may
receive WASM data. `libslic3r` and `packages/slicer-wasm/cpp` are read-only for
this work; no submodule edit, patch, or pointer update is permitted.

Both hosts request a high-performance WebGL adapter as a preference. The
shared R3F `Canvas` uses Three.js `powerPreference: 'high-performance'`, while
Electron adds Chromium's `force_high_performance_gpu` startup switch before
creating a window. Neither setting selects a named adapter or makes a discrete
GPU mandatory; browser/Electron capability checks and WebGL2 plus
software-rendering remain available, but a native renderer failure is surfaced
as an unavailable preview.

## Goals and non-goals

Goals:

- Keep per-segment geometry attributes static and GPU-resident for the lifetime
  of an immutable slice result.
- Draw a shared indexed segment template through one enabled-index stream per
  page, using one draw for an ordinary page and a small number of draws for a
  large result.
- Make layer/range/filter changes deterministic and bounded to rebuilding
  index streams, while making camera gestures uniform-only updates.
- Preserve Feature/Line Type, travel, dimming, single-layer, move-end, marker,
  palette and shell/depth semantics from Preview v2.
- Provide an explicit capability/unavailable-state and memory/lifetime contract that can
  be measured in a real browser later.

Non-goals for this increment:

- Retaining an alternate CPU renderer.
- A new C++ bridge, `libslic3r` change, or native libvgcode dependency.
- Browser FPS claims, a synthetic GPU, or a wall-clock benchmark in unit tests.
- External `.gcode` import, result editing, pause insertion, or custom G-code.

## Source-neutral data boundary

The renderer receives the existing typed preview result (`ClientToolpath`, or
an equivalent `PreviewSource` adapter) as structure-of-arrays metadata and
binary arrays. The source boundary supplies, at minimum:

| Group | Values used by streaming renderer |
| --- | --- |
| Static shape | start/end XYZ, width, height, cap angle/bias |
| Identity/order | segment ID, layer ID, per-layer move order |
| Categories | move type, extrusion role/feature, extruder/tool, colour-print ID |
| Selection metadata | layer ranges/Z, optional source-line mapping |
| Colour/metrics | palette references and optional Phase-C metric arrays |

The streaming planner does not parse G-code and does not know whether the
source came from the WASM slicer or a future importer. A future external source
must produce the same ordered segment/metadata contract and expose lazy text
chunks separately. Renderer and control code must not gain an external-source
branch.

## Architecture

```text
PreviewSource / ClientToolpath (SoA)
              |
              v
       immutable source/page plan
          |                 |
          v                 v
 global RGBA32F textures   per-page R32UI local index texture
 (endpoint/shape/color-layer)       + segment_base
                                  |
                 shared 8-ID / 24-invocation template
                                  |
                         one instanced draw per page
```

### Global static textures

The renderer uploads the complete accepted source result once into three
global `RGBA32F` textures: endpoint positions, endpoint shape values, and
color plus layer ID. Texture sampling uses nearest filtering, clamp-to-edge,
no mipmaps, and integer texel addressing. Endpoint and shape data remain
unchanged for the lifetime of the result; palette changes refresh only the
color channels in place.

The textures are global to the source result, not duplicated per page. Pages
therefore carry only their source offset and segment count for addressing.

### Shared SegmentTemplate

The template is created once per renderer context and shared by all pages. Its
`vertex_id` attribute contains libvgcode's eight logical vertex IDs expanded to
24 vertex invocations. Each page uses a Three.js `InstancedMesh`; the vertex
shader reads the page's selected local ID, adds `segment_base`, fetches the
global textures, and emits the camera-facing physical-width/height band.

The WebGL2 shader is GLSL ES 3.00. It keeps libvgcode's near-vertical fallback,
zero-length direction fallback, cap-angle handling and no-cull band rendering
semantics. Desktop GLSL 1.50 and `samplerBuffer` are references, not runtime
requirements for the Web/Electron path.

The material emits alpha 1 with `THREE.NoBlending`, `depthTest: true`,
`depthWrite: true`, and `THREE.DoubleSide`. The Three.js `transparent` flag is
used only for render ordering; no toolpath color is alpha-blended.

### Per-page selection texture

Each page owns an `R32UI` texture containing local source IDs. The texture is
updated in place in source order when any of these change:

- inclusive visible layer start/end;
- active-layer inclusive move end;
- travel visibility;
- active-scheme feature/material/tool visibility.

Entries are emitted at most once, with no per-segment object allocation. The
renderer copies selected IDs into the existing page texture, marks it for
upload, and sets that page mesh's draw count to the emitted count. Dimming is
implemented with page material uniforms. Palette updates rewrite only the
global color texture. Camera renders do not invoke the planner or selection
rebuild.

### Layer-aligned pages

Pages preserve source order and are grouped at layer boundaries. The default
soft target is 65,536 segments per page; actual capacity is the minimum of:

1. the soft target;
2. `floor(MAX_TEXTURE_SIZE² / texelsPerSegment)` for every static texture; and
3. the configured per-result GPU budget after template/page overhead.

A page may exceed the soft target to avoid splitting a normal layer. If one
layer exceeds the hardware hard capacity, it is split only as an explicit
oversized-layer exception; all pieces carry that layer ID and remain visible
for the active layer. The planner reports this exception. It may never silently
drop or coarsen segments in the active inspection range.

The planner retains source order and reports each page's `firstSegment` and
`segmentCount`, plus layer and capacity diagnostics used during construction.
The renderer uses the source offset/count and does not create per-segment
Three.js objects.

## Behavioural equivalence

The backend must satisfy the existing Preview v2 contract unchanged:

- Feature/Line Type and material/tool filters hide entries through the enabled
  index stream. Travel visibility is global and hides travel entries rather
  than dimming them.
- Dimming changes brightness only. Earlier visible layers remain represented
  and the active layer remains full-strength according to the existing
  inspection state.
- The layer range is inclusive. The active layer is visible from its implicit
  first move through the inclusive move end. Single-layer mode pairs both
  layer endpoints and clamps the move end to that layer's local maximum.
- The marker selects the last move at or before the active move end. It uses
  the source-neutral endpoint/order metadata and does not pick the dense path
  with pointer raycasting.
- Model shells remain alpha 0.15 and toolpaths remain visible through shells;
  invalidating a slice removes stale preview data before a new result appears.

The native backend is the sole/default toolpath renderer. Its semantic tests
and unavailable-state diagnostics are authoritative.

## Capability, unavailable state, and context loss

The native backend is selected when the context reports WebGL2, GLSL ES 3.00,
integer texture support, vertex texture fetch, and a usable
`MAX_TEXTURE_SIZE`. WebGL1 is not a fallback. The backend records the selected
mode and limits (`MAX_TEXTURE_SIZE`, texture units, estimated budget) for
diagnostics.

If shader compilation, texture allocation, page planning, context loss, or a
budget check fails, the toolpath preview becomes unavailable and reports the
failure explicitly. No alternate renderer is constructed, preview controls do
not change, and stale GPU handles are never retained. A later implementation
may retry after context restoration.

Mobile is deferred with the shared application's desktop-only first-release
policy. Small desktop windows do not change the page format; UI controls keep
their existing focus and keyboard semantics.

## Lifetime and release contract

1. The three global static textures, shared template, and one index texture per
   page are allocated after a completed result is accepted.
2. Selection changes update each existing index texture in place and set its
   mesh draw count. Camera gestures allocate and upload no path data.
3. Result invalidation, unmount, WebGL context loss, and failed partial
   construction dispose every texture, template buffer, material, and planner
   reference exactly once.
4. The planner may reject a result that exceeds its configured static/index
   budget or texture capacity. No active segment is silently dropped.

The planner reports estimates for static textures and page-local index
capacity. These are planning values, not hardware measurements or release
claims.

## Focused verification contract

The planner and renderer tests use small deterministic sources so unit tests
remain fast and explain the behavior they protect. They cover complete
layer-aligned page coverage, hard-capacity splitting, page-local selection,
cross-page source addressing, travel/feature filters, native template shape,
opaque depth state, capability failures, and resource release. Large
250,000- and 1,000,000-segment measurements are browser diagnostics, not
generated fixtures in the product or unit-test bundle.

## Risks and mitigations

| Risk | Mitigation / acceptance evidence |
| --- | --- |
| WebGL2 texture dimensions or integer formats vary | Capability query, page limit formula, shader compile test, unavailable diagnostic |
| One layer exceeds page capacity | Explicit oversized-layer page split and active-range test |
| Selection rebuild blocks interaction | Linear page-local scan contract and browser smoke coverage |
| GPU memory pressure | 64-byte estimate and explicit budget diagnostics |
| Camera accidentally rebuilds data | build/rebuild counters and camera gesture test must remain unchanged |
| Web/Electron semantic drift | shared planner/visibility tests and both-host E2E before default switch |
| C++/source drift or external G-code mismatch | source-neutral adapter contract; no bridge/submodule edits in this stream |

## Acceptance criteria

The native renderer is accepted as the default after its planner, template,
selection, capability, lifetime, and dual-host behavior are covered by tests
and smoke checks. Large-slice measurements are diagnostics rather than unit
test gates. A missing WebGL2 capability or failed allocation leaves the
preview unavailable with a diagnostic; it never selects another backend.

## Addressing invariant

Each page's selected IDs are local to that page. Because static endpoint,
shape, and color-layer textures are global to the source result, the vertex
shader adds the page's `firstSegment` through a `segment_base` uniform before
fetching them. This offset must be retained for every page draw; otherwise
pages after the first read the wrong source range and large previews truncate.
