# Per-Plate Print Architecture

**Date:** 2026-09-15

**Status:** Draft — accepted decisions are recorded as each related discussion
group closes. Implementation must not begin until this specification is
approved as a whole.

**Scope:** Replace Neo's single reusable `BridgeState::print` with a headless,
per-plate print/result architecture equivalent in ownership and lifecycle to
OrcaSlicer's `PartPlateList` / `PartPlate` / `Print` design. This is a
headless WASM bridge refactor; it does not port the wxWidgets GUI and does not
modify the pinned `packages/slicer-wasm/cpp/` submodule.

## 1. Context

OrcaSlicer creates a `Print` and `GCodeResult` for every `PartPlate`. The
`PartPlateList` owns those runtime objects, while each `PartPlate` refers to
its corresponding `Print`. The references are explicitly not serialized.
Plate order, settings, membership, and other project state are serialized;
the runtime print graph is rebuilt after loading.

Neo currently has one reusable `BridgeState::print` and a data-only
`plate_session_plates` list. A plate operation or preview read may therefore
need to reconstruct a plate-local input model and reuse that one global Print.
This specification establishes independent invalidation and slice-result
boundaries for each plate.

## 2. Accepted Decisions: Result Lifecycle and Persistence Boundary

### 2.1 One runtime Print and result owner per plate

Neo will keep a runtime registry keyed by session-stable plate identity. Each
plate entry owns one `Print`, its `GCodeResult`/generated G-code metadata, and
its native core-result cache. Separately, a plate has a presentation state and
at most one transferable React rendering projection. A result remains
available when the user switches away from and returns to an unchanged plate.
An invalidating change affects only the plates whose slice inputs changed;
unaffected plate results remain available for preview and export.

This matches Orca's per-`PartPlate` `Print` and `GCodeResult` lifetime. The
registry is runtime-only: no native pointers, G-code, preview buffers, or
result caches are written to a project file or persisted user preference.

### 2.2 Current-plate Slice is retained

The existing primary Slice command continues to slice only the current plate.
It applies and processes the current plate's registry-owned Print, leaving
other valid plate results intact. A future explicit `Slice All Plates` command
may schedule every printable plate, but is outside this refactor.

The application never short-circuits an admitted Slice merely because that
plate currently has a matching result. Every admitted Slice runs the normal
`Print::apply()` / `Print::process()` request and the complete result-handling
pipeline. Native step state may skip calculation that is already current, but
it may not skip result collection, replacement, and preview publication. The
task always reaches an ordinary Slice terminal; a feasible success is
`completed`, and cancellation or execution failure is reported explicitly.
Section 2.16.1 defines the typed terminal reasons discovered before native
processing. There is no application-level `completed_no_work` shortcut.

`Print::empty()` is not a pre-click admissibility predicate. Unlike Orca, Neo
does not run a delayed background `apply` after each edit, so a registry
Print's object list may describe an earlier input state until the requested
Slice applies the current Model and configuration.

This retains Neo's current command semantics and matches Orca's plate-local
slice context: Orca selects the current `PartPlate`'s Print and result before
invoking its slicing process.

### 2.2.1 Slice applies the authoritative world-space Model directly

Neo follows Orca's input path: before Slice, the selected registry Print is
configured with its plate index and origin, then receives the authoritative
world-space `state().model` and that plate's effective configuration directly
through `Print::apply()`. The Slice path must not call
`make_current_plate_model()` or make another bridge-owned full-Model copy just
to filter a plate. The Print's plate context supplies the plate-local behavior
while retaining authoritative world-space transforms.

Membership is maintained incrementally by model and plate mutations. Slice
validates the target plate's current membership and input stamp, rather than
unconditionally rebuilding membership before every Slice. `Print::apply()`
still creates the Print-owned native input snapshot required by libslic3r and
thread isolation; it remains a named native profile cost. The eliminated cost
is the additional bridge-layer clone/filter pass, not a claim that a complex
slice can avoid all native input copying.

Prepare Prime Tower estimation remains outside this path. It uses membership
and a lightweight projection only; it must not invoke `Print::apply()` merely
to obtain a preview.

The real-project Slice profile must prove zero calls to the bridge-local
model-construction helper, exactly one selected registry Print `apply`, and
separate timing for input validation, native `Print::apply`, and
`Print::process`.

### 2.3 Stable plate IDs are session-only

The registry and Worker history use a stable plate ID only for the lifetime of
one loaded project session. A project load creates new IDs and fresh registry
entries with no retained result. Project persistence remains index/order based
and compatible with the existing Orca/BBS 3MF representation.

No Neo-specific persistent UUID is added. On save, the bridge materializes the
ordered plate configuration, prime-tower coordinate arrays, membership, and
custom G-code in the existing project format. On load, it reconstructs the
session mapping. This follows Orca's distinction between serialized plate
state and nonserialized Print references.

### 2.3.1 Project-load registry construction and replacement fence

