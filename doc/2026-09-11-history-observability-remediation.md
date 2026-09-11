# History Observability Remediation

**Date:** 2026-09-11
**Status:** Implemented — locally verified
**Scope:** Bounded diagnostics and regression guards for the existing shared
Undo/Redo mutation and restore path. This does not change interaction, restore,
or history ownership semantics.

## Accepted behaviour

- The Worker measures each completed native history transaction, direct native
  history mutation, and Undo/Redo/jump restore. The typed Worker client records
  the corresponding request/response duration. Both expose a versioned,
  structured-clone-safe snapshot containing only count, total, max, and latest
  milliseconds for mutation, all restore, direct restore, and full restore.
- `slicer-app` records bounded FIFO wait, native restore, filament-refresh, and
  projection durations. It mirrors only the Worker/client scalar aggregates;
  it never retains history frames, contexts, model structures, or geometry.
- A successful restore declares its path from the Worker-owned `impact` receipt:
  `model: 'none'` is direct and every other accepted impact is full. The app
  records direct and full projection separately. Direct Prime Tower projection
  keeps its model-reload counter at zero; full projection increments its own
  explicit count.
- In E2E builds the shared Workspace exposes the combined bounded snapshot via
  `window.__orcaE2e.historyDiagnostics()`. Production UI receives no new
  history panel, notification, polling loop, or renderer-owned history copy.

## Regression budgets

- The real multi-filament command smoke retains its warmed slot Undo/Redo
  assertion below **100 ms** and emits the numeric budget plus collected samples
  in its structured result. This guards the low-latency mutable-filament path
  on large multi-colour sessions without treating console output as evidence.
- Focused Worker/client and application tests assert the Worker/client
  aggregates, direct-versus-full restore counters, split projection timing, and
  zero direct Prime Tower model reloads. Existing real serial/threaded Prime
  Tower smoke continues to assert zero direct reloads and reports full restore
  reloads.

## Verification target

- Run focused Worker protocol and shared restore/history-mutation tests, then
  affected package typechecks and `git diff --check`.
- Run the real serial and threaded history/multi-filament/Prime Tower smoke
  commands against available artifacts. No C++ bridge or pinned submodule
  source is modified by this remediation.

## Verification record

- Focused Worker protocol diagnostics and shared restore/history-mutation
  coverage passed; the complete `@orca/slicer-app` suite passed (73 files,
  522 tests), along with affected app and WASM typechecks and `git diff
  --check`.
- Existing real-WASM history smoke passed for serial and threaded artifacts.
  The serial/threaded multi-filament command smoke passed the collected warmed
  slot Undo/Redo budget (all samples about 1.1–1.4 ms, below 100 ms). The
  serial/threaded Prime Tower smoke reported zero direct model reloads and two
  full restore reloads in each variant.
