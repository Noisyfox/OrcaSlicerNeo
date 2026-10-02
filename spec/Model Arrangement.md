# Model Arrangement

**Date:** 2026-10-02

**Status:** Partially approved — operation scope, capacity behavior, plate rules,
and instance eligibility accepted; remaining design decisions under discussion.
Implementation has not started.

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
not change Arrange all into a selection-only command.

## Accepted plate rules and instance eligibility

### Imported plate locks

Do not add lock/unlock controls in this feature's initial scope. Continue to
preserve imported lock flags in project persistence, and honor them during
arrangement:

- Arrange all excludes locked plates as destinations and preserves their
  instances' plate-local arrangement.
- Arrange current plate refuses the operation when the current plate is locked.
- A plate-grid reflow may change a locked plate's world origin. Its instances
  follow that origin while retaining their plate-local transforms.

The absence of an unlock control does not cause an imported lock to be ignored.
This activates the existing stored lock metadata for arrangement, while leaving
lock/unlock controls deferred.

### Empty plates

Both arrangement operations retain all empty plates, including locked empty
plates and plates containing no printable instances. Only an explicit user
Delete plate operation removes them. Arrangement does not automatically recycle
plates after moving their instances elsewhere.

This follows Neo's existing empty-plate retention contract and deliberately
differs from native Orca's trailing-plate recycling during Arrange all.

### Arrange all candidates

Consider instances throughout the project, including those without plate
membership. Printable instances already parked outside the real plates are
eligible for another placement attempt, including instances parked by an earlier
arrangement. Imported locked-plate membership takes precedence and excludes the
instance from rearrangement.

### Arrange current plate candidates

Use authoritative native plate membership and the native instance bounding-box
intersection test. The scope predicate is exactly:

```text
belongs_to_current_plate
OR (instance_box_intersects_current_plate AND has_no_plate_membership)
```

Consequently:

| Existing membership | Intersects current plate | Included in operation scope |
| --- | --- | --- |
| Current plate | Either | Yes, including out-of-bounds members |
| Another plate | Either | No |
| No plate | Yes | Yes |
| No plate | No | No |

The current plate must also be unlocked. An instance belonging to another plate
is never collected by this operation merely because its bounding box extends
into the current plate, regardless of whether that other plate is locked.
After scope collection, apply the printable/non-printable handling below and
the accepted placement-failure policy.

This narrows Orca's `belongs_to_current_plate OR intersects_current_plate`
predicate to avoid taking instances from another plate.

### Instances marked non-printable

An instance whose user-controlled printable flag is false does not participate
in packing and is not a fixed obstacle for the other candidates. If it is in
the operation scope and not protected by locked-plate membership, move it to the
outside-plate parking area when arrangement completes. Preserve its
non-printable flag.

This follows Orca's handling of non-printable instances. It is distinct from a
printable instance that the arrangement algorithm cannot place: both may end up
parked, but arrangement must preserve their different printable flags.

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
- `ArrangeJob::prepare_all()` traverses the whole model, including instances
  without a real-plate assignment, and separates printable, non-printable, and
  locked instances. Finalization parks non-printable instances.
- `ArrangeJob::prepare_partplate()` uses plate membership or bounding-box
  intersection to collect candidates. Neo adds the no-existing-membership
  requirement to the intersection branch, as specified above.
- `PartPlateList::rebuild_plates_after_arrangement()` enables trailing-plate
  recycling for Arrange all, but not Arrange current plate. It scans backward,
  removes empty plates or those without printable instances, skips non-empty
  locked plates, stops at an ordinary non-empty plate, and retains the first
  plate. The empty/non-printable check precedes the lock check, so native Orca
  can recycle an empty locked plate. Neo retains these plates instead.

## Remaining design decisions

Resolve each related group before updating this specification again:

1. Material compatibility, prime-tower obstacles, and effective per-plate
   configuration.
2. Arrangement parameters and persistence, shared UI entry points, progress,
   cancellation, concurrent operations, and failure/commit semantics for both
   WASM variants.
3. Native parity targets, acceptance fixtures, performance expectations, and
   independently verifiable implementation stages.

This document is a peer of [Grand Plan](Grand%20Plan.md). Accepted design
decisions do not mark arrangement as delivered or complete any roadmap item.
