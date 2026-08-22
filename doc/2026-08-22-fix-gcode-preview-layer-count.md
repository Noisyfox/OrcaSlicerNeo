# Fix G-code preview layer count for multi-height plates

2026-08-22

## Problem

With two objects of different heights on the same plate, the G-code path
preview after slicing stopped at the top of the shorter object; layers that
only existed in the taller object were unreachable in the layer scrubber.

`orc_get_slice_result()` reported the layer count as
`print.objects().front()->layers().size()` — the first object's own sliced
layer count. When the first object was the shorter one, the client's
`layers`/`maxLayer` capped the preview at that object's height even though the
toolpath buffers (built from `GCodeProcessorResult.moves` in G-code order)
contained vertices for every layer of the whole plate, including the taller
object's extra layers.

## Fix

Derive the reported layer count from the toolpath itself instead of from the
first object:

- `bridge_buffers.hpp`: `ToolpathBuffers` gains a `layerCount` field.
- `bridge_buffers.cpp`: `build_toolpath()` tracks the maximum 0-based layer id
  seen across the moves and stores `max_layer_id + 1` (0 when no toolpath
  vertices were produced).
- `bridge.cpp`: `orc_get_slice_result()` reports `tp.layerCount`, matching the
  mock contract where `layers` is the number of layers whose ids appear in the
  toolpath (`layer_id` is 0-based at the pinned SHA).

This keeps the preview scrubber in sync with the actual G-code content and
also covers raft/support layer offsets, where gcode layer ids can exceed an
object's `layers().size()`.

## Verification

- `pnpm typecheck`, `pnpm test` for the shared packages.
- `scripts/build-windows.bat quick` rebuilt both wasm64 variants
  (threaded + serial) from the changed sources.
- Two-object repro (20 mm cube added first, then a 40 mm box, layer height
  0.2): both variants report `layers=200` (max toolpath layer id 199 + 1)
  instead of the old first-object cap of 100; every layer id in the toolpath
  buffer is `< layers`.
- `scripts/build-windows.bat smoke` (run-slice + bridge-smoke against both
  variants) passes.
