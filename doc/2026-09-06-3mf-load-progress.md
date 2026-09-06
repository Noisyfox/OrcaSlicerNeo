# 3MF Load Progress

**Date:** 2026-09-06

**Status:** Implemented

**Scope:** Keep the 3MF project-loading dialog's progress indicator aligned
with the actual load stages in the shared Electron and Web application.

## Accepted behaviour

- Opening a 3MF project shows the existing project progress dialog.
- The progress value advances through the load stages and reaches completion
  only after the project state has been applied.
- Geometry-only 3MF import uses the same progress contract.

## Decision

- Reuse the existing slice progress transport for project operations. The
  native bridge emits stable stage values at 0, 10, 20, 55, 75, 90, and 100;
  serial builds forward them through the permanent callback and threaded
  builds publish them through the existing shared mailbox.
- Project load and geometry-only import subscribe to the same typed callback
  through the Worker client, and the shared action updates the dialog's
  operation state from each event.

## Verification

- Focused WASM client/Worker tests: passed (98 tests).
- Focused project action tests: passed (15 tests).
- Workspace `pnpm typecheck`: passed.
- Workspace `pnpm test`: passed.
- `scripts\\build-windows.bat quick`: passed for threaded and serial wasm64.
- Desktop E2E: passed (29 tests passed, 3 existing intentional skips).
