# Printer console local fixtures and Electron E2E

**Date:** 2026-08-28

**Status:** Implemented

**Scope:** Deterministic local verification of printer configuration, the
Electron guest console, and Moonraker Send / Send & Print actions.

## Fixture boundary

`apps/desktop/e2e/printer-control.e2e.ts` starts an ephemeral loopback HTTP
server inside each test. The server provides a minimal printer console page,
records the console page's same-origin request headers, and implements the
Moonraker `/server/info`, upload, and print-start endpoints. It intentionally
does not discover or contact a LAN printer or the public Internet. Multipart
uploads are retained as raw request bytes so the test can assert upload count
without coupling to a browser `FormData` implementation.

## Coverage

- Device adds two records, leaves newly saved records unselected, selects a
  record, edits it, and requires confirmation before deleting the other record.
- A real Electron `<webview>` loads the loopback console and the fixture
  observes the configured `X-API-Key` on the guest's same-origin fetch.
- Send performs one upload and no start request.
- Send & Print performs one upload followed by start. The fixture fails the
  first start; the UI reports `start-failed-after-upload`, and the explicit
  retry starts the returned remote path without a second upload.

The Electron e2e launcher accepts `ORCA_E2E_PRINTER_CONFIG` to isolate the
printer configuration document in a per-test temporary file. The production
path remains `userData/printer-config.json`.

## Electron compatibility note

Electron 43's `WebViewTag` does not expose `addContentScripts`, despite the
newer API shape used by the adapter contract. The adapter keeps the reviewed
script registration path for hosts that provide it and falls back to running
the same fixed source at guest navigation start on Electron 43. The fixture
waits for that script's non-enumerable marker before its receipt request, so
the assertion observes the actual guest fetch rather than a renderer mock.
