# Undo and Redo

**Date:** 2026-09-07
**Status:** Delivered and verified — implementation accepted 2026-09-08
**Branch:** `dev/undo-redo-design`

## 1. Goal

Add project-scoped Undo/Redo to the shared React application for both Electron
and Web. The feature must restore the model and the user-facing editing context
without treating global preferences as project history.

This is a major specification at the same level as `spec/Grand Plan.md`.
It extends the shared Web/Electron architecture and the delivered 3MF project
persistence contract.

## 2. Chosen Direction

History will be incremental and project scoped. It must not export and retain a
complete BBS 3MF archive for every edit: doing so duplicates large mesh payloads
and incurs native-buffer allocation, Worker transfer, and archive-compression
cost on every history entry.

Neo will adapt the wx-free object-history core of native OrcaSlicer into the
WASM Worker. The adapted core retains Orca's `ObjectID`-keyed version
intervals, serializes mutable model objects only when changed, and shares or
defers serialization of immutable mesh data. A small Neo `HistoryContext`
replaces the native GUI objects and is paired with each project history frame.
The current full native `UndoRedo.cpp` is not compiled as-is because its GUI
adaptation layer depends on wxWidgets, OpenGL canvas objects, and native
`PartPlateList`.

Derived slicing output (G-code, preview buffers, and print-processing state) is
not history. A restore invalidates it and follows the normal re-slice path.

## 3. Upstream OrcaSlicer Reference Boundary

Native OrcaSlicer provides an object-history stack in
`src/slic3r/Utils/UndoRedo.{hpp,cpp}`. Its snapshots preserve the `Model`, GUI
selection, `GLGizmosManager`, and `PartPlateList`; it does not generically
serialize `PresetBundle` or `AppConfig`. Upstream deduplicates/retains shared
model history rather than writing a complete project archive for each action.

Preset switching is outside that stack: `Tab::select_preset()` changes the
active preset through the preset bundle and application configuration without
taking a Plater undo snapshot. Object/plate/project configuration edits may be
snapshotted because they belong to project state. A special restore path reloads
an appropriate printer preset when a restored project changes printer
technology; it is not generic preset-selection history.

Neo follows that behavioural boundary while using its Worker/WASM and React
architecture rather than porting wxWidgets GUI classes.

### 3.1 Why the native source is adapted, not linked unchanged

The upstream algorithm itself does not need wxWidgets: its core saves mutable
objects through `ObjectID`-keyed cereal archives and tracks immutable meshes by
shared pointer and time interval. The source's GUI adapter does need wxWidgets:
one `take_snapshot` overload retrieves `PartPlateList` through
`GUI::wxGetApp().plater()`, while the snapshot API serializes native
`Selection`, `GLGizmosManager`, and `PartPlateList`. Those classes are coupled
to `GLCanvas3D`, wx events/timers, and native rendering resources.

The extraction boundary is therefore:

- retain/adapt the model object-history, interval, shared-mesh, serialization,
  restore, and eviction mechanisms in the Worker/WASM layer;
- replace native GUI object serialization with a Neo-owned `HistoryContext`;
- restore React selection/gizmo/plate projections through stable identities
  after the model is restored;
- keep the upstream wx GUI source out of the WASM target.

## 4. Accepted State Boundary

Each committed history frame includes:

- project/model state affected by the command;
- selection, expressed through stable object/part/instance identities and its
  selection mode;
- the currently active plate;
- the active gizmo type and any small, durable gizmo UI state required to
  restore the editing context;
- project-owned configuration overrides (object, part, or plate settings).

Selection, active plate, and gizmo values are sampled when a genuine project
mutation begins and completes. The mutation's predecessor and successor frames
therefore carry the editing context that existed on each side of that action.

Restore uses stable identities. If a referenced entity no longer exists, Neo
keeps the valid subset of the selection or clears it when no valid selection
remains.

The following are explicitly outside history:

- printer, process, and filament preset selection;
- global/system preferences and their persisted storage;
- opening or closing a gizmo as an isolated UI action;
- derived slicing and preview output.

Undo/Redo therefore does not restore historical global-preference snapshots.
When a restored project requires a compatible printing technology, normal
preset compatibility/loading may run, but this is not an attempt to restore a
historical global preset.

