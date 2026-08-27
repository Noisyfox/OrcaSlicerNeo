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

### 3.4 Stage 4 — API-key acquisition (2026-08-27)

**Decision:** The user manually enters the printer API key in
OrcaSlicerNeo. The application does not attempt to obtain, scrape, infer, or
exchange it from the embedded printer console's login flow.

Consequences:

- Create/edit-printer UI includes a dedicated masked API-key field, separate
  from the printer URL and display name.
- The key is sent only to the trusted host-side secret-handling boundary; it
  must not enter shared React state, regular form persistence, analytics,
  diagnostics, browser devtools logging, or the printer URL.
- Reauthentication is deterministic: the user replaces the key through the
  printer edit flow. The product does not depend on vendor-specific browser
  cookies or attempt silent credential extraction.
- A later adapter may validate a key by making its documented printer API
  request, but validation cannot read browser form fields, cookies, or page
  storage.

This stage decides only the source of the secret. The encrypted Electron
storage design, in-memory lifetime, deletion behavior, and Web-host behavior
remain separate decisions.

### 3.5 Stage 5 — Cross-platform printer credential use (2026-08-27)

**Decision:** The printer API key is required on both hosts. On Web it is not
used for iframe script injection; it is retained so the static Web application
can authenticate its own G-code upload request to the user's printer.

Consequences:

- Introduce a dedicated `PrinterCredentialRepository`, separate from ordinary
  `UserPreferences`. It is keyed by a stable printer integration ID and is not
  represented in shared app state after a request completes.
- Electron uses the credential both to supply its reviewed embedded-console
  adapter and to authorize direct printer operations such as G-code upload.
- Web uses the credential only for direct, documented printer API operations;
  the iframe does not receive it and continues to use any authentication flow
  offered by the printer console itself.
- A static Web build has no server-side secret vault. Its at-rest protection,
  session lifetime, and user-recovery UX are a required explicit design
  decision, not an implicit use of ordinary `localStorage`.
- Removing a printer integration deletes its associated credential on the
  current host. Exporting, syncing, or copying credentials between hosts is
  out of scope unless a later specification explicitly authorizes it.

The direct Web upload path also requires a printer API that is reachable from
the browser and permits the application's origin through CORS. HTTPS Web pages
cannot rely on an insecure HTTP printer endpoint without encountering mixed
content restrictions. Those compatibility and fallback policies remain to be
decided.

### 3.6 Stage 6 — Two independent printer-control channels (2026-08-27)

**Decision:** The feature has two separate objectives and therefore two
separate execution paths:

1. Render the printer's Web control console inside the application.
2. Control the printer through its documented HTTP API, including G-code
   upload and print operations.

The embedded console is a user-facing display/authentication surface. The HTTP
API client is the authoritative application-control surface. Neither path may
depend on the other at runtime.

```text
User
 ├─ printer console panel ──> WebViewHost
 │    ├─ Electron <webview>: bundled API-key bridge where supported
 │    └─ Web <iframe>: display/manual console authentication only
 │
 └─ OrcaSlicerNeo print actions ──> PrinterControlClient ──> printer HTTP API
                                      ^
                                      └─ PrinterCredentialRepository
```

Consequences:

- Implement a typed `PrinterControlClient`/`PrinterTransport` contract for
  status, G-code upload, print start, cancellation, and later printer-specific
  operations. Application features call this contract, never iframe DOM,
  `executeJavaScript`, page callbacks, or browser cookies.
- The embedded-console adapter and API client may both use the same stored API
  key, but they are separate consumers. Failure to frame a console does not
  remove API printing capability; a failed API request does not give the
  console adapter permission to scrape credentials or DOM state.
- On Electron, secret resolution and local-network HTTP requests belong behind
  a narrow host/preload boundary so raw keys do not pass through shared React
  state. On Web, the browser adapter performs the API request subject to the
  Web platform's secure-context, CORS, local-network-access, and mixed-content
  rules.
