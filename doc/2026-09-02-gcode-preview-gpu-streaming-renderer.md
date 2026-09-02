# G-code Preview GPU streaming renderer

**Date:** 2026-09-02
**Status:** Living implementation entry; native SegmentTemplate renderer is the sole/default toolpath renderer; unavailable GPU/context states are diagnosed explicitly
**Scope:** GPU streaming/indexed-segment redesign for the shared G-code preview

## Purpose and boundary

This document records the implementation steps for the large-slice renderer
redesign. Step 1 established the implementation contract and deterministic
metadata fixture; step 2 adds a source adapter and immutable page/index
planner; step 3 adds the WebGL2 backend; and the final integration makes the
native SegmentTemplate path the sole/default renderer. The normative
architecture is
[`spec/G-code Preview GPU Streaming Renderer.md`](../spec/G-code%20Preview%20GPU%20Streaming%20Renderer.md).

The renderer remains a shared `packages/slicer-app` feature for Web and
Electron. `packages/slicer-wasm/src/client` remains the only JavaScript layer
that receives WASM data, and `libslic3r` plus
`packages/slicer-wasm/cpp` remain untouched. The step-1 fixture contains
metadata only; it deliberately does not allocate positions, band geometry,
Three.js objects, WebGL resources, or a mock GPU.

## Native SegmentTemplate migration (2026-09-02)

The active GPU backend now follows Orca/libvgcode `SegmentTemplate`: one
shared template contains eight logical vertices and 24 vertex invocations per
segment, with pointy endpoint spikes represented by the native vertex-ID
pattern. The GLSL ES 3.00 vertex shader retains `POINTY_CAPS` and
`FIX_TWISTING`, camera-relative corner selection, near-vertical basis fallback,
width/height, cap-angle, and z-bias calculations.

Static endpoint position, height/width/angle/bias, and colour/layer data are
uploaded to RGBA32F textures. Each layer-aligned page owns an R32UI selected
index texture. Layer/move/travel/feature slider changes update only those index
textures and draw counts; camera changes update Three camera uniforms only.
No per-segment entity matrix or cap mesh is rebuilt by the active GPU path.

## Accepted step-2 implementation

`gpuStreamingPlanner.ts` adapts the existing `ClientToolpath` structure of
arrays without copying shape, palette, or metric buffers. The direct
`GpuStreamingSource` entry point validates every static SoA length (including
optional metric/angle/bias arrays), rejects non-ordered layer IDs, and always
regenerates layer ranges from `layerIds`; caller-provided empty, gapped,
overlapping, or mismatched tables therefore cannot silently omit or duplicate
segments. It derives small, planner-owned layer records (retaining optional
layer Z values) and freezes the source wrapper, layer records, page table, and
diagnostics. Typed arrays remain owned by the accepted slice result and are
treated as immutable by contract; the planner makes no per-segment object
allocations.

Pages are assembled in source order at layer boundaries. The 65,536 target is
soft: an ordinary layer may exceed it and is marked `oversized`. A supplied
`hardCapacity`, future `MAX_TEXTURE_SIZE` plus texel schema, or configured
budget can lower the capacity. A layer over that hard capacity is split only
as an explicit `oversizedLayer` exception, with every piece retaining the layer
ID. No WebGL capability query or allocation occurs here.

The default four-texel static schema is derived as two endpoint texels, one
shape texel, and one identity/category texel (64 bytes per static segment).
Page diagnostics report static bytes, maximum enabled-index capacity (4 bytes
per segment), total estimate, budget exceedance, atlas dimensions, and
`allocatedBytes: null`. The next backend can consume page-local `Uint32Array`
enabled indices from `rebuildGpuStreamingSelection`; the one-pass rebuild keeps
inclusive layer/move-end, travel, and feature-hide semantics and preserves
source order. Dimming remains a later uniform/metadata concern and does not
duplicate shape data.

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

The redesign preserves the accepted Preview v2 semantics: extrusion
feature/line-type and travel filtering hide paths; travel is independently
coloured and filtered as the native Travels option, regardless of any
preserved extrusion role. Dimming changes brightness but does not turn a
visible segment into a hidden one; single-layer mode keeps a paired layer range
and shows that layer from its first move through the active move end; and the
native-style solid hotend marker uses the last move at or before that end. Existing
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
  cannot initialize or a page allocation fails, leave the toolpath preview
  unavailable for that result and surface a non-blocking capability status.
  There is no alternate toolpath renderer and no silent loss of the active
  inspection range.