The approved multi-filament feature defines one narrow projection exception:
after an Undo/Redo restoration changes the current project's filament rack, Neo
writes that resulting rack as the selected printer's last-used default for
future new projects. The rack preference is not itself part of history and no
other global preference is changed. See
[`Multi-Filament Support.md`](Multi-Filament%20Support.md#103-per-printer-remembered-rack).

Project-owned overrides are canonical Worker `ProjectConfigOverlay` state,
scoped to the project, object, part, or plate as applicable. They are validated
against the selected base preset, participate in slicing and supported 3MF
project persistence, and are restored by history. A system preset switch
changes the base configuration but does not discard a valid project overlay.

## 5. History Granularity

History is transactional and semantic, matching upstream interaction behaviour:

- a discrete command (for example import, delete, rename, split, clone, or a
  numeric transform commit) creates one history entry;
- a pointer or gizmo drag opens a transaction at gesture start and commits one
  entry when it ends;
- intermediate drag frames never create entries;
- a cancelled gesture discards its transaction;
- an operation with no effective state change creates no entry;
- committing a new operation after Undo discards the redo branch.

Opening/closing a gizmo alone has no history entry. When Undo/Redo restores an
editing command, it restores that command's saved gizmo context only after any
active gesture has ended; restoration must not interrupt a drag in progress.

### 5.1 Editing context is attached to project mutations

Selection changes, clearing selection, active-plate switches, and isolated
gizmo open/close are renderer editing context only. They do not call the
history mutation API, create a history revision, move the cursor, mark the
project dirty, or discard a Redo branch.

The next genuine project mutation samples the then-current context. Its
`beforeContext` atomically refreshes the retained predecessor frame while its
`afterContext` accompanies the new project frame. Undo/Redo consequently
restores the context on the appropriate side of a real action without needing
standalone context records. After Undo, any number of context-only UI changes
leave Redo available; only a successfully committed project mutation creates a
new branch and truncates Redo.

Native Orca's `SnapshotType::Selection` and `!`-prefixed snapshots are not
copied here: although ordinary traversal/dirty handling may skip those records,
taking such a snapshot still truncates native Redo. Neo requires the stricter
non-mutating behaviour above.

### 5.2 Project replacement boundary

New Project, Open/replace Project, and Reload Project are hard history
boundaries. After the existing unsaved-changes confirmation succeeds, Neo
releases the entire prior history and its saved checkpoint; the loaded or new
project becomes a new clean baseline. Undo can never revive a replaced project.

Add Model remains an ordinary current-project action. Clear Scene is also an
ordinary, undoable action in the current project: it is semantically equivalent
to deleting all models, not to opening a new project.

This matches OrcaSlicer's `ProjectSeparator`, which clears its main history
stack before recording a new/reset/loaded project state.

### 5.3 Required command coverage

Every exposed project mutation must enter the single Neo history transaction
boundary. The initial release covers:

- body drag and all Move/Rotate/Scale gizmo, numeric-panel, Drop-to-Bed, and
  Reset transformations;
- Add Model, Add Cube/Handy Model, and Clear Scene;
- every current ObjectList structural action: rename, delete, clone, split,
  assemble, reorder, add/remove instance, part-type change, and printable
  change;
- multi-plate add/remove/reorder/lock actions and project-owned plate
  configuration; active-plate switching remains UI context only;
- object-, part-, and plate-owned temporary project-configuration overrides.

An unintegrated project mutation must not silently bypass history. It must be
connected to the transaction boundary before release or remain unavailable in
that release. This is stricter than native Orca's distributed manual
`take_snapshot()` call sites and prevents incomplete Undo/Redo coverage as the
shared application grows.

### 5.4 Setting-edit commit boundaries

Text and numeric controls keep an uncommitted local draft. Enter or focus loss
commits exactly one valid, effective `Change Option` transaction; Escape drops
the draft without changing project state. Boolean and enum controls commit one
transaction immediately. Future continuous controls use a begin/end gesture
transaction.

This prevents the current React `onChange` path from creating one Worker write
and history entry per typed character. It is a deliberate shared-app
coalescing policy; native Orca takes snapshots at individual configuration
change callbacks and relies on its controls to determine their cadence.

### 5.5 Future high-frequency gizmos

The Worker transaction API reserves `coalesce`/nested-transaction capability
for future painting, support-point, and similar high-frequency gizmos. Current
Move/Rotate/Scale operations use ordinary gesture transactions and do not
implement a separate gizmo history stack or UI. A future high-frequency gizmo
may append internal changes within one outer transaction and publish one final
semantic history entry, following Orca's `EnteringGizmo`/`GizmoAction`/
`LeavingGizmo` compaction intent.

The dormant implementation accepts an opt-in child transaction with
`{coalesce: true, parentTransactionId}`. A child commit publishes no entry;
the outer transaction remains the sole semantic history boundary. No paint or
support-point UI uses this path in the current release.

### 5.6 Save and crash-recovery boundary

Save and Save As retain the in-memory history and merely advance the saved
checkpoint. Users may Undo across a completed save, and dirty state is
recalculated relative to that checkpoint. New/Open/Reload remain the only
project-lifecycle actions that discard history.

History is never persisted to 3MF, host preferences, browser storage, or an
automatic-recovery file. Future crash recovery, if needed, is a separate,
latest-project 3MF-style autosave feature; it must not retain history frames,
mesh references, redo branches, selection/gizmo state, or field drafts.

## 6. Core Ownership and Atomicity

- The history core and every persisted `HistoryContext` are Worker/WASM-owned.
  React holds only the currently projected context and uncommitted gesture or
  field-draft state; it does not retain a parallel history, geometry, or model
  structure.
- The adapted core must preserve native Orca's object-version semantics rather
  than re-executing commands. Undo restores an existing object version; Redo
  restores its later version. This prevents restore results from drifting when
  operation implementations, indices, or compatibility state change.
- The core must retain the atomicity of a semantic command: an Undo or Redo
  applies the complete command frame, including its model and context state.

### 6.1 Worker transaction contract and code placement

The Worker exposes an explicit transaction contract:

```text
beginHistory(label, kind, beforeContext) -> transactionId
commitHistory(transactionId, afterContext) -> HistoryStatus
abortHistory(transactionId) -> RestoreResult
undoHistory() / redoHistory() -> RestoreResult
getHistoryStatus() -> HistoryStatus
jumpHistory(targetId) -> RestoreResult
```

There is no application operation for recording standalone selection or plate
context. Only project transactions update the retained timeline.

The shared TypeScript client exposes one `runProjectHistoryTransaction()`
entrypoint that serializes begin, model mutation, and commit, aborting on
error. Once migration is complete, every project-mutating bridge operation
requires an active transaction ID.

At the shared application boundary, `packages/slicer-app` has one history
coordinator for this stream, backed by a shared FIFO revision-operation gate.
It serializes project transactions, navigation requests, and filament
mutations before entering the Worker, owns an idempotent project-mutation
lease, projects the returned `HistoryStatus` before publication, refreshes the
complete filament-session snapshot after every native revision change through
a non-reentrant lease read, and releases the lease only after the supplied
renderer/model publication barrier settles. A filament command that arrives
while a project operation is pending waits in the same FIFO and therefore uses
the refreshed session revision; it is not rejected merely because the project
is busy. Public history-status reads also enter the FIFO, so an older blocked
read cannot overwrite a newer mutation's authoritative projection. Transform
gestures, scene additions/clears, configuration edits,
boot resets, and undo/redo/jumps must use this coordinator; no feature may
call the native history methods or manually pair a pending flag with a
filament refresh. A failed or cancelled operation releases its lease in all
paths, while a synchronous bridge-start failure releases immediately because
no native revision was entered.

The adapted history core lives in Neo-owned
`packages/slicer-wasm/src/history/ProjectHistory.{hpp,cpp}`. `bridge.cpp`
exposes only the C API; the typed client, Worker RPC, shared runtime, and React
controller are thin adapters. No `packages/slicer-wasm/cpp` submodule source is
modified and no wx GUI source is compiled into WASM. Upstream history fixes are
reviewed and ported deliberately as separate Neo changes.

### 6.2 Transform synchronization boundary

During pointer or gizmo dragging, React/three.js retains temporary transform
state for responsive rendering. At gesture start, the Worker captures the
pre-change model version; at successful gesture end, React sends the final
transform once to the Worker `Model` and commits the history transaction.
Numeric transforms, Drop to Bed, and Reset use the same capture/sync/commit
sequence. Cancelling a gesture restores its local pre-gesture transform and
aborts the Worker transaction.

The existing pre-slice full transform synchronization remains a defensive
consistency check, not the first time a committed transform is written to the
native model. This makes the Worker model authoritative at every history
boundary without sacrificing drag performance.

### 6.3 Two-phase restore and failure handling

Neo restores through a prepare/commit protocol. The Worker first reconstructs
and validates the requested model version and `HistoryContext` in a temporary
restore container, retaining shared immutable meshes where possible. Only a
successful preparation atomically replaces the active model and moves the
history cursor.

On preparation or validation failure, the active model, cursor, selection,
plate, and gizmo remain unchanged, and the UI reports a retryable restore
failure. If a severe WASM memory failure prevents preservation of a safe active
state, history is disabled for that session and the user is offered reloading
the last saved 3MF; Neo must never continue editing a partially restored
project.

Native Orca assumes its self-generated in-memory snapshots are valid and
restores its `Model` in place. The two-phase protocol is the Neo-specific
reliability boundary required by the asynchronous Worker/WASM environment.

### 6.4 Stable identity and stale-result isolation

History context references object, part, and instance `ObjectID` values and
stable plate IDs only, never positional indices. A restored entity retains the
identity of that historical version. After each restore React re-reads complete
model structure and mesh projections.

Every renderer object, cached positional index, and asynchronous refresh result
is associated with the active history revision/token. A result for another
revision is discarded. Creating a new branch after Undo invalidates all
discarded-Redo IDs and any UI reference to them.

## 7. Resource Budget and Eviction

History has a fixed, per-project-session byte budget of **256 MiB** by default.
The limit is configurable in a later preference surface and applies equally to
Electron and Web; it deliberately does not derive from an imprecise browser
physical-memory estimate.

- Accounting includes every JS and WASM allocation held solely for history.
- When the budget is exceeded, release optional/reconstructable data first,
  then evict the oldest Undo history while preserving the current state and the
  most recent usable Undo/Redo path.
- One atomic entry that alone exceeds the normal budget remains retained. This
  allows the operation that succeeded to be undone; subsequent commits resume
  normal oldest-first eviction.
- Reaching the retained-history boundary is represented by the disabled Undo
  control. The initial release has no disruptive notification.

The Worker status contract exposes non-disruptive resource diagnostics:
`bytesUsed`, `byteBudget`, cumulative `optionalBytesReleased`, cumulative
`evictedEntryCount`, `lastEvictedEntryId`, `oldestRetainedEntryId`, and
`oversizedEntryRetained`. These values describe the current project session
for diagnostics and automation; they do not create a toast, interrupt an
edit, or become a second history owner in React.

This follows native Orca's byte-based, LRU-style policy while choosing a
cross-host fixed ceiling appropriate for a browser/WASM memory environment.

Neo's `bytesUsed` is a deterministic retained-allocation estimate. It charges
the observed capacities of retained payload/context/container vectors and
long strings, plus canonical fixed upper-bound slots for history records,
intervals, and the history implementation. Compile-time assertions keep each
slot at or above its corresponding private retained object size; these slots
are not allocator telemetry. A string is considered externally stored by its
canonical logical-size threshold rather than the host's SSO capacity, and a
long value then charges its observed retained capacity plus one terminator.
Each unique shared-payload allocation/control-block unit is charged once by
pointer identity even when several frames retain it. Orca's corresponding
`UndoRedo.cpp::memsize()` is an estimate of its object-history representation:
it charges object/interval structures, serialized bytes, and an immutable
object only while the history is its sole owner (`use_count() == 1`), then
releases optional data and older snapshots. Neo therefore preserves Orca's
optional-release/LRU behavior while applying a stricter exhaustive contract to
context, container capacities, labels/keys, and shared control/owned-allocation
units across native and wasm64 hosts.

## 8. Initial Invariants

- The shared app remains host-neutral: all history behaviour is identical in
  Electron and Web.
- Renderer code continues to access native model state only through the typed
  slicer client and Worker boundary.
- The live model remains the source of truth; React history metadata must not
  become a second geometry model.
- Restoring a frame refreshes the model structure/mesh projection and updates
  the Object List, selection, active plate, gizmo, dirty state, and slice
  invalidation as one coherent restore transaction.

### 8.1 Saved checkpoint and project dirty state

The history cursor is the sole authority for persisted-project dirty state.
After a successful 3MF save, Neo records the current project-modifying history
position as the saved checkpoint. The project is dirty exactly when the path
between the current cursor and that checkpoint contains a project-modifying
entry.

- Undoing to the saved checkpoint clears dirty; Redoing away from it restores
  dirty.
- Selection and plate-only UI changes preserve the existing dirty state because
  they do not touch history.
- Preset selection and system preferences remain outside this calculation.
- If eviction removes the saved checkpoint, Neo conservatively reports dirty.
- All project mutations must enter through the history transaction boundary;
  the previous accumulated dirty-reasons boolean cannot compete with the
  history cursor.

This matches Orca's saved-snapshot-time model and ensures Save, Undo/Redo, and
close confirmation describe the same project state.

## 9. History Navigation UI and Shortcuts

Neo provides both one-step and direct history navigation, matching Orca's
Undo/Redo toolbar behaviour:

- enabled/disabled Undo and Redo buttons in the shared primary toolbar;
- directional dropdown lists labelled with the available project-modifying Undo
  or Redo entries;
- direct jump to any listed entry through one atomic Worker restore. Sparse
  adjacent-only frames crossed by the jump are resolved from the selected
  opaque entry ID and applied internally in order; React receives only the
  final full projection, while stale, evicted, and opposite-direction IDs are
  still rejected;
- `Ctrl/Cmd+Z` for Undo, and `Ctrl/Cmd+Shift+Z` or `Ctrl+Y` for Redo;
- when an editable text control owns keyboard focus, its native text
  Undo/Redo takes precedence and project shortcuts do not run.

Project-history navigation is available only on the **Prepare** tab. On Home,
Preview, and Device, the toolbar buttons and their directional-menu triggers
remain visible but disabled, and the shared app neither consumes nor dispatches
project Undo/Redo shortcuts. Returning to Prepare re-enables them solely from
the current Worker `HistoryStatus`; navigating away never discards history.

Selection and plate context are restored with project-modifying frames. They do
not appear in history menus because no standalone entries are created.

## 10. Verification and Performance Gates

Verification is layered across the shared application:

- unit tests cover transactions, Redo preservation across UI-only context
  changes, Redo truncation on the next genuine mutation, context restoration, saved
  checkpoints, dirty calculation, and saved-checkpoint eviction;
- Worker/WASM integration covers every exposed mutation category, mixed
  multi-entry menu jumps across Add Plate, Move, and full-model operations,
  and confirms history remains usable after 3MF save;
- large-model fixtures verify no per-edit complete-3MF archive, mesh sharing,
  256 MiB accounting/eviction, and safe traversal to the oldest retained frame;
- Electron, threaded Web, and serial Web end-to-end tests exercise the shared
  interaction and host integration.

The release handoff matrix is automated by `pnpm verify:undo-redo`. It runs
`pnpm test`, `pnpm typecheck`, dual-variant WASM quick and smoke checks, then
Desktop, threaded-Web, and serial-Web E2E sequentially so shared staged assets
cannot race. It writes exact command output and exit codes to the configured
report path for release evidence.

Correctness, history-budget enforcement, and safe eviction are CI gates.
Elapsed time and peak-memory measurements are recorded as diagnostic baselines
first, rather than flaky cross-hardware timing gates. Native Orca similarly
measures history memory and calls least-recently-used release after restore.

## 11. Relationship to Other Documents

- Extends `spec/Web-Electron Shared Application Architecture.md`.
- Extends `spec/3MF Project Persistence.md` with transient, project-session
  history; saved 3MF files do not contain the undo stack.
- Resolves the Undo/Redo deferral in `spec/ObjectList-and-Parts.md` for a
  future implementation milestone.
- The sequential agent-gated implementation plan is
  `doc/2026-09-07-undo-redo-implementation-plan.md`.
- Is tracked in `spec/Grand Plan.md` and `doc/high_level_dev_plan.md`.
