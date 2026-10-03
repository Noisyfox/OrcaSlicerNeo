# Model Arrangement

**Date:** 2026-10-02

**Status:** Delivered 2026-10-02. Native arrangement, atomic history, task
coordination, and shared controls are implemented. Both production WASM
variants and the focused real Electron/Web acceptance journeys pass.

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

WASM compilation, dependency compatibility, and runtime task behavior must be
verified through the implementation gates below.

All application, runtime, typed-client, Worker, and native bridge components
ship together. New internal arrangement APIs require their complete current
contract: do not make fields optional or insert fallback values to accommodate
mixed component versions. Reject malformed requests, results, and menu state
at their receiving boundary. This does not remove defaults for missing data
in persisted user preferences or optional fields that represent actual domain
states, such as an instance without a plate assignment.

### Footprint geometry

Use Orca's native two-dimensional convex hull for each arrangement instance,
as prepared by `ModelInstance::get_arrange_polygon()`. Do not add concave
nesting or treat holes and concavities as available placement space. For
example, the open interior of a U-shaped footprint is occupied by its convex
hull for packing purposes.

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
Cancellation, geometry-processing exceptions, invalid results, and commit
failures follow the separate execution policy below. They do not use the
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

## Accepted interaction and execution behavior

### Entry points

The toolbar Arrange action opens the arrangement settings popup. Its Arrange
button executes Arrange all, and its Reset button uses the scope defined above.
Provide Arrange current plate through a separate plate-operation entry.
This follows Orca's entry-point organization.

Do not add the native `A` / `Shift+A` arrangement shortcuts in the initial scope.
Both operations remain available through their buttons.

### Progress and editing restrictions

Display progress while computing, without showing intermediate model layouts.
Apply the completed result once.

Disable all editing functions for the duration of the operation, including
model and plate edits, printing-configuration changes, arrangement-parameter
changes, and Undo/Redo. Do not admit another arrangement concurrently. Keep
camera orbit, pan, and zoom available for viewing the scene.

This is a uniform Neo editing restriction. Native Orca instead checks job
activity in individual actions and cancels jobs from some editing paths.

### Coordination with slicing

Do not start a new slice job while arrangement is running. The converse depends
on the runtime variant:

- Threaded WASM permits starting arrangement while an existing slice job runs.
  Computing an arrangement does not itself cancel that slice job.
- On successful arrangement application, object mutations use the existing
  affected-plate invalidation and cancellation mechanism. Request cancellation
  of an active slice job only if its plate is affected; unaffected jobs continue.
  Preserve the existing input-version and task-identity checks so stale output
  cannot publish as a current result.
- Serial WASM keeps arrangement disabled while slicing occupies the sole
  stateful Worker. Arrangement may start after slicing reaches a terminal state.

Follow the mutation lifecycle in
[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md). Do not cancel
all slicing eagerly on arrangement entry or replace this policy with symmetric
mutual exclusion. Supporting threaded slice and arrangement computation
concurrently is a requirement for the later task integration design.

### Atomic application and Undo

Apply model transforms, plate membership, automatically added plates, and
outside-plate parking as one atomic project change. A completed arrangement
that changes the project is one Undo step; Undo restores the project state
before that arrangement, including removal of plates created by it.

The accepted partial-success cases are completed arrangements and use the same
single application and Undo boundary. Do not publish an intermediate state
containing only some of their changes.

### Cancellation

Follow the existing runtime-variant cancellation policy in
[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md):

- Threaded WASM supports cancellation. A canceled arrangement discards its
  computed results and preserves the project state before arrangement.
- Serial WASM exposes no Cancel action in the initial scope. Wait for normal
  completion or failure; do not terminate the state-owning Worker to cancel.
- Cancellation does not add an Undo entry.

Native Orca supports cooperative cancellation through its background worker
and the arrangement stop callback. In Neo's serial runtime, synchronous native
computation occupies the sole stateful Worker, so a queued cancel call cannot
interrupt it. This scope does not introduce a separate arrangement Worker or a
yielding execution mechanism to provide serial cancellation.

### Failures

