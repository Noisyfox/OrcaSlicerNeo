# Web–Electron Shared Application Architecture

**Date:** 2026-09-09

**Status:** Approved — implementation basis; multi-filament boundary closed at
`07f276d`

**Scope:** Refactor OrcaSlicerNeo so the same application functionality can ship
as an Electron desktop application and a conventional static web application.

## 1. Decision Summary

The application will use a shared React feature layer plus thin platform hosts.
Electron remains the desktop host; a new Vite-based `apps/web` becomes the web
host. The web application runs slicing entirely in the browser through local
WASM. No models, slicing requests, or profile selections are sent to a backend
in the first release.

The first web release prioritizes the existing core flow and a largely
feature-equivalent interface:

1. Load STL/3MF.
2. Select bundled system Printer and Process profiles; edit the native
   multi-filament rack in Prepare.
3. Change the existing core settings surface.
4. Slice locally.
5. Inspect the model, toolpath, layers, selection, and movement in the 3D
   viewport.
6. Download G-code.

User-created profiles, cloud accounts, cloud slicing, profile updates, on-demand
profile delivery, PWA/offline support, and richer startup recovery are
intentionally deferred. Project persistence and 3MF drag-and-drop are approved
as a subsequent independent milestone under `spec/3MF Project Persistence.md`.

Temporary slicer setting overrides remain usable during a running session, but
are not persisted in either host during the first release.

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

The exact package names may change during implementation, but these boundaries
are normative. `apps/desktop/src/renderer` must not remain the de facto shared
application directory.

Both hosts use the same React, TypeScript, Vite, Tailwind/shadcn, Zustand, and
React Three Fiber stack. No SSR framework or second UI framework is introduced.
Themes, global CSS, shadcn wrappers, and application components belong to
`slicer-app`; hosts may add only narrow platform CSS, such as Electron window
drag regions.

The common app includes a visually shared `BrandBar`. In custom Electron and
browser menu modes, it places the Orca icon at the left beside the shared menu.
Native macOS menu mode hides both the icon and renderer menu, while retaining
the traffic-light safe inset and draggable area. Electron supplies drag-region
styling; Web renders the branded bar without a drag region, native-window inset,
or window controls. This preserves the intentional Electron frameless design
without making it a Web-only or desktop-only component.

The first-release Web layout is a desktop layout that adapts fluidly to the
viewport size: it retains the complete layout at any window size, shrinking
the settings panel and 3D viewport to fit (each scrolls internally when
constrained) with no fixed minimum viewport. It must not claim partial
responsive/mobile support.

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
- Drag-and-drop will eventually be supported on both hosts through the same
  import contract, but is not a first-release feature.
- `BrandBar` styling uses the injected `chrome` capability rather than a
  direct `window.orca` read. Its visual component remains common, while
  Electron-only drag behavior stays in the Electron host.

### 4.1 Shared titlebar menu and native-menu boundary

The shared application owns one ordered, host-neutral File/Help menu model and
one complete versioned state snapshot. The model contains Add Model, Clear
Scene, Slice, Export G-code, and the Help → AGPL-3.0 source operation. The
source operation is a fixed external-link boundary; neither shared code nor a
host adapter accepts an arbitrary URL.
This menu scope does not include View, gizmo, Add Cube/Add Primitive, or
keyboard-shortcut entries.

The state projection is authoritative for both rendered and native surfaces:
File business actions are disabled until boot is ready, Clear Scene and Slice
also require a model, Export G-code requires a completed slice result, and Add
Model, Clear Scene, Slice, and Export G-code are all disabled while slicing.
Help → source remains enabled once the menu surface exists. The command
dispatcher re-checks the complete snapshot immediately before execution, so a
stale pointer or native-menu selection cannot bypass these guards.

Host placement is deliberately platform-specific while the model and state
remain shared:

- Web renders the browser titlebar menu and never exposes Quit/Exit.
- Windows/Linux Electron renders File/Help in the custom frameless titlebar,
  includes Exit, and marks menu controls `no-drag` so pointer activation does
  not interfere with window dragging or window controls.
- macOS Electron renders no duplicate File/Help controls in the shared
  titlebar. The main process installs exactly one native File/Help application
  menu, including Quit, and updates its enabled/checked state from the same
  full snapshot.

