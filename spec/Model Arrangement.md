# Model Arrangement

**Date:** 2026-10-02

**Status:** Partially approved — operation scope, capacity, plate rules, instance
eligibility, material/printing constraints, and parameter/persistence rules
accepted. Interaction, execution, and acceptance decisions remain under
discussion. Implementation has not started.

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

## Accepted material and printing constraints

### Multiple materials on one plate

Expose **Allow multiple materials on same plate**, enabled by default, and
retain the native arrangement rules behind it.

- When enabled, different materials may share a plate subject to the native
  filament-temperature-category compatibility checks.
- Disabling the option does not split a multi-material instance or require
  exactly one filament slot per plate. Native packing accepts the first item
  even when it is multi-material. For subsequent items, it permits the item
  when its filament-slot set and the plate's already-packed aggregate set have
  a subset relationship in either direction. For example, `{1, 2}` and `{1}`
  may share a plate.
- Preserve these native semantics rather than replacing them with material
  name equality, slot-count limits, or a new compatibility rule in the UI.

### Prime tower reservation

Treat an existing prime tower as a fixed obstacle. Arrange moves models around
it and does not automatically move the tower's plate-local position.

For Arrange all, follow Orca's native tower-need detection and footprint
estimation when a tower is needed but no existing tower footprint is available.
This includes potential newly created plates. Reserve the estimated footprint
before packing models; do not rely solely on already generated slice output.

Orca's Arrange all tower preparation returns early when the prime tower is
disabled or the operation uses sequential/by-object printing. Preserve these
conditions rather than reserving speculative towers unconditionally.

### Global and plate-local print sequence

Support the native distinction between by-layer and by-object printing:

- Arrange all uses the global print sequence. Temporarily exclude plates whose
  effective print sequence differs from the global one, preserving their
  plate-local model arrangement and excluding them as destinations.
- This is operation-local exclusion. Do not change a plate's saved lock flag
  to represent it, and do not leave an imported unlocked plate locked afterward.
- Arrange current plate uses that plate's effective print sequence. If it
  differs from the global sequence, use automatic spacing for this operation,
  as Orca does; this does not overwrite the user's stored spacing preference.
- Imported explicit locks remain authoritative: the current-plate operation
  still refuses a locked plate.

### Bed exclusions and extrusion calibration area

Preserve the native distinction between mandatory exclusions and a preferred
clear area:

- Printer bed exclusion regions must be avoided.
- Wrapping-detection regions must be avoided when the corresponding detection
  feature is enabled.
- The extrusion calibration region is preferentially avoided. When native
  packing cannot place an item with that preference, its fallback may use the
  calibration region while retaining the mandatory exclusions and tower
  obstacles. Do not turn this preference into an unconditional no-placement
  region.
- Provide **Avoid extrusion calibration region** under Orca's applicability
  condition: a Bambu vendor configuration with `scan_first_layer` enabled.
  Keep the native conditional behavior of this option.

These are arrangement constraints; they do not change the existing slice-time
collision-warning policy in [Multi-Filament Support](Multi-Filament%20Support.md).

### Configuration of automatically added plates

Automatically created plates use an empty plate-local configuration override
layer and inherit the global configuration. Do not copy overrides from the
current plate or from a model's source plate, including bed type, print sequence,
or spiral-vase settings.

This matches native Orca and Neo's existing Add Plate contract in
[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md).

## Accepted parameters and preferences

### Parameter defaults

| Parameter | Default | Persistence scope |
| --- | --- | --- |
| Spacing | `0`, meaning automatic spacing | Separate by-layer and by-object values |
| Auto rotate for arrangement | Disabled | Separate by-layer and by-object values |
| Allow multiple materials on same plate | Enabled | Shared across both printing modes |
| Avoid extrusion calibration region | Enabled when the native applicability condition is met | Shared across both printing modes |
| Align to Y axis | Enabled for `printer_structure = I3`, otherwise disabled, subject to auto-rotation exclusion | No independent persistent preference |

### Spacing