- Static atlas resources live for one immutable slice result. Dynamic index
  streams are replaced only after a completed selection rebuild. The old
  stream is retired after the draw boundary; all pages, textures, buffers,
  template resources, and material references are disposed on result
   invalidation, unmount, and context loss.
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

## Accepted step-3 backend implementation

`gpuStreamingRenderer.ts` is an independent WebGL2/Three.js backend. It consumes an existing
`GpuStreamingPagePlan`, uploads immutable endpoint position,
height/width/angle/bias, and colour/layer data to RGBA32F textures. Known upload
byte lengths are reported, while driver-reported allocation remains `null`.
The shared template is the native eight-logical-vertex/24-invocation
vertex-ID pattern. Its GLSL ES 3.00 vertex shader uses `gl_InstanceID`,
`usampler2D`, integer `texelFetch`, camera-facing side/up fallbacks,
zero-length direction fallback, `POINTY_CAPS`, `FIX_TWISTING`, cap angle, and
bias.

Each selection update receives the planner's page-local inclusive index
streams and updates only the page R32UI index texture and draw count. Camera
and dimming methods only update material uniforms. Static upload and dynamic
upload counts, draw instance counts, and page-local upload payloads are
observable for tests and diagnostics.

The source feature palette is resolved into the static RGBA32F colour texture;
`updatePalette()` updates that texture without rebuilding the template or
selection streams. Unknown IDs retain the deterministic fallback.
`probeGpuStreamingCapabilities` requires WebGL2, integer texture formats,
four texture units, vertex texture fetch, and a valid `MAX_TEXTURE_SIZE`.
Construction returns a diagnostic unavailable result on missing capabilities,
unsupported schema, allocation failure, or compile failure. The injected
resource facade is used by tests; the default facade creates nearest/no-mipmap
Three `DataTexture`s, one shared 24-invocation `BufferGeometry`, and page-local
`InstancedMesh` draws with `ShaderMaterial`. Read-only `sceneObjects` plus `attachToScene()` and
`detachFromScene()` let a later integration step add page meshes without
transferring scene ownership. All owned resources are wrapped in idempotent disposal,
including partial construction, context loss, explicit disposal, and retired
index streams. The caller's renderer, scene, and camera are never disposed.

The backend intentionally does not claim browser FPS or GPU compatibility
evidence. Browser measurements remain a separate acceptance gate.

## Accepted native preview integration

`gpuStreamingIntegration.ts` exposes only host-neutral options and diagnostics
for the native renderer. `ToolpathLines` always builds the immutable page plan,
creates `GpuStreamingRenderer` against the current Three renderer, uploads the
initial selection, and attaches its page meshes directly to the shared scene.
There is no feature gate, e2e enable switch, B2 construction, or alternate
entity-matrix path.

Layer range, active move end, travel visibility, and feature hide changes call
only `updateSelection`; active-layer dimming calls `updateDimming`; camera
frames call `updateCamera`; and a distinct palette calls `updatePalette`. None
of those paths rebuilds the static plan/atlas.

Planner, capability, budget, shader/atlas construction, context-loss, and
selection/palette update failures report a non-blocking diagnostic and leave the
toolpath preview unavailable. Cleanup detaches native meshes and disposes all
backend resources on source replacement/invalidation, context loss, and
unmount. The
backend seam exposes `commitDrawBoundary()`, and each owned page mesh calls the
backend's page-complete hook from `onAfterRender`; retired index/palette
textures are released only after every page has completed that frame. This
keeps replacement streams alive while a draw may still reference them and
avoids an integration-side retirement leak.
The
e2e-only status hook reports `ready`, `context-lost`, `disposed`, or
`unavailable`; an unavailable state always has a diagnostic reason. This is
not a performance claim. The existing marker, shell/depth policy, and all
preview controls remain outside the renderer diagnostics.

## Migration and verification state

1. **Step 1:** accept this architecture, add the metadata-only fixture/test
   contract, and add concise links from the existing Preview v2 documents. No
   renderer, bridge, or behaviour change.
2. **Step 2:** implement the source adapter and page/index planner
   with unit tests.
3. **Step 3:** implement WebGL2 static atlas + dynamic index pages and
   capability/lifetime diagnostics. (Complete.)