After a project has been admitted for loading, Neo eagerly constructs one
empty runtime Print/result registry entry for every reconstructed plate. This
matches Orca's `rebuild_plates_after_deserialize()` behavior. Construction
creates only the Print/result containers and their plate association: it does
not clone a per-plate Model, call `Print::apply()`, recover unsaved runtime
results, or restore history. A first Slice still materializes the target
plate's input and applies it to that entry.

The first per-plate-Print delivery also does not restore a `gcode_file`
embedded in a 3MF into a plate result. Although Orca's
`PartPlateList::rebuild_plates_after_deserialize()` loads that persisted
G-code into the corresponding `PartPlate` result, Neo initially preserves the
project input only: every reconstructed plate starts presentation-invalid and
requires an explicit Slice before Preview or Export is available. Loading
embedded G-code is deferred as a later persistent-format compatibility feature,
not treated as an unsaved-runtime-state exception.

Replacing a whole project (open, new, or clear) is stricter than an ordinary
threaded edit. If a job is active, Neo first requests its cancellation and
waits for its terminal state and registry lease release. It then closes the
old project before parsing the requested project: release its runtime registry
and result leases, clear its Model, plate definitions, history, and
presentation state, and start a new empty project session. The new file is
then parsed directly into that fresh session, which eagerly constructs its
empty registry entries after its plates are reconstructed. The old and new
full registries therefore never coexist merely to let an obsolete job finish.

This deliberately follows Orca's user-visible replacement semantics:
`Plater::load_project()` calls `reset()` before `load_files()`. Consequently a
parse or load failure leaves Neo's new, empty project session rather than
reviving the closed project. The earlier atomic-old-project-preservation
proposal is not part of this design.

In serial wasm64, whole-project operations are restricted by the same runtime
and bridge admission gates as Slice; they create no deferred project-replace
queue. In threaded wasm64, the admitted whole-project replacement owns the
cancellation/fence sequence above. From admission until its success or failure
terminal state, it also
locks all native mutation, Undo/Redo, Slice, and Export operations with
`project_replacing`; only progress and camera/window navigation remain
available. Such edits would necessarily be discarded by the replacement and
therefore must never produce ambiguous history or a competing job. The old
slice task's terminal mailbox event is drained before the close/load event for
the new session, including when parsing subsequently fails.

### 2.4 Per-plate slice-input stamps and presentation validity

Every registry entry has an opaque, monotonic slice-input stamp. A plate result
is eligible for React preview or Export only when its presentation state is
`valid`, a native core result exists, and its completed-result stamp exactly
equals the plate's current input stamp. Presentation state is not ownership of
the native core cache: it controls publication to React and Export, while the
`Print` decides which of its own cached steps and data remain reusable. The
stamp is advanced by known native mutations rather than by serializing or
hashing the complete model.

- Instance/volume changes, transforms, printable state, or membership changes
  invalidate the owning plate; a cross-plate operation invalidates both source
  and destination.
- Per-plate settings, bed settings, Prime Tower position, and plate custom
  G-code invalidate only that plate.
- Printer, Process, filament-rack, flushing-matrix, and other shared slicing
  configuration invalidate every plate.
- Selection, camera state, current-plate selection, and Prepare-only Prime
  Tower proxy refresh do not invalidate a slice result.

This mirrors Orca's use of a plate-local `update_slice_result_valid_state()`
for local changes and `PartPlateList::invalid_all_slice_result()` for shared
changes. The stamp supplies the same rule without coupling validity to the GUI
objects.

### 2.4.1 Explicit Slice invalidates the React projection, not core output

An admitted explicit Slice changes a plate's result state from `valid` or
`invalid` to `slicing`, immediately invalidates and releases only the
Worker-to-React rendering payload and renderer typed-array/GPU projection. It
does **not** reset, free, or otherwise invalidate the registry Print's native
`GCodeResult`, generated G-code, or completed native steps. It also does
**not** advance that plate's input stamp: its inputs have not changed. The
task captures the existing input stamp at launch and may publish a fresh React
projection only if that stamp and its task identity still match at completion.
Success makes the state `valid`; cancellation or failure leaves it `invalid`
and does not automatically retransfer the retained core cache.

This is deliberately a result-lifecycle transition rather than a model
revision. Orca similarly has a separate `m_slice_result_valid` flag: setting
it false does not mutate model inputs. Neo likewise separates its presentation
invalidation from native Print ownership.

### 2.5 No proactive core-result eviction

Every per-plate Print, GCodeResult, generated G-code, and completed native
step cache remains resident until native processing itself replaces it, the
plate entry is destroyed, or the project session closes. Neo does not reset or
free those core objects merely because an input stamp advances or a React
projection becomes invalid, and it introduces no LRU in this refactor.

Orca likewise lets a plate retain its native G-code result and temporary
G-code path after `update_slice_result_valid_state(false)`. The host difference
is intentional: native Orca normally uses a filesystem path whereas Neo's
data resides in MEMFS/WASM memory. A memory budget, storage spill, or eviction
product policy requires a separate future specification.

