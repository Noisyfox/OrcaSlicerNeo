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

### 3.8 Stage 8 — Best-effort Web transport; vertical flow first (2026-08-27)

**Decision:** Web printer operations use a best-effort direct browser
transport. The product does not preflight-test whether a configured printer
supports CORS, HTTPS/TLS, browser local-network access, or iframe embedding.
Instead it attempts the operation when the user requests it and reports the
actual failure in the operation UI.

Consequences:

- Adding or editing a printer validates only local configuration syntax and
  built-in driver selection. It does not make a network request or declare a
  printer compatible in advance.
- `uploadGcode`, `startPrint`, status refresh, and console loading each expose
  their own progress and error result. Browser-blocked, CORS, mixed-content,
  local-network permission, TLS, timeout, HTTP, and protocol failures are
  normalized into a user-visible error without exposing the API key.
- The absence of a preflight check is not a claim that every printer works in
  Web. Electron remains the richer/local-network host; Web errors must explain
  that the browser or printer may have blocked the request.
- Implementation priority is the end-to-end vertical flow: configure printer
  → retain credential → select printer → upload G-code with progress/cancel →
  start print → display operation state/error. Additional driver breadth,
  proactive compatibility analysis, and rich console integration follow that
  flow.

The first vertical-flow UI decision still required is whether a successful
upload always starts printing immediately or whether upload and start are
separate user actions.

### 3.9 Stage 9 — Send versus Send & Print (2026-08-27)

**Decision:** Match OrcaSlicer's send workflow with two explicit actions:

- **Send** uploads the G-code to the selected printer only.
- **Send & Print** uploads the G-code, then starts a print only after upload
  succeeds.

Consequences:

- Both actions use the same validated printer, generated G-code bytes,
  filename policy, upload progress, cancellation, and error presentation.
- `Send` completes with the remote file identifier returned by the driver; it
  must not call the print-start endpoint.
- `Send & Print` is a two-step operation. The driver uses the exact remote path
  returned by the upload response when it invokes `startPrint`.
- If upload succeeds but starting fails, the result is an explicit
  `start-failed-after-upload` state. The UI identifies that the file remains on
  the printer and offers a deliberate retry of **Start Print**; it must not
  silently upload the file again or claim that printing began.
- Cancelling applies only while an upload is in flight. Once the print-start
  request has been issued, cancellation is a separate printer `cancelPrint`
  action subject to the driver's documented semantics.
- The common API keeps `uploadGcode()` and `startPrint()` separate. A UI-level
  operation orchestrator composes them for **Send & Print**, rather than adding
a driver-specific combined endpoint.

### 3.10 Stage 10 — Web credential persistence without a master password (2026-08-27)

**Decision:** Web does not require a master password or a user-unlock flow for
printer API keys. It persists each key in browser storage under the
OrcaSlicerNeo Web origin.

Consequences:

- `BrowserPrinterCredentialRepository` uses a dedicated, versioned
  browser-storage namespace rather than adding keys to ordinary
  `UserPreferences`. Its implementation may use localStorage for the first
  vertical slice; changing to IndexedDB later is a storage implementation
  detail, not a protocol change.
- The value is not encrypted at rest by the application. Its confidentiality
  depends on the user's browser profile, device account, and the security of
  the OrcaSlicerNeo Web origin. It is therefore unsuitable for shared or
  untrusted browser profiles.
- Clearing site data, using private browsing, or changing the Web origin may
  remove credentials; the UI handles this as a request to enter the API key
  again.
- The key remains excluded from React state, ordinary preference export,
  URLs, logs, telemetry, WebView/iframe messages, and error text. It is read
  only immediately before a printer API request and is redacted from any
  diagnostics.
- The Web host sends it only in the Moonraker driver's `X-Api-Key` request
  header to the configured printer origin. It never supplies the key to the
  iframe console.

This decision is specific to browser persistence. Electron's persistent secret
storage and its behavior when OS-backed encryption is unavailable remain to be
specified.

### 3.11 Stage 11 — Plain printer configuration persistence on both hosts (2026-08-27)

**Decision:** API keys are stored as plain fields in the same JSON printer
configuration object as the printer URL. Electron does not use an OS credential
vault or encrypted fallback; it writes the object to the user's configuration
file. Web persists the equivalent object in its browser configuration storage.

```ts
interface PrinterConfigurationDocument {
  version: 1;
  printers: Array<{
    id: string;
    displayName: string;
    driverId: 'moonraker' | string;
    consoleUrl: string;
    apiBaseUrl: string;
    apiKey: string;
  }>;
}
```

Consequences:

- `PrinterCredentialRepository` is folded into a single
  `PrinterConfigurationRepository`. It persists one coherent printer record
  rather than separately reconciling a URL list and a secret store.
