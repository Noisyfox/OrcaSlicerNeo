# G-code Preview v2

**Status:** Delivered inspection foundation and read-only analysis/text; further preview actions remain deferred.

**Started:** 2026-09-01

## Purpose

The delivered G-code display provides a shared Web/Electron preview
experience that approaches current OrcaSlicer's inspection workflow while
retaining the React application, WebGL 2 renderer, and the existing WASM bridge
architecture.

This specification is deliberately separate from the approved Workspace
Prepare and Preview Modes specification. That specification governs workspace
navigation and lifetime. This specification governs the G-code data model,
preview renderer, controls, and inspection information.

## Delivered scope

The delivered scope comprises the inspection foundation and read-only analysis.

### Inspection foundation

The inspection foundation provides:

- a left-side, dual-thumb vertical layer-range control;
- a bottom, single-thumb move-end control for the selected layer;
- default Feature/Line Type colouring, a feature legend with visibility
  filtering, and a travel visibility control;
- explicit, continuous toolpath segments rather than implicit pairs of move
  endpoints;
- true extrusion-band rendering, based on each segment's width and height,
  rather than fixed-width screen-space lines;
- Orca-style inspection emphasis: the current upper layer is prominent and
  earlier visible layers are dimmed by default;
- a native-style solid hotend marker at the last mappable move in the active
  range, hidden at the final enabled endpoint;
- the existing Preview shell behaviour: model shells remain at alpha 0.15 and
  paths are not depth-occluded by them.

External G-code import and result-mutating actions remain deferred.

### Read-only analysis and information

Read-only analysis provides:

- core analysis colour schemes: Feature/Line Type, Filament/Tool, Speed,
  Volumetric Flow, Layer Time, Temperature, and Fan Speed;
- summary statistics and per-feature time/filament breakdowns;
- a native-style tool model and current-move inspection; and
- a G-code text window linked to the active move and source G-code line.

Preview does not add pauses, filament changes, custom G-code insertion, or
other actions that alter a slice result. Those changes need a dedicated result
lifecycle and export design in a future specification.

Advanced metric schemes — actual speed, actual volumetric flow, line width,
layer height, pressure advance, acceleration, and jerk — are deliberately
outside the delivered scope, but the data contract must admit them.

### Information semantics

Preview displays only standard estimated time. Stealth/silent time is not
exported to the UI or made selectable.

The summary shows total estimated time, total filament length and weight, and
total cost. Cost follows current Orca's presentation: a bare decimal rounded to
two places, without an inferred currency symbol. The initial shared application
has no global unit preference, so all preview units are metric. A future global
unit system may replace that presentation; one is not created by this work.

Per-feature statistics show standard time and filament consumption. Native
action statistics include tool-change count and delay. Per-tool consumption
breakdowns remain deferred; [Application Shell](Application%20Shell.md) defines
the current feature/action table and native metric semantics.

Numerical colour schemes derive their legend min/max values from the active
slice result, rather than using global physical ranges. Their ramps use current
Orca colour schemes as the visual reference. User-customisable colour ramps are
an explicit future extension, not a delivered preference feature.

For multi-material output, the Filament/Tool scheme uses the configured actual
filament colours and identifies the associated filament/tool in its legend. A
single-material preview remains on the Feature/Line Type default unless the
user selects a different scheme.

The G-code text window is virtualised plain text with active-line highlighting;
syntax highlighting is deferred. A selected line maps to its exact preview move
when one exists. Selecting an otherwise unmappable line positions the preview
at the nearest preceding mappable move; if none precedes it, the current
inspection position remains unchanged.

Preview displays no read-only layer-slider ticks for existing pauses, colour
changes, tool changes, or custom G-code. They will be designed with a future
result-editing feature instead of being partially exposed here.

The current-move marker uses OrcaSlicer's `SequentialView::Marker` hotend
model: the selected printer's shipped vendor `hotend_model` is preferred,
with the exact `resources/profiles/hotend.stl` model as deterministic
fallback. Both are read directly from the existing profile-resource archives:
the vendor machine JSON is the authoritative `vendor_id`/`model` to
`hotend_model` mapping, and no preview asset or duplicate hotend manifest is
staged. The renderer fetches only the selected vendor archive, or the core
archive when falling back, and extracts only the machine metadata and selected
STL in memory. The asset is loaded on demand and rendered with Orca's 0.5 mm
Z offset, bounding-box-height translation, 180-degree X rotation,
translucent white material, and depth-tested model rendering. It is anchored
at the selected move endpoint and hidden when the visible range reaches the
final enabled layer and move. User-provided external hotend assets remain
future work.