Support both native automatic spacing (`0`) and manually requested non-negative
spacing in millimeters. Default to automatic spacing. Preserve the native
algorithm's inflation, fitting, support-related spacing, and sequential-print
clearance rules rather than interpreting the entered number as a replacement
for all native constraints.

Orca's spacing slider covers 0–100 mm, but its numeric input accepts larger
values. Neo must not introduce a 100 mm hard maximum. The exact controls and
layout remain part of the interaction design discussion.

The earlier current-plate print-sequence rule still applies: if the plate's
sequence differs from the global sequence, this operation uses automatic spacing
without changing the saved preference.

### Rotation and Y-axis alignment

Expose Auto rotate for arrangement, disabled by default. When enabled, the
native algorithm may change an instance's Z-axis rotation to improve packing;
it does not change X/Y orientation or scale as part of this option.

Also expose Align to Y axis. On printer selection/change and on Reset, derive
its value from `printer_structure`: enabled for I3, disabled for other or
unspecified structures. The user may adjust it during the session.

The options are mutually exclusive. Enabling auto-rotation turns Y alignment
off and disables its control. Y alignment can itself change Z-axis rotation
while auto-rotation is off; it is not a promise to preserve the original angle.
Preserve the native alignment algorithm's handling of shapes without a dominant
axis.

### Cross-session storage

Use the existing host-neutral preference boundary for Electron and Web to
persist spacing, auto-rotation, multiple-materials, and calibration-region
preferences across sessions. Keep spacing and auto-rotation separate for the
global by-layer and by-object printing modes; the other two use shared saved
values.

Do not persist the user's Y-alignment toggle independently. Printer changes and
Reset re-derive its value as above, and the auto-rotation exclusion remains in
force. These are application preferences, not new per-project printing settings.

### Reset

Provide Reset with the native scope:

- Restore spacing and auto-rotation defaults for the current global printing
  mode. Preserve the other mode's separately saved spacing and rotation.
- Restore the shared multiple-materials and calibration-region defaults,
  respecting the latter's applicability condition.
- Re-derive Y alignment from the current printer structure.

Reset does not reset both printing modes' independent preferences at once.

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
- [Arrange.cpp](../packages/slicer-wasm/cpp/src/libslic3r/Arrange.cpp) evaluates
  filament compatibility and the filament-slot subset rule.
  [GLCanvas3D](../packages/slicer-wasm/cpp/src/slic3r/GUI/GLCanvas3D.hpp) initializes
  the multiple-materials option to enabled.
- The free `get_wipetower_arrange_poly()` helper in the job source clears the
  setter to keep the tower fixed. `ArrangeJob::prepare_wipe_tower()` handles
  existing and estimated footprints and the disabled-tower/by-object early
  return.
- `ArrangeJob::prepare_all()` temporarily excludes plates with a different print
  sequence. `init_arrange_params()` selects the current plate's sequence and
  uses automatic spacing when it differs from the global sequence.
- `PartPlateList::preprocess_exclude_areas()` prepares mandatory bed and enabled
  wrapping-detection exclusions. `preprocess_nonprefered_areas()` prepares the
  calibration region; the job gates it by vendor, first-layer scanning, and
  the user's option. The libnest2d selection policy retries packing without
  the preferential region while retaining mandatory regions and prime towers.
- [GLCanvas3D.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/GLCanvas3D.cpp)
  contains `_render_arrange_menu()` and `load_arrange_settings()`, which define
  spacing input, parameter persistence keys, rotation/alignment exclusion, and
  Reset scope. Printer-preset selection in
  [Plater.cpp](../packages/slicer-wasm/cpp/src/slic3r/GUI/Plater.cpp) re-derives
  Y alignment from the printer structure.

## Remaining design decisions

Resolve each related group before updating this specification again:

1. Shared UI entry points and controls, progress, cancellation, concurrent
   operations, and failure/commit semantics for both WASM variants.
2. Native parity targets, effective-configuration mapping, acceptance fixtures,
   performance expectations, and independently verifiable implementation stages.

This document is a peer of [Grand Plan](Grand%20Plan.md). Accepted design
decisions do not mark arrangement as delivered or complete any roadmap item.
