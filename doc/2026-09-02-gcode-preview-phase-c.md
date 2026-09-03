# G-code Preview Phase C foundation

**Date:** 2026-09-02

**Status:** Implemented C1/C2/C3/C4 read-only preview increment; Orca hotend marker override delivered

**Scope:** Read-only preview analysis data, source-neutral contract, core
analysis schemes, native color ramps, scheme-scoped legend filtering,
summary/per-feature statistics, and the current-move inspection card. C4 adds
lazy source-text inspection and bidirectional source-line navigation. External
G-code loading remains future work.

## Accepted behavior

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

The right-top overlay presents bridge-precomputed summary values and
per-feature standard time/filament rows. It does not scan toolpath segments
when opening or updating the panel. The current-move card follows the active
layer and move-end selection through the bridge-supplied layer intervals and
an in-range binary search, showing available
layer/Z, endpoint XYZ, move type, feature, filament/tool, mapped G-code line,
and selected-scheme value. Unknown or unavailable fields are omitted; travel
does not claim a stale extrusion feature. The card remains in the existing
right-top panel gutter, leaving the right layer slider and both thumbs
reachable.

The preview UI performs one canonical logical `moveOrders` derivation from the
bridge's raw per-segment order/source-id arrays (including coalesced arc
segments), then retains that array through the streaming planner and UI.
Validated contiguous `layerRanges` are reused by reference. Layer bounds use
those compact result-local ranges; the scrubber and marker therefore avoid
redundant full-path scans while preserving the metadata-free fallback used by
direct source fixtures.

`PreviewSource` is source-neutral: the current slice result is one source
kind, while a future external-G-code source can provide the same preview
result and an optional lazy text-chunk reader. No external source is
implemented; the current slice result's text window uses the typed Worker
client.

The current slice result publishes `sourceText.available` and byte length
metadata without copying its full G-code into the initial preview payload.
`readTextChunk({ resultId, offset, length })` reads from the result's MEMFS
G-code only when requested. The bridge validates a matching completed result
ID, non-negative integer offsets, and a maximum request length of 64 KiB;
requests past EOF are clamped to EOF. Returned bytes are aligned to UTF-8
code-point boundaries; at most three continuation bytes may be added at each
edge, so a 64 KiB request has an explicit 64 KiB + 6 byte response bound. The
typed client validates that bound before decoding and crossing the Worker
boundary. Invalid or stale requests fail without exposing a partial result.

The text window uses the seekable `readTextLines({ resultId, startLine,
lineCount })` path. The bridge retains only the current result's cumulative
line-end byte offsets and returns at most 128 complete lines and 64 KiB per
page; the line-end table never crosses into the renderer. The UI keeps at most
six fixed line pages, requests the active page directly for late slider moves,
and centers the active row after that page resolves. Manual scrolling is
debounced by 160 ms after the last scroll event; only then are the visible
uncached page(s) requested, so continuous scrolling does not issue intermediate
page requests. Pending scroll loads are cancelled when the result changes or
the window unmounts, and stale page responses cannot populate a newer result.

The G-code text window is a separately persisted overlay. Its title bar can be dragged
to reposition it, and a visible bottom-right handle can resize it. Both
gestures use pointer capture and terminate safely on pointer up, cancel, lost
capture, or unmount. Position and size are clamped to the viewport; the
window keeps a usable header, text area, and footer through a 320x220 px
minimum and a 768x720 px maximum (also constrained by the viewport). The
Close button and text scrolling remain
independent of dragging, and the resize handle supports keyboard arrow
adjustment with an accessible label. The last geometry is restored once when
the window opens, clamped to the current viewport, and saved only after a
pointer gesture or keyboard resize finishes. It uses the shared
`UserPreferences.ui.gcodeTextWindow` namespace; malformed or missing values
keep the default geometry.

The text window is a separately toggled, larger overlay (`C` while the preview
viewport owns focus, or its close button). It renders only a bounded visible
row window of plain text and highlights the active mapped source line. Slider
movement updates that highlight. The bottom move slider and the right layer
slider also consume vertical wheel steps while hovered: wheel-up advances and
wheel-down reverses the relevant move/end value, with values clamped to their
bounds. Every wheel event over the right slider, including its start thumb and
the surrounding dark frame, adjusts the visible layer end; the start thumb
remains independently draggable and keyboard-controlled. In single-layer mode
wheel changes keep both layer bounds coupled. The wheel hit area includes the
entire surrounding dark frame, including its padding and labels, while remaining
isolated from the preview canvas. Wheel changes select the next existing
renderable layer ID, so sparse or stale layer data cannot land on an empty
layer. Selecting an exact mapped line moves the
preview to its layer and move; an unmappable line uses the nearest preceding
  mapped move, while a line before the first mapping leaves the inspection state
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

The current-move marker follows OrcaSlicer's `SequentialView::Marker`: the
renderer resolves the selected printer's vendor `hotend_model` from the
machine JSON already contained in the existing vendor profile archive, and
otherwise reads the exact `resources/profiles/hotend.stl` entry from the core
archive. It requests only the needed profile archive and extracts only machine
metadata plus the selected STL in memory; no preview asset, hotend mapping
manifest, or duplicated model binary is staged. Rendering uses Orca's 0.5mm Z
offset, bounding-box-height translation, 180-degree X rotation, translucent
white material, and depth-tested model rendering. External/user hotend files
remain outside the current source scope.

## Source limitations

The pinned G-code processor provides authoritative normal-mode time and
filament statistics. Per-feature time is accumulated from processed moves;
per-feature filament length/weight comes from the processor's role usage
statistics. Per-feature cost is not exposed by the processor and is therefore
not synthesized. Stealth time remains intentionally absent from the shared
preview contract.
