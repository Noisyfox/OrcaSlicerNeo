# G-code Preview Phase C foundation

**Date:** 2026-09-02

**Status:** Implemented C1 foundation

**Scope:** Read-only preview analysis data and source-neutral contract. UI,
renderer changes, external G-code loading, and source-text retrieval remain
future work.

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

`PreviewSource` is source-neutral: the current slice result is one source
kind, while a future external-G-code source can provide the same preview
result and an optional lazy text-chunk reader. No external source or text
window is implemented in C1.

## Source limitations

The pinned G-code processor provides authoritative normal-mode time and
filament statistics. Per-feature time is accumulated from processed moves;
per-feature filament length/weight comes from the processor's role usage
statistics. Per-feature cost is not exposed by the processor and is therefore
not synthesized. Stealth time remains intentionally absent from the shared
preview contract.
