# Printer HTTP Transports

**Date:** 2026-08-28

**Status:** Implementation note — M14 step 3

**Scope:** Host adapters for the platform-neutral `PrinterTransport` contract.

## Boundary

`PlatformCapabilities.printers.transport` is injected beside printer
configuration. The shared printer-control package remains unaware of browser,
Electron, Node, or IPC APIs.

The Web adapter uses `XMLHttpRequest` so upload progress and cancellation are
available. JSON bodies are sent as serialized text; multipart bodies are
materialized as browser `FormData` only inside the browser adapter. Browser
CORS, mixed-content, TLS, local-network, and other security failures become a
generic transport failure and never include authorization values.

Electron sends a structured-clone-safe request over typed preload IPC. The
main process encodes JSON or multipart bytes and performs the request with the
Node HTTP client, bypassing renderer CORS. Only the current main renderer may
start or cancel a request. Progress events contain only request ID and byte
counters; request payloads never contain callbacks, `AbortSignal`, `FormData`,
`Blob`, or `BodyInit`.

## Verification

Focused tests cover browser GET/JSON/multipart requests, headers, progress,
abort/error behavior, and API-key redaction; Electron encoding, sender guard,
progress/cancel routing, preload shape, renderer adapter behavior, and
`PrinterControlService` injection are covered with fake XHR/native clients.
