# WebView Platform Abstraction

**Date:** 2026-08-27

**Status:** Draft — interactive design in progress

**Scope:** A common WebViewPanel-style feature layer for embedding third-party
web content. Electron may provide a richer implementation through Electron
`<webview>`; the static Web host uses a browser `<iframe>` with its naturally
limited capability set.

This is a top-level product specification, intentionally peer to
`Grand Plan.md`. Each approved discussion stage is recorded here before the
next design stage begins. No implementation is authorized by this draft.

## 1. Goals

1. One shared application-facing WebView API and shared React panel.
2. Electron supports embedded-page script injection, page JavaScript calls,
   and page-to-host callbacks.
3. Web embeds through a standard iframe and retains only browser-safe basic
   behavior.
4. The shared React package remains free of Electron, Node, and host-specific
   imports.
5. The vocabulary should align with OrcaSlicer's `WebViewPanel`: navigation,
   user scripts, host script execution, page messages/callbacks, title/error/
   new-window events, user agent, and developer tools where a host supports
   them.

## 2. Architecture direction (unconfirmed)

The direction under discussion is an injected platform contract:

```text
shared React WebViewPanel
  └─ platform.webview.mount(container, options, events)
       ├─ Electron: <webview> guest implementation
       └─ Web:      <iframe> basic implementation
```

The contract will expose a capability set and return an explicit `unsupported`
result for methods that Web cannot perform. This retains one source-compatible
surface while preventing callers from treating a no-op as a successful script
execution.

## 3. Confirmed decisions

### 3.1 Stage 1 — Script authority (2026-08-27)

**Decision:** Only scripts built into and shipped with OrcaSlicerNeo may be
injected into an Electron embedded page.

Consequences:

- The application provides no UI or public API for entering arbitrary
  JavaScript.
- Scripts cannot be fetched, downloaded, edited, or persisted as user data.
- A configured third-party host cannot request, select, register, replace, or
  alter an injected script.
- Script identity is a build-time, versioned identifier. The Electron host
  resolves the identifier to a bundled source asset; renderers and guest pages
  pass only identifiers, never source code.
- Document-start injection and post-load execution are Electron-only powers.
  They are unavailable, and report `unsupported`, for the Web iframe host.
- A later built-in script requires normal source review, tests, AGPL source
  distribution, and a release update. It is not configuration data.

The original OrcaSlicer pattern is relevant as a product reference: its host
injects a fixed `window.orca` bridge and fixed styling scripts before page
content, then uses a host-controlled callback path. The new implementation
will generalize this only for bundled, reviewed bridges.

## 4. Questions queued for the next stages

1. Which integration configuration may users edit: only URL/origin entries, or
   only a fixed built-in integration catalogue?
2. What is the exact public API and which operations must be present for
   `WebViewPanel` compatibility?
3. Which Electron guest security and storage/session model is required?
4. Which iframe subset and messaging behavior is useful enough on Web?
5. How should navigation, external links, popups, and URL allow-lists behave?
6. How should COOP/COEP/threaded-WASM coexist with external iframe content?
7. What UI workflow exposes embedded integrations to the user?
8. What verification matrix and test fixture are required?