An algorithm exception, result-validation failure, or failure while applying
results abandons the entire arrangement. Preserve or restore the project state
before arrangement, report the failure, and do not add an Undo entry. Never
retain newly created plates or partially applied transforms from a failed
operation.

This includes geometry-processing exceptions. Native Orca reports its special
geometry exception and clears the exception marker before continuing through
finalization; Neo deliberately uses the uniform failure rule instead.

An oversized model, excessive height, an unusable footprint classified as an
unsuccessful placement, or exhaustion of the plate budget remains a normal
partial-success outcome as defined above. Distinguish those outcomes from an
exception that prevents the operation from producing a valid result.

## Accepted native-parity criteria

Use a fixed Orca version, matching inputs, and matching arrangement parameters
for comparison, accounting for the explicit Neo behavior differences in this
specification. Require matching rules and no unexplained material regression in
packing quality; do not require identical instance-by-instance layouts for
every complex case.

- For simple, stable fixtures, compare positions and rotation angles using
  numerical tolerances.
- For complex fixtures, verify the placement constraints and compare the number
  of plates needed and the number of instances that could not be placed. Account
  separately for Neo's deliberate retention of empty plates.
- Investigate material regressions rather than accepting any collision-free
  layout. Known native spacing, fitting, exclusion, and fallback semantics remain
  the reference instead of imposing stronger geometric rules in the tests.

Orca uses libnest2d/NLopt optimization with accuracy and parallel-execution
parameters. Cross-platform layout differences have not yet been measured;
this criterion does not assert that native and WASM results will differ. The
implemented fixtures and numerical tolerances are recorded in the acceptance
section below.

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
- `_render_arrange_menu()` supplies the Arrange and Reset buttons; the toolbar
  opens that menu. `Plater::select_plate_by_hover_id()` handles the separate
  current-plate arrangement entry. Native `A` / `Shift+A` shortcuts are deferred
  in Neo.
- `Plater::arrange()` takes an Arrange snapshot before starting the job.
  `ArrangeJob::process()` reports progress and checks the cancellation callback;
  `finalize()` applies the resulting arrangement after computation.
- Native `can_arrange()`, instance-count actions, and `can_undo()` / `can_redo()`
  require an idle UI worker. `Plater::priv::remove()` cancels jobs before deleting
  an object. Neo instead disables all editing during arrangement.
- `ArrangeJob::finalize()` skips application when canceled or when an exception
  remains. Its special `libnest2d::GeometryException` handler reports the error
  and clears the exception marker. Neo's uniform failure rule does not retain
  that special continuation behavior.
- `ArrangeJob::finalize()` applies object transforms, updates the scene, rebuilds
  plate relationships, and updates the current slicing context. Native
  `Plater::priv::restart_background_process()` refuses restart while a UI job is
  active; this alone does not imply that every existing slice job is canceled.
- [Model.cpp](../packages/slicer-wasm/cpp/src/libslic3r/Model.cpp) implements
  `ModelInstance::get_arrange_polygon()` using `ModelObject::convex_hull_2d()`.
  `Arrange.cpp` configures libnest2d accuracy and parallel execution; these are
  optimization settings rather than a definition of one unique final layout.

## Performance scope

Do not profile the native Orca arrangement algorithm or introduce a native
versus WASM performance benchmark or comparative timing gate in this scope.
Use native Orca for functional and packing-quality comparisons only. Validate
Neo's UI responsiveness, cancellation behavior, and successful task completion;
dedicated performance benchmarks and optimization are deferred.

## Implementation stages and delivery gates

Complete and verify each stage before advancing to the next. Keep independently
testable changes in separate commits and apply the repository's
[testing guidelines](../doc/testing_guidelines.md).

1. **Build feasibility:** integrate Arrange, libnest2d, and NLopt into the WASM
   scaffold. Build both threaded and serial variants and run a minimal real
   arrangement in each. Keep the pinned core protected and exclude GUI code.
   Compile the pinned NLopt release as an independent dependency, with separate
   serial and threaded wasm64 staging prefixes under `.work/deps`. The CI
   dependency job builds and caches both prefixes before either core build;
   the main CMake project only imports the staged headers and static archive.
   Include the dependency fetch/build scripts in the cache key so source,
   checksum, or build-option changes invalidate the cache.
