# Filament vector editor

**Status:** Implementation
**Date:** 2026-09-24

Governing inputs: [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md),
[Preset Editor Dialog](../spec/Preset%20Editor%20Dialog.md), and
[testing guidelines](testing_guidelines.md).

## Accepted design

Native option storage types remain unchanged. Ordinary Filament vector fields
are edited as individual elements (default native index zero, never rack slot
index), matching Orca ConfigOptionsGroup. Genuine lists and structured options
retain explicit specialized/read-only presentation. Native metadata supplies
element types, GUI semantics and nullable information; the renderer does not
split serialized vector strings or infer vector cardinality from delimiters.

The bridge projects editor values and implements element updates by cloning
one effective option, changing the selected element, and serializing the full
option into the existing sparse draft registry. Other elements are preserved.
Raw stored values remain available to current consumers. Editor projections are
derived response data and must not be added to history roots or 3MF files.
There is no cross-version internal protocol fallback. Existing full-option
mutation remains a distinct operation for current native clients; element
mutation has explicit intent and validates index/type/value natively.

Cover float, int, bool, string, percent, float-or-percent and enum elements,
including nullable values and native escaping for multiline text/G-code.
True lists (including compatibility lists), points/groups and multi-variant
options must not be silently truncated. Reset semantics retain the existing
field/category/preset contract; all mutations still create one history entry.
Shared canonical source ownership, slot actual colours and native config
assembly remain unchanged. No pinned submodule changes.

The UI retains the existing desktop layout and uses existing shared controls.
Mobile remains deferred. Additional work is per-option/per-editor projection,
not model geometry; benchmark response size and history cost before handoff.

## Sequential implementation and gates

Each step is assigned to a new implementation subagent. The subagent implements
and self-verifies, reports exact commands and results without committing. The
parent independently reviews and runs acceptance, then commits the accepted
step. No next step starts before acceptance. Corrections stay with that step's
agent until accepted.

1. Native projection, element mutation and strict typed-client contract.
   Tests: real native metadata, element preservation, invalid inputs, escaping,
   nullable/percent/enum semantics, source isolation, history and persistence.
   Gate: affected package tests/typecheck, serial quick build and focused real
   WASM harness; parent independently exercises native element/history paths.
2. Shared preset editor consumes native bindings and scalar editor values.
   Tests: real vector-shaped metadata, numeric/bool/text/enum/nullable controls,
   source/effective display, resets, shared-source state and actual colour
   preservation. Gate: app tests/typecheck and focused Electron E2E; parent
   independently verifies representative fields through the real runtime.
3. Reusable real-WASM UI and complex-project performance qualification.
   Implement any remaining in-scope fixes revealed by acceptance. Test both
   build variants, primary real host path, repository tests/typecheck and
   complex project get/edit/reset/Undo/Redo. Record fixture/artifact hashes,
   sample counts, median/p95, response size and history memory indicators;
   keep private fixture and raw machine-local evidence outside git.
   Gate: parent independently reruns the performance probe and reviews history
   storage/restore to confirm projections do not duplicate snapshot state.

Baseline: `%TEMP%/orca-preset-perf/final-serial.json` and scripts, prior serial
artifact hash `3e4db847481e6256c7220b7ead7b9fa13aeceee9d104dfaa6fe475fb2ec723fd`.
Odyssey fixture: 45,586,816 bytes, 14 objects/instances, 11 plates; SHA256
`6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`.
Path: `E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf`.

## Acceptance record

- Step 1: pending.
- Step 2: not started.
- Step 3: not started.