4. **Step 4:** connect the native backend to the real preview, add explicit
   unavailable-state diagnostics, and add dual-host smoke coverage. (Complete.)
5. **Step 5:** remove the obsolete entity-matrix backend and make the native
   SegmentTemplate renderer the sole/default implementation. (Complete.)

The native renderer is now the production path. Functional, memory/lifetime,
capability, and dual-host gates passed. Browser benchmark results remain
diagnostic evidence only; a missing WebGL2 capability or failed allocation is
reported as an unavailable preview rather than selecting a second renderer.

## Accepted step-5 browser and dual-host verification (2026-09-02)

The shared integration always selects the native renderer. There is no feature
gate, opt-in switch, B2 override, or entity-matrix fallback. When a streaming
plan, WebGL2 capability probe, budget check, shader/atlas construction, or
selection update fails, the integration reports a non-blocking diagnostic and
leaves the toolpath preview unavailable. No persistent UI setting was added.

The opt-in `ORCA_E2E_GPU_STREAMING_PERF=1` browser harness is exposed only by
e2e builds. It creates the deterministic metadata fixture, adds bulk typed SoA
geometry, plans pages, constructs `GpuStreamingRenderer` against a real
Three.js WebGL2 context, renders to force texture/index uploads, measures
selection replacement and 30 requestAnimationFrame camera updates, then
detaches and disposes all resources. It does not create a segment object or
assert a wall-clock threshold. The regular Web and Electron default e2e flows
assert `ready`, or `unavailable` with a non-empty diagnostic reason.

Evidence from this Windows runner (2026-09-02; values vary by run):

| Host/context | Case | Pages | Static bytes / ms | Selection ms / index bytes | Camera frames / FPS | Renderer | Dispose |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| Web Chrome 151, ANGLE SwiftShader Vulkan (software) | 250k | 4 | 16,027,360 / 30.82 | 10.53 / 753,664 | 30 / 65.20 | native | geometries 4→0 |
| Web Chrome 151, ANGLE SwiftShader Vulkan (software) | 1m | 16 | 64,108,032 / 77.88 | 14.04 / 3,112,960 | 30 / 64.94 | native | geometries 16→0 |
| Electron 43.4, ANGLE NVIDIA GeForce RTX 3080 D3D11 | 250k | 4 | 16,027,360 / 36.48 | 14.41 / 786,432 | 30 / 262.34 | native | geometries 4→0 |
| Electron 43.4, ANGLE NVIDIA GeForce RTX 3080 D3D11 | 1m | 16 | 64,108,032 / 79.41 | 14.40 / 3,145,728 | 30 / 262.42 | native | geometries 16→0 |

All four runs visited exactly the requested segment count during selection and
reported `cameraIndexUploadCountDelta = 0`. Web used `MAX_TEXTURE_SIZE=8192`
and 32/32 texture units; Electron used 16384 and 16/16. The Web runner is
explicitly configured with `--use-angle=swiftshader-webgl`, so its FPS is
software-driver evidence rather than proof of the Preview v2 2020 integrated
GPU baseline. Electron evidence is a discrete RTX 3080, not that baseline;
therefore no claim of representative integrated-GPU 60/30 FPS equivalence or
native Orca bit-for-bit screenshots is made. Driver-reported texture
allocation remains unavailable (`null` in the backend contract); the harness
records observable geometry lifetime and all owned resources are disposed.

The browser harness and default flow passed on both hosts, with the latest Web
SwiftShader rerun completing 250k but timing out during the subsequent 1m
case after 120 seconds; an earlier independent Web run supplied the 1m row
shown above. That timeout reinforces that this runner cannot establish the
representative integrated-GPU gate. It does not affect renderer selection:
unsupported or failed native initialization leaves the preview unavailable.

## Native SegmentTemplate GPU path (2026-09-02)

The entity-matrix/solid-cap implementation previously documented here is
superseded and is not the active GPU path. The active implementation follows
Orca/libvgcode `SegmentTemplate`: one shared template provides eight logical
vertices and 24 vertex invocations per segment, and page-local instanced draws
consume the selected IDs.

Static endpoint position, height/width/angle/bias, and colour/layer values are
stored in RGBA32F textures. The selected local segment stream is an R32UI
texture. The GLSL ES 3.00 vertex shader retains native `POINTY_CAPS`,
`FIX_TWISTING`, camera-facing corner selection, near-vertical basis fallback,
and endpoint spike calculations. Slider changes update only index textures and
draw counts; camera changes update uniforms only.

