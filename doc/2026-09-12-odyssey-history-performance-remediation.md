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
