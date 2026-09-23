# Object interaction performance

Date: 2026-09-23
Status: Implementation verified; complex-project performance acceptance failed
Scope: Shared settings panel and incremental model publication in Electron and Web.

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

## Verification scope

Cover Project selection independence, Scoped target switching and field edits,
search/reset semantics, retained geometry identity, consecutive adds, and
Add/Undo/Redo. Run package tests/typecheck per piece, root tests/typechecks at
handoff, and focused Electron interaction tests plus real-WASM timing probes.
Validate commit and geometry contracts with both WASM quick builds, focused
native harnesses, and real Electron/Web integration.

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

## Verification

- `pnpm test`: 943 tests passed; `pnpm typecheck` passed.
- `scripts\build-windows.bat quick`: serial and threaded builds passed.
- `bridge-smoke.mjs` and `history-smoke.mjs`: serial passed.
- `scene-geometry-smoke.mjs`: both variants passed, including 101 instances
  sharing one volume with zero geometry buffers on a retained-resource read,
  targeted commit deltas, separate-instance identity, Undo/Redo, nested/no-op.
- Real Electron: five focused Add, selection, Undo/Redo and DRC tests passed.
- Real Web: DRC import/profile/slice/layer/G-code download passed.
- Full release matrix and unrelated host flows were not run.

## Complex-project acceptance (2026-09-23)

Independent subagent review passed 263 targeted protocol, geometry, history,
selection and interaction tests, plus `git diff --check 14f23068 70de14a3`.
No normal-path blocking defect was found. Two exceptional cleanup risks remain:
scoped configuration rejection after constructing an unpublished projection can
retain new volumes; malformed null geometry records can throw before allocation
cleanup enters its try/finally. Neither occurred in this acceptance run.

Real visible Electron used the exact Odyssey project through a verified temporary
copy: 45,586,816 bytes, SHA-256
`6db07e50b4692f95bfef65595e9fcd0bf902c9660b7b1d7bc1a4f98b4d7d2425`,
14 objects and 11 plates. Source and copy hashes were unchanged after the run.
The accepted target is median <=100 ms and P95 <=200 ms.

Twelve cycles exercised Add Cube, Undo Add, Redo Add, Delete Cube, Undo Delete,
and Redo Delete (72 operations). Timing starts at DOM command dispatch, waits
for the expected object count and completed mutation/projection with available
history navigation, drains queued Worker work through the existing native
performance-profile read, then waits two animation frames. This completion
proxy includes background tower work and cross-process observation overhead;
it does not measure GPU presentation directly. Menu opening and project loading
are excluded. P95 uses nearest rank (the maximum for 12 samples).

| Operation | Median ms | P95 ms | Verdict |
| --- | ---: | ---: | --- |
| Add Cube | 471.4 | 534.2 | Fail |
| Delete Cube | 485.6 | 498.1 | Fail |
| Undo Add | 491.1 | 515.3 | Fail |
| Redo Add | 491.7 | 508.2 | Fail |
| Undo Delete | 493.8 | 512.9 | Fail |
| Redo Delete | 492.1 | 512.2 | Fail |

An earlier foreground-only run showed Add/Delete at 65/84 ms median, but omitted
pending tower work. Immediate Undo then took approximately 850 ms because it
queued behind that work and caused another refresh. Those foreground numbers
are not acceptance results. Draining the queue between operations reduced the
Undo runtime call to approximately 12 ms, disproving native history restore as
the source of that extra 380 ms. Full model reload count remained zero.

Native profiles show about 410 ms per expensive tower projection, about 370 ms
of which is `used_slot_full_scan_fallback`. Add/Delete call the no-argument
`invalidate_preview_source` in `bridge_model_operations.cpp`, clearing every
plate projection and used-slot summary. History restore also takes the global
invalidation branch when object counts change (`bridge_history.cpp`). Thus the
unmodified helmet volumes are scanned again despite successful mesh reuse.
The next performance change should preserve unaffected plate/volume usage
summaries across structural edits and restores, using authoritative input
changes to invalidate only affected results. Drag changes are unnecessary for
this finding.

Local raw measurements and the executed Node/Playwright probes are retained in
`test-results/complex-cube-acceptance/` (ignored artifacts). This run did not
repeat the dual-WASM build or full release matrix, and did not change production
code. The feature's protocol checks pass; end-to-end performance acceptance
remains failed.
