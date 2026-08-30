# Preset Compatibility Bridge Snapshot

**Date:** 2026-08-30
**Status:** Implemented bridge boundary; typed client/UI migration pending

## Purpose

`packages/slicer-wasm/src/bridge.cpp` now exposes a coherent FFF preset
snapshot for the compatibility picker defined in
`spec/Profile Compatibility and Preset Selection.md`. The bridge remains the
only application boundary that reads OrcaSlicer's `PresetBundle` compatibility
state; JavaScript must not recreate `compatible_printers`, condition, inherited
preset, parent-printer, or library-exclusion rules.

## API

`orc_get_preset_snapshot()` returns:

```json
{
  "ok": true,
  "printers": ["visible printer entries"],
  "prints": ["visible and compatible print entries"],
  "filaments": ["visible and compatible filament entries"],
  "printer": { "name": "...", "idx": 0 },
  "print": { "name": "...", "idx": 0 },
  "filament": { "name": "...", "idx": 0 }
}
```

Each entry preserves the existing preset entry fields (`name`, visibility,
default/selection state, and vendor/model/variant metadata). Candidate order
is the native `PresetCollection` order. `orc_get_presets(kind)` is deliberately
unchanged as a transitional per-kind read API.

A successful `orc_select_preset(kind, name)` now returns the same snapshot.
It rejects missing or invisible names for every kind and additionally rejects
incompatible print/filament names. Printer changes invoke native
`update_compatible(Always)`; print changes retain the validated print and
invoke `update_compatible(Never, Always)` so filament compatibility and native
fallback are resolved before the snapshot is created. Filament selection
returns a snapshot without a redundant compatibility pass.

## Verification

The real-WASM bridge smoke harness checks initial snapshot coherence, candidate
projection, rejected stale/unavailable process requests without state mutation,
and native printer-to-process-to-filament/process-to-filament selection paths.
It intentionally discovers suitable profiles from the installed profile set
instead of pinning vendor names. A deterministic compatibility profile fixture
remains a later verification task from the accepted specification.
