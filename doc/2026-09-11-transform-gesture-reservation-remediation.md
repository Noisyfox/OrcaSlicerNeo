# Transform Gesture Reservation Remediation

**Date:** 2026-09-11
**Status:** Implemented — pending root acceptance

## Accepted behaviour

- Pointer-down creates only a short, read-only Worker reservation: the native
  history revision, the complete stable object/part/instance target collection,
  and the existing before-context. It does not acquire a project-mutation lease,
  retain the shared FIFO, or open `active_history_transaction` while a renderer
  draft is being dragged.
- Pointer-up enters the shared FIFO and revalidates the native revision, the
  stable target identities, and the renderer CompositeID collection before
  beginning a transaction. A valid final batch opens, writes, and commits one
  short atomic native transaction, yielding one history entry with the original
  before-context and current after-context.
- A changed revision or identity rejects the release before `beginHistory` and
  before any final transform write. The result is consumable as `stale`, and
  the Workspace reconciliation path rebuilds the renderer/object/plate
  projections from Worker authority. Cancellation and no-op releases stay local
  and create no history entry.
- Filament, Prime Tower, ordinary project mutations, and navigation continue
  through their normal shared FIFO while a draft is live. Their newer revision
  safely invalidates the pending reservation instead of waiting for pointer-up.
- React retains only renderer-local draft transforms and a small identity/
  revision reservation. It owns neither a model snapshot nor a history copy.

## Verification

- Focused `TransformHistoryCoordinator` coverage proves pointer-down opens no
  native transaction, release performs one final transform batch, successful
  drag yields one history entry, and cancellation/no-op write nothing.
- Regression coverage queues named filament, Prime Tower, and ordinary project
  mutations during a long draft, confirms they settle before release, then
  confirms the stale release does not open a history transaction or write the
  model and reconciles immediately. A separate identity-only invalidation case
  covers stable-target validation.
- This remediation changes shared TypeScript only; no WASM bridge/native source
  or pinned C++ submodule is modified. `pnpm --filter @orca/slicer-app test`
  passed (73 files, 516 tests), `pnpm typecheck` passed, and the focused
  transform/controller suite passed (68 tests). The existing real
  serial/threaded `history-smoke.mjs` passed against both artifacts, including
  final atomic multi-object transform write, one-entry history, Undo, Redo,
  invalid-target rollback, and stale-transaction checks.