If creation of a registry entry, Slice, or projection conversion cannot obtain
memory, Neo reports `out_of_memory` for that requesting operation. It does not
silently evict any other plate's core cache. A previously committed edit is not
rolled back merely because its later Slice cannot allocate; its presentation
remains invalid until a successful Slice. Explicit deletion, project close, or
a separately specified user-directed cache-management feature are the only
ways to release a retained plate core cache.

### 2.5.1 Memory attribution is a required profile output

The non-mock real-project profile records the WASM heap before and after each
relevant operation, per-plate native core-cache object counts and attributable
byte estimates, plus React typed-array and GPU projection byte counts. The
initial refactor establishes observability rather than an invented memory
ceiling; an OOM report must identify the layer and plate attribution available
at the failing allocation.

`Print::apply(global_model)` retains Orca's current copy semantics: each
per-plate `Print::m_model` has its own model/object/volume/instance/config
structure, while every copied `ModelVolume` shares its immutable
`TriangleMesh` and convex-hull `shared_ptr` with the authoritative model.
Thus the profile reports shared source-mesh bytes separately from each
plate's structural model-copy bytes and from its derived slice/G-code cache;
it must not attribute the same mesh bytes once per plate.

The instrumentation for this profile is compiled only into its dedicated,
non-mock profile build. In a normal production build, C++ preprocessor gates
and React/Worker compile-time constants must remove the instrumentation and
its runtime guard entirely. Profile modules may remain bundled only if their
production import path has no profile side effect. Existing unrelated test or
E2E hooks are not in scope for this refactor; this requirement governs all new
instrumentation introduced by it.

### 2.5.2 A committed input change invalidates only presentation

When a native mutation has committed successfully and advances a plate's
input stamp, Neo marks that plate's presentation state `invalid` and releases
its transferable Worker-to-React payload and renderer projection if it was
showing that plate. The retained core result becomes unpublishable because its
completed stamp no longer matches; the bridge does not reset or free it.
`Print::apply()` subsequently determines the minimal native invalidation for
the next Slice. Section 2.4.1 applies the same presentation release to an
explicit Slice without advancing input stamp.

This rule is applied only after the input mutation has committed. A rejected,
failed, or cancelled edit leaves the prior stamp and its valid result intact.
It is distinct from result eviction: Neo still never discards a result whose
completed stamp matches the current input stamp.

This follows Orca's ownership boundary. Orca's
`PartPlate::update_slice_result_valid_state(false)` only changes the plate
validity flag; its non-current plate movement path leaves that plate's
`GCodeProcessorResult` allocated. A later invalidating
`BackgroundSlicingProcess::apply()` may selectively change native state once
that Print is active. Tests must prove a failed edit preserves the old valid
projection, whereas a successful local edit releases only the edited plate's
React projection while retaining its core cache. They must separately prove
that explicit Slice clears even a stamp-matching old React projection at task
start, and that a failed or cancelled re-slice does not automatically
retransfer the retained core cache.

### 2.6 Add Plate follows Orca's layout-change gate

Adding a plate compares the old and new grid column counts. When the count is
unchanged, Neo creates only the new PlateDefinition and its empty registry
entry. It does not scan old membership, move an old instance, invalidate an
old plate result, or recompute an old plate's Prime Tower placement.

When the column count changes, Neo rebuilds membership before the operation
and translates only instances belonging to plates whose origin actually
changed. Only those plates receive new input stamps and become invalid. The
operation never calls `Print::apply` merely because the plate grid changed.

This is Orca's `create_plate()` policy: `update_all_plates_pos_and_size()` is
called only after a column-count change. Neo must not retain its current
unconditional all-plate Prime Tower normalization in this path.

### 2.6.1 Reorder preserves only origin-stable slice results

A plate reorder updates display order independently from stable plate identity.
If a plate's physical origin does not change, Neo retains its registry Print
and matching valid result without mutating that Print. If its origin changes,
Neo advances only that plate's input stamp and invalidates its result; an
active job for it is cancelled or discarded by stamp mismatch. Reorder and
column-count reflow never call `Print::apply()`; the new display index and
origin are written into the registry Print only immediately before its next
explicit Slice.

This intentionally follows Orca's conservative result-validity behavior for
plates whose origin changes, while avoiding its eager Print mutation during
layout work. Neo does not attempt to retain a result by proving that a
world-space translation plus a new origin yields byte-identical G-code. That
semantic optimization requires a separate specification.

The reorder integration test must distinguish unchanged from changed origins,
retain only the former results, invalidate only the latter, and show zero
`Print::apply` calls during the reordering operation.

### 2.7 Delete Plate parks models, then reflows only affected survivors

Deleting a nonempty plate moves its instances to the unprintable/parked area;
it does not delete the model or silently move it to a neighbouring printable
plate. When no job leases its registry entry, the deleted plate's Print,
result, and generated G-code are destroyed. Later plates whose physical origin
changes are reflowed and invalidated; unaffected plates retain their registry
entries and valid results.

