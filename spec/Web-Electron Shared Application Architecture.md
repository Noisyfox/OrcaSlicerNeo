# Web–Electron Shared Application Architecture

**Date:** 2026-09-09

**Status:** Delivered shared architecture; current host/runtime boundaries.
Section 4.2 records delivered service-provider contracts and native host
execution and accepted development-host account flow.

**Scope:** Refactor OrcaSlicerNeo so the same application functionality can ship
as an Electron desktop application and a conventional static web application.

## 1. Decision Summary

The application will use a shared React feature layer plus thin platform hosts.
Electron is the desktop host; Vite-based `apps/web` is the static Web host. The web application runs slicing entirely in the browser through local
WASM. No models, slicing requests, or profile selections are sent to a backend
in the first release.

The first web release prioritizes the existing core flow and a largely
feature-equivalent interface:

1. Import supported models or open a 3MF project.
2. Select bundled system Printer and Process profiles; edit the native
   multi-filament rack in Prepare.
3. Change the existing core settings surface.
4. Slice locally.
5. Inspect the model, toolpath, layers, selection, and movement in the 3D
   viewport.
6. Download G-code.

Local user-preset delivery and future synchronization are owned by
[User Preset Repository and Versioning](User%20Preset%20Repository%20and%20Versioning.md).
Electron Bambu account execution has passed development-host real-account
acceptance; its scope and shared account boundary are recorded in section 4.2. Cloud
slicing, online profile updates, PWA/offline guarantees and richer startup
recovery remain deferred.
Project configuration and explicit 3MF persistence are delivered under
[Project and Scoped Configuration](Project%20and%20Scoped%20Configuration.md)
and [3MF Project Persistence](3MF%20Project%20Persistence.md).

## 2. Product and Compatibility Policy

- **Web execution:** entirely local WASM. No generalized remote-slicer
  abstraction is introduced; a future cloud capability must define a boundary
  for its concrete task instead of preemptively duplicating the WASM API.
- **Primary target:** desktop Chrome 133 or later on Windows, macOS, and
  Linux. Chrome 133 is the first supported baseline because it ships the
  required Wasm Memory64 support.
- **Hard browser requirements:** WebGL 2 and wasm64. If either is absent, the
  web application shows an unsupported-environment screen and does not start.
- **WASM threading:** prefer the threaded wasm64 artifact. When cross-origin
  isolation/thread support is unavailable, automatically run a separate
  single-thread wasm64 artifact. No manual mode picker is needed. The Web host
  shows the active single-thread fallback as a non-blocking upper-right status
  notice with a circular close control. Dismissing it hides the notice for the
  current page session and does not change runtime selection.
- **WASM artifacts:** both threaded and single-thread wasm64 builds ship with
  Electron and Web. They expose the same typed client contract.
- **Thread pool:** the threaded artifact uses all logical cores reported by
  `navigator.hardwareConcurrency`; the first release imposes no extra cap.
- **Deployment:** all first-party application resources are served from one
  origin: HTML, JavaScript, Worker chunks, WASM, `.data` (if any), profile
  bundles, fonts, and images. The production web host supplies the COOP/COEP
  headers required by the threaded variant. A non-isolated deployment remains
  usable through the serial variant.
- **Transport:** production Web deployments require HTTPS. `localhost` is the
  sole development exception; public HTTP deployment is unsupported.
- **Rendering:** the application requires WebGL 2; WebGL 1 is not a fallback.
  The shared R3F canvas requests the browser's `high-performance` WebGL
  adapter preference without requiring or naming a GPU. Electron additionally
  asks Chromium to prefer a discrete adapter at startup; normal browser,
  integrated-GPU, and software-rendering fallbacks remain valid.
- **Language:** English-only initially. User-visible copy must be organized so
  a later i18n layer can replace it without reworking feature logic.
- **Mobile:** not a first-release target. Every new feature design must record
  its mobile support status, input implications, memory/performance impact,
  and whether it is supported, degraded, or deferred.
- **Static web application:** no Service Worker, installability, or guaranteed
  offline use in the first release.
- **Development:** the normal Web development server and standard Web E2E
  environment carry COOP/COEP and exercise the full threaded path. Separate
  startup/test commands deliberately omit those headers to exercise serial
  fallback and other reduced-capability scenarios.

## 3. Workspace Shape

```text
apps/
  desktop/                 Electron main, preload, desktop adapter, entry
  web/                     Vite web host, browser adapter, entry
packages/
  slicer-app/              shared React features, stores, viewport, styles
  slicer-runtime/          Worker/WASM/profile loading orchestration
  platform-contract/       platform, preferences, and profile-source contracts
  slicer-wasm/             existing C++ bridge, WASM build, typed base client
```