## Data-source boundary

Initially the preview consumes only G-code produced by the application's
current completed slice result. No external `.gcode` import is implemented.

The shared preview pipeline consumes a source-neutral
`PreviewSource` abstraction. A future imported-G-code source must be able to
provide the same preview command stream, metadata, and lazily read text
without changing renderer or control semantics.

The canonical source remains `libslic3r`'s `GCodeProcessorResult`, which is
already used by the WASM bridge. The bridge, typed client, and Worker are the
only path to renderer data; the shared application never talks directly to the
Emscripten module.

## Preview data v2 contract

Layer count comes from the complete processed toolpath: maximum zero-based
layer ID plus one, or zero for an empty path. It must never use only the first
object's layer count; taller objects and raft/support offsets remain reachable.
Retain the two-height-object regression in both WASM variants.

Before validation/slicing, each native Print receives the active preset bundle's
Bambu-vendor identity, matching native Orca. A P1P cube must produce nonempty
layers/toolpath. Failure while generating the preview result must surface the
returned error instead of leaving a successful-looking slice and empty viewport.

The bridge provides explicit renderable segments. A segment records at least:

- start and end coordinates;
- layer id, per-layer movement order, and source G-code id;
- move type, extrusion role, extruder id, and colour-print id;
- extrusion width and height; and
- enough categorical information to separately filter extrusion features and
  travel moves.

The contract is structure-of-arrays typed binary data transferred through the
existing WASM heap and Worker boundary. It must not create a JSON object per
move or a React element per segment.

It reserves optional parallel numeric arrays for supported and future metrics: feedrate,
actual feedrate, volumetric flow, actual flow, fan speed, temperature, pressure
advance, acceleration, jerk, time, and layer duration. Result-level metadata
also reserves feature/extruder palettes, layer Z values and ranges, precomputed
per-feature statistics, and source-G-code line mapping. Optional data is
omitted when a source cannot provide it.

Full G-code text is not copied to the renderer during initial preview loading.
The typed source API retrieves text on demand in bounded chunks or line pages.

## Interaction and information architecture

### Layout

