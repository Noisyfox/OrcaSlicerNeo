# Device console response headers and debugger Worker startup

**Date:** 2026-10-06

**Status:** Implemented and regression-tested

**Scope:** Electron response-header handling and Fluidd Worker startup during
VS Code debugging.

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

A temporary standalone Electron probe launch was blocked by execution policy;
validation used the existing Playwright harness. Native WASM rebuilds, Web E2E
and the full release matrix were not run because the change only narrows an
Electron response-header callback and does not alter WASM or Web code.

## Confirmed VS Code debugging failure

The response-header leak was a separate defect. Restoring the old global
header injection in an isolated probe still allowed the actual Fluidd parser
to complete; it did not reproduce the reported preview hang.

An Electron probe with a fresh Chromium session loaded the actual Fluidd
parser from `u1.lan` and transferred the complete 666,901-byte
`Cube_PLA_7.5g_14m3s.gcode` buffer. It returned 18,746 moves and 136 layers
in approximately 1.14 seconds. Fluidd's own `gcodePreview/loadGcode` action
also completed with the same results. The user confirmed that manual preview
worked in the probe and failed in their VS Code debugging session.

During the stalled VS Code session, the local 9222 CDP endpoint listed the
application page, the Fluidd `webview`, and its `parseGcode` Worker. The
Worker's `self.onmessage` was still null: its initialization had not executed.
Fluidd reported an active parser, zero progress and no moves or layers.
Sending only `Runtime.runIfWaitingForDebugger` to that Worker completed the
existing preview. After two seconds, Fluidd reported no active parser,
666,901 bytes of progress, 18,746 moves and 136 layers. No file, printer
configuration or application code was changed for this recovery.

This establishes a debugger startup wait as the immediate cause. The
[VS Code debugger target manager](https://github.com/microsoft/vscode-js-debug/blob/main/src/targets/browser/browserTargetManager.ts)
recursively enables auto-attachment with `waitForDebuggerOnStart`, while its
[supported JavaScript target types](https://github.com/microsoft/vscode-js-debug/blob/main/src/targets/browser/browserTargets.ts)
do not include Electron's `webview`. That source evidence explains the likely
debugger integration failure, rather than a Fluidd parser or application
Worker defect.

For Device/Fluidd testing, use the existing `Desktop Debug Main Process`
configuration instead of `Desktop Debug All`, which also starts
`Desktop Debug Renderer Process`. The application renderer can be inspected
with its Electron DevTools. The configuration names and the 9222 port are
defined in [the workspace launch configuration](../.vscode/launch.json).
No speculative debugger configuration or product workaround was added.
