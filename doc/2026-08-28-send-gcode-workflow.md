# Send and Send & Print workflow

**Date:** 2026-08-28

**Status:** Implemented

**Scope:** Shared, host-neutral G-code sending UI on top of a completed slice.

## Decisions

- The shared toolbar exposes separate **Send** and **Send & Print** actions.
  Both open the same modal with an ephemeral printer target selection. The
  selection is independent of Device's console selection and is never written
  to preferences or the printer configuration repository.
- The modal validates the selected configuration before enabling an action:
  the slice must be complete, a printer must be explicitly selected, the
  driver must be Moonraker, and both API base URL and API key must be present.
  Missing or unsupported setup is reported with generic, key-free copy.
- **Send** calls `PrinterControlService.uploadOnly()` exactly once.
  **Send & Print** calls `uploadThenStart()`, which uploads once and then uses
  the exact returned remote path for the separate start request.
- Upload progress is shown through an accessible live status and progress
  indicator. Upload cancellation uses an `AbortSignal` when the modal is
  closed or its target changes. The completed upload is retained if starting
  fails, and the modal offers an explicit start-only retry.
- API keys are passed only to the existing service snapshot and transport seam.
  They are not rendered, logged, or included in user-facing errors.

## Verification

The shared component tests cover action/request differences, ephemeral
selection (including a deleted previous target), progress and cancellation,
start failure after upload without re-upload, and API-key redaction. No real
LAN printer or webview is used.

## Deliberate limits

The first slice does not add printer status polling, a cancel-print control
after a start request, or real-printer/webview E2E fixtures. Those remain
separate follow-up work.