- Electron persists this document in the host user configuration. Web persists
  the same schema under the application origin. Neither host encrypts the
  `apiKey` field.
- The shared application consumes a redacted printer summary; the platform
  transport resolves the raw configuration record by ID only for an outbound
  printer request. The key is still excluded from normal React state, URLs,
  logging, telemetry, iframe messages, and user-facing error text.
- Printer configuration export, synchronization, and backup are out of scope.
  A later export feature must warn explicitly that the document includes API
  keys or must redact them by default.
- Removing a printer removes its complete configuration record, including its
  API key, on that host.

This stage supersedes the earlier proposed separation of an encrypted
Electron credential repository from configuration storage. It does not alter
the requirement that only built-in adapters can receive an API key through
Electron document-start injection.

### 3.12 Stage 12 — Separate endpoints; full shared configuration access (2026-08-27)

**Decision:** Users enter the embedded printer-console URL and the Moonraker
HTTP API base URL separately. The application does not derive either endpoint
from the other.

**Decision:** Shared UI code may read the complete printer configuration
record, including its API key.

Consequences:

- `consoleUrl` is used exclusively by `WebViewPanel`; `apiBaseUrl` is used
  exclusively by the selected printer API driver. Each is independently parsed
  and validated as a supported HTTP(S) endpoint.
- The create/edit-printer UI presents separate labelled fields and records
  their values unchanged after canonical URL normalization. This supports
  installations where Mainsail/Fluidd and Moonraker are served on different
  ports, paths, proxies, or hosts.
- The shared printer store/configuration context carries the full record. It
  may pass the selected record to `PrinterControlService` and Electron's
  bundled console adapter; host code is no longer the sole reader of the API
  key.
- API keys remain masked in all visual surfaces by default, never rendered in
  logs, telemetry, URLs, errors, screenshots/diagnostic bundles, or iframe
  messages. A dedicated reveal/edit interaction, if added, must require an
  explicit user action.
- This stage supersedes the Stage 11 constraint that shared React state only
  receives a redacted summary. It does not permit remote page code, a user
script, or an untrusted integration to read the configuration object.

### 3.13 Stage 13 — Multi-printer configuration and independent ephemeral selection (2026-08-27)

**Decision:** The first release supports multiple saved printer configuration
records. The embedded-console panel and the G-code send panel each have their
own independent printer selection control.

**Decision:** Neither current selection is persisted. A console selection does
not change the send target, and a send-target selection does not navigate or
reload the console panel.

Consequences:

- The configuration document's `printers` array is the authoritative list of
  saved records. Each record has a stable ID; duplicate display names are
  permitted, while duplicate IDs are rejected.
- `ConsolePanelState.selectedPrinterId` and
  `SendGcodePanelState.selectedPrinterId` are separate in-memory UI state. They
  are deliberately absent from the printer configuration document and existing
  user preferences.
- Whenever either panel is activated or its action dialog opens, it validates
  its previous selected ID against the current record list. If the record was
  deleted, the selection becomes empty; the panel does not silently choose a
  different printer.
- With an empty or invalid selection, the console panel displays a neutral
  selection prompt, and Send/Send & Print are disabled. Choosing a printer is
  always an explicit user act.
- Deleting a printer removes the record and its API key. Existing in-flight
  upload or print operations retain a snapshot of the selected configuration
  and complete or fail normally; no new operation may start from a deleted
  selection.

### 3.14 Stage 14 — Console panel is not a browser (2026-08-27)

**Decision:** The embedded printer-console panel does not expose browser
navigation controls. It has no address bar, history/back/forward buttons, stop
button, manual refresh button, or user-editable navigation target.

**Decision:** Selecting a printer in the console panel immediately loads that
record's `consoleUrl`. The panel reloads only when the selection changes or the
selected record's `consoleUrl` is edited.

Consequences:

- `WebViewPanel` is a controlled application surface rather than a general
  browsing experience. Product UI does not surface OrcaSlicer's developer-only
  navigation affordances.
- An empty selection renders a selection prompt; it does not keep displaying a
  previously selected page.
- The host implementation may internally observe navigation, reload after a
  crash, and expose lifecycle/error events to the shared panel, but it must not
  let a user browse to a different target through panel chrome.
- The configured URL is the sole top-level navigation authority. A page-initiated
  navigation policy will be specified separately; it cannot change the saved
  console URL or selected printer record.

### 3.15 Stage 15 — Universal Moonraker console API-key injection (2026-08-27)

**Decision:** Users manually select the built-in `moonraker` driver when they
configure a printer. The Moonraker adapter is also the sole first-release
console API-key injector; no separate Mainsail or Fluidd adapter selection is
required.

