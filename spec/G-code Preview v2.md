# G-code Preview v2

**Status:** Living major design specification — foundation decisions accepted;
interaction and information-architecture decisions remain in discovery.

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
- a bottom, dual-thumb move-range control for the selected layer;
- default Feature/Line Type colouring, a feature legend with visibility
  filtering, and a travel visibility control;
- explicit, continuous toolpath segments rather than implicit pairs of move
  endpoints;
- true extrusion-band rendering, based on each segment's width and height,
  rather than fixed-width screen-space lines;
- Orca-style inspection emphasis: the current upper layer is prominent and
  earlier visible layers are dimmed by default, with this as a persistable
  preview preference;
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

## Renderer and performance policy

Toolpaths are GPU-rendered, camera-facing extrusion bands. Rotation, pan, and
zoom only update camera uniforms and must never reconstruct toolpath geometry.
Layer/move ranges, legend filters, dimming, and colour-scheme changes should
normally update shader uniforms or prebuilt buffer visibility, not rebuild the
complete scene.

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
a full path rebuild.

