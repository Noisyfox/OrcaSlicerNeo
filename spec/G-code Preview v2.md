# G-code Preview v2

**Status:** Major design approved for phased implementation.

**Started:** 2026-09-01

## Purpose

Replace the current minimal G-code display with a shared Web/Electron preview
experience that approaches current OrcaSlicer's inspection workflow while
retaining the React application, WebGL 2 renderer, and the existing WASM bridge
architecture.

This specification is deliberately separate from the approved Workspace
Prepare and Preview Modes specification. That specification governs workspace
navigation and lifetime. This specification governs the G-code data model,
preview renderer, controls, and inspection information.

## Scope and phasing

The work is delivered in two phases.

### Phase B — reliable Orca-style inspection foundation

Phase B is the first shipping target. It provides:

- a right-side, dual-thumb vertical layer-range control;
- a bottom, single-thumb move-end control for the selected layer;
- default Feature/Line Type colouring, a feature legend with visibility
  filtering, and a travel visibility control;
- explicit, continuous toolpath segments rather than implicit pairs of move
  endpoints;
- true extrusion-band rendering, based on each segment's width and height,
  rather than fixed-width screen-space lines;
- Orca-style inspection emphasis: the current upper layer is prominent and
  earlier visible layers are dimmed by default;
- a lightweight camera-facing nozzle marker at the final move in the active
  range;
- the existing Preview shell behaviour: model shells remain at alpha 0.15 and
  paths are not depth-occluded by them.

Phase B does not add external G-code import, result-mutating preview actions,
advanced metric colour schemes, summary statistics, or a G-code text window.

### Phase C — read-only analysis and information

Phase C remains read-only and adds:

- core analysis colour schemes: Feature/Line Type, Filament/Tool, Speed,
  Volumetric Flow, Layer Time, Temperature, and Fan Speed;
- summary statistics and per-feature time/filament breakdowns;
- a native-style tool model/inspection information window, replacing the
  Phase-B lightweight marker where appropriate; and
- a G-code text window linked to the active move and source G-code line.

Phase C does not add pauses, filament changes, custom G-code insertion, or
other actions that alter a slice result. Those changes need a dedicated result
lifecycle and export design in a future specification.

Advanced metric schemes — actual speed, actual volumetric flow, line width,
layer height, pressure advance, acceleration, and jerk — are deliberately
outside the initial Phase-C scope, but the data contract must admit them.

### Phase-C information semantics

Phase C displays only standard estimated time. Stealth/silent time is not
exported to the UI or made selectable.

The summary shows total estimated time, total filament length and weight, and
total cost. Cost follows current Orca's presentation: a bare decimal rounded to
two places, without an inferred currency symbol. The initial shared application
has no global unit preference, so all preview units are metric. A future global
unit system may replace that presentation; one is not created by this work.

Per-feature statistics show standard time and filament consumption. Per-tool
breakdowns and tool/filament-change counts remain outside the Phase-C target.

Numerical colour schemes derive their legend min/max values from the active
slice result, rather than using global physical ranges. Their ramps use current
Orca colour schemes as the visual reference. User-customisable colour ramps are
an explicit future extension, not a Phase-C preference feature.

For multi-material output, the Filament/Tool scheme uses the configured actual
filament colours and identifies the associated filament/tool in its legend. A
single-material preview remains on the Feature/Line Type default unless the
user selects a different scheme.

The G-code text window is virtualised plain text with active-line highlighting;
syntax highlighting is deferred. A selected line maps to its exact preview move
when one exists. Selecting an otherwise unmappable line positions the preview
at the nearest preceding mappable move; if none precedes it, the current
inspection position remains unchanged.

Phase C displays no read-only layer-slider ticks for existing pauses, colour
changes, tool changes, or custom G-code. They will be designed with a future
result-editing feature instead of being partially exposed here.

The Phase-C current-move marker is a generic 3D nozzle/tool visual, not a
printer-model-specific asset.

## Data-source boundary

Initially the preview consumes only G-code produced by the application's
current completed slice result. No external `.gcode` import is implemented.

The shared preview pipeline will nevertheless consume a source-neutral
`PreviewSource` abstraction. A future imported-G-code source must be able to
provide the same preview command stream, metadata, and lazily read text
without changing renderer or control semantics.

The canonical source remains `libslic3r`'s `GCodeProcessorResult`, which is
already used by the WASM bridge. The bridge, typed client, and Worker are the
only path to renderer data; the shared application never talks directly to the
Emscripten module.

## Preview data v2 contract

The bridge must replace the current endpoint-only toolpath buffer with explicit
renderable segments. A segment records at least:

- start and end coordinates;
- layer id, per-layer movement order, and source G-code id;
- move type, extrusion role, extruder id, and colour-print id;
- extrusion width and height; and
- enough categorical information to separately filter extrusion features and
  travel moves.

The contract is structure-of-arrays typed binary data transferred through the
existing WASM heap and Worker boundary. It must not create a JSON object per
move or a React element per segment.

