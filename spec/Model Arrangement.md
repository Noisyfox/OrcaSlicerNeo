# Model Arrangement

**Date:** 2026-10-02

**Status:** Partially approved — operation scope and capacity behavior accepted;
remaining design decisions under discussion. Implementation has not started.

**Scope:** Orca-compatible model arrangement in the shared Electron and Web
application. This is the living feature specification, maintained in batches
after related design questions have been resolved.

## Accepted implementation direction

Reuse OrcaSlicer's C++ arrangement core, vendored libnest2d, and NLopt through a
headless Neo adapter. Do not port the wxWidgets/OpenGL arrangement job or plate
GUI. The adapter prepares native arrangement inputs and applies results to the
authoritative native project state.

Follow the existing
[shared application architecture](Web-Electron%20Shared%20Application%20Architecture.md):
application code uses the runtime boundary; only the typed WASM client accesses
the Emscripten module. Arrangement runs off the renderer thread on both hosts.
The pinned `packages/slicer-wasm/cpp` submodule remains protected by repository
rules; required upstream adaptations use maintained patches or a deliberate,
documented submodule update.

WASM compilation, dependency compatibility, performance, and runtime task
behavior remain unverified. Choosing this direction does not authorize product
implementation before the remaining design decisions are resolved.

## Accepted operation scope

Provide two operations:

- **Arrange all:** rearrange eligible instances across plates. Existing plate
  membership does not constrain the destination. Automatically add plates when
  needed, subject to the total plate limit.
- **Arrange current plate:** arrange eligible instances in the current plate's
  printable area. Do not automatically add plates or distribute overflow to
  other printable plates. Preserve successful placements and move overflow to
  the native plate session's outside-plate parking area.

A selection-only operation is not included in this scope. Model selection does
not change Arrange all into a selection-only command. Detailed eligibility,
including locked plates, non-printable instances, and already parked instances,
will be specified in the next decision batch.

## Accepted capacity and partial-success behavior

- The total number of real plates must never exceed **36**, including locked
  plates.
- A model that cannot fit a single plate does not prevent other eligible models
  from being arranged. Apply successful placements, move the unplaceable model
  to the outside-plate parking area, and report the unsuccessful placement.
- Oversized geometry, excessive printing height, and degenerate footprints are
  examples of unsuccessful placement inputs. Arrangement does not automatically
  scale or split a model to make it fit.
- If Arrange all reaches the total plate limit and some instances still cannot
  be assigned, preserve successful placements and park the remaining instances
  outside the real plates. Explicitly report that the 36-plate limit has been
  reached; do not silently exceed the limit or roll back successful placements
  solely because of capacity overflow.
- Arrange current plate uses the same partial-success policy for overflow,
  without adding real plates.
- Parking retains the model in the project. It does not delete geometry or
  imply changing the instance's user-controlled printable flag. Membership and
  print-volume validity follow the native
  [multi-plate contract](Multi-Plate%20Support.md).

These decisions concern completed arrangement with unsuccessful placements.
Cancellation, geometry-processing exceptions, stale results, and commit
failures require a separate task/transaction policy and are not defined by this
partial-success rule.

## Native Orca reference behavior

The source reference is the repository's pinned Orca core. Product behavior is
traced through the actual job entry points rather than inferred from unused
helper functions.

- [ArrangeJob::prepare](../packages/slicer-wasm/cpp/src/slic3r/GUI/Jobs/ArrangeJob.cpp)
  dispatches its default state to `prepare_all()` and its plate-menu state to
  `prepare_partplate()`. The existing `prepare_selected()` helper is not called
  by this dispatch.
- [PartPlateList](../packages/slicer-wasm/cpp/src/slic3r/GUI/PartPlate.cpp)
  maps successful logical beds onto real plates and creates additional plates
  for Arrange all. `create_plate()` rejects creation at `MAX_PLATES_COUNT`.
  Current-plate postprocessing maps overflow to the outside-plate virtual
  position. General postprocessing also moves unarrangeable items there.
- [The libnest2d selection policy](../packages/slicer-wasm/cpp/deps_src/libnest2d/include/libnest2d/selections/firstfit.hpp)
  handles successful and unfit items separately; native job finalization does
  not roll back the whole arrangement merely because some items did not fit.
  Neo explicitly defines the total real-plate budget and the capacity diagnostic
  above, including the contribution of locked plates to that budget.
- `ArrangeJob::check_unprintable()` removes degenerate footprints and instances
  exceeding printable height from the movable set. Finalization sends those
  instances to a virtual outside-plate area while applying other results.

## Remaining design decisions

Resolve each related group before updating this specification again:

1. Plate locking, empty-plate retention/recycling, candidate eligibility,
   material compatibility, prime-tower obstacles, and effective per-plate
   configuration.
2. Arrangement parameters and persistence, shared UI entry points, progress,
   cancellation, concurrent operations, and failure/commit semantics for both
   WASM variants.
3. Native parity targets, acceptance fixtures, performance expectations, and
   independently verifiable implementation stages.

This document is a peer of [Grand Plan](Grand%20Plan.md). Accepted design
decisions do not mark arrangement as delivered or complete any roadmap item.
