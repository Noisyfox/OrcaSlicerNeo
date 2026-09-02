# G-code Preview GPU Streaming Renderer

**Date:** 2026-09-02
**Status:** Approved architecture; opaque solid-entity instance backend supersedes the atlas/shader implementation (2026-09-02)
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
GPU mandatory; browser/Electron capability checks and the existing WebGL2,
software-rendering, and B2 fallbacks remain authoritative.

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
- Provide an explicit capability/fallback and memory/lifetime contract that can
  be measured in a real browser later.

Non-goals for this increment:

- Replacing the current `ToolpathLines` backend or changing its output.
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
     immutable static page planner
       |                    |
       v                    v
  static GPU atlas       layer/page table
  (per-segment data)     (CPU metadata)
                              |
                         selection/filter rebuild
                              v
                 dynamic enabled index stream (R32UI)
                              |
             shared indexed SegmentTemplate + instanced draw
```

### Static segment atlas

The planned WebGL2 layout is page-local 2D textures, because WebGL2 guarantees
GLSL ES 3.00 integer texture sampling but does not guarantee the desktop
`samplerBuffer` path used by libvgcode's desktop shader. `texelFetch` is used
with nearest/no-mipmap sampling; no filtering or normalised coordinate math is
allowed for IDs.

Each static page stores:

- two `RGBA32F` texels per segment for start/end XYZ (the fourth component is
  reserved for alignment/bias as needed);
- one `RGBA32F` texel for width, height, cap angle and z-fighting bias;
- one integer texel for layer/order/category IDs, packed only where the value
  range is proven safe; otherwise use `R32UI` fields; and
- palette/metric references in integer or float textures when a selected
  colour scheme needs them.

The exact packed channel schema is an implementation detail only if the
contract tests assert that every source value round-trips. A static colour
palette texture may be updated when a colour scheme changes; source segment
attributes and geometry are not rewritten. Optional metric arrays are omitted
when unavailable, as required by Preview v2.

### Shared indexed segment template

The template is created once per renderer context and shared by all pages. It
is an indexed prism/pointy-cap template equivalent to libvgcode's
`SegmentTemplate`: eight corners, 24 byte-sized indices, six faces, and an
instanced draw. The vertex shader obtains the local segment ID from the
enabled-index stream, fetches static attributes with `texelFetch`, derives the
camera-facing side/up directions, and emits a physical-width/height band.

The WebGL2 shader is GLSL ES 3.00. It keeps libvgcode's near-vertical fallback,
zero-length direction fallback, cap-angle handling and no-cull band rendering
semantics. Desktop GLSL 1.50 and `samplerBuffer` are references, not runtime
requirements for the Web/Electron path.

### Dynamic enabled-index stream

Each page owns an `R32UI` stream of local static segment IDs. The stream is
rebuilt in source order when any of these change:

- inclusive visible layer start/end;
- active-layer inclusive move end;
- travel visibility;
- active-scheme feature/material/tool visibility; or
- a future source-neutral visibility predicate.

Entries are emitted at most once, with no per-segment object allocation. A
rebuild returns the emitted count and a visit counter for diagnostics. Draw
count equals the stream length. Dimming is derived from static layer metadata
and active-layer uniforms (or a compact page uniform), so dimming does not
require duplicating or rewriting the enabled stream. Palette updates likewise
do not rebuild static geometry.

The index stream is the only per-selection GPU upload in the planned backend.
It is replaced after the current draw boundary, then the previous stream is
released. A camera render is forbidden from invoking either the static page
planner or the index rebuild.

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

The page table records `firstSegment`, `segmentCount`, `firstLayer`, `lastLayer`,
static atlas dimensions, enabled count, and estimated/allocated bytes. A page
table is CPU metadata, not a Three.js geometry object.

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

The streaming backend must pass the existing renderer semantic tests before it
is enabled by default. The current B2 backend remains behaviourally
authoritative during migration.

## Capability, fallback, and context loss

The streaming backend may be selected only when the context reports WebGL2,
GLSL ES 3.00, integer texture support, vertex texture fetch, and a usable
`MAX_TEXTURE_SIZE`. WebGL1 is not a fallback. The backend records the selected
mode and limits (`MAX_TEXTURE_SIZE`, texture units, estimated budget) for
diagnostics.

If shader compilation, atlas allocation, page planning, context loss, or a
budget check fails, the result falls back to the current B2 renderer. The
fallback is explicit and non-blocking; it cannot alter preview controls or
drop the active inspection range. A later implementation may retry after
context restoration, but must not retain stale GPU handles.

Mobile is deferred with the shared application's desktop-only first-release
policy. Small desktop windows do not change the page format; UI controls keep
their existing focus and keyboard semantics.

## Lifetime, release, and memory contract

1. Static atlas pages and the shared template are allocated after a completed
   result is accepted, and are immutable until result invalidation.
2. Selection changes allocate a replacement dynamic index stream, publish it at
   a draw boundary, and release the previous stream. Camera gestures allocate
   nothing in the streaming path.
3. Result invalidation, unmount, backend fallback, WebGL context loss, and
   failed partial construction dispose every page texture, index stream,
   template buffer, material, and CPU planner reference exactly once.
4. Accounting uses an upper bound of 64 bytes per static segment plus 4 bytes
   per enabled index, page metadata, and template resources. Implementations
   report estimated and allocated bytes; driver-reported values may be
   unavailable and must remain `null`, not zero.
5. A configurable budget rejects or evicts non-active nearby pages before
   compromising the active range. Any adaptive detail outside that range is
   visible in diagnostics and is restored after camera interaction.

For planning, the static upper bound is approximately 16 MiB at 250,000
segments and 64 MiB at 1,000,000 segments, before texture padding and page
overhead. Enabled streams add at most 1 MiB and 4 MiB respectively when every
segment is enabled. These are estimates, not hardware measurements or release
claims.

## Deterministic fixture and benchmark contract

The repository fixture is metadata-only and lives in
`packages/slicer-app/src/components/workspace/viewport/gpuStreamingFixture.ts`.
It generates exactly 250,000 and 1,000,000 ordered synthetic segments using a
fixed seed/formula, with compact `Uint32Array` layer/order data and
`Uint8Array` category data. It never allocates endpoints, widths, Three.js
objects, WebGL textures, or mock geometry.

The pure tests must assert:

- exact segment counts and byte-identical repeated generation;
- contiguous, complete layer/page coverage and no split of normal synthetic
  layers;
- inclusive layer/move selection, travel filtering, feature hide semantics,
  source-order stability and no duplicate IDs; and
- a linear metadata scan (`visitedSegments === segmentCount`) with no geometry
  construction or wall-clock threshold.

This fixture is a deterministic contract/complexity harness, not an FPS
benchmark. A later real browser harness must measure 60 FPS at approximately
250k and 30 FPS at approximately 1m on the representative 2020 integrated
GPU, along with index rebuilds, GPU memory and active-range preservation.

## Migration steps and retention policy

1. **Design + fixture (this step):** add this spec, the living task entry, and
   the pure metadata fixture/tests. Existing renderer files and behaviour stay
   unchanged.
2. **Planner adapter:** map the source-neutral B1 result to static-page and
   index-stream plans; test packing, round trips, page limits and disposal
   with a fake resource tracker. Keep the current backend as default.
3. **WebGL2 backend behind a flag:** implement atlas upload, shared template,
   shader, dynamic streams and explicit capability fallback. Add renderer
   tests and a real browser measurement harness.
4. **Dual-host verification:** run Web threaded/serial and Electron semantic
   flows, same-renderer screenshots, context/budget tests, and manually review
   the fixed native reference. Enable by default only after all gates pass.
   (Functional, lifetime, and dual-host verification passed on 2026-09-02;
   the representative integrated-GPU performance gate remains pending, so the
   default stays off. Browser measurements are recorded in the living
   implementation entry; this runner uses SwiftShader for Web and an RTX 3080
   for Electron, so neither is a representative 2020 integrated-GPU claim.)
5. **Removal:** retain the current B2 backend through the full functional,
   lifetime, fallback, visual and representative-hardware performance gate.
   Remove it only in a separately approved cleanup change after the streaming
   backend has been the default for one release cycle without a fallback-rate
   regression.

## Risks and mitigations

| Risk | Mitigation / acceptance evidence |
| --- | --- |
| WebGL2 texture dimensions or integer formats vary | Capability query, page limit formula, shader compile test, B2 fallback |
| One layer exceeds page capacity | Explicit oversized-layer page split and active-range test |
| Selection rebuild blocks interaction | Linear scan contract, worker/planner ownership in follow-up, measured browser rebuilds |
| GPU memory pressure | 64-byte estimate, budget diagnostics, non-active eviction, active-range guarantee |
| Camera accidentally rebuilds data | build/rebuild counters and camera gesture test must remain unchanged |
| Web/Electron semantic drift | shared planner/visibility tests and both-host E2E before default switch |
| C++/source drift or external G-code mismatch | source-neutral adapter contract; no bridge/submodule edits in this stream |

## Acceptance criteria

The step-1 design/fixture gate passes when:

1. this specification and the dated living entry are linked from the existing
   Preview v2 and implementation documents without duplicating their product
   behaviour;
2. the 250k/1m metadata fixture tests are deterministic, fast, geometry-free,
   and prove selection semantics plus a linear visit count;
3. `pnpm --filter @orca/slicer-app test`,
   `pnpm --filter @orca/slicer-app typecheck`, `pnpm test`, `pnpm typecheck`,
   and `git diff --check` pass; and
4. `packages/slicer-wasm/cpp` has no diff or pointer change attributable to
   this work.

The streaming backend is accepted as an opt-in backend after the functional,
lifetime, capability/fallback, and dual-host gates. Its real WebGL2 browser
measurements are recorded in the living implementation entry. The Web
measurement uses a SwiftShader software driver and Electron uses a discrete
RTX 3080; no representative integrated-GPU or native Orca pixel-equivalence
claim is made. The default preference remains blocked until the stated 2020
integrated-GPU 250k/1m gate is measured. The current B2 backend remains the
production path and automatic fallback and is not removed by this change.

## Superseding architecture: opaque solid entities (2026-09-02)

The prior static-atlas/texel-fetch shader architecture is superseded by the
explicit product requirement that toolpath thickness and height be real
geometry and that no toolpath use alpha blending. The active implementation
uses one shared faceted, diamond-profile solid-prism geometry template and one
page-local `THREE.InstancedMesh` per planner page. Selection rebuilds materialize
each segment's endpoint midpoint, direction basis, width, height, and optional
bias in the instance matrix; the prism supplies the real side facets of the
diamond band. Endpoint faces are omitted so a continuing move cannot expose a
flat, dark diamond cap.
The profile is a four-point diamond in the local `line_right`/`line_up` plane,
matching libvgcode's cardinal endpoint construction rather than a square or
chamfered ring.

Toolpath materials are standard Three `MeshStandardMaterial` instances with
flat face shading, `color: 0xffffff`, `roughness: 0.82`, and `metalness: 0`.
The scene's ambient/directional lights produce stable top/side contrast from
the real diamond-prism normals, making adjacent same-colour paths readable
without an artificial gap, endpoint block, or alpha outline. They use `transparent: true` solely to
place them after the transparent preview shell in Three's render queue,
`opacity: 1`, `blending: THREE.NoBlending`, `depthTest: true`,
`depthWrite: true`, and `FrontSide`. This queue flag does not enable alpha
compositing; the renderer's blend state is explicitly disabled. Depth is
intentionally enabled for the solid entities themselves: the preview shell
does not write depth, while the toolpaths establish depth and therefore
self-occlude from the camera-facing side. Per-instance RGB colours implement
the feature palette and an opaque gray unknown-feature fallback. Travel colour
is selected from the move type (not the preserved extrusion role), using
libvgcode's `Travels` colour `RGB(56, 72, 155)`; travel is consequently
independent of extrusion feature visibility and follows the global travel
toggle. There is no custom toolpath shader,
`texelFetch`, atlas, integer texture, enabled-index texture, or
shader-derived outline/width/height. The planner remains a pure
source/page/selection planner and can retain its page metadata accounting for
deterministic partitioning.

The baseline correspondence to native libvgcode is page-local selected
instances, ordered layer ranges, vertical direction fallback, and shell-visible
depth state. Native `ViewerImpl::render_segments` explicitly disables
`GL_CULL_FACE`; the current Three adaptation intentionally uses
`side: FrontSide` (back-face culling) because its physical diamond entities must
self-occlude. This is a deliberate adaptation difference, not a claim that the
native renderer culls back faces. Native libvgcode's eight-corner template has
camera-dependent spike/silhouette vertices and cannot be represented exactly
by one static affine mesh without reintroducing shader-derived shape logic.
Three/WebGL2 therefore uses a physically solid diamond-profile template and
materializes direction/width/height on the CPU, as required. Camera updates
only update camera/render state. Layer, move, travel, and feature filters
rebuild selected page matrices/colors and counts without re-parsing or slicing.

The Three material leaves `vertexColors` disabled because the shared prism has no
per-vertex `color` attribute. `InstancedMesh.instanceColor` is enabled by
Three independently. Enabling both paths would multiply by the missing
attribute before applying the instance color, making every toolpath black;
this instance-color-only contract is shared by the streaming renderer and B2.

Both the opt-in backend and B2 fallback use opaque solid entities. On result
invalidation, unmount, context loss, or construction failure all owned
templates, meshes, materials, and attributes are released and B2 is retained;
successful construction removes B2 to prevent double drawing. The browser
harness reports entity allocation and matrix/color uploads, not atlas/index
uploads. Existing atlas-specific acceptance measurements are historical and
must not be used as evidence for this architecture.