It reserves optional parallel numeric arrays for the Phase-C metrics: feedrate,
actual feedrate, volumetric flow, actual flow, fan speed, temperature, pressure
advance, acceleration, jerk, time, and layer duration. Result-level metadata
also reserves feature/extruder palettes, layer Z values and ranges, precomputed
per-feature statistics, and source-G-code line mapping. Optional data is
omitted when a source cannot provide it.

Full G-code text is not copied to the renderer during initial preview loading.
Phase C will obtain it through an on-demand, chunked source-text API.

## Interaction and information architecture

### Layout

Preview controls use Orca-style canvas overlays and do not change the existing
left workspace sidebar or resize the 3D viewport.

- The dual-thumb layer-range slider is fixed to the canvas's right edge.
- The single-thumb move-end slider is fixed to its bottom edge.
- The colour-scheme selector, legend, and statistics occupy a collapsible,
  right-top canvas overlay.
- The right-top Feature/Line Type overlay reserves a horizontal gutter for the
  right-edge layer slider. The two overlays must not intersect at any desktop
  viewport size, including when a long legend makes the right-top overlay
  scroll; the gutter must not intercept either layer thumb.
- In Phase C, the G-code text window is a separately toggled, larger overlay
  rather than content that compresses the legend or statistics.

The layer slider controls the inclusive visible layer range. The upper active
layer is visually prominent; earlier visible layers are dimmed by default. The
move slider controls the inclusive movement range from the active layer's
implicit start through its current move end. Its single thumb is the current
inspection position and drives the nozzle marker.

Single-layer inspection keeps the right-edge control as a dual-thumb layer
range slider. Both thumbs move the active layer together, so the inclusive
range remains `[active layer, active layer]`; leaving single-layer inspection
restores the inclusive range from layer zero through the active layer.

### Filter and state semantics

Legend filters have Orca's hide semantics: disabling a feature, material/tool,
or travel category removes those paths from the rendered result rather than
only reducing their opacity.

Filtering and legend items are scoped to the active colour scheme. For example,
Feature/Line Type filtering does not affect Filament/Tool filtering. Travel
visibility is global across colour schemes.

All preview controls are ephemeral for the initial delivery. Colour scheme,
legend/filter state, travel visibility, dimming state, overlay expansion, and
all range positions reset to their defaults when a new slice result is loaded;
none are persisted across sessions. Persisted preview preferences are a future
product decision.

### Read-only navigation and G-code linking

No Phase-B or Phase-C control modifies the slice result. In particular,
custom-G-code actions, pause insertion, and filament changes remain out of
scope.

Phase C's G-code window has two-way inspection navigation:

- Moving either slider or advancing the active move highlights the matching
  source line in the text window.
- Selecting a mappable source line updates the active layer and move end.

The 3D path itself is not pickable. Dense overlapping extrusion bands make
pointer picking imprecise and costly; deterministic slider and text navigation
are the supported ways to select a move.

### Current-move information

Phase B renders a lightweight camera-facing marker at the current move. Phase
C adds a native-style inspection card next to the marker or in the right-top
overlay. It displays, when available: layer number and Z, X/Y/Z position, move
type, feature, source G-code line, and the values relevant to the selected
colour scheme. Missing source fields are omitted rather than represented by
invented values.

### Keyboard and theme behaviour

When the viewport, rather than a text input or other ordinary focusable control,
owns keyboard focus, preview supports the Orca-style inspection shortcuts:

- Up/Down adjust the active end of the layer range.
- Left/Right adjust the active move end.
- Shift or Ctrl accelerates range stepping.
- `L` toggles single-layer inspection.
- In Phase C, `C` toggles the G-code text window.

These shortcuts must not break text editing or standard Tab focus navigation.

All Phase-B and Phase-C overlays, controls, legend states, and colour ramps
must adapt to the application's light and dark themes. Semantic feature colours
remain stable between themes; surface, text, inactive, and gradient supporting
colours adapt to maintain legibility.

## Renderer and performance policy

The implementation architecture for the GPU streaming/indexed-segment path is
recorded in [`G-code Preview GPU Streaming Renderer`](G-code%20Preview%20GPU%20Streaming%20Renderer.md).
That specification is an implementation refinement only: the behaviour and
performance goals below remain authoritative, and the current backend remains
the migration fallback until its gates pass. Its accepted renderer is now the
opaque solid-entity instance design recorded in the dated living entry; the
earlier atlas/texel-fetch shader variant is superseded.

Toolpaths are GPU-rendered, camera-facing extrusion bands. Rotation, pan, and
zoom only update camera/render state and must never reconstruct or upload
toolpath entities. Layer ranges, the move end, legend filters, dimming, and
colour-scheme changes rebuild only selected page-local instance matrices,
colours, and counts; they do not re-parse the source or rebuild the complete
scene. Toolpath materials remain opaque with `NoBlending`.