In threaded wasm64, deleting the active-slice plate commits the persistent
deletion immediately and removes the plate from the live registry. It advances
the job's required stamp, requests cancellation, and transfers that exact
runtime-entry incarnation to a retired tombstone container. The job lease is
the sole owner permitted to access the tombstone Print until its terminal
state; it may never publish a result. Only then is the tombstone's Print,
result, and generated G-code destroyed.

Undo before that terminal state restores the plate definition with the same
session plate ID but creates a fresh live registry-entry incarnation. It must
never reuse the tombstone Print that the old job may still access. A model or
instance deletion from an active plate follows the same snapshot rule without
needing a tombstone: it commits the authoritative Model change, advances the
plate stamp, and requests cancellation, but does not apply to, mutate, or
destroy the running Print before that job terminates.

Orca's `PartPlateList::delete_plate()` immediately destroys the deleted
plate's Print. Neo intentionally differs for a pthread-held active Print, so
the history rule governing a subsequent Undo restoration is safe even while
the obsolete job drains.

### 2.8 Prime Tower coordinates are plate-local through layout reflow

Prime Tower X/Y are coordinates in a plate's local printable bed. A grid
origin change therefore does not move or recalculate an existing plate's tower
coordinate. Adding a plate initializes only that new plate's default X/Y
values, following Orca's new-plate default-position behaviour. This
initialization is constant-time: it must not inspect models, scan used slots,
or compute placement for an old plate.

At persistent 3MF and native-slice boundaries, the bridge materializes the
ordered X/Y arrays required by the existing project format. The runtime source
of truth remains the individual plate definitions.

### 2.9 History restores inputs, never a prior large slice result

An input-changing history operation restores the model, plate definitions,
membership, configuration, and slice-input stamps, but it never stores or
restores a `Print`, GCodeResult, G-code source, toolpath, or preview buffer in
a history frame. A plate invalidated by an operation remains invalid after an
Undo or Redo of that operation and must be sliced again. Plates not affected by
the operation retain their valid results.

This deliberately follows Neo's established Prime Tower history rule and
avoids retaining a second large result tree for every history node. It is also
consistent with Orca's split between serialized PartPlate state and its
nonserialized Print object: Orca may reconnect a still-resident temporary
result after rebuild, but ordinary history does not serialize a complete G-code
payload.

### 2.9.1 Transform drag is one final input transaction

Renderer drag frames are deliberately local presentation state. Pointer-down
captures only a read-only Worker revision and stable target-identity
reservation; it creates neither a native history transaction nor a slice-input
stamp change. Pointer-up validates that reservation, then commits the complete
final transform set atomically in exactly one object-granular history
transaction. Only this successful final commit advances the affected plate
stamps and, in threaded wasm64, requests cancellation of an affected active
job.

Escape, lost pointer capture, a stale reservation, or a failed final mutation
creates no history entry, does not cancel a job, and restores the renderer from
the Worker-authoritative projection. A completed drag creates exactly one Undo
entry. This gives Neo the one-action boundary of Orca's interactive Undo
snapshot while retaining Neo's receipt-based history rather than a full
snapshot.

The transform integration test must exercise multiple visual drag frames and
prove exactly one native transform mutation, one history entry, no stamp or
cancellation before pointer-up, and an authority reconcile on an aborted or
stale gesture.

### 2.10 Full history restore reconciles the runtime registry precisely

After a full-model restore, the bridge stages and validates the complete
persistent target state before committing the history cursor. It then
reconciles the runtime registry by session-stable plate ID and current
slice-input stamp:

- unchanged IDs with an already-valid matching stamp retain their Print and
  result;
- changed IDs, deleted IDs, and newly created IDs receive the appropriate
  invalidated, destroyed, or empty registry entry;
- a plate affected by the restored history action may not recover a retired
  historical result merely because an older stamp happens to match.

Retention is conditional on native pointer safety. An implementation must
prove that a retained Print has no stale pointer into a replaced
`state().model`; otherwise it recreates an empty invalidated entry. Registry
changes occur only after the persistent restore and history-cursor commit have
succeeded. A failure leaves the prior model, plate state, registry, valid
results, and history cursor unchanged.

### 2.11 History and slicing are stamp-safe

Serial and threaded artifacts have intentionally different active-slice
interaction rules. In serial mode, native Undo/Redo is disabled while a slice
is running. In threaded mode, an Undo/Redo affecting the active slice commits
the restored authoritative state immediately, advances its stamps, and then
requests asynchronous cancellation of the obsolete job. A history operation
that does not affect the active slice's plate does not cancel it. Every
completed slice publishes only when its start stamp still equals the current
plate stamp; a late completion after a cancellation or history change is
discarded.

This is the headless equivalent of Orca's background-process switch guard:
Orca does not switch its active PartPlate Print until the background process
can safely switch print context.

