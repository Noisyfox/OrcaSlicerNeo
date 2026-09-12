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