These package ownership boundaries are normative. `apps/desktop/src/renderer` must not remain the de facto shared
application directory.

Both hosts use the same React, TypeScript, Vite, Tailwind/shadcn, Zustand, and
React Three Fiber stack. No SSR framework or second UI framework is introduced.
Themes, global CSS, shadcn wrappers, and application components belong to
`slicer-app`; hosts may add only narrow platform CSS, such as Electron window
drag regions.

[Application Shell](Application%20Shell.md) owns titlebar, menus, split output
action, resizable sidebar, persistent pages and diagnostic windows.
[Workspace Prepare and Preview Modes](Workspace%20Prepare%20and%20Preview%20Modes.md)
owns mode-specific navigation and scene lifetime. Both hosts share the desktop
layout with internal scrolling; mobile product support remains deferred.

Migration is an extraction and adaptation, not a rewrite of unrelated product
behavior. Existing renderer components, stores, and slicer workflows should
move substantially intact wherever they are already platform-neutral; changes
must be limited to real platform boundaries or explicitly approved behavior
corrections.

## 4. Platform Boundary

The shared application receives platform services through injected interfaces.
It must never directly access `window.orca`, Electron, Node.js, an OS file
path, or a host-specific persistence/asset API.

Standard browser UI APIs remain valid in the shared React layer: DOM events,
Web Workers, WebGL 2, pointer events, and React Three Fiber. Platform-specific
capabilities are represented by contracts such as:

```ts
interface PlatformCapabilities {
  models: {
    pick(): Promise<{ name: string; bytes: Uint8Array } | null>;
  };
  exports: {
    save(defaultName: string, bytes: Uint8Array): Promise<void>;
  };
  preferences: UserPreferencesRepository;
  runtime: SlicerRuntime;
  profiles: ProfileSource;
  chrome: {
    kind: 'desktop' | 'web';
    platform?: string;
    menuMode: 'custom' | 'native' | 'browser';
    dragRegion?: boolean;
    macSafeInset?: boolean;
  };
  menu: PlatformMenu;
  externalLinks: ExternalLinks;
}
```

