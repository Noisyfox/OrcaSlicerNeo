# Object Interaction and Incremental Publication

**Updated:** 2026-10-11

**Status:** Current engineering reference

## Accepted behavior

Project settings do not depend on model selection or plate navigation. Scoped
settings follow the current target, including when switching from Project mode.
Search, expanded categories, field drafts, validation, reset, and Undo/Redo keep
their existing behavior. Unchanged fields avoid remounting or rerendering their
controls. Categories remain expanded by default; no virtualization is introduced.

Every committed structural edit reuses the SceneDelta already calculated by
native history. Commit receipts carry that delta; nested and no-op commits
carry null. Reads never calculate a second scene diff or metadata revision.
The targeted patch exports descriptions only for changed objects and raw
geometry only for missing ModelVolume IDs, once per volume regardless of
instance count. Full project initialization reads a full baseline. There is
one protocol and no legacy fallback.

Renderer geometry and BVH ownership is shared by runtime session plus native
volume ID. Entity identities remain object/volume/instance tuples. Exclusive
renderer geometry (wipe towers) does not enter this pool. Pending reads retain
the resources they advertise; final owners release the resources. Cloning and
instance separation follow Orca's recursive new IDs. Replacing published mesh
must change volume ID; set_mesh on unpublished volumes is allowed. Selection
and history continue using native entity IDs.

Continuous-drag admission, transaction ordering, and history semantics are not
changed in this task. Mobile support remains deferred under the shared desktop
layout policy. Reduced renderer work benefits both supported hosts without
introducing host-specific behavior or additional persistent geometry caches.

## Protocol and cost

`orc_history_commit` returns `{status, scene_delta}`. The native history store
copies its existing delta into the receipt before budget eviction; it does not
recompute it. `getModelScenePatch(objectIds, knownGeometryKeys)` converts keys
from the current client session into the native request's `known_volume_ids`.
Native responses separate `renderables` from `geometries`. Model renderables
and geometry resources have required `geometryKey` fields in the typed client;
exclusive renderer buffers use explicit ownership instead.

The existing O(object count) ID filtering/order scans and history capture
remain. A touched object's descriptions include its volumes and instances;
unchanged objects contribute no descriptions or vertex/index buffers. The
renderer still performs a shallow ordered merge. This is object-level metadata
incrementality, not a claim that the entire transaction is O(changed meshes).
`ModelVolume::set_mesh()` does not change its ID: the bridge's only call fills a
new unpublished volume. Any future replacement of a published mesh must renew
its volume identity first. Instance separation uses Orca's `add_object(*source)`
and removes unwanted cloned instances by source index, never by the old ID.

## Cache invalidation

A successful slice-input mutation uses one native-authoritative affected plate
set across the Worker and renderer. The Worker advances those input stamps,
withdraws those transferable presentations, and invalidates those Prime Tower
projections. React removes only those receipts and cancels a running job only
when its plate is included. `Print`, `GCodeProcessorResult`, used-slot
summaries, and matching renderer receipts for other plates remain resident.

Undo/Redo restore responses carry mandatory `affected_plate_ids`; the typed
client rejects a missing, duplicate, or invalid field rather than falling back
to global invalidation. Add/Delete and their Undo/Redo therefore use the
existing object-summary delta path for the changed plate and leave unrelated
plates as projection cache hits. Global Prime Tower invalidation remains only
for session reset and true global slicing-input changes such as project or
filament configuration, whose native affected set contains every live plate.

Every committed plate input stamp is a Prime Tower projection dependency.
Refresh from plate-session mutation receipts even when transforms retain the
same GLVolume and object-list arrays. Reactive projection reads wait until the
project mutation lease releases, preventing a pre-commit read during an open
history transaction. Explicit history-restore reads likewise follow the native
restore commit. Selecting a plate changes interaction ownership only and does
not issue a projection read.

Native cache entries carry the input stamp and display index; a mismatch is
recomputed lazily. Explicit eviction is not the sole validity proof. Cache hits
reuse unaffected plates and incremental used-slot summaries without another
model traversal or reflow.

Slice cancellation, failure, stale completion, and empty-result reads withdraw
only derived slice presentation. They do not clear Prepare tower projections
or used-slot summaries, because they do not mutate model/configuration inputs.
Retain the regression that checks cache reuse both before and after a cancelled
job's terminal message, then performs a Move without a full used-slot scan.
Warm reads, plate selection, ordinary movement, last-object departure/return,
configuration changes, plate reorder, and deletion to an empty plate must
preserve correct eligibility/dimensions/slots and unrelated-plate cache hits.


## Verification boundary

### Real-project profiling constraints

The current committed `big-proj.3mf` has 51 objects across eleven serialized
plates. The fixture helper pins its byte length and hash and stages a
same-basename copy. The dedicated
[interaction profile](../apps/desktop/e2e/real-project-interaction-profile.e2e.ts)
requires visible enabled Undo within 100 ms for Add Plate, 125 ms for ordinary
Move, and 250 ms for Move during an active slice; active-slice Undo has a
750 ms ceiling. These larger-fixture limits supersede the former fourteen-object
fixture's gates for this runner, not its reuse/zero-full-scan assertions.
Plate-switch coverage retains 500 ms cold / 250 ms subsequent limits.

Measure from dispatch/pointer release through visible committed history, and
for Undo through restored selection, bounds/pivot and published world projection.
Native ABI return alone is not the acceptance boundary. Exercise the ordinary
canvas/history path, not injected native state. Report application, client,
Worker and native stages separately with artifact/fixture identity. Drain
load-time diagnostics before measuring.

Diagnostic rings are bounded and drain-on-read, containing scalar stages only,
never model/context/mesh bytes or project names. Prime Tower samples use native
plate indices and a 16-sample ring; clients reject missing/extra stage fields.
New profiling hooks compile out of ordinary production artifacts.

Per-plate rollback snapshots retain availability and its incarnation/result/
input/task identities. They do not copy G-code, line indexes or native result
owners, rewind newer results/replacement plates, or eagerly load Preview/GPU
data. Keep the trivially-copyable, at-most-128-byte snapshot regression with a
million-entry line index. Current history follows
[Undo and Redo](../spec/Undo%20and%20Redo.md), not earlier sparse-frame protocols.

Normal Prime Tower estimation uses current native geometry/configuration and
the enabled SEMM purge matrix without a temporary Print. Malformed/incomplete
numeric or matrix input may use the separately profiled native `Print.apply`
fallback. Same-plate translation preserves valid cached geometry; membership,
bounds and geometry changes invalidate the affected native set. Used-slot
summaries are incremental. No unbounded global mesh cache or cross-version
persisted projection cache is introduced.

### Coverage and interpretation

Use the committed real-project fixture and artifact-identity rules in
[testing guidelines](testing_guidelines.md). Test selection/target changes,
field drafts, Add/Delete/Undo/Redo, geometry reuse and unaffected-plate cache
hits. Timing results require the exact fixture, source/artifacts, host and
measurement scope; previous local measurements are not universal guarantees.
Native output ownership is defined by
[Per-Plate Print Architecture](../spec/Per-Plate%20Print%20Architecture.md).