### 2.12 Renderer retains only the currently previewed plate projection

The Worker retains every plate's native core cache under the no-eviction rule,
but retains transferable rendering payloads only as needed for the currently
previewed plate. The renderer retains typed-array and GPU toolpath resources
only for that one plate. Switching to a presentation-valid plate requests a
fresh projection from its retained core result and rebuilds the one renderer
projection. Neo must not keep a second CPU/GPU toolpath copy for every plate.

If the explicitly activated preview plate is not presentation-valid or has no
result matching its current stamp, the renderer releases its prior toolpath
projection and shows the plate's empty "needs slicing" state. It must not
leave a different plate's toolpath visible as a fallback. The target plate's
native core cache remains retained but is not transferred or rendered.

This matches Orca's Preview binding, which is updated to the current
PartPlate's GCodeResult rather than drawing every plate result at once.

### 2.12.1 Slice completion and React projection have separate terminals

A Slice task reaches `completed` after native `Print::process()` and the
Worker-side result bridge are ready; the registry entry becomes
presentation-valid and Export may be reevaluated at that terminal. At the
same terminal, global slicing progress/busy state ends and its command gates
are released. React typed-array transfer and GPU construction occur
asynchronously afterward and do not keep the Print lease, slice task, or
global slice-job slot occupied. A projection failure may be retried from the
retained native cache without invalidating it or changing Export eligibility;
while it is pending, only the relevant Preview surface displays local loading
state rather than global slicing progress.

Every projection payload carries the source `slice_task_id`, `plate_id`, and
`input_stamp`. React assigns a renderer-local, monotonic `projection_epoch`
to each Preview activation or retry. It applies a payload only when all of the
following still match: the active `preview_plate_id`, a `valid` presentation
state, the current input stamp, and the latest local epoch. Otherwise it
discards the payload without native mutation. This token is deliberately local
rather than an `AsyncTaskId`: projection delivery is UI work and has no native
Print/task lifetime to manage.

The first implementation preserves Neo's existing transport shape. On demand,
the Worker copies the selected plate's bridge toolpath buffers out of the WASM
heap into ordinary `ArrayBuffer` instances, then posts those buffers to React
as transferables, so the Worker-to-React hop transfers ownership without a
second buffer copy. React never holds a view into WASM memory. This common
serial/threaded protocol deliberately avoids a `SharedArrayBuffer` view and
the additional core-result pin/heap-growth lifetime it would require. Profile
output distinguishes WASM-to-Worker extraction, Worker-to-React transfer, and
React/GPU construction costs.

Every result-facing bridge request—toolpath projection, G-code text paging,
and export—is explicitly addressed by `plate_id`, `input_stamp`, and that
plate's runtime-only `result_generation`. The generation increments only when
that entry completes a successful normal Slice. The bridge validates the
three-part receipt before and after extraction; a mismatch returns `stale`
and publishes no old data. A bare current Print or bare native `result_id` is
not a cross-plate API identity. Native result IDs may remain internal bridge
implementation details, but do not replace this receipt or persist in a
project file. Existing unscoped result APIs are removed in this refactor;
there are no internal compatibility wrappers, fallbacks, or aliases.

Result reads return a typed terminal state: `ok`, `stale`, `unavailable`, or
`failed`. `stale` is an expected asynchronous race and React silently drops
it; `unavailable` renders the target plate's needs-slicing state; only
`failed` reports a bridge or allocation error. No result read throws merely
because a concurrent edit, cancellation, or new Slice superseded its receipt.

Each entry owns its `GCodeProcessorResult` and an exclusive MEMFS temporary
G-code file, named by its stable plate ID and result generation. This mirrors
Orca's per-`PartPlate` `GCodeResult` and temporary G-code path: valid results
for multiple plates coexist, and Export/text paging read the target entry's
file without rerunning `Print::export_gcode()`. The file is runtime-only and
is never serialized into a project.

Result generations are immutable after publication. Projection, text paging,
and Export acquire a short result-generation lease. A successful replacement
publishes its new generation atomically; the prior result and its temporary
file remain only until their leases reach zero, then release. Deleting a plate
with a live result lease uses the same tombstone rule. Input invalidation alone
does not delete the retained core result or its G-code file.

### 2.13 Slice and Export target the selected current plate

The primary Slice command applies and processes only the selected current
plate. The primary Export command exports only that same plate and is enabled
only when its result stamp is valid. Selecting an unsliced or invalid plate
immediately disables Export; Neo must never export the most recently sliced
but no-longer-selected plate by accident. An invalid selected plate must not
fall back to another plate's result for either Preview or Export. Explicit
Slice All Plates and Export All Plates remain future commands.

Export is globally disabled while any slice job is active, in both wasm
variants. Threaded per-plate ownership deliberately does not create an
exception for exporting an unrelated valid plate while another plate slices:
there is no concurrent export task, result lease, or ambiguous snapshot
download in this refactor. Once the slice job reaches a terminal state, Export
is reevaluated solely from the selected plate's matching result stamp and
presentation state; it does not wait for React typed-array transfer or GPU
projection construction.