The Electron preload exposes only typed model/state synchronization, native
command events, the host Quit operation, and the fixed source operation. The
main process validates version, menu shape, state fields, and command IDs;
malformed updates fall back to startup-disabled state. Web's adapter keeps the
same contract with browser `window.open` semantics for the fixed source URL.

## 5. Runtime and WASM Loading

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

In the first release, both hosts resolve profile packages through this same
relative-URL fetch path. Electron bundles the packages with its renderer
assets and its existing restricted loopback HTTP server serves them to the
Worker; Web serves the equivalent static files. The Worker never receives
profile bytes through preload/IPC or direct Node filesystem access. Electron
may introduce an optimized source later behind the `ProfileSource` contract.

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
The C++ bridge and `libslic3r` keep seeing their existing virtual filesystem
layout (for example `/system` and `/info`); a JS-side installer populates that
layout before `orc_init()`.

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
  core.<version>.zip
  vendors/
    bambu-lab.<version>.zip
    creality.<version>.zip
    ...
```

`core` contains common, non-vendor resources. Each vendor package retains its
profile file tree. A small browser-compatible archive dependency runs in the
Worker and unpacks packages into MEMFS.

Package membership is generated deterministically from the upstream
OrcaSlicer profile organization. The build must not carry a manually curated
vendor-file list: upstream common resources become `core`, and upstream vendor
organization defines the vendor packages. This keeps package generation
reproducible as upstream profiles are added, removed, or reorganized.

The first release includes all packages and installs every package before
slicer initialization; it does not defer a vendor package until profile
selection. A shared startup screen remains visible until the WASM runtime and
all attempted package installs complete, and shows a text label for the current
startup step. Profile downloads include their current package count, such as
`Downloading profiles (N/Total)...`. The main application is not interactive
before that point.

Profile packaging is an independent build/CI target. A profile-content change
generates only the manifest and profile packages; it must not trigger a WASM
build. Rebuilding WASM/runtime is required only when the profile package format
or bridge/runtime interpretation of its fields changes.

- A failed vendor package is skipped; startup continues and writes an error to
  the console. Only successfully installed packages contribute profiles.
- A failed `core` package or WASM initialization fails startup and logs the
  error; the host does not enter the main application. A dedicated recovery
  screen/retry action is deferred.
- Versioned immutable file names and a small manifest pointer are used so
  future independent package updates have a cache-friendly distribution path.
- The first release does **not** implement profile-package hashes, signatures,
  compatibility validation, online update checks, rollback, or on-demand
  downloading. They remain explicit follow-up work.

The first-release Printer and Process pickers list only profiles that were
successfully installed from profile packages. The native snapshot also exposes
the installed, compatible `filament_catalog` consumed by the Prepare rack.
The AppConfig-derived “Not installed” state and any single-filament picker are
removed; a future on-demand delivery feature may add an explicit
downloadable-but-not-installed state without changing the rack contract.

## 7. Preferences and Selection Restoration

System profile definitions and installation state are never duplicated into a
user configuration. The profile packages are authoritative for their content
and availability.

The shared, minimal user preference model stores only the current selections
and UI preferences:

```ts
interface UserPreferences {
  version: 1;
  selectedProfiles: {
    printer?: string;
    print?: string;
  };
  rememberedFilamentRacks?: Record<string, {
    version: 1;
    slots: Array<{ preset: string; colour: string }>;
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
- If either repository cannot read or write (for example, disabled Web storage,
  quota exhaustion, or an Electron file I/O failure), the application continues
  with in-memory preferences for that session and logs the failure to the
  console. Preferences never block startup or slicing; the first release has
  no dialog, retry, or recovery flow.
- `sidebarWidth`, `deviceSidebarWidth`, `switchToDeviceAfterSend`, and other
  common UI preferences are persisted in both hosts. The send-navigation
  preference defaults to `true`; older documents that lack it are migrated to
  that default by normalization.
- Future host-only UI data may use platform namespaces. Shared preferences must
  not acquire Electron-only concepts.
- User-created profiles, profile-definition persistence, project data, models,
  transforms, settings edits, slice results, and G-code are not persisted in
  the first release. Settings edits remain active only for the current session.

On boot, after all available profiles are initialized, the runtime restores
Printer and Process through the C++ bridge in that order. It accepts the
bridge's resulting compatible combination rather than duplicating compatibility
logic in TypeScript. A missing profile name falls back to the native default
and logs to the console; if no default is usable, it falls back to the first
profile returned by the bridge. For a new project, the selected Printer's
remembered rack is then applied through the typed multi-filament session
command. An opened project owns its rack and takes priority over that seed.
Only the resolved Printer/Process names are written to `selectedProfiles`.

Selecting a system Printer or Process clears all temporary slicer-setting
overrides for the current session. Rack edits use their own atomic session
commands and never update `selectedProfiles`.

## 8. Interaction and Lifecycle

- The Web UI aims to retain the desktop application's current core features,
  not create a reduced mobile-style slicer page.
- Web G-code export triggers a standard browser file download. Electron keeps
  its native save dialog.
- The approved `spec/3MF Project Persistence.md` milestone supersedes the
  original geometry-only 3MF-import and ephemeral-work assumptions here. It
  defines project configuration restoration, explicit BBS 3MF persistence,
  dirty-session protections, and the host-specific Electron/Web save flows.
- Web uses the browser's native `beforeunload` confirmation for close, reload,
  and navigation away; browsers may not show custom detail. Electron may use a
  native host confirmation. Neither host offers saving or restoration in this
  first-release flow.
- Any change to slice inputs invalidates the current result: profile selection,
  temporary settings, model import/clear, and model transforms all require a
  new slice. On invalidation the toolpath and layer state are immediately
  cleared, export is disabled, and the common status indicates that re-slicing
  is required. Stale preview data is never rendered.
- A first-release AGPL source-code link is present in a visible footer or menu,
  pointing to the source corresponding to the web release. A fuller About page
  is deferred.

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
  independent online updates, rollback, and on-demand vendor loading.
- Cloud accounts, cloud profile delivery/synchronization, user-created profile
  persistence, and conflict resolution.
- Project persistence and 3MF drag-and-drop are tracked as approved pending
  work in `spec/3MF Project Persistence.md`; generated G-code/result
  persistence remains outside that milestone's first-release scope.
- Remote slicing implementation.
- In-progress slicing cancellation. The existing bridge capability is not
  exposed through the first-release UI; a future design must define reliable
  behavior for both threaded and serial WASM artifacts.
- Rich startup error page, retry behavior, and user-visible profile fallback
  notification.
- Complete About page and expanded legal information.

## 12. Migration Sequence

Migration proceeds as small independently verifiable steps, keeping Electron
usable throughout:

1. Define the platform contracts and make the Electron renderer use an
   Electron adapter instead of directly calling `window.orca`; do not move UI
   in this step.
2. Extract platform-neutral renderer UI and runtime code into the shared
   packages without redesigning unrelated stores or slicer workflows.
3. Move profile delivery from Emscripten preload files to the portable package
   runtime, first preserving Electron behavior and smoke coverage.
4. Add the Web host and browser adapter, then validate the shared core flow.
5. Add dual-wasm capability selection and the required real-artifact E2E
   coverage before declaring the refactor complete.

Each step must have a focused verification target and a separate commit. The
migration is complete: the shared preference/profile contracts are the only
application boundary, and no legacy AppConfig bridge, single-filament
selection path, compatibility shim, or data migration is retained.

## 13. Relationship to Existing Specifications

This specification extends the approved Electron GUI rewrite design in
`doc/2026-08-12-electron-gui-rewrite-design.md`. It replaces the desktop-only
assumption that the Electron renderer is the application boundary, while
preserving the existing C++ bridge rule: `packages/slicer-wasm/src/client` is
the only JavaScript layer that touches the WASM module.

The multi-filament contract is defined by
[`Multi-Filament Support.md`](Multi-Filament%20Support.md). Implementation work
must update this specification, `spec/Grand Plan.md`, and the high-level
development plan in step with delivered milestones. The complete dual-variant
acceptance runner is bounded by 120 seconds; developer runs may select
`--threaded-only`, while release acceptance runs both variants.