2. **Headless adapter:** prepare native geometry and effective configuration,
   collect eligible instances and plate constraints, and solve without mutating
   the project. Verify geometry, materials, plate rules, and partial-success
   outcomes against the accepted behavior.
3. **Result application:** validate instance identities and results, apply the
   complete change atomically, and integrate native history and affected-plate
   tracking. Verify one-step Undo, failure rollback, and preserved state on
   cancellation or rejected results.
4. **Task coordination:** integrate progress, variant-specific cancellation,
   editing admission, and concurrent threaded slicing. Verify that computing an
   arrangement preserves an existing slice, application cancels only affected
   slicing, and obsolete task output cannot overwrite current state.
5. **Shared UI and acceptance:** connect the settings popup, plate action,
   preferences, progress, and diagnostics. Verify the complete user flow on
   Electron and Web, variant-specific behavior, and functional Orca parity.

Resolve concrete interface, fixture, tolerance, and control details within
these stages without weakening accepted behavior. Mobile input and mobile
qualification remain deferred under the shared desktop application scope.

This document is a peer of [Grand Plan](Grand%20Plan.md). Its arrangement item
is delivered; cut, measure, and orientation tools remain separate work.

## Implementation and acceptance record

All commands below passed on the Windows acceptance host. The initial delivery workspace
suite contains 1,345 passing tests, and all workspace typechecks pass. Parent
acceptance independently reran the native core/adapter executables, the serial
bridge smoke, and the real dual-host journey and reviewed the rendered output.

The native adapter lives in
[`HeadlessArrangement.cpp`](../packages/slicer-wasm/src/arrangement/HeadlessArrangement.cpp),
with task ownership and atomic publication in
[`bridge_arrangement.cpp`](../packages/slicer-wasm/src/bridge_arrangement.cpp).
Only frozen polygons and configuration reach the background solver. Final
publication updates transforms, plate membership, normalized estimated tower
coordinates, input revisions, and history together. Existing tower positions
remain fixed; failures restore the previous model, plate, and configuration
state. Unaffected threaded slice jobs continue through that publication.

The shared application exposes
[`ArrangementControls.tsx`](../packages/slicer-app/src/components/workspace/arrangement/ArrangementControls.tsx),
with host preference persistence in
[`useArrangementStore.ts`](../packages/slicer-app/src/stores/useArrangementStore.ts).
Editing is fenced at the rendered controls, menu, scene-interaction, project
mutation, and Worker request boundaries. Camera navigation remains available.

The reproducible acceptance commands, run from the repository root on Windows,
are below. The standalone CMake target builds require `emsdk_env.bat` in the
calling command environment; the acceptance host uses `D:\emsdk`.

```powershell
pnpm test
pnpm typecheck
cmd /c "call D:\emsdk\emsdk_env.bat >nul 2>&1 && cmake -S packages/slicer-wasm -B packages/slicer-wasm/.work/serial/build -DNEO_ARRANGEMENT_TEST=ON && cmake --build packages/slicer-wasm/.work/serial/build --target orca_slice -j 6"
node packages/slicer-wasm/harness/arrangement-smoke.mjs packages/slicer-wasm/.work/serial/build/orca_slice.js --test-injection
scripts\build-windows.bat quick --variant both -j 6
cmd /c "call D:\emsdk\emsdk_env.bat >nul 2>&1 && cmake --build packages\slicer-wasm\.work\serial\build --target arrangement_core_test headless_arrangement_test -j 4"
cmd /c "call D:\emsdk\emsdk_env.bat >nul 2>&1 && cmake --build packages\slicer-wasm\.work\threaded\build --target arrangement_core_test headless_arrangement_test -j 4"
node packages/slicer-wasm/.work/serial/build/arrangement_core_test.cjs
node packages/slicer-wasm/.work/serial/build/headless_arrangement_test.cjs
node packages/slicer-wasm/.work/threaded/build/arrangement_core_test.cjs
node packages/slicer-wasm/.work/threaded/build/headless_arrangement_test.cjs
node packages/slicer-wasm/harness/arrangement-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js
node packages/slicer-wasm/harness/arrangement-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js
node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js packages/slicer-wasm/fixtures/cube.stl
node scripts/run-arrangement-e2e.mjs
git diff --check
```