[Application Shell](Application%20Shell.md#detailed-workspace-presentation) owns
the current layout: a persistent resizable right Slice Info sidebar, a left
layer capsule, a bottom move capsule, and a workspace-level G-code text window.
Controls retain reachable drag and keyboard targets in short/narrow windows.

The layer slider controls the inclusive visible layer range. The upper active
layer is visually prominent; earlier visible layers are dimmed by default. The
move slider controls the inclusive movement range from the active layer's
implicit start through its current move end. Its single thumb is the current
inspection position and drives the nozzle marker.

Single-layer inspection keeps the layer control as a dual-thumb layer
range slider. Both thumbs move the active layer together, so the inclusive
range remains `[active layer, active layer]`; leaving single-layer inspection
restores the inclusive range from layer zero through the active layer.

### Filter and state semantics

Legend filters have Orca's hide semantics: disabling an extrusion feature or
material/tool removes those paths from the rendered result rather than only
reducing their opacity. Travel is an independent option category: its paths
use the native Travels colour and are controlled by the global travel toggle,
not by a preserved extrusion role or extrusion feature filter.

Filtering and legend items are scoped to the active colour scheme. For example,
Feature/Line Type filtering does not affect Filament/Tool filtering. Travel
visibility is global across colour schemes.

Display choices survive result invalidation and reslicing within the UI
session: colour scheme, feature/action filters, travel, dimming and single-layer
mode. New result bounds reset layer/move positions; retained single-layer mode
starts on the final layer. Navigation preserves the sidebar and text-window
state. These display choices are not cross-session preferences; sidebar size,
collapse state and text-window geometry use the explicit preferences defined
in Application Shell.

### Read-only navigation and G-code linking

No preview control modifies the slice result. In particular,
custom-G-code actions, pause insertion, and filament changes remain out of
scope.

The G-code window has two-way inspection navigation:

- Moving either slider or advancing the active move highlights the matching
  source line in the text window.
- Selecting a mappable source line updates the active layer and move end.

The 3D path itself is not pickable. Dense overlapping extrusion bands make
pointer picking imprecise and costly; deterministic slider and text navigation
are the supported ways to select a move.

### Current-move information

The native-style hotend marker follows the current move. Slice Info displays
available layer/Z, XYZ endpoint, move type, feature, tool, source line and
selected-scheme value. Missing fields are omitted; travel never inherits a
stale extrusion feature.

### Keyboard and theme behaviour

When the viewport, rather than a text input or other ordinary focusable control,
owns keyboard focus, preview supports the Orca-style inspection shortcuts:

- Up/Down adjust the active end of the layer range.
- Left/Right adjust the active move end.
- Shift or Ctrl accelerates range stepping.
- `L` toggles single-layer inspection.
- `C` toggles the G-code text window.

These shortcuts must not break text editing or standard Tab focus navigation.

All preview overlays, controls, legend states, and colour ramps
must adapt to the application's light and dark themes. Semantic feature colours
remain stable between themes; surface, text, inactive, and gradient supporting
colours adapt to maintain legibility.

## Renderer and performance policy

The implementation architecture for the GPU streaming/indexed-segment path is
recorded in [`G-code Preview GPU Streaming Renderer`](G-code%20Preview%20GPU%20Streaming%20Renderer.md).
That specification is an implementation refinement only: the behaviour and
performance goals below remain authoritative. Its accepted renderer is the
native Orca/libvgcode SegmentTemplate path; capability or context failures
leave the toolpath preview unavailable rather than selecting a second backend.

Toolpaths are GPU-rendered, camera-facing extrusion bands. Rotation, pan, and
zoom only update camera/render state and must never reconstruct or upload
toolpath entities. Layer ranges, the move end, legend filters, dimming, and
colour-scheme changes rebuild only selected page-local index streams,
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
- Native adaptations follow repository ownership: edit and commit Orca source
  in the native submodule, then update its pin deliberately; never add an Orca
  source patch or a second renderer-side interpretation of native state.

## Verification direction

Maintain contract tests for segment continuity,
layer and move indexes, palettes, optional metrics, and metadata; renderer
tests for range/filter/dimming semantics; and shared Web/Electron end-to-end
coverage for the delivered controls. Large-slice benchmarks must exercise the
chunking/adaptive-detail path and verify that camera navigation never triggers
a full path rebuild. The benchmark fixtures must cover the two minimum
performance baselines. Release verification continues to include the existing
unit, typecheck, serial/threaded WASM build and smoke, Web threaded/serial E2E,
and desktop E2E requirements.

The fixture suite must include feature-rich single-material and multi-material
reference slices as well as the ordinary and large performance cases. Fixture
identity must be documented before changing the bridge contract.

### Approved fixture plan

Maintain the following repository-owned fixtures:

- **Command matrix:** a small synthetic `PreviewSource` command stream covering
  every delivered feature, travel, layer/move boundaries, width/height variation,
  and each delivered core metric. It is the deterministic unit and renderer
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
  Filament/Tool palette and legend without requiring external G-code
  import.
- **Performance measurements:** representative 250,000- and 1,000,000-segment
  browser diagnostics, kept outside the normal unit-test and product bundles.

The fixture manifest records the native reference SHA, profile names/config,
camera pose, selected ranges, theme, browser viewport, expected command/segment
counts, and approved reference captures. Generated G-code and screenshots are
checked in only where they are needed for deterministic visual or text mapping
tests; otherwise a reproducible fixture-generation command is recorded.

## Delivered read-only analysis and source text

The completed slice result exposes a typed `PreviewAnalysis` alongside its
toolpath metadata. The analysis contains standard estimated time, total
filament length/weight/cost when the source provides the required filament
properties, and per-feature standard time and filament consumption. Missing
values are omitted; the bridge does not estimate or substitute them.

The worker-side client derives min/max ranges for every optional numeric
toolpath metric. A range is present only when the source supplied a matching,
finite metric array. This makes Feature/Tool, Speed, Volumetric Flow, Layer
Time, Temperature, and Fan schemes capability-driven without scanning data in
React or the renderer.

The preview exposes the seven initial read-only schemes: Feature / Line Type,
Filament / Tool, Speed, Volumetric Flow, Layer Time, Temperature, and Fan
Speed. Feature and Filament / Tool use active result palettes. Numeric schemes
use the active result range and the native libvgcode 11-color linear ramp;
schemes with unavailable data are not offered. Legend visibility is stored per
scheme and rebuilt as page-local selection indices, so changing a scheme or
filter does not rebuild the native static geometry/textures. Travel remains
the independent native Travels color and global visibility option in every
scheme. The bridge feature palette uses Orca's user-facing `ExtrusionRole`
display names for every standard role (including bottom surface, gap fill,
brim, support transition, prime tower, custom, and mixed); only an unknown
numeric role uses the explicit `Role N` fallback. Travel still resolves by
move type and is not affected by extrusion-role legend filters. The layer
slider owns a higher overlay stacking level than the
analysis card so its thumbs remain reachable when overlays are crowded.
Categorical preview colours use Orca's rendering adjustment: a colour whose
three RGB channels are all below 0.2 is displayed as neutral 0.2 gray. This
keeps black and near-black assigned filaments visible under toolpath lighting;
the legend uses the same displayed colour. Numeric range ramps and Travels
retain their native palette values.

The preview UI performs one canonical logical `moveOrders` derivation from the
bridge's raw per-segment order/source-id arrays (including coalesced arc
segments), then retains that array through the streaming planner and UI.
Validated contiguous `layerRanges` are reused by reference. Layer bounds use
those compact result-local ranges; the scrubber and marker therefore avoid
redundant full-path scans while preserving the metadata-free fallback used by
direct source fixtures.