### 2.13.1 Save is an input-only operation

Threaded wasm64 permits Save Project while a slice job is active. The main
Worker captures one consistent snapshot of the authoritative Model, plate
definitions, and persistent configuration, then writes it using a one-slot
export arena. Save does not cancel the job, write history, change input stamps,
or serialize runtime Print/result/task state. Its own synchronous serialization
may temporarily occupy the main Worker; the edit-plus-Undo latency guarantee
does not apply while Save is in progress.

Serial wasm64 disables Save while slicing because its sole Worker cannot
respond until `Print::process()` returns. This follows Orca's distinction:
desktop Save remains available during background slicing, whereas operations
which replace or mutate the project are disabled.

### 2.14 Selected, active-slice, and preview plate identities are distinct

Neo maintains three explicit runtime identities when needed:

- `selected_plate_id` is the plate selected in Prepare and targeted by normal
  editing, Slice, and Export commands.
- `active_slice_plate_id` is the plate whose registry Print is currently in
  synchronous native processing.
- `preview_plate_id` is the one plate whose retained result is projected into
  renderer CPU/GPU resources.

In threaded mode, Prepare may select and edit another plate whose input does
not affect the active job. This follows Orca: it commits the plate selection
before checking whether its background process can switch Print, so the Prepare
selection may change while the active Print remains unchanged. During that
interval Preview and progress remain bound to `active_slice_plate_id`; no
Preview result or Print context is rebound. Completion or cancellation does
not retrospectively rebind Preview to a plate selected during the job: the
completion status and existing projection remain associated with the active
job plate. Only a subsequent explicit Preview activation binds the selected
plate's valid result (or its empty state).

In serial mode, all editing context is locked while slicing: the selected,
active-slice, and preview identities remain the active plate. The UI may keep
camera/navigation controls available, but it must not accept plate selection,
native mutation, configuration, history, Slice, or Export commands until the
slice reaches a terminal state.

Serial mode uses two admission gates for every restricted operation. The typed
runtime gate records the active serial-slice epoch before it dispatches Slice,
then rejects a restricted request immediately with `slice_busy` without
posting it to the occupied Worker. This is the gate which provides a prompt
answer: while synchronous `Print::process()` is running, the Worker cannot
receive another message and therefore cannot itself respond promptly.

The bridge is the second, authoritative gate. A restricted request carries the
runtime's observed terminal serial-slice epoch. When the Worker next receives
that request, the bridge accepts it only if no serial slice is active and the
epoch still equals its own terminal epoch; otherwise it returns `slice_busy`
without mutating state or creating a history entry. This rejects queued or
future bypassed requests that were admitted before a serial slice began but
were not executed until after it completed. UI disabling is a projection of
the runtime gate, not its sole enforcement mechanism.

### 2.15 Threaded jobs support asynchronous cancellation; serial jobs lock

Neo does not introduce a separate SliceJob Worker. In serial wasm64,
`Print::process()` remains synchronous on the sole stateful Worker, so every
editing command is disabled until it reaches a terminal state. This preserves
the same per-plate native Print/result registry without attempting to transfer
C++ objects between isolated WASM heaps.

In threaded wasm64, the bridge must run a frozen, registry-owned plate Print
on a dedicated Emscripten pthread in the same shared WASM memory. The main
Worker remains available to commit edits and history. An edit affecting the
active plate, or shared configuration, is **not** blocked by either serial
gate: it commits first, advances the required stamps, and asynchronously
requests cancellation through an atomic job signal. The job holds a shared
runtime-entry lease until it reaches a terminal state, so deletion or history
reconciliation cannot release its Print while it runs. Only a matching terminal
stamp may publish a result.

Before enabling this mode, implementation must prove that `Print::process()`
after `Print::apply()` does not read or mutate the authoritative model,
PresetBundle, or plate registry. This is a mandatory delivery gate, not a
fallback to serial locking for threaded builds.

### 2.15.1 Thread budget and generic asynchronous task identity

Threaded Neo keeps the production pthread pool at
`navigator.hardwareConcurrency`. The dedicated job pthread participates in the
same TBB arena as `Print::process()`; it does not reserve a speculative extra
`+1` worker. The stateful Worker never runs TBB work while a job is active: it
remains available for mutations, stamps, cancellation, and progress control.
The actual pool/arena sizing is a measured build decision, not a guessed one.
The threaded acceptance build must prove no pool starvation or deadlock, at
least two effective TBB threads on a multicore host, and the required 100 ms
edit-plus-Undo response while slicing.

Every asynchronous task receives an `AsyncTaskId` from one global runtime
generator, rather than from a slice-specific epoch. The ID is a non-reused,
monotonic 64-bit value for one WASM session; it is transmitted through JSON as
a decimal string and through a shared-memory mailbox as seqlock-protected
high/low `uint32` fields. It is not serialized into a project file.