**Decision:** The Electron injector follows the established
`PrinterWebView::SendAPIKey` approach. A bundled document-start script wraps
the console's `window.fetch` and adds the configured `X-API-Key` header to its
requests. This makes the behavior independent of Mainsail versus Fluidd, as
both are Moonraker clients.

Consequences:

- The injector is a versioned OrcaSlicerNeo asset selected only by the built-in
  `moonraker` driver. It is not a user-authored script, a downloaded plugin, or
  a console-vendor-specific configuration choice.
- Electron registers it before the console document's own scripts execute. It
  avoids the native implementation's post-load registration and forced reload,
  while preserving the same fetch-header behavior.
- Web never injects the script; its iframe console authenticates according to
  its own normal UI/session behavior. Web's application-side Moonraker API
  calls still independently send the configured `X-API-Key` header.
- The initial vertical slice adds no additional destination-origin filtering
  around the injected fetch wrapper. Tightening request scoping, handling of
  non-fetch console transports, and broader console compatibility are deferred
  rather than prerequisites for the end-to-end flow.

This records the native behavior as the compatibility reference:
`PrinterWebView::SendAPIKey` registers a user script that wraps `window.fetch`,
sets `X-API-Key`, and reloads the page. The new Electron implementation changes
only timing and platform mechanics, not the chosen protocol behavior.

### 3.16 Stage 16 — Shared injection ownership; no page callback bridge (2026-08-27)

**Decision:** Shared application code owns the decision to inject a built-in
printer-console script. Given the selected printer configuration, it resolves
the versioned Moonraker injection asset and requests injection through the
common WebView contract.

**Decision:** The Web iframe implementation automatically ignores a requested
injection script and writes a redacted diagnostic log. It does not fail console
loading, show an error to the user, or affect application-side Moonraker HTTP
operations.

**Decision:** The first release has no page-to-application message, callback,
or RPC bridge. API-key injection and typed application-side printer HTTP
control are sufficient for the defined product flow.

Consequences:

- `@orca/slicer-app` contains the driver-to-bundled-script association and
  invokes a host-neutral `registerBuiltInScript(scriptId, context)` operation.
  The shared package does not create an Electron element, invoke Electron IPC,
  or inspect the browser host type directly.
- The Electron host resolves the registered built-in ID to its reviewed source
  and installs it at document start. The iframe host returns an ignored/
  unsupported result and logs only the driver and script identifier; it never
  logs script source or API-key values.
- The public implementation does not expose `window.wx`, `window.orca`,
  `postMessage` callbacks, guest RPC, or a remote page's ability to request a
  host method. These may be added only by a future specification amendment
  tied to a concrete printer-console requirement.
- Host-to-page raw script execution remains an Electron implementation
  capability for the reviewed built-in injector. It is not an application
  extension API and has no Web equivalent.

### 3.17 Stage 17 — Minimal common surface, default storage, and popup policy (2026-08-27)

**Decision:** The initial common WebView contract contains only the operations
the printer-console flow uses: set/load the configured console URL, register a
built-in script request, and report load/error state to the panel. It does not
attempt source compatibility with the broad native `WebViewPanel` API and does
not publicly expose general JavaScript evaluation, page callbacks, browser
history, or browser controls.

**Decision:** The first implementation uses each platform's default embedded
web storage/session behavior. It creates no explicit Electron webview partition,
cookie profile, storage migration, storage-clearing policy, or browser-side
storage workaround.

**Decision:** Page-initiated navigation remains inside the embedded console.
For an Electron new-window request, follow OrcaSlicer: open the requested URL
in the operating system's default browser and deny creation of an embedded
child guest. For a Web iframe, allow the browser to apply its ordinary
new-tab/window behavior; popup blocking or other browser policy may prevent
the request, and the Web app does not intercept or emulate it.

Consequences:

- The shared React panel is deliberately smaller than its native namesake. Its
  API grows only when a concrete product workflow requires another operation.
- Electron and Web may persist console authentication state differently under
  their defaults. The configured API key remains the reliable cross-restart
  credential for application-side Moonraker calls; no behavior relies on
  console cookies surviving.
- The Electron adapter owns conversion of a guest new-window event into an
  external-browser launch. The iframe adapter cannot reproduce that host-level
  control for a cross-origin document and treats it as best-effort browser
  behavior.
- This policy does not add general navigation chrome, does not update the
  configured `consoleUrl` after a page-driven navigation, and does not add a
  target-origin allow-list in the first slice.

### 3.18 Stage 18 — Web iframe compatibility is best effort (2026-08-28)

