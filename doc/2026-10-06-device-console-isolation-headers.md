# Device console isolation response headers

**Date:** 2026-10-06

**Status:** Implemented and regression-tested

**Scope:** Electron response-header handling for embedded printer consoles.

The Device webview uses Electron's default session. The session previously
injected COOP `same-origin` and COEP `require-corp` into every response,
including remote Fluidd documents and Worker scripts. This produced an ignored
COOP warning on the untrustworthy HTTP origin `http://u1.lan` and imposed
application isolation policy on an external console.

Isolation headers now apply only to the exact application renderer origin,
including its Worker and WASM resources. Development uses the configured Vite
renderer origin; builds use the bound loopback server origin. Remote responses
retain their own headers. Web embedding and guest security preferences are
unchanged. This corrects the header leak; the supplied warnings alone do not
establish a particular Fluidd Worker failure.

This host-only fix does not change mobile support, input behavior, or runtime
memory characteristics.

## Verification

Unit coverage checks application documents, scripts, Workers and WASM, external
console and Worker resources, distinct ports/protocols, development origins,
case-insensitive replacement and invalid origins. Live HTTP inspection of
`u1.lan` returned JavaScript for the Monaco editor Worker with status 200.

Passed checks:

- `pnpm --filter @orca/desktop test`: 102 tests.
- `pnpm --filter @orca/desktop typecheck`.
- `pnpm test`: 1,649 tests across the workspace.
- `pnpm typecheck`: all workspace packages.
- With `VITE_USE_MOCK=1`, `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`;
  confirmed the emitted slicer Worker contains `const useMock = true`.
- `pnpm --filter @orca/desktop exec playwright test e2e/printer-control.e2e.ts`:
  all three tests passed. The Device test executes a guest Worker and verifies
  its response lacks injected COOP/COEP while the application remains
  cross-origin isolated. API-key reuse, guest reload and printer control pass.
- `git diff --check`.

Actual Fluidd functionality after the fix remains unverified. A temporary
standalone Electron probe launch was blocked by execution policy; validation
used the existing Playwright harness. Native WASM rebuilds, Web E2E and the
full release matrix were not run because the change only narrows an Electron
response-header callback and does not alter WASM or Web code.