Each task record contains `task_id`, `kind`, lifecycle state, and task-specific
context. Slice records additionally carry `plate_id` and the runtime-entry
incarnation; `slice-input stamp` remains a separate result-publication
validity test. The initial kinds are `slice` and `project-load`; the generator
and task-message envelope are intentionally shared by later asynchronous
operations such as export or analysis.

Threaded progress messages include the full task identity. A writer may update
the foreground mailbox only while its task is still active, and the runtime
renders a progress update only when its `task_id`, kind, plate identity, and
entry incarnation match the active task record. A task-terminal bridge event,
not a progress snapshot, is authoritative for completion, cancellation, and
result publication. React projection delivery is not a Worker asynchronous
task: it does not receive its own `AsyncTaskId`, own a Print, or prolong a
slice task's native lifetime.

`AsyncTaskMailbox` is the common C++-owned, mutex-protected FIFO for all
asynchronous task messages, including progress, completion, cancellation, and
error. Every record has a global monotonic sequence and is consumed exactly
once in order; no progress message is overwritten or coalesced. Its public
operations and the resulting Worker-to-React message protocol are identical
in both WASM variants. The existing shared mailbox storage becomes the
threaded implementation's internal wake mechanism, carrying an independent
sequence which tells the Worker to drain the FIFO. It is no longer interpreted
as a latest-progress snapshot for task lifecycle purposes.

The queue starts with a deliberately large fixed capacity. If it fills,
producers apply backpressure until the Worker consumes messages; they never
overwrite or drop a record. The dedicated profile build records message count,
byte count, high-water mark, and backpressure count, while those measurements
and their guards are compiled out of production. Capacity is revisited only
from real-project profile evidence.

`AsyncTaskMailbox` hides its notifier internally. In serial wasm64 it invokes
the registered bridge callback after enqueue; in threaded wasm64 it increments
the shared wake sequence because pthreads never call JS. In both cases the
mailbox drains the same FIFO into the same ordered typed Worker-to-React
messages, including `task-terminal`. No runtime, client, or React caller
branches on the WASM mode to consume task messages.

### 2.16 One global job; explicit Slice replaces it

Neo permits at most one active slice job across all plates, in both wasm
variants. Per-plate Print ownership does not imply concurrent slicing of those
Prints. This follows Orca's single `BackgroundSlicingProcess`: it has one
current Print, does not switch it while `STATE_RUNNING`, and cancels the
existing work instead of running a second process.

In threaded wasm64, an explicit Slice for another plate requests cancellation
of the active job and records one pending explicit replacement. Repeated
explicit Slice requests replace that pending request, so the last one wins and
the system never forms an unbounded queue. The replacement captures its input
stamp only when it actually starts; if its plate has been deleted or its input
has become unsliceable while it waited, it is discarded with a clear terminal
status. Once it starts, it follows the full Slice and result lifecycle in
Sections 2.2 and 2.4.1 even if that plate previously had a stamp-matching
result; native calculation may skip current steps, but result processing and
publication still run. An edit must never enqueue a replacement Slice
automatically.

In serial wasm64, Slice is one of the restricted operations rejected by the
runtime and bridge admission gates while the sole job runs; it creates no
pending replacement.

### 2.16.1 Slice materializes native feasibility inside its task

Before allocating a Slice task, Neo performs only cheap structural admission:
the selected plate must exist and the runtime must not be blocked by the
serial busy or project-replacement gates. Once admitted, the task first marks
the React projection `slicing`, binds the target registry Print, and executes
`Print::apply()` against the current Model and effective configuration. It
then evaluates the resulting `Print::empty()` state and native `validate()`
result before entering `Print::process()`.

An empty Print or no printable instance ends that already-created task as
`not_sliceable`; a user-correctable `validate()` error ends it as
`invalid_input`; allocation failure and unexpected native exceptions end it as
`out_of_memory` or `failed`. These terminals release the global slice-job slot
and leave the React presentation invalid, but do not reset the retained native
core cache. Only a feasible task continues to native processing and the normal
result pipeline. This mirrors Orca's ordering—its
`update_background_process()` applies first and
`BackgroundSlicingProcess::start()` then reads `Print::empty()`—while placing
both steps in Neo's explicit Slice task.

### 2.17 Cancellation policy and acceptance boundary

Serial wasm64 exposes no Cancel command. Synchronous `Print::process()` owns
the sole Worker and cannot receive a JavaScript-to-WASM cancel call before it
returns; terminating that Worker would also discard the runtime registry,
history, and project state. The serial UI therefore waits for the job's normal
terminal state and the bridge rejects any bypassed cancel request without
altering state.

Threaded wasm64 Cancel affects only the active global job. It writes an atomic
cancellation signal, does not change inputs or history, does not automatically
start a replacement, and reports the eventual cancelled terminal state. An
explicit Slice replacement is the only cancellation path that may subsequently
start another job.

