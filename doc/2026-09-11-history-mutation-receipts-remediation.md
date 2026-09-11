# History Mutation Receipt Remediation

**Date:** 2026-09-11
**Status:** Implemented

## Accepted behaviour

- Every successful native mutation that creates, truncates, or changes project
  history returns the authoritative post-commit `HistoryStatus` in the same
  typed receipt. This includes filament assignment, preset, routing and slot
  mutations, project-setting mutations, and Prime Tower movement.
- The shared mutation FIFO projects the receipt before publishing renderer or
  store state. It does not issue a competing history-status read for a
  successful receipt, and revision ordering rejects an older status.
- Toolbar/menu state and canonical project dirty state consume that one
  receipt. React retains only the current projection, never a separate history
  model.
- Filament refreshes and ordinary project operations remain in the same FIFO.
  A rapid interleaving therefore sees the current native revision, projects
  each returned receipt in order, and a branch created after Undo immediately
  removes redo availability in the UI.

## Scope and boundaries

- Preserve the Worker/WASM/client/runtime boundary; application code does not
  access Emscripten directly and the renderer remains non-blocking.
- Do not modify `packages/slicer-wasm/cpp/`. The pinned submodule's existing
  dirty state is outside this task.
- Cover the receipt contract at the native/client/runtime/store boundaries,
  including a real serial and threaded WASM smoke sequence.

## Verification record

- Focused typed-client receipt contracts, including rejection of a missing
  filament history receipt, pass.
- Shared store/FIFO coverage proves a filament receipt immediately projects the
  navigation and dirty stores, and a delayed lower revision cannot resurrect a
  redo branch after an interleaved project mutation.
- Incremental serial and threaded WASM builds pass. The real multi-filament
  smoke validates that each exposed filament command's receipt exactly equals
  the post-commit native status; the real Prime Tower smoke validates the same
  scalar receipt in both variants.
- Workspace typecheck passes.