For ordinary slices, all prepared segment data may remain GPU-resident. For
large or multi-colour slices, segment data is partitioned into layer-aligned
chunks with nearby-layer caching. When memory pressure or the path count makes
full-detail rendering harmful to interaction, the application may temporarily
reduce detail outside the actively inspected layer range while rotating or
dragging. It automatically restores full detail after the gesture. The active
inspection range always retains its true geometry.

Statistics are preaggregated by the Worker/bridge during preview preparation;
opening or changing an information panel must not rescan the entire path on the
UI thread.

The minimum performance baseline is a typical 2020-era integrated-GPU laptop:

- a representative ordinary slice of roughly 250,000 segments sustains at
  least 60 FPS while rotating; and
- a representative large slice of roughly 1,000,000 segments sustains at
  least 30 FPS while rotating.

The adaptive-detail policy may apply above those conditions, but it cannot
reduce detail in the currently active inspection range.

## Delivery and release approach

Phase B is an independently shippable replacement for the current preview. It
must reach its functional and performance release gates before Phase C begins.
Phase C is a later independent increment on the accepted Preview data v2
contract; it must not require replacement of the Phase-B renderer or controls.

## Visual reference and approval

The fixed native visual and interaction reference is the repository's existing
engine baseline: `Noisyfox/OrcaSlicer` commit
`b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`
(`version_2.4.0-12323-gb97ca3c0ac`). Its dirty working tree is never part of
the reference. Changing this reference requires an explicit specification
update and approval.

Visual approval has two complementary layers:

- Web and Electron use repeatable same-renderer screenshot regressions for
  preview controls and scene output.
- Approved fixed-reference captures from native Orca guide manual visual
  comparison of layout, colours, dimming, ranges, and information density.

Native OpenGL output and browser WebGL output are not compared with a direct
pixel-diff assertion: platform fonts, driver rendering, and rasterisation would
make that noisy and misleading. A visual change is accepted when internal
regressions pass and the approved reference comparison is reviewed.

## Product constraints retained from existing specifications

- Prepare and Preview keep their shared Canvas, camera, resource lifetime, and
  model-shell semantics.
- Preview stays an inspection view. Existing result invalidation immediately
  removes stale toolpath data.
- The solution remains shared across static Web and Electron, desktop Chrome
  133+ / WebGL 2 capable, and keeps model/renderer code host-independent.
- `libslic3r` stays unmodified. Any C++ work is confined to the WASM bridge or
  its normal build scaffold under the repository rules.

## Verification direction

The eventual implementation must add contract tests for segment continuity,
layer and move indexes, palettes, optional metrics, and metadata; renderer
tests for range/filter/dimming semantics; and shared Web/Electron end-to-end
coverage for the Phase-B controls. Large-slice benchmarks must exercise the
chunking/adaptive-detail path and verify that camera navigation never triggers
a full path rebuild. The benchmark fixtures must cover the two minimum
performance baselines. Release verification continues to include the existing
unit, typecheck, serial/threaded WASM build and smoke, Web threaded/serial E2E,
and desktop E2E requirements.

The fixture suite will include feature-rich single-material and multi-material
reference slices as well as the ordinary and large performance cases. Fixture
selection is a prerequisite to implementation and must be documented before
the Phase-B bridge contract is changed.

### Approved fixture plan

The implementation creates and records the following repository-owned fixtures
before changing the bridge contract:

- **Command matrix:** a small synthetic `PreviewSource` command stream covering
  every Phase-B feature, travel, layer/move boundaries, width/height variation,
  and each Phase-C core metric. It is the deterministic unit and renderer
  fixture; it is not a substitute for a real slice.
- **Single-material reference:** the existing
  `packages/slicer-wasm/fixtures/cube.stl` sliced with the already-established
  `Bambu Lab P1P 0.4 nozzle`
  profile. This is the compact real bridge, Web, desktop, and native-reference
  fixture.
- **Feature-rich reference:** a new, small repository-owned model/profile
  fixture that deterministically emits perimeters, infill, top/bottom skin,
  bridge/overhang where supported, support, and travel. It is used for legend,
  filtering, dimming, range, and screenshot approval.
- **Multi-material reference:** a new small repository-owned multi-material
  fixture with two configured distinct filament colours. It validates the
  Phase-C Filament/Tool palette and legend without requiring external G-code
  import.
- **Performance streams:** deterministic synthetic segment streams containing
  exactly 250,000 and 1,000,000 segments, partitioned like real layer chunks.
  They isolate renderer throughput and adaptive-detail measurements from the
  slicing duration and from future profile changes.

The fixture manifest records the native reference SHA, profile names/config,
camera pose, selected ranges, theme, browser viewport, expected command/segment
counts, and approved reference captures. Generated G-code and screenshots are
checked in only where they are needed for deterministic visual or text mapping
tests; otherwise a reproducible fixture-generation command is recorded.
