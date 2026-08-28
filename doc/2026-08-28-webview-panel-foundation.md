# WebViewPanel Contract and Web iframe Foundation

**Date:** 2026-08-28
**Status:** Implemented
**Scope:** Shared WebViewPanel host contract and the Web platform's basic
printer-console iframe adapter. Electron's complete guest implementation and
Device UI remain separate follow-up work.

## Contract

`@orca/platform-contract` now exposes a deliberately small `WebViewHost` /
`WebViewPanel` boundary. A host mounts a panel into a caller-owned DOM
container. The panel can load a configured URL, reports `idle`, `loading`,
`loaded`, and `error` state, and emits state/navigation events. It also
declares whether built-in script injection, host API exposure, and embedded
page JavaScript execution are available. Built-in script requests carry an
identifier and opaque host-owned context; script source is never part of the
shared contract.

The contract is injected as `PlatformCapabilities.webview`. Existing Electron
assembly currently supplies an explicit unsupported placeholder so no Electron
`<webview>` is introduced in this step.

## Web degradation and privacy boundary

The Web adapter creates an ordinary `<iframe>` without a `sandbox` attribute,
so the user's printer console retains its normal scripts, forms, storage,
downloads, and browser popup behavior. It does not probe support before
mounting and does not read `contentWindow` or `contentDocument`; cross-origin
iframe DOM and page state remain outside the application's authority.

Web `registerBuiltInScript`, `exposeHostApi`, and `executeJavaScript` are safe
no-ops returning an explicit `unsupported` result. Each writes one redacted
diagnostic containing only the operation (and the built-in script identifier
for the script request). URL values, opaque context such as API keys, and
JavaScript source are never logged or sent through iframe messaging. The Web
host therefore never performs printer API-key injection; its direct typed
printer HTTP transport remains independent.

## Verification

- `apps/web/src/browserWebView.test.ts` checks iframe attributes, controlled
  navigation, lifecycle/error state, disposal, capability flags, unsupported
  results, and diagnostics that exclude URL/API-key/script content.
- `packages/platform-contract/src/contracts.test.ts` checks the dependency-
  free contract shape.
- Full repository test, typecheck, desktop build, and Electron E2E results are
  recorded with the implementation handoff.