The current slice result publishes `sourceText.available` and byte length
metadata without copying its full G-code into the initial preview payload.
`readTextChunk` reads the retained native G-code only when requested. Every
text read validates the complete plate/input/generation receipt under
[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md), non-negative integer offsets, and a maximum request length of 64 KiB;
requests past EOF are clamped to EOF. Returned bytes are aligned to UTF-8
code-point boundaries; at most three continuation bytes may be added at each
edge, so a 64 KiB request has an explicit 64 KiB + 6 byte response bound. The
typed client validates that bound before decoding and crossing the Worker
boundary. Invalid or stale requests fail without exposing a partial result.

The text window uses the seekable `readTextLines` path. The native result owner retains its cumulative
line-end byte offsets and returns at most 128 complete lines and 64 KiB per
page; the line-end table never crosses into the renderer. The UI keeps at most
six fixed line pages, requests the active page directly for late slider moves,
and centers the active row after that page resolves. Manual scrolling is
debounced by 160 ms after the last scroll event; only then are the visible
uncached page(s) requested, so continuous scrolling does not issue intermediate
page requests. Pending scroll loads are cancelled when the result changes or
the window unmounts, and stale page responses cannot populate a newer result.

The virtual text viewport maintains logical line coordinates independently of
its bounded physical scroll track. This keeps slider-selected lines visible
when a G-code file exceeds a browser engine's maximum layout/scroll coordinate;
only the small visible row window is positioned in physical CSS pixels.

The G-code text window is a separately persisted overlay. Its title bar can be dragged
to reposition it, and a visible bottom-right handle can resize it. Both
gestures use pointer capture and terminate safely on pointer up, cancel, lost
capture, or unmount. Position and size are clamped to the workspace overlay host; the
window keeps a usable header, text area, and footer through a 320x220 px
minimum and a 768x720 px maximum (also constrained by the workspace). The
Close button and text scrolling remain
independent of dragging, and the resize handle supports keyboard arrow
adjustment with an accessible label. The last geometry is restored once when
the window opens, clamped to the current workspace bounds, and saved only after a
pointer gesture or keyboard resize finishes. It uses the shared
`UserPreferences.ui.gcodeTextWindow` namespace; malformed or missing values
keep the default geometry.

The text window is a separately toggled, larger overlay (`C` while the preview
viewport owns focus, or its close button). It renders only a bounded visible
row window of plain text and highlights the active mapped source line. Slider
movement updates that highlight. The bottom move slider and the left layer
slider also consume vertical wheel steps while hovered: wheel-up advances and
wheel-down reverses the relevant move/end value, with values clamped to their
bounds. Every wheel event over the layer slider, including its start thumb and
the surrounding dark frame, adjusts the visible layer end; the start thumb
remains independently draggable and keyboard-controlled. In single-layer mode
wheel changes keep both layer bounds coupled. The wheel hit area includes the
entire surrounding dark frame, including its padding and labels, while remaining
isolated from the preview canvas. Wheel changes select the next existing
renderable layer ID, so sparse or stale layer data cannot land on an empty
layer. Selecting an exact mapped line moves the preview to
its layer and move;
an unmappable line uses the nearest preceding mapped move, while a line before
the first mapping leaves the inspection state
unchanged. A result-local source index is built once during slice-result
construction; ordered processor IDs are binary-searched without a duplicate
React-side map, so repeated opening and navigation are independent of full
path scans. Missing mapping or text metadata leaves the
window unavailable rather than fabricating source content. The view remains
read-only: no editing, pauses, filament changes, or external import actions.

Arc commands such as G2/G3 are one logical preview move even when the
processor tessellates them into several consecutive render segments sharing
one positive `gcode_id`. All segment geometry and per-segment metrics remain
available for rendering. Unmapped zero ids and distinct/non-consecutive source
ids remain separate moves, and layer boundaries always reset the move order.
