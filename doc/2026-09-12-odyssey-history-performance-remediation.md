# Odyssey History Performance Measurement

Date: 2026-09-12
Status: Verified
Scope: Measure the real imported multi-colour Odyssey 3MF path from Prime Tower
pointer release through its native history commit, Undo, and Redo projections.

## Accepted behavior

- The timing regression first proves that the requested 3MF reached a committed
  native project session. Its receipt must match the selected filename and byte
  length, use `preflight-commit`, report `project` mode, settings, multiple
  plates, and non-zero object and instance counts.
- It retains the separate functional regression's exact eight-Prime-Tower
  assertion. The performance test has its own Electron session and must not
  weaken or reuse that functional assertion as a proxy for loading.
- On an active eligible Prime Tower, timing begins at pointer-up and ends only
  after the Worker mutation count, client round trip, application publication,
  and authoritative tower position agree.
- Undo and Redo timing each end only after the authoritative position returns,
  the filament rack remains enabled, and neither filament-routing rejection nor
  slicer error is visible.
- Every stage has a 120-second liveness ceiling. It is intentionally a generous
  regression guard for a 45 MB real project, not a cross-machine benchmark;
  each run logs wall-clock and Worker/client/application stage timings.
- The E2E-only history diagnostic splits history-projection reads into
  plate-session, Prime Tower, and filament snapshots at both the Worker-native
  and Worker-client boundaries. It also separately records the application
  Prime Tower read, all-volume collection reconciliation, collection emit, and
  best-effort remembered-filament preference publication. Those are scalar
  count/total/max/latest aggregates only; no project path, session identity,
  history context, mesh, or preference values are retained or exposed.
- A stage that the Worker impact does not request is reported with a zero
  count delta and `null` timing. The test does not manufacture a read merely
  to produce a timing sample.

## Verification record

The real threaded-WASM Odyssey project was committed as `preflight-commit`:
45,201,991 bytes, 13 objects, 13 instances, and 11 plates. The focused
performance E2E passed with these wall-clock measurements:

- pointer-up to authoritative native commit: 926.97 ms;
- Undo to authoritative tower plus valid filament rack: 938.98 ms;
- Redo to authoritative tower plus valid filament rack: 969.04 ms.

Its nested measurements were 74.73 ms Worker / 579.67 ms client / 599.99 ms
application for the move; 5.43 ms Worker / 238.58 ms client / 238.61 ms
application restore / 517.52 ms Tower projection / 15.95 ms filament refresh
for Undo; and 3.20 ms / 351.80 ms / 351.82 ms / 532.50 ms / 17.95 ms for Redo.

After sub-stage instrumentation, the same real project E2E passed in 31.2 s.
The measured Undo/Redo breakdown was:

- native history restore: 4.74 / 3.64 ms;
- plate-session snapshot: 0.60 ms native, 10.95 / 9.71 ms Worker round trip,
  and 10.96 / 9.72 ms application await;
- one full Prime Tower projection: 501.85 / 498.28 ms native, 502.05 /
  498.50 ms Worker round trip, and 502.17 / 498.63 ms application await;
- `WipeTowerVolumeCollection` reconciliation and emit: about 0.04–0.05 ms
  and 0.03–0.04 ms respectively; its complete `setProjection` call was
  0.08–0.11 ms;
- filament snapshot: 3.28 / 3.41 ms native and 14.10 / 10.62 ms Worker round
  trip; the already-existing full filament refresh was 21.77 / 18.01 ms.

The optional remembered-filament reread and preference persistence were not
requested for this restore receipt (zero count delta), so they do not explain
the observed delay. Critically, each Undo and Redo observed **two** full Prime
Tower reads (about 1,007 ms aggregate Worker time) but only one collection
publication. The second request is an overlapping reactive refresh rejected
by the generation/revision fence after consuming Worker work. The bottleneck
is therefore native full Prime Tower projection and its redundant reactive
read, not application-side collection reconciliation, emit, plate snapshot,
filament refresh, or preference persistence.

## Applied remediation

- The projection gateway now treats a successful direct restore projection as
  satisfying the same semantic renderer inputs seen by its following reactive
  effect. Equivalent fresh Worker snapshot objects do not invalidate that
  result; a real history revision, filament/plate revision, overlay, model
  volume identity, or model structure identity still does.
- It also joins concurrent reads for one input identity and keeps the existing
  generation/revision fence. A failed Prime Tower mutation explicitly forces
  reconciliation, so this coalescing never retains a local drag draft after a
  rejected native command.
- The reactive effect is gated by the phase of the render which created it.
  Effects queued while the restore phase was active cannot execute later after
  the shared store becomes idle and create obsolete full projection reads.
- The existing successful move receipt already supplies authoritative position
  and footprint to `WipeTowerVolumeCollection`; its plate-revision publication
  is marked satisfied so it cannot enqueue a stale all-tower read ahead of an
  immediate Undo.

The focused real-project E2E now gives every direct Undo and Redo exactly one
Worker/client/application Prime Tower projection read, and holds that count
for one second after the visible restoration settles. On the same 45 MB,
13-object, 11-plate Odyssey project, the one remaining Worker reads measured
493.21 ms for Undo and 485.02 ms for Redo, replacing the prior approximately
1,007 ms aggregate two-read cost. The test also proved the original and moved
positions, retained Prime Tower selection/gizmo state, and a usable filament
rack without routing or slicer errors.

## Accepted direct-restore receipt boundary

- A committed narrow Prime Tower history restore now carries an optional,
  version-1 `primeTowerReceipt` across the native bridge, Worker, typed client,
  and runtime history result. It is not yet consumed by the viewport collection.
- Its available form contains only the restored plate identity, post-restore
  plate revision, authoritative X/Y, and the footprint captured with that
  history frame. The bridge does not recompute a Prime Tower projection or infer
  state from renderer data while producing it.
- The union also reserves a `cleared` form for a future direct transition that
  intentionally removes or disables a tower. Missing, legacy, non-direct, or
  malformed receipt data is ignored by the client so the existing full
  projection fallback remains authoritative.
