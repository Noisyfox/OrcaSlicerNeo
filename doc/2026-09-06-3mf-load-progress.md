# 3MF Load Progress

**Date:** 2026-09-06

**Status:** Implemented; mailbox delivery corrected 2026-09-16

**Scope:** Keep the 3MF project-loading dialog's progress indicator aligned
with the actual load stages in the shared Electron and Web application.

## Accepted behaviour

- Opening a 3MF project shows the existing project progress dialog.
- The opening operation is committed and given a browser paint opportunity
  before native parsing begins.
- The progress value advances through the load stages and reaches completion
  only after the project state has been applied.
- Serial and threaded main-runtime producers make every enqueued stage visible
  immediately. A threaded slice pthread remains shared-wake-only and never
  calls JavaScript.
- Geometry-only 3MF import uses the same progress contract.

## Decision

- Reuse the common asynchronous-task FIFO for project operations. The
  native bridge emits stable stage values at 0, 10, 20, 55, 75, 90, and 100;
  every message is first committed with its global sequence. After releasing
  the FIFO mutex, a serial or threaded main-runtime producer invokes the same
  JS notifier, whose guarded consumer drains that FIFO until empty. A pthread
  cannot enter JavaScript, so it advances the shared wake and the main Worker
  consumes the same FIFO on its next poll. There is no project-load-specific
  side channel.
- Project load and geometry-only import subscribe to the same typed callback
  through the Worker client, and the shared action updates the dialog's
  operation state from each event.
- Project parsing remains synchronous on the stateful Worker. Moving it to a
  pthread would require a separate staged ownership, commit, failure, and
  cancellation design for the global Model, preset bundle, plate registry,
  and history; this visibility correction does not introduce that risk.

## Verification

- Worker tests cover live serial and threaded main-runtime delivery while the
  native call is active, nested enqueue FIFO order, and pthread wake-only
  delivery.
- Project-action coverage proves native loading starts only after the opening
  state's frame callback has ended.
- Visible Electron threaded and Web serial real-WASM coverage prove the dialog
  and a native nonterminal stage are rendered before the project-load result is
  committed.
