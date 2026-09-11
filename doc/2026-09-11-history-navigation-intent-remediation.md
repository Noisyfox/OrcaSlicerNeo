# History Navigation Intent Remediation

**Date:** 2026-09-11
**Status:** Implemented — pending root acceptance

## Scope

Repair P2 in the shared history restore coordinator: a request received while
another restore projection is active must not be silently joined to, dropped,
or rejected from a stale React `HistoryStatus`.

## Accepted behaviour

- Navigation is an intent stream, not a renderer-owned history model. Each
  Undo, Redo, or directional jump enters the existing project FIFO as an
  individual request and has one eventual outcome: success, an explicit Worker
  stale/unavailable/restore failure, or the established drag-cancellation
  consumption rule.
- Repeated one-step intents execute in FIFO order. This deliberately chooses
  per-press native navigation rather than client-side count arithmetic or
  lossy coalescing.
- Opposite-direction and jump intents are sent without deriving a target from
  the rendered status. The Worker evaluates them after all preceding FIFO work
  has committed, using its current cursor and revision; evicted, stale, or
  unavailable targets remain explicit Worker failures.
- A restore obtains its renderer revision only after it reaches the FIFO head.
  It retains the existing cancellation, atomic native restore, selective
  impact projection, publication barrier, and failure cleanup. No two native
  restores run concurrently and a slow projection prevents later native work
  from publishing over it.
- While restoration is active, navigation controls and shortcuts may enqueue
  an intent even when their displayed direction availability is stale. The
  Worker remains the authority for whether that intent can execute. Normal
  project mutations retain their shared FIFO ordering.

## Verification target

Focused coordinator coverage proves rapid Undo x N, Undo then Redo, direct
jump interleaved with an ordinary project mutation, and slow projection
ordering/revision projection. The affected app tests and typecheck are run
before the in-scope commit; a serial/threaded real-WASM navigation smoke is
run when the existing artifacts are available.

## Verification record

- Focused history coordinator, navigation, and toolbar tests passed: 30 tests.
- `pnpm --filter @orca/slicer-app test` passed: 73 files, 521 tests.
- `pnpm --filter @orca/slicer-app typecheck` and `git diff --check` passed.
- Existing real-WASM `history-smoke.mjs` passed against both available serial
  and threaded artifacts, including native Undo/Redo and directional-jump
  stale/opposite-side rejection. This TypeScript-only change does not alter
  the bridge or pinned C++ submodule.
