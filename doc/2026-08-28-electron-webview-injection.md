# Electron WebView guest and Moonraker injection

**Date:** 2026-08-28
**Status:** Implemented
**Scope:** Electron `<webview>` platform adapter and the first built-in
Moonraker console API-key injector.

## Security boundary

The renderer now mounts a real Electron `<webview>` guest. The parent window
keeps `contextIsolation: true` and `nodeIntegration: false`; the only Electron
window preference added is `webviewTag: true`. Before Electron creates a guest,
the embedder's `will-attach-webview` policy deletes both preload fields and
forces `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true`,
and `allowRunningInsecureContent: false`. No Node object, preload API, or
arbitrary renderer function is exposed to the guest. The Electron main process
configures post-creation policy only for contents whose type is `webview`.

Guest initial navigation is checked in `will-attach-webview`, before guest
creation. Electron can normalize a DOM `<webview>` without a `src` to
`about:blank`, so that value is allowed only as the attach-time placeholder
alongside an empty/undefined src; the adapter immediately uses its programmed
`loadURL` target. Later navigation is checked on the guest's main-process
`will-navigate` event, where `about:blank` is not allowed. All real targets are
limited to credential-free `http:` and `https:` URLs.
`file:`, `javascript:`, `data:`, custom protocols, and credential-bearing URLs
are rejected. A guest `window.open`/new-window request always denies child
creation. Safe HTTP(S) requests are passed to the operating system's default
browser through `shell.openExternal`; no guest URL is logged.

## Orca reference and fixed script

The behavior follows the intent of Orca's `PrinterWebView::SendAPIKey`: wrap
`window.fetch`, preserve the request input, copy existing headers, and set
`X-API-Key`. The new implementation changes only the host mechanics and timing:
the script is a reviewed, code-shipped asset registered at Electron
`document_start`, rather than a script assembled from user input after load.

Only `moonraker-fetch-v1` is accepted. Its context must be an object containing
exactly one non-empty `apiKey` string (bounded length, no control characters).
Unknown IDs, extra context fields, and user-authored source are rejected. The
generated script never prints or stores the key in a page-visible object. A
page-local marker makes the fetch wrapper idempotent for a document; a new page
navigation receives the registered script again. `Headers` construction covers
plain init headers, `Headers`, and `Request` inputs while leaving the URL
unchanged.

The host API surface is deliberately data-only and fixed to
`orca-printer-console`; arbitrary names, functions, and sensitive-looking
fields are rejected. It creates no page callback, `postMessage`, or RPC bridge.
The existing `executeJavaScript` operation is available to the host-backed
panel for reviewed host code, but no shared UI path accepts user script input.

## Lifecycle and host differences

`ElectronWebViewPanel` reports loading, loaded, failure, navigation, and guest
destruction states, and removes every listener on disposal. Script and host API
registrations are installed before the next `loadURL`; content-script
registration is deduplicated. The adapter does not create an explicit
partition, matching the Stage 17 default storage decision.

The Web adapter remains a plain unsandboxed iframe. It cannot inspect a
cross-origin document or inject the key, so script/API/page-JavaScript requests
remain explicit `unsupported` results with redacted diagnostics. Web's direct
Moonraker transport remains independent of the console iframe.

## Verification and limitations

Pure unit tests cover URL/context validation, fixed script generation,
idempotence markers, `Request`/`Headers` handling, host API validation, guest
navigation/popup policy, lifecycle, and disposal. The dedicated local fixture
suite now adds the required real Electron `<webview>` receipt assertion plus
Device CRUD and Send / Send & Print orchestration coverage. No real LAN
printer or external site is contacted. Electron 43 lacks the
`WebViewTag.addContentScripts` method, so that host uses the same reviewed
source as a navigation-start fallback; newer hosts retain the preferred
document-start registration path.