- The Electron adapter uses native dialogs and main/preload IPC.
- The Web adapter uses browser file selection and a normal Blob download.
- The shared model state contains only a display name and model data. Electron
  retains an absolute source path in its host-private, in-memory session data
  for a future seamless model-reload feature; it is neither rendered by the
  common UI nor persisted in the first release. Web has no equivalent path.
  Electron separately persists project recent paths behind its host-owned
  [Home history capability](3MF%20Project%20Persistence.md#persistence-boundary);
  shared state receives opaque IDs and display metadata, including full paths
  used only as recent-menu labels. File access still resolves IDs in the host.
  Recent PNG previews
  are requested separately and extracted/cached by a dedicated Electron Node
  Worker, independent of the slicer Worker and recent/project operation queues;
  see [Home](Application%20Shell.md#home-page).
- Both hosts route file drops through the shared model/project import
  contracts; see [Model Import](Model%20Import.md).
- `BrandBar` styling uses the injected `chrome` capability rather than a
  direct `window.orca` read. Its visual component remains common, while
  Electron-only drag behavior stays in the Electron host.

### 4.1 Shared menus

The platform contract carries a versioned menu model, complete state snapshot
and guarded command dispatch. The shared app owns business availability;
Electron owns native menu placement and validated preload/main IPC. Web owns
browser download/link behavior. See [Application Shell](Application%20Shell.md).

### 4.2 Service providers and accounts

**Decision status:** The shared boundary and Electron-only Bambu native-addon
direction are selected and implementation is authorized. Step 1 delivers the
host-neutral [service-provider contracts](../packages/service-provider/src/index.ts)
and platform account-capability injection. Account and printer interfaces are
separate, with provider-owned account association. Step 2 adds common printer
provider dispatch and reactive Device/Send catalogues while retaining Moonraker
forms and console authentication. Electron now registers a Bambu account
provider; Web retains an empty account list. Step 3 delivers the host-only
native addon and
pinned artifacts. Step 4 delivers the application-owned Bambu utility, typed
read IPC, serialized local repository and real-plugin startup/shutdown. The
Home login flow, isolated official-page bridge and provider settings are
accepted on the macOS ARM64 development host with real China-region login,
logout and remembered-login restart. Other regions/challenges and real-account
authentication on the other hosts remain unverified.
Step 6 registers the same Bambu provider for both account and printer
capabilities, publishes validated Cloud account lists through the common Device
catalogue, and retains unsupported control/upload/monitoring capabilities.
LAN discovery/access are implemented and automatically accepted. Real LAN-only
device qualification is deferred.
Desktop build and packaging entry points now prepare the pinned native
resources explicitly, and the six-target CI matrix uses matching native
architectures with packaged-provider probes. Windows, Linux and macOS packages
on x64 and ARM64 all pass real-plugin startup, configuration restart and
isolated-login/system-browser handoff checks. The macOS ARM64 app also restores
the real China-region account and Cloud catalogue across normal restart.

Provider identity, account modeling and account methods belong in a shared
contract module outside `printer-control`. They must be usable by services with
no printer functionality, including future profile synchronization. The common
provider boundary must not depend on the printer domain, Electron, Node.js,
native plugin types or a vendor's authentication payloads.

Account and printer capabilities are separate interfaces. A concrete provider
offering both implements/extends both interfaces under the same provider
identity. The printer interface does not inherit the account interface, and
account support is not mandatory for a printer-only provider. Future profile
synchronization is another capability with its own domain contract; it does not
become a method on the printer service or a mandatory account capability.

Printer consumers identify the provider and its printer/route identifiers;
they do not supply or persist an account reference for discovery or printer
operations. The provider owns the association with its current account,
credential resolution, token refresh, account-change cleanup and rejection of
stale results. It publishes the resulting device/route changes through the
printer capability; consumers apply those changes without interpreting account
identity. Common account contracts support login, logout and account-state
presentation independently of printer functionality. Shared UI must not shuttle
raw tokens between capabilities. Each provider has at most one logged-in account;
different providers may be logged in concurrently. Bambu China and international
regions belong to the same provider, not two independently active providers.
Internally, Bambu account identity includes its region. Changing regions requires
logout of the current account followed by login in the other region; it does not retain
multiple regional sessions for quick switching. A cross-capability public
account-reference format is not required for this integration. Bambu persistence
follows the black-box plugin policy below. Account authentication
does not itself authorize printer binding, profile synchronization or project
changes. Profile/library transitions remain governed by
[User Preset Repository and Versioning](User%20Preset%20Repository%20and%20Versioning.md#8-storage-synchronization-and-project-interchange).

Expose Bambu login-region selection in application settings, following Orca's
[Login region preference](../packages/slicer-wasm/cpp/src/slic3r/GUI/Preferences.cpp).
Home initiates login using the saved region; it does not provide a separate
region selector. The setting belongs to the Bambu provider, while account
cleanup on region changes follows the rules below.
After login, Home shows the account avatar next to the prominent display name,
with the provider name underneath as secondary text and a default icon when the
avatar is absent or unavailable. The Bambu host loads the public image
without account credentials and supplies image data to the renderer, preserving
its content security and cross-origin isolation policies. Image loading does
not block account operations, and logout discards the image and pending load.
On first use, default to `Others` and allow login without requiring an explicit
region selection. Do not infer the region from system language or IP address.
This uses Orca's unspecified-region fallback in
[AppConfig::get_country_code](../packages/slicer-wasm/cpp/src/libslic3r/AppConfig.cpp).

Future preset synchronization has a single designated account provider, following
OrcaCloud's role in Orca. Other account providers may coexist for printer access,
but do not each synchronize presets or contribute parallel synchronized preset
libraries. This is a future capability boundary, not preset synchronization
delivery in the Bambu phase.

Account logout, whether explicitly requested or triggered by authentication
expiry under Orca's error handling, removes that account's Cloud printer routes
from Neo's saved configuration. A device with an independent LAN route remains
saved; one with no remaining routes is removed. After re-login, a successful
account-device fetch automatically restores the account's Cloud devices/routes;
the user does not add each printer again. This is local cleanup, not
cloud unbinding or deletion at the provider. Other providers' accounts and
routes remain independent. Region changes use this same logout behavior.
The printer-specific consequences are owned by
[the printer domain](Printer%20Domain%20and%20Control%20Architecture.md#21-bambu-electron-provider-design).
Plugin error handling and logout calls follow Orca's behavior; an arbitrary
transient network error is not itself an account logout.

Bambu login uses an embedded, isolated Electron login window for the official
page, with system-browser handoff and a local callback when the page requests
it, following Orca's login flow. Login is remembered automatically across normal
application shutdown/restart. Closing the application is not account logout.

Neo uses its own host-owned configuration directory for the plugin and its own
local LAN device configuration. The first delivery does not import or share an
existing Orca installation's configuration, remembered LAN access codes or
plugin session files. Users log in within Neo and enter LAN access codes on
first use; subsequent launches restore Neo's own saved state. The plugin's
private persistence remains opaque.

For the first delivery, expose the login entry point only on Home. Account
contracts and execution remain independent of the printer domain. After a
system-browser handoff, closing the Neo login window does not cancel the current
login attempt: its browser callback may still complete login, and Home then
reflects the updated account state. This follows Orca's application-owned
callback service rather than tying login completion to the window lifetime.
See [Orca's login window lifecycle](../packages/slicer-wasm/cpp/src/slic3r/GUI/WebUserLoginDialog.cpp)
and [browser callback handler](../packages/slicer-wasm/cpp/src/slic3r/GUI/HttpServer.cpp).

While a provider's login window still exists, another Home login action brings
that window to the foreground and preserves its page/input state, rather than
starting a replacement login window. If the window has been closed, create a
new one. This is an intentional host-UI difference from Orca's
[ShowUserLogin](../packages/slicer-wasm/cpp/src/slic3r/GUI/GUI_App.cpp),
which recreates the dialog. It does not change the plugin-facing login flow or
the application-owned browser callback lifetime described above.

Treat `open-bamboo-networking` as a black box. Reproduce Orca's plugin-facing
call pattern for the selected login/discovery scope: lifecycle ordering,
parameters, callback registration/dispatch, login completion, restoration,
connection, errors and logout. Electron replaces the wxWidgets host without
changing those protocol-facing semantics. Account/profile capabilities remain
separate public interfaces; this does not import Orca's combined cloud API or
its unrelated features into Neo.

The plugin owns Bambu session persistence and refresh. Provide its host-owned
configuration directory and use the exposed lifecycle/status/login/logout
functions as Orca does. Do not read or rewrite private auth files, call internal
functions or Bambu REST endpoints to bypass the plugin, replace its token
refresh policy, or change plugin-specific configuration to suppress behavior
required by the Orca call pattern. Neo may handle ABI-returned login data within
the native host as Orca does; shared UI never receives raw tokens. Normal
shutdown preserves the plugin session rather than invoking user logout.

Startup restoration and post-login connection may perform network I/O. This
explicit Bambu lifecycle decision supersedes the earlier proposed on-demand
authentication and no-background-connection restrictions for Bambu. Local
catalogue/configuration methods still do not initiate new probes themselves;
they do not promise that an already initialized plugin is network-idle.
Moonraker's request-driven behavior remains unchanged. Do not claim control,
monitoring or synchronization delivery merely because the plugin maintains a
connection internally. The Orca call sites and qualification boundary are
recorded in the printer specification.

For the first Bambu integration, the selected approach is a Node-API native
addon wrapping `open-bamboo-networking` in an Electron utility process. Native
network execution stays outside the renderer and slicing runtime. Shared UI
uses injected public capability contracts; plugin loading, browser callbacks,
plugin configuration-directory ownership and IPC belong to the Electron
implementation. Following the [application-instance boundary](Application%20Shell.md#host-and-page-lifetime),
each independent Electron application instance owns one Bambu provider utility
shared by its account and printer capabilities. Single-instance multiple main
windows and cross-instance utility sharing are not supported product behavior.
Leaving Device or closing an auxiliary window does not destroy the provider or
log out its account. Normal shutdown of that application instance closes its
provider process and releases resources while preserving remembered login.
This is separate from the slicing utility process.

The accepted control design shares persistent configuration across independent
instances while retaining separate runtime ownership. It does not introduce
per-instance profile directories or proactive cross-instance synchronization of
login/logout/account changes. New instances restore the latest persisted state;
already running instances handle their own session and any server/plugin
invalidation. See the [instance boundary](Application%20Shell.md#host-and-page-lifetime)
and [qualification sequence](Printer%20Console%20and%20Control%20Integration.md#accepted-qualification-sequence).
Concurrent storage behavior remains to be qualified. This decision does not
permit private plugin auth-file manipulation or imply that within-process
serialization protects independent processes.

Ship a fixed compatible version of `open-bamboo-networking` with the Electron
application, validated and released together with the native adapter. No
first-use plugin download or user-managed plugin installation is part of the
first delivery. Plugin updates are delivered through Neo application updates.
Use upstream precompiled release artifacts, pinning their version and file
checksums; Neo does not build the plugin from source. Follow Orca's common-header
integration: reuse its shared plugin data/callback declarations and typed
function-pointer signatures across platforms. Platform-specific code selects
the matching library artifact and resolves its symbols with the native loader;
do not create platform-specific ABI definitions or a separate per-platform
ABI/dependency qualification workstream. Normal builds and feature verification
still apply.

The first delivery targets all six existing Electron platforms: Windows x64
and ARM64, macOS Intel/x64 and Apple Silicon/ARM64, and Linux x64 and ARM64.
Each package must include matching plugin and adapter artifacts. These are
delivery targets, not a claim of completed builds or feature validation. The
upstream release is pinned to `v2.2.0`, using its `02.08.01` library series;
missing upstream binaries or
actual build/load failures remain delivery gaps, not authorization to
silently compile a replacement or drop a selected target.

For the first delivery, assume the independent provider process remains stable.
Provider-process crash handling is explicitly out of scope: do not add automatic
restart, restart backoff, a manual crash-recovery flow or a crash-recovery state
machine. This is a delivery assumption, not evidence that crashes are impossible.
Normal startup, shutdown and Orca-compatible plugin/API error handling remain
in scope; the exclusion does not remove ordinary resource cleanup.

Only Electron execution is selected for this phase. The contracts remain shared
so a later host or network service can implement them without redefining the
account or printer domain. This does not deliver a Web provider, gateway or
browser-compatible native plugin. Unsupported hosts must not advertise Bambu
execution merely because they can import its interfaces. Local Web slicing and
existing Moonraker behavior remain independent of this integration. Mobile
account/provider execution is deferred along with mobile product support.

Remaining engineering design and verification work is grouped below. It must
preserve the selected product behavior and provider ownership boundaries:

| Group | Remaining work |
| --- | --- |
| Authentication and credentials | Specify the public account methods and host request/state representation; map unavailable plugin/session state and superseded login results using Orca's applicable calls and errors. Window reuse and browser-handoff lifetime are already selected above. |
| Discovery and adoption | Specify provider-internal identity association and stale-result handling, within the selected cloud auto-enumeration, LAN access-code and route-removal behavior. Consumers do not supply account references. |
| Native host and delivery | Exact upstream binary release; ordinary build/feature verification and real-account/device acceptance. All six Electron targets are selected; use Orca's common headers and loader pattern. Orca configuration import and process crash recovery are excluded from the first delivery. |

Authentication is handled by the provider, with account summaries available
locally. The public account request/state contract is defined in the service-provider
module; native transport/state handling must respect the selected window-close behavior. The Home-only login entry point, embedded
login with external handoff, remembered login and Orca-compatible black-box
plugin execution are accepted as described above. Existing stateless
public printer access remains unchanged; internal plugin lifecycle is host-owned.

The accepted [camera follow-up](Printer%20Domain%20and%20Control%20Architecture.md#81-bambu-lan-live-view-and-shared-playback)
retains v2.2.0 and the existing Bambu utility. Native LAN reads and H.264 fMP4
remuxing stay host-side; shared HTML video/image playback receives typed media
delivery. Binary frames use a bounded document-owned channel, not normal
observation events or slicing IPC. Shared remote URL/HLS playback preserves
Web isolation and does not imply a Web-native Bambu provider or TUTK support.
Only its specification and isolated feasibility probe are currently authorized;
production camera integration and hardware qualification remain pending.

The Bambu-specific scope and feasibility limits are owned by
[Printer Domain and Control Architecture](Printer%20Domain%20and%20Control%20Architecture.md#21-bambu-electron-provider-design).
Its [implementation and acceptance sequence](Printer%20Domain%20and%20Control%20Architecture.md#22-bambu-implementation-and-acceptance-sequence)
defines eight independently reviewable increments, their dependencies and the
evidence required before each is complete. Steps 1–3 are delivered; application
Bambu Cloud enumeration and the application-owned provider
process/account flow are validated on macOS ARM64, including real
China-region login/logout/restart and Cloud devices in the common Device
surface. LAN discovery/access are implemented, with real-device qualification
deferred. Six-target packaging and packaged-provider startup are accepted;
other regions/challenges and real-account authentication on the other hosts
remain unverified.

The subsequent [Bambu monitoring/control design](Printer%20Domain%20and%20Control%20Architecture.md#23-bambu-monitoring-and-control-design)
uses one shared capability- and topology-driven React Monitor for all providers,
with H2D + AMS acceptance through the same Electron provider boundary. Observation
delivery and available controls come from the printer contract rather than a
provider-name branch in the shared application. Moonraker retains its existing
manual Refresh and basic print controls. Software implementation and fixture
regressions do not establish physical control qualification; real heating, motion
and material operations require separate acceptance.

## 5. Runtime and WASM Loading

Electron's utility-host feasibility migration is authorized under
[Native Python Plugin Architecture, section 12](Native%20Python%20Plugin%20Architecture.md#12-delivered-utility-host-and-temporary-file-boundary).
Electron runs its existing WASM session in a Node Worker inside a window-owned
utility process, connected directly to the renderer by MessagePort. Web keeps
its browser Worker. This migration adds no Python/plugin capability.
Future native Python integration is limited to Electron with the threaded WASM
runtime. Electron serial mode and both Web modes provide no Python plugin support;
falling back to serial must not initialize Python or silently skip required plugins.

`packages/slicer-wasm/src/client` remains the only JavaScript layer that calls
the C++ bridge. `slicer-runtime` owns creation of the app Worker and resolution
of runtime assets and profile installation into MEMFS; UI features receive a
typed `SlicerClient`, never module URLs or Emscripten globals. The shared UI
directly uses that client because model parsing, scene meshes, slicing, preview
data, and G-code all share its one stateful WASM/MEMFS session.

Every runtime asset URL is relative to the host/module deployment location.
No app code hardcodes an origin or root-relative asset path. This applies to
the Worker, WASM artifacts, profile manifest, and profile packages, so the
same Web build can run at a site root, a subpath, or a preview deployment.

Web resolves profile packages through the relative-URL fetch path. Electron's
utility Worker reads the same bundled package tree through `ProfileSource` and
loads the same WASM artifacts locally. Packaged WASM/data/profile assets are
asar-unpacked. Profile bytes do not pass through preload or renderer IPC.

At startup the Web host performs capability gating before creating the app:

1. Require WebGL 2 and wasm64; otherwise render the unsupported screen.
2. If the page is cross-origin isolated and the threaded artifact is usable,
   choose the threaded wasm64 runtime.
3. Otherwise choose the serial wasm64 runtime and expose the fallback status.

The same selection mechanism is used by Electron, although its controlled
origin normally selects the threaded artifact. Browser/resource failures and
out-of-memory failures are surfaced through common error handling. No product
model-size limit is imposed in the first release.

The current opaque AppConfig bridge/client path is retired: initialization no
longer accepts AppConfig JSON, and the `setAppConfig` / `getAppConfig` APIs are
removed from the shared contract. Profile selection is restored only through
`selectPreset(kind, name)` after runtime resources are ready.

## 6. Profile Resource Architecture

System profiles are runtime resources, not Emscripten `--preload-file` inputs.
A JS-side installer populates `/system` before `orc_init()`. The separate
`resources/info` directory is preloaded into `/info` when WASM is built.

```text
ProfileSource -> ProfileInstaller -> WASM MEMFS -> orc_init()
       |                |
       |                +-- materializes the bridge's expected file tree
       +-- selects where profile packages come from
```

First-release sources are static and bundled with each host. Future sources may
come from an account/cloud service without changing the C++ bridge or shared
UI. Profile persistence is distinct from profile resource delivery.

### 6.1 Package layout

Profile resources use a versioned manifest plus independent single-file ZIP
packages:

```text
profiles/
  manifest.json
  core.upstream.zip
  vendors/
    BBL.<BBL.json version>.zip
    Creality.<Creality.json version>.zip
    ...
```

`core` contains common, non-vendor resources. Each vendor ZIP mirrors the
upstream profile tree with `<Vendor>.json` and `<Vendor>/` at its root. The
vendor ZIP filename uses the `version` field in its matching `<Vendor>.json`;
the core filename remains `core.upstream.zip` for now. The installer unpacks core resources directly under `/system` and installed vendor
archive under `/profiles`. Only printer-activated vendors and the permanent
OrcaFilamentLibrary and Custom bundles are linked into `/system` for ordinary
native loading; core is always present. A small
browser-compatible archive dependency runs in the Worker.

Package membership is generated deterministically from the upstream
OrcaSlicer profile organization. The build must not carry a manually curated
vendor-file list: upstream common resources become `core`, and upstream vendor
organization defines the vendor packages. This keeps package generation
reproducible as upstream profiles are added, removed, or reorganized.

The hosts distribute all packages. Before slicer initialization the Worker
installs only core, OrcaFilamentLibrary, Custom and explicit printer-selected
vendors.
Opening Setup Wizard installs remaining packages once per runtime before
building the full catalogue; failed vendors may retry on later openings.
A shared startup screen remains visible until the WASM runtime and
required attempted package installs complete, and shows a text label for the current
startup step. Profile downloads include their current package count, such as
`Downloading profiles N/Total`. The main application is not interactive
before that point, except that Help → File Manager can inspect whichever files
are already mounted while startup continues. Its Refresh action re-reads the
current directory as installation progresses. Mandatory first-use Setup Wizard
owns the modal workspace after initialization, blocks File Manager and other
commands, and silently discards incoming file intents until completion.

Profile packaging is an independent build/CI target. A profile-content change
generates only the manifest and profile packages; it must not trigger a WASM
build. Rebuilding WASM/runtime is required only when the profile package format
or bridge/runtime interpretation of its fields changes.

- A failed vendor package is skipped; startup continues and writes an error to
  the console. Only successfully installed packages contribute profiles.
- A failed `core` package or WASM initialization fails startup and logs the
  error; the host does not enter the main application. Help → File Manager
  remains available to inspect the mounted filesystem. A dedicated recovery
  screen and startup retry action are deferred.
- Versioned immutable file names and a small manifest pointer are used so
  future independent package updates have a cache-friendly distribution path.
- The first release does **not** implement profile-package hashes, signatures,
  compatibility validation, online update checks, or rollback.
  They remain explicit follow-up work.

The Printer and Process pickers list native-visible profiles from activated
printer vendor packages. The native snapshot also exposes the activated,
compatible `filament_catalog` consumed by the Prepare rack. The temporary Setup
Wizard catalogue independently parses all `/profiles` vendor packages on open,
then releases that native bundle on close. Neo WASM neither reads nor generates
vendor `.opc` caches. These policies are owned by
[Setup Wizard and Profile Activation](Setup%20Wizard%20and%20Profile%20Activation.md).
The AppConfig-derived “Not installed” state and any single-filament picker are
removed. Wizard candidates are presented after remaining package delivery;
no downloadable-but-not-installed rack state is introduced.

## 7. Preferences and Selection Restoration

System profile definitions and installation state are never duplicated into a
user configuration. The profile packages are authoritative for their content
and availability.

The shared user preference model stores activation references, current
selections and UI preferences; it stores no complete system preset data:

```ts
interface UserPreferences {
  version: 1;
  profileActivation?: {
    models: Array<{ vendor: string; model: string; nozzle_diameter: string[] }>;
    filaments: string[];
  };
  selectedProfiles: {
    printer?: string;
    print?: string;
  };
  rememberedFilamentRacks?: Record<string, {
    version: 1;
    slots: Array<{
      preset: string;
      colour: string;
      native: { representative: string | null; multiColour: string | null; type: string | null };
    }>;
  }>;
  ui: {
    sidebarWidth?: number;
    deviceSidebarWidth?: number;
    switchToDeviceAfterSend?: boolean;
  };
}
```

The identifier is the existing OrcaSlicer profile `name` field for Printer and
Process. Filament preset names belong to the remembered rack and project slot
state; they are not global selections.

- Electron and Web implement the same `UserPreferencesRepository` contract.
  Electron writes a small preferences file in user data; Web uses localStorage.
- A malformed, unreadable, or unsupported preference version is discarded and
  replaced with defaults. The first release has no migration implementation.
- Read failure uses normalized in-memory defaults and logs the failure. Write
  failure rejects the repository operation without publishing the unsaved
  in-memory value. Ordinary UI preference mirrors remain best effort. Setup
  must persist normalized activation before applying it, so its save failure
  keeps selection editable and its application failure retries the saved
  preparation. Before native preparation, the typed client publishes target
  vendor links (including permanent OrcaFilamentLibrary and Custom). Preparation
  uses a fresh candidate `PresetBundle::apply_vendor_config`, preserving its
  existing interface, with overwrite enabled and current Printer seeded in
  AppConfig. Only live vendor metadata is value-copied for the inline pre-load
  rule. Normal library loading resets it; absent-library metadata retention
  follows native behavior without copying old presets/project collections. Both variants disable native installation
  with `ORC_NEO_WASM`; the client already manages links.
  The API owns writable loading, first active-filament correction and selection
  export. Native logs/exceptions remain the diagnostic path. Preparation/save
  failures leave the live project, bundle and history unchanged, but links and
  directory/corrected/discarded preset-file side effects persist through failures
  and cancellation; restart rebuilds links from saved activation. Apply uses the
  prepared bundle without relinking or reparsing resources. There is no
  cross-storage rollback.
- `sidebarWidth`, `deviceSidebarWidth`, `switchToDeviceAfterSend`, and other
  common UI preferences are persisted in both hosts. The send-navigation
  preference defaults to `true`; older documents that lack it are migrated to
  that default by normalization.
- Future host-only UI data may use platform namespaces. Shared preferences must
  not acquire Electron-only concepts.
- Preferences do not store project data, models, transforms, settings edits,
  generated slice results or G-code. Explicit 3MF saves persist the supported
  project inputs through the project-persistence contract. User-created profile
  repositories and generated-result persistence remain deferred.

On boot, saved activation is loaded before runtime initialization, and the
client links its printer vendors plus OrcaFilamentLibrary and Custom for native
loading.
Missing activation or no usable real printer presents mandatory setup before
restoring remembered selections/racks. After configured startup, the runtime restores
Printer and Process through the C++ bridge in that order. It accepts the
bridge's resulting compatible combination rather than duplicating compatibility
logic in TypeScript. A missing profile name falls back to the native default
and logs to the console; if no default is usable, it falls back to the first
profile returned by the bridge. For a new project, the selected Printer's
remembered rack is then applied through the typed multi-filament session
command. An opened project owns its rack and takes priority over that seed.
Only the resolved Printer/Process names are written to `selectedProfiles`.

Printer and Process selection follow native compatibility and project-owned
configuration rules. Representable local overrides are retained; Printer/Filament
drafts and native Print children keep their distinct owners. Rack edits use
atomic session commands and never update `selectedProfiles`.

## 8. Interaction and Lifecycle

Web exports through browser downloads; Electron uses native save dialogs.
[3MF Project Persistence](3MF%20Project%20Persistence.md) owns explicit saves,
project replacement, dirty protection and host close/navigation behavior.
[Per-Plate Print Architecture](Per-Plate%20Print%20Architecture.md) owns input
invalidation, retained native outputs, cancellation and preview receipts.
Only affected plate presentations become unavailable after a committed edit.
Stale receipts are never rendered or exported.

A visible source-code link satisfies the release's source-offer entry point;
a fuller About surface remains deferred.

## 9. Release, Cache, and Versioning

The shared UI, WASM core, and system profile resource manifest are versioned as
one compatibility set. Electron and Web are independently built and deployed;
Web may ship UI-only fixes independently, but must not silently change its
WASM/profile compatibility set.

The profile manifest and package URLs are runtime assets supplied by each host.
This permits future independent vendor-package release workflows without
changing the common application or C++ bridge.

## 10. Required Verification

The following list is release/milestone acceptance evidence. It is not the
default edit-loop or per-commit matrix; routine execution follows
`doc/testing_guidelines.md` and selects the smallest test set
that covers the changed risk. The refactor is not complete until all of the
following hold:

1. Shared-package unit tests run with no Electron runtime.
2. Chrome Web E2E covers import, system-profile selection, slicing, preview,
   layer inspection, and G-code download.
3. A real threaded wasm64 Chrome flow verifies COOP/COEP deployment.
4. A real serial wasm64 Chrome flow verifies the fallback path.
5. Existing Electron core E2E continues to pass.

Routine Chrome E2E may use compact profile fixtures that preserve upstream
profile organization, keeping the feedback cycle small. A profile-package
integration test and a release/overnight smoke run must instead boot the full
manifest and every vendor package.

Mocks remain appropriate for fast unit/UI tests but cannot replace real WASM
verification of either artifact.

For routine development, shared application behaviour is exercised end to end
in one primary host. The other host validates its platform seam, and the second
WASM variant validates selection/fallback plus a focused real slice path. The
complete cross-host and threaded/serial matrix above runs for release,
milestone acceptance, overnight regression, or an explicitly documented
high-risk task gate.

## 11. Explicitly Deferred Work

- PWA, Service Worker, installation, offline guarantees, and cache migration.
- Mobile Chrome product support; every new feature must nevertheless assess it.
- Profile package validation, signatures, hashes, compatibility gates,
  independent online updates and rollback.
- Cloud account execution (Electron Bambu login has a selected design in
  section 4.2), cloud profile delivery/synchronization and cloud conflict
  resolution. Local user-preset persistence is delivered under its own
  [specification](User%20Preset%20Repository%20and%20Versioning.md).
- Generated G-code/result persistence; explicit project input persistence
  and drag-and-drop are already delivered.
- Remote slicing implementation.
- Serial-runtime in-progress slicing cancellation; threaded cancellation
  follows the delivered per-plate task contract.
- A rich startup error page, startup retry behavior, and user-visible profile
  fallback notification. The diagnostic File Manager remains available during
  startup and after failure.
- Complete About page and expanded legal information.

## 12. Related specifications

The shared-host migration is complete. No legacy AppConfig bridge, parallel
single-filament selection API or compatibility adapter is retained.
[Grand Plan](Grand%20Plan.md) owns current delivery status;
[documentation index](../doc/README.md) links the topic specifications.