- API errors must be reported as printer operation failures with actionable
  compatibility detail. They are not treated as WebView errors.
- The WebView abstraction does not itself acquire printing/upload methods.
  It remains a separate, UI-oriented platform contract.

This stage establishes the architectural separation only. The supported printer
API families, endpoint schemas, transport security, upload semantics, and
operation state model remain to be defined.

### 3.7 Stage 7 — Modular printer API drivers; Moonraker first (2026-08-27)

**Decision:** Printer HTTP control is modular. The common application uses a
vendor-neutral printer-control contract, while built-in drivers implement
individual printer API families. Moonraker is the first supported driver.

The implementation introduces a new shared `@orca/printer-control` package:

```text
shared application
  └─ PrinterControlService
       └─ PrinterApiDriver selected by `driverId`
            ├─ MoonrakerDriver (first built-in driver)
            └─ future built-in drivers
                 └─ host-injected PrinterTransport + PrinterCredentialRepository
```

No driver is loaded from a user URL or arbitrary code. `driverId` is a closed,
versioned built-in identifier. A user configures a printer endpoint and selects
only a driver that OrcaSlicerNeo ships.

The first-release common contract includes:

```ts
interface PrinterApiDriver {
  readonly id: string;
  readonly displayName: string;
  testConnection(printerId: string): Promise<PrinterConnectionInfo>;
  getStatus(printerId: string): Promise<PrinterStatus>;
  uploadGcode(input: GcodeUpload, progress: ProgressSink, signal: AbortSignal): Promise<UploadedGcode>;
  startPrint(printerId: string, remoteFile: UploadedGcode): Promise<void>;
  pausePrint(printerId: string): Promise<void>;
  resumePrint(printerId: string): Promise<void>;
  cancelPrint(printerId: string): Promise<void>;
}
```

`PrinterTransport` is host injected. It resolves a credential immediately
before a request, adds the driver-defined authentication header, performs the
HTTP request, and redacts authorization values from diagnostics. A driver never
reads Electron APIs, browser storage, or raw credential records. The shared
application receives typed operation results and progress only.

#### Moonraker driver requirements

Moonraker behavior follows the existing native implementation as the reference
for protocol semantics, not as a source dependency:

- connection test: `GET /server/info`;
- authentication: `X-Api-Key` when an API key is configured;
- upload: multipart `POST /server/files/upload`, with `file` and `root=gcodes`;
- start: JSON `POST /printer/print/start` using the path returned by upload;
- first control set: printer status plus PAUSE, RESUME, and CANCEL_PRINT
  commands/operations where the Moonraker API supports them;
- upload cancellation and progress are mandatory; a completed upload and a
  print-start request are distinct operations, so a failed start never causes
  the application to report a successful print.

Moonraker's existing `Moonraker` and `MoonrakerPrinterAgent` source files are
the detailed reference for endpoint shape, response parsing, filename handling,
status behavior, and API-key conventions. Their C++ HTTP, native threading,
and GUI-agent dependencies are not reused in the WASM/shared application path.

Future drivers must implement the same contract and add fixture-backed protocol
tests. They cannot enlarge the common API merely to expose an untyped vendor
endpoint; new shared operations require a specification amendment.

## 4. Questions queued for the next stages

1. Does the static Web host send G-code directly to the printer API, with CORS
   and HTTPS/TLS support required from the printer; and what should happen when
   a printer does not meet those browser requirements?
2. How are manually entered printer API keys securely stored, updated, and
   removed on Electron and Web?
3. What is the exact public API and which operations must be present for
   `WebViewPanel` compatibility?
4. Which Electron guest security and storage/session model is required?
5. Which iframe subset and messaging behavior is useful enough on Web?
6. How should navigation, external links, popups, and URL allow-lists behave?
7. How should COOP/COEP/threaded-WASM coexist with external iframe content?
8. What UI workflow exposes embedded integrations to the user?
9. What verification matrix and test fixture are required?