The native fixtures cover shared-bed packing, overflow, unusable inputs,
material subsets, current-plate scope, locks, the 36-plate budget, print
sequence, exclusions, tower estimation, and cancellation. The bridge fixture
adds rollback, one-step Undo/Redo including added plates and tower coordinates,
stale result rejection, and affected versus unaffected slicing.

`NEO_ARRANGEMENT_TEST` defaults to OFF and compiles fault-injection state and
execution paths only into the arrangement implementation file when enabled.
The explicit serial test build above exercises publication rollback; normal
smoke runs require the injection sentinel to be absent from the WASM binary
and clearly skip injected-failure assertions. CI tests the enabled build-tree
artifact separately and uploads only the production `out/serial` artifact.
Normal full and quick build drivers explicitly reset the gate to OFF before
building and staging, including when the same CMake cache previously enabled it.

The real Electron serial journey covers settings, reset, saved preferences,
both entry points, packing, Undo/Redo, and absence of Cancel during computation.
The real Web threaded journey covers completed packing, disabled editing,
responsive camera zoom, and cancellation with unchanged transforms/history.
Both use freshly staged artifacts; the runner verifies their hashes. The
20 mm cube checks allow 0.01 mm at bed/non-overlap boundaries and compare
restored transforms to five decimal places. Native polygon union checks use a
relative area tolerance of `1e-9`.

Functional parity evidence uses the pinned native Arrange implementation and
source-traced GUI preparation rules. Separate desktop-Orca GUI differential
testing, cross-platform layout comparison, mobile qualification, and native
performance profiling are not part of the recorded checks. The Linux CI
dependency-cache path is configured but requires execution by remote CI.

### Latest main integration (2026-10-03)

The remote default branch is `main`; there is no remote `master`. Merge commit
`fec2c857d72bd7fed7ff9310d385fadfa0858910` integrates main commit
`2f25b0fe00cd66c1b2361c62c2c64042f8f7649f` without conflicts. The merge preserves
the pinned Orca submodule and incorporates Electron's threaded NODEFS temporary
filesystem. No production arrangement adaptation was required.

After the merge, `pnpm test` passed all 1,370 tests and `pnpm typecheck` passed
across the workspace. The dual-variant quick build and both production
arrangement bridge smokes passed, including history, tower placement, threaded
cancellation, stale-result rejection, and affected/unaffected concurrent slicing.
The NODEFS bridge smoke passed against the freshly built threaded artifact.

The real Electron serial and Web threaded journeys passed with the existing
runner. The runner now also supports the following focused Electron threaded
journey, which passed with staged artifact hashes verified:

```powershell
node scripts/run-arrangement-e2e.mjs --desktop-only --desktop-threaded
node packages/slicer-wasm/harness/nodefs-bridge-smoke.mjs
```

Using that freshly built threaded Electron host, the NODEFS lifecycle E2E also
passed: Unicode/space-containing temporary paths, native G-code bytes and
preview, replacement results, project export/reopen, and session cleanup after
reload, utility-process failure, and normal quit.

```powershell
$env:ORCA_E2E_REAL='1'
$env:ORCA_E2E_NODEFS_EXPECT_VARIANT='threaded'
$env:ORCA_E2E_VISIBLE='1'
$env:CI='1'
pnpm --filter @orca/desktop exec playwright test e2e/nodefs-runtime.e2e.ts
```

The Electron journey verifies the same settings, packing, atomic history,
current-plate action, and saved preferences in both variants. It observes the
editing guard during computation and expects Cancel only in threaded mode.
The temporary-filesystem integration and its reproduction commands are defined
in [Native Python Plugin Architecture](Native%20Python%20Plugin%20Architecture.md).
