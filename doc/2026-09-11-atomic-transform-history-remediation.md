# Atomic Transform History Remediation

**Date:** 2026-09-11
**Status:** Implemented

## Accepted behaviour

- A complete multi-object transform gesture enters the Worker as one
  transaction-bound batch. The Worker validates every CompositeID, every
  transform payload, the transaction identity, and the captured history
  revision before applying any target.
- A successful batch applies all targets, recomputes plate membership once,
  returns one authoritative plate-session receipt, and commits one history
  entry. Invalid, stale, or failed batches leave model, history, and revision
  unchanged before transaction abort restores the captured Worker state.
- Renderer transforms remain drafts until that receipt succeeds. Cancellation,
  timeout, stale transaction/revision, or any native failure rebuilds the
  model mesh, Object List, plate session, and selection projection from the
  Worker before the shared mutation operation settles.
- This repair is limited to transform atomicity and reconciliation. It does
  not start later performance, restore-coordinator, or observability work.

## Verification

- Focused native/client/application regressions cover one multi-object
  receipt/history entry, injected second-target rejection with no partial
  model state, stale transaction/revision rejection, cancellation, and
  Undo/Redo interleaving.
- The changed bridge is checked with the applicable serial and threaded WASM
  quick/smoke evidence, plus affected TypeScript tests/typecheck and diff
  hygiene.