The material emits opaque alpha 1 with `transparent: true` solely for Three
queue ordering, `blending: THREE.NoBlending`, `depthTest: true`, and
`depthWrite: true`. `side: THREE.DoubleSide` matches libvgcode's explicit
`GL_CULL_FACE` disable; this does not enable blending, and the depth buffer
remains responsible for occluding overlapping path faces.

The old B2 entity implementation has been removed. On native capability,
allocation, shader, context, or selection failure, the scene remains without a
toolpath and the integration records the diagnostic. Context loss and result
invalidation dispose the shared template, textures, page materials, and index
streams exactly once.

### Cross-page source addressing fix (2026-09-02)

The dynamic `R32UI` stream stores page-local segment IDs, while the static
RGBA32F atlases contain the complete source stream. The vertex shader now adds
each page's `firstSegment` as a `segment_base` uniform before fetching endpoint,
shape, and colour texels. This preserves local index capacity while ensuring
every page renders its own source range; the regression test covers a selection
split across two pages.

The browser harness reports static texture and selected-index uploads. Legacy
entity report fields remain aliases for dashboard compatibility only. Unit
coverage asserts native template cardinality, texture dimensions/formats/
nearest filtering, pointy-cap shader invariants, opaque NoBlending materials,
multi-page selection, index-only slider updates, camera no-upload behaviour,
and idempotent disposal. Native WASM C++ remains untouched.

## Accepted native-style tool marker (2026-09-02)

The previous square camera-facing sprite is replaced by a real Three.js hotend
marker matching libvgcode's `ToolMarker::init(32, 2, 4, 1, 8)`: a 32-sided
downward cone whose tip is local z=0, followed by a cylindrical stem. The
marker group is anchored at the last mappable move endpoint plus z=0.5, with
no screen-facing billboard or scale distortion. Its white material uses
opacity 0.5, normal source-alpha blending, `depthTest: true`,
`depthWrite: false`, and `DoubleSide`, matching libvgcode's disabled culling,
depth-write suppression, and default alpha. Shared scene lights provide the
native marker's ambient/diffuse/specular appearance; the marker is rendered at
order 1100 after toolpaths.

The marker follows native hide semantics: it is omitted when the visible layer
and active move have reached the final enabled layer/move endpoint. Otherwise
it remains at the last move at or before the active move, including the nearest
preceding mapped move behaviour already defined by Preview v2. This change is
marker-only: toolpath entities retain their opaque `NoBlending` contract.

## Accepted GPU adapter preference (2026-09-02)

The shared R3F `Canvas` passes Three.js's standard
`powerPreference: 'high-performance'` WebGL context hint. This asks the
browser to choose a high-performance/discrete adapter when one is available;
it does not name a GPU, require a discrete adapter, or set
`failIfMajorPerformanceCaveat`. Static Web therefore keeps the browser's normal
integrated-GPU and software-rendering fallback, including the existing WebGL2
capability/error handling.

Electron applies Chromium's supported `force_high_performance_gpu` command-line
switch before window creation. The switch is a preference only: Chromium may
ignore it when no discrete adapter exists or when that adapter is unavailable.
The existing Linux SwiftShader branch remains authoritative for GPU-less or
known-broken Linux environments, so the startup preference never prevents the
safe software fallback.

## Historical shell depth regression (superseded)

An opt-in real bridge probe using the repository's `3DBenchy.drc` handy model
and the staged `Bambu Lab P1S 0.4 nozzle` profile produced 100,295 segments
across 170 ordered layers (the final layers 140–169 all contained positive
width/height segments). The planner therefore produced complete multi-page
selection data; the reported missing upper toolpath was not an active-range,
page-boundary, atlas-addressing, palette, or frustum failure.

The earlier atlas implementation exposed a shell-depth cutoff because its
material used Three's default depth state. That implementation is no longer
active. The native SegmentTemplate material explicitly emits opaque alpha 1
with `blending: THREE.NoBlending`, `depthTest: true`, `depthWrite: true`, and
`side: THREE.DoubleSide`; double-sided rasterization matches native cull state,
while depth buffering preserves correct overlap. Regression tests inspect the
static texture/index formats and native template invariants.
