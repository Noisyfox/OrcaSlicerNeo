# Send and Send & Print workflow

**Date:** 2026-08-30

**Status:** Implemented

**Scope:** Shared, host-neutral G-code sending UI on top of a completed slice.

## Decisions

- The shared toolbar exposes separate **Send** and **Send & Print** actions.
  Both open the same modal with an ephemeral printer target selection. The
  selection is independent of Device's console selection and is never written
  to preferences or the printer configuration repository.
- The modal validates the selected configuration before enabling an action:
  the slice must be complete, a printer must be explicitly selected, the
  driver must be Moonraker, and the API base URL must be present. An API key
  is optional; when absent, Moonraker requests omit `X-Api-Key`.
  Missing or unsupported setup is reported with generic, key-free copy.
- **Send** calls `PrinterControlService.uploadOnly()` exactly once.
  **Send & Print** calls `uploadThenStart()`, which uploads once and then uses
  the exact returned remote path for the separate start request.
- Upload progress is shown through an accessible live status and progress
  indicator. Upload cancellation uses an `AbortSignal` when the modal is
  closed or its target changes. The completed upload is retained if starting
  fails, and the modal offers an explicit start-only retry.
- The session-only Device navigation option is presented alongside the Close
  and Send actions. The printer selector and this option are disabled while
  sending or during the success countdown; Close remains available for
  cancellation or early dismissal.
- After a successful Send or Send & Print, the modal counts down for five
  seconds before closing. An optional, session-only checkbox changes the
  status copy and, when the countdown completes, closes the modal first and
  then asks the app-level navigation callback to show Device. Manual close,
  target changes, errors, cancellation, and start failures cancel this
  navigation.
- API keys are passed only to the existing service snapshot and transport seam.
  They are not rendered, logged, or included in user-facing errors.

## Verification

The shared component tests cover action/request differences, ephemeral
selection (including a deleted previous target), progress and cancellation,
start failure after upload without re-upload, API-key redaction, and keyless
upload/start requests. The Electron fixture covers the same keyless
Send & Print path without a real LAN printer.

## Deliberate limits

The first slice does not add printer status polling, a cancel-print control
after a start request, or real-printer/webview E2E fixtures. Those remain
separate follow-up work.
