# Moonraker upload progress correction

**Date:** 2026-10-06

**Status:** Implemented and verified

## Behavior

Follow the [printer control specification](../spec/Printer%20Console%20and%20Control%20Integration.md)
and the [shared application architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md).
Electron sends the encoded HTTP body in bounded chunks, waiting for each write
callback before writing another chunk. Progress counts bytes handed to the local
network stack; it does not prove that Moonraker accepted the file.

The shared send dialog shows a percentage during transfer, then an indeterminate
“Waiting for printer confirmation…” status after all bytes have been sent.
Transfer percentages below completion never round up to 100%. Success requires
the successful response and a valid remote file path. Send & Print displays a
separate indeterminate print-start status after confirmed upload. Cancellation
remains available while awaiting upload confirmation; retry after failed print
start sends only the start request.

This correction applies to both hosts' shared dialog. Browser XHR upload
transport is unchanged. Mobile support remains deferred under the shared
architecture; no input or layout changes are introduced. Electron retains its
existing full-body encoding allocation, with only one bounded write outstanding.

## Verification

Regression tests cover intermediate write progress, complete body fidelity,
write failure, cancellation and late callbacks, and delayed printer confirmation.
Shared component tests cover waiting, near-complete rounding, cancellation,
print-start staging, and successful completion. A delayed-response Moonraker
fixture covers main/preload/renderer wiring in Electron. Run repository unit
tests and typechecks plus the focused printer-control and primary mock Electron
journeys. WASM builds and real Web runs are not required: this correction changes
neither the WASM boundary nor the browser transport.

### Results

- `pnpm --filter @orca/desktop exec vitest run src/main/printerHttpTransport.test.ts`:
  10 tests passed, including a real 32 MiB HTTP upload paused at the receiver.
  The sender reported intermediate progress while blocked and the received
  multipart body matched the encoded body byte for byte after resuming.
- `pnpm --filter @orca/slicer-app exec vitest run src/components/send/SendGcodeDialog.test.tsx`:
  25 tests passed.
- `pnpm test`: all 1,646 tests passed. An initial run exhausted the test worker
  heap while deeply comparing a 32 MiB Buffer; replacing that assertion with
  Buffer's byte comparison resolved the test-harness issue before the final run.
- `pnpm typecheck`: all workspace typechecks passed.
- With `VITE_USE_MOCK=1`,
  `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`: passed;
  the compiled Worker contains `const useMock = true`.
- `pnpm --filter @orca/desktop exec node scripts/check-renderer-css.mjs`: passed.
- `pnpm --filter @orca/desktop exec playwright test e2e/printer-control.e2e.ts e2e/app.e2e.ts`:
  35 passed; 3 real-WASM-only scenarios were skipped in mock mode. The printer
  fixture held its upload response until the UI showed waiting without 100%,
  then released it to verify success and start-only retry.
- `git diff --check`: passed. Local specification links were verified.

No physical printer or minutes-long real-network transfer was available for
verification. The controlled socket test proves intermediate progress under
backpressure; the Electron fixture proves delayed-confirmation UI behavior.