**Decision:** The Web console uses a plain iframe without a `sandbox`
attribute. The goal is maximum practical compatibility with a user's own
printer console, including its normal scripts, forms, authentication storage,
downloads, and browser-controlled popup behavior.

**Decision:** Web console embedding is best effort. The application does not
preflight iframe support when a printer is configured and does not make
embedded-console success a prerequisite for application-side printer control.
Browser security policy, printer-server response headers, local-network rules,
mixed-content restrictions, and individual console behavior may prevent a
console from displaying; those outcomes are handled when they occur.

Consequences:

- A plain cross-origin iframe still cannot be read, scripted, or otherwise
  controlled by the shared application. This preserves the specified Web
  no-injection behavior independently of `sandbox`.
- The existing COOP/COEP isolation needed for threaded WASM can conflict with
  third-party printer consoles that do not opt into cross-origin embedding.
  The initial feature neither requires printer owners to reconfigure their
  servers nor commits to a proxy, `credentialless` iframe, or isolation-mode
  downgrade. It attempts the configured console URL and accepts actual browser
  behavior as the first-release compatibility boundary.
- Moonraker's `cors_domains` remains useful for direct Web API requests, but
  is not assumed to make a separately served Mainsail/Fluidd console document
  embeddable under COEP. CORS and iframe embedding are distinct browser checks.
- Electron remains the complete-capability host: it can load the console,
  perform reviewed document-start API-key injection, and implement OrcaSlicer
  external-window behavior. Web degrades only the console presentation layer;
  its typed printer-control adapter still attempts direct HTTP operations.

### 3.19 Stage 19 — Device tab and printer-list workflow (2026-08-28)

**Decision:** Add a dedicated `Device` tab for printer-console management. Its
left-side toolbar contains the printer selection list and the add-printer
action. Its right-side content area contains the selected printer's common
WebViewPanel (Electron webview or Web iframe).

**Decision:** Every printer row in the left list has independent edit and
delete actions. Add and edit open the printer-configuration dialog. Deletion
requires a confirmation dialog before the record, including its stored API key,
is removed.

**Decision:** Saving a newly created printer does not select it and does not
change or reload the active console. The user chooses it explicitly from the
Device tab list afterwards.

Consequences:

- The Device tab's list selection is the previously specified independent,
  non-persisted console selection. With no selection it displays the empty
  state and does not retain a prior console.
- Editing the selected printer's `consoleUrl` reloads that selected console,
  as defined in Stage 14; editing a non-selected printer leaves the current
  console untouched.
- The destructive action is explicit despite configuration being local. This
  avoids silently losing both printer connection details and its manually
  entered API key.
- This view does not add live printer-status polling, a generic browser UI, or
  a requirement that console loading succeeds before the printer can appear in
  the list.

### 3.20 Stage 20 — Automated verification with local fixtures (2026-08-28)

**Decision:** CI uses deterministic local fixtures instead of requiring a
physical printer: a Moonraker-compatible HTTP fixture for application-side
printer control and a minimal printer-console page for embedded-view behavior.
Manual testing against a real LAN printer is supplementary rather than a CI
gate.

**Decision:** Electron's document-start API-key injection is a required real
end-to-end test, not merely an adapter unit-test mock. The fixture console
performs a same-origin `fetch` on load; the fixture server records the request
headers; a Playwright Electron test asserts receipt of the configured
`X-API-Key`.

The first verification matrix includes:

| Area | Required automated coverage |
| --- | --- |
| Printer configuration | Multiple records; add/edit/delete confirmation; API key persists in the selected platform store; Device and Send selections remain independent and non-persisted. |
| Moonraker driver | Request construction and error mapping for server information, G-code upload, and Send & Print's upload-then-start sequence, including a start failure after a successful upload. |
| Electron console | A real `<webview>` loads the fixture console; the built-in script executes at document start and adds `X-API-Key`; a new-window request follows the external-browser policy. |
| Web console | A normal iframe is rendered; a requested built-in script is ignored with a redacted diagnostic; a display failure does not disable direct printer-control actions. |
| Cross-platform UI | Device empty state, explicit selection, selected-console reload after `consoleUrl` edit, and no automatic selection after adding a printer. |

Consequences:

- Fixture assertions observe the server-side request, so they verify the guest
  page's actual behavior without relying on Playwright to inspect cross-process
  webview DOM internals.
- Tests may use a bounded readiness wait for guest load and fixture receipt;
  they must not depend on real LAN discovery, a printer, or external Internet
  access.
- Existing unit tests remain appropriate for adapter and reducer behavior, but
  cannot substitute for the Electron guest-injection test.

## 4. Questions queued for the next stages

No unresolved product-design questions are currently queued. Implementation
planning may add technical follow-ups only when a concrete repository constraint
requires a decision.
