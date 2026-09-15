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
its result-validity state. A result remains available when the user switches
away from and returns to an unchanged plate. An invalidating change affects
only the plates whose slice inputs changed; unaffected plate results remain
available for preview and export.

This matches Orca's per-`PartPlate` `Print` and `GCodeResult` lifetime. The
registry is runtime-only: no native pointers, G-code, preview buffers, or
result caches are written to a project file or persisted user preference.

### 2.2 Current-plate Slice is retained

The existing primary Slice command continues to slice only the current plate.
It applies and processes the current plate's registry-owned Print, leaving
other valid plate results intact. A future explicit `Slice All Plates` command
may schedule every printable plate, but is outside this refactor.

This retains Neo's current command semantics and matches Orca's plate-local
slice context: Orca selects the current `PartPlate`'s Print and result before
invoking its slicing process.

### 2.3 Stable plate IDs are session-only

The registry and Worker history use a stable plate ID only for the lifetime of
one loaded project session. A project load creates new IDs and an empty
registry. Project persistence remains index/order based and compatible with
the existing Orca/BBS 3MF representation.

No Neo-specific persistent UUID is added. On save, the bridge materializes the
ordered plate configuration, prime-tower coordinate arrays, membership, and
custom G-code in the existing project format. On load, it reconstructs the
session mapping. This follows Orca's distinction between serialized plate
state and nonserialized Print references.

### 2.4 Strict per-plate slice-input stamps

Every registry entry has an opaque, monotonic slice-input stamp. A plate result
is available only when its completed-result stamp exactly equals the plate's
current input stamp. The stamp is advanced by known native mutations rather
than by serializing or hashing the complete model.

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

### 2.5 No proactive result eviction

Every valid per-plate Print, GCodeResult, generated G-code, and Worker-side
preview source remains resident until it becomes invalid or the project
session closes. Neo does not introduce an LRU or silently discard a valid
plate result in this refactor.

Orca likewise retains a valid plate's result and its temporary G-code path.
The host difference is intentional: native Orca normally uses a filesystem
path whereas Neo's data resides in MEMFS/WASM memory. If a new slice cannot
allocate required memory, that slice operation fails explicitly and leaves all
previously valid plate results intact. A memory budget, storage spill, or
eviction product policy requires a separate future specification.

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

### 2.7 Delete Plate parks models, then reflows only affected survivors

Deleting a nonempty plate moves its instances to the unprintable/parked area;
it does not delete the model or silently move it to a neighbouring printable
plate. The deleted plate's registry entry, Print, result, and generated G-code
are destroyed. Later plates whose physical origin changes are reflowed and
invalidated; unaffected plates retain their registry entries and valid
results.

This follows Orca's `PartPlateList::delete_plate()` behaviour. The history
rule governing a subsequent Undo restoration of a deleted plate's prior result
is deliberately specified separately below.

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

The Worker retains every valid plate result under the no-eviction rule, but the
renderer retains typed-array and GPU toolpath resources only for the currently
previewed plate. Switching to a valid plate requests that plate's retained
Worker-side result and rebuilds the one renderer projection. Neo must not keep
a second CPU/GPU toolpath copy for every valid plate.

This matches Orca's Preview binding, which is updated to the current
PartPlate's GCodeResult rather than drawing every plate result at once.

### 2.13 Slice and Export target the selected current plate

The primary Slice command applies and processes only the selected current
plate. The primary Export command exports only that same plate and is enabled
only when its result stamp is valid. Selecting an unsliced or invalid plate
immediately disables Export; Neo must never export the most recently sliced
but no-longer-selected plate by accident. Explicit Slice All Plates and Export
All Plates remain future commands.

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
Preview result or Print context is rebound. After completion or cancellation,
the next Preview activation binds the selected plate's valid result.

In serial mode, all editing context is locked while slicing: the selected,
active-slice, and preview identities remain the active plate. The UI may keep
camera/navigation controls available, but it must not accept plate selection,
native mutation, configuration, history, Slice, or Export commands until the
slice reaches a terminal state.

### 2.15 Threaded jobs support asynchronous cancellation; serial jobs lock

Neo does not introduce a separate SliceJob Worker. In serial wasm64,
`Print::process()` remains synchronous on the sole stateful Worker, so every
editing command is disabled until it reaches a terminal state. This preserves
the same per-plate native Print/result registry without attempting to transfer
C++ objects between isolated WASM heaps.

In threaded wasm64, the bridge must run a frozen, registry-owned plate Print
on a dedicated Emscripten pthread in the same shared WASM memory. The main
Worker remains available to commit edits and history. An edit affecting the
active plate, or shared configuration, commits first, advances the required
stamps, and asynchronously requests cancellation through an atomic job signal.
The job holds a shared runtime-entry lease until it reaches a terminal state,
so deletion or history reconciliation cannot release its Print while it runs.
Only a matching terminal stamp may publish a result.

Before enabling this mode, implementation must prove that `Print::process()`
after `Print::apply()` does not read or mutate the authoritative model,
PresetBundle, or plate registry. If that proof fails, threaded mode falls back
to the serial locking rule for the affected operation.

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