The automated job tests must prove all of the following: serial Slice attempts
and cancel bypasses do not form a queue; threaded repeated explicit Slice
requests retain only the last replacement; normal edits do not create a
replacement; and cancel neither creates history nor mutates input stamps.

### 2.18 Slice admission acceptance boundary

The serial automated test must hold a real slice in progress and show that a
restricted runtime operation rejects with `slice_busy` before that slice
reaches a terminal state. It must also prove that no request reaches native
mutation or history creation. A queued stale request with an older terminal
epoch must be rejected by the bridge after the slice finishes.

The Slice-feasibility test must begin with a registry Print whose cached
`empty()` state is stale relative to a newly edited Model. It must prove that
Neo admits the task, executes and profiles `Print::apply()` first, then emits
the appropriate `not_sliceable`, `invalid_input`, `out_of_memory`, or `failed`
terminal without entering `Print::process()` when native feasibility fails.
It must also prove that no empty-Print conclusion is made from the pre-click
cache alone.

The threaded real-Electron test, using the non-mock staged `u1.3mf` Odyssey
fixture, must start a slice and then edit the active plate or shared settings.
The edit and its matching Undo entry must appear within 100 ms; it must not
return `slice_busy`. The active job must be cancelled or have its result
discarded by stamp mismatch, and it must never publish stale output.

The threaded native lifecycle test must pause an active job, delete its plate,
and then complete or cancel that job under memory-safety instrumentation. It
must prove no use-after-free and no result publication. A second case must Undo
the deletion before the old job terminates and prove the restored live entry is
a distinct incarnation; only the old tombstone is released at the old job's
terminal state.

The threaded task-message test must prove global `AsyncTaskId` non-reuse and
that a late progress message for a cancelled/replaced task cannot update the
new active task's progress or terminal status.

The explicit-Slice lifecycle test must begin with a visible result whose stamp
matches unchanged inputs. It must prove that Slice immediately clears only the
React payload and renderer projection, leaves the native Print/result cache
available for incremental core processing, and leaves the input stamp
unchanged. The task must still execute normal result-bridge handling. Its
success may publish a fresh React projection; its failure or cancellation must
leave the plate presentation-invalid without automatically reusing the retained
core cache.

The projection-delivery test must delay an old payload behind a newer Preview
activation, input change, or retry. It must prove that React discards the old
payload by plate, stamp, presentation-state, and local epoch checks, while the
Worker keeps the native cache and the completed Slice task has already released
its job slot.

The UI result-boundary test must prove that a successful Slice ends global
slicing progress and restores Export eligibility before an intentionally
delayed current-plate projection finishes. During that delay, only Preview may
show local projection-loading state; Slice controls and Export must not remain
blocked by renderer work.

### 2.19 Real-project performance acceptance boundary

Performance acceptance uses the real non-mock, rebuilt-and-staged Electron
application and the fixture
`E:\OneDrive\Dokumente\3d打印\模型\奥德赛\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf`.
Every profile reports the complete click-to-visible-Undo wall time, JavaScript
time, JS-to-WASM transport time, and named native bridge stages; an aggregate
time alone is insufficient.

- An Add Plate operation that does not change the grid column count must show
  its Undo entry within 100 ms. Its profile must prove zero old-plate
  `Print::apply` calls, Prime Tower estimates, used-slot scans, coordinate
  write-backs, and position changes.
- A full object drag must show its one Undo entry within 100 ms after
  pointer-up, with exactly one transform/history mutation.
- A threaded object move affecting the active slice must also show its Undo
  entry within 100 ms; the obsolete task must cancel or fail its stamp check.
- An Add Plate operation which changes the grid column count has no invented
  fixed wall-time budget. Its profile must prove that only plates whose origin
  actually changes are moved, and that no plate receives `Print::apply` or an
  old-plate Prime Tower recomputation solely because of reflow.
- The same profile records WASM heap use, per-plate core-cache attribution, and
  React typed-array/GPU projection sizes before and after the exercised
  operations. It establishes no arbitrary memory ceiling, but an induced or
  observed allocation failure must report `out_of_memory` with available layer
  and plate attribution and must show no automatic cache eviction.

## 3. Constraints Carried Forward

- The React application continues to use the typed runtime/client boundary;
  only `packages/slicer-wasm/src/client` talks to Emscripten directly.
- The Worker remains the owner of model, plate, print, history, and derived
  result state. Renderer state is only a projection.
- Persistent project data retains existing 3MF compatibility requirements.
  The exemption from cross-version compatibility applies only to unsaved
  runtime state such as Print objects, result caches, and history receipts.
- Prime-tower Prepare proxies stay pre-slice estimates. Acquiring or updating
  a proxy must not call `Print::apply` merely to construct a preview.
- The previous sparse Move and Add Plate history receipts remain supported and
  follow the stamp, invalidation, and registry-reconciliation rules above.

## 4. Open Decision Groups

1. Typed client/UI result switching, export targeting, progress, cancellation,
   profiling, and acceptance gates.
