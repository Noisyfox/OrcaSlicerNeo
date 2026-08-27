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

### 3.2 Stage 2 — User-managed embedded hosts (2026-08-27)

**Decision:** Users may add, edit, and remove embedded page URLs in the
application. “Host” here means an embed target URL and its canonical origin;
it never means modifying the operating system `hosts` file.

Consequences:

- The editable data contains a display name, initial HTTPS URL, and the
  canonical `scheme + hostname + port` origin derived from that URL. The
  application does not accept a free-form origin separate from the URL.
- Production entries require HTTPS. Localhost development fixtures are the
  only documented HTTP exception.
- URL parsing, normalization, and validation are performed by a shared,
  dependency-free parser before an entry is saved or loaded. Invalid,
  credential-bearing, `file:`, `data:`, `javascript:`, and custom-protocol URLs
  are rejected.
- The registry is stored in platform preferences: Electron through a typed
  main/preload IPC repository and Web through the injected browser preference
  repository. A malformed registry is discarded without preventing the slicer
  from starting.
- Adding a host grants no additional privilege. In particular it cannot create
  or modify injected scripts, enable Node/Electron access, set a user agent,
  open arbitrary external URLs, or grant a page host capabilities.
- The exact script association and page capability policy for user-added hosts
  remain an explicit later decision. Until that policy is defined, a user-added
  host is only a navigable embedded target.
- The UI must make the distinction visible: a user-added target is untrusted
  content and is not a plugin installation or a trusted desktop integration.

This decision requires product-level URL validation in addition to a deployment
CSP. A restrictive `frame-src` CSP can prevent a newly saved URL from loading;
the deployment strategy for dynamically added HTTPS origins remains to be
decided in the navigation/security stage.

### 3.3 Stage 3 — Printer-console scope and API-key injection (2026-08-27)

**Decision:** User-entered URLs exist solely to embed the user's own printer
Web control console so that the printer can be managed from within
OrcaSlicerNeo. This feature is not a general-purpose browser, plugin host, or
arbitrary third-party webpage integration system.

**Decision:** The sole purpose of an injected built-in script is to provide a
printer API key to the matching printer Web console, avoiding a repeated manual
login. It is not a generic script-customization, analytics, DOM-automation, or
arbitrary host-API mechanism.

Consequences:

- A saved entry represents a printer-control integration, not merely a named
  bookmark. Its UI must identify the printer and expose printer-management
  status rather than browser-oriented controls.
- The product ships a small, reviewed set of printer-console adapters. Each
  adapter has a stable ID, exact supported origin/path rules, and one bundled
  API-key injection script. A user URL may select only an adapter whose URL
  matcher accepts it; it cannot attach an arbitrary built-in script.
- The injected script receives the API key only for the adapter and current
  origin that were selected. It must not log the key, place it in a URL,
  persist it in page-visible storage unless the adapter contract explicitly
  requires it, or send it to any origin other than the selected printer
  console.
- Electron runs the adapter script at document start when possible so that the
  console sees the credential before its normal authentication flow. Web does
  not inject scripts; iframe users authenticate manually in that host.
- The generic page-message and host-JavaScript-call APIs remain implementation
  tools for these reviewed adapters, not public extension APIs for a user-added
  page.
- Page behavior remains inherently adapter-specific. If a printer console has
  anti-framing policy, an unsupported login protocol, or changes its DOM/API,
  the adapter reports an unsupported or update-required integration; the
  application does not attempt to bypass the printer vendor's policy.

The key acquisition, secure storage, lifecycle, and removal rules are not yet
decided. No API key may be placed in shared React state, ordinary preferences,
URL query parameters, renderer logs, browser `localStorage`, or a Web host
iframe message.

## 4. Questions queued for the next stages

1. How are printer API keys obtained, securely stored, updated, and removed on
   Electron, and what is the Web-host behavior when injection is unavailable?
2. What is the exact public API and which operations must be present for
   `WebViewPanel` compatibility?
3. Which Electron guest security and storage/session model is required?
4. Which iframe subset and messaging behavior is useful enough on Web?
5. How should navigation, external links, popups, and URL allow-lists behave?
6. How should COOP/COEP/threaded-WASM coexist with external iframe content?
7. What UI workflow exposes embedded integrations to the user?
8. What verification matrix and test fixture are required?
