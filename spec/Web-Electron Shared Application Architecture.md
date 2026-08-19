# Web–Electron Shared Application Architecture

**Date:** 2026-08-19

**Status:** Draft — active architecture review

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
2. Select bundled system printer/process/filament profiles.
3. Change the existing core settings surface.
4. Slice locally.
5. Inspect the model, sliced mesh, toolpath, layers, selection, and movement in
   the 3D viewport.
6. Download G-code.

Project persistence, user-created profiles, cloud accounts, cloud slicing,
profile updates, on-demand profile delivery, drag-and-drop import, PWA/offline
support, and richer startup recovery are intentionally deferred.

## 2. Product and Compatibility Policy

- **Web execution:** entirely local WASM. A future `SlicerEngine` extension
  point may add remote slicing, but no remote implementation is in scope.
- **Primary target:** desktop Chrome on Windows, macOS, and Linux.
- **Hard browser requirements:** WebGL 2 and wasm64. If either is absent, the
  web application shows an unsupported-environment screen and does not start.
- **WASM threading:** prefer the threaded wasm64 artifact. When cross-origin
  isolation/thread support is unavailable, automatically run a separate
  single-thread wasm64 artifact. No manual mode picker is needed. The active
  single-thread fallback is shown as a non-blocking UI status.
- **WASM artifacts:** both threaded and single-thread wasm64 builds ship with
  Electron and Web. They expose the same typed client contract.
- **Deployment:** all first-party application resources are served from one
  origin: HTML, JavaScript, Worker chunks, WASM, `.data` (if any), profile
  bundles, fonts, and images. The production web host supplies the COOP/COEP
  headers required by the threaded variant. A non-isolated deployment remains
  usable through the serial variant.
- **Rendering:** the application requires WebGL 2; WebGL 1 is not a fallback.
- **Language:** English-only initially. User-visible copy must be organized so
  a later i18n layer can replace it without reworking feature logic.
- **Mobile:** not a first-release target. Every new feature design must record
  its mobile support status, input implications, memory/performance impact,
  and whether it is supported, degraded, or deferred.
- **Static web application:** no Service Worker, installability, or guaranteed
  offline use in the first release.

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
  chrome: { kind: 'desktop' | 'web'; platform?: string };
}
```

- The Electron adapter uses native dialogs and main/preload IPC.
- The Web adapter uses browser file selection and a normal Blob download.
- Drag-and-drop will eventually be supported on both hosts through the same
  import contract, but is not a first-release feature.
- Desktop-specific title-bar/window behavior belongs to the desktop host;
  the web host supplies normal browser chrome.

## 5. Runtime and WASM Loading

`packages/slicer-wasm/src/client` remains the only JavaScript layer that calls
the C++ bridge. `slicer-runtime` owns creation of the app Worker and resolution
of runtime assets; UI features receive a typed `SlicerClient`, never module
URLs or Emscripten globals.

At startup the Web host performs capability gating before creating the app:

1. Require WebGL 2 and wasm64; otherwise render the unsupported screen.
2. If the page is cross-origin isolated and the threaded artifact is usable,
   choose the threaded wasm64 runtime.
3. Otherwise choose the serial wasm64 runtime and expose the fallback status.

The same selection mechanism is used by Electron, although its controlled
origin normally selects the threaded artifact. Browser/resource failures and
out-of-memory failures are surfaced through common error handling. No product
model-size limit is imposed in the first release.

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

The first release includes all packages and attempts to load them all before
slicer initialization. It shows package-level boot progress.

- A failed vendor package is skipped; startup continues and writes an error to
  the console. Only successfully installed packages contribute profiles.
- A failed `core` package fails initialization and logs the error. A dedicated
  recovery screen/retry action is deferred.
- Versioned immutable file names and a small manifest pointer are used so
  future independent package updates have a cache-friendly distribution path.
- The first release does **not** implement profile-package hashes, signatures,
  compatibility validation, online update checks, rollback, or on-demand
  downloading. They remain explicit follow-up work.

## 7. Preferences and Selection Restoration

System profile definitions and installation state are never duplicated into a
user configuration. The profile packages are authoritative for their content
and availability.

The shared, minimal user preference model stores only the current selections
and UI preferences:

```ts
interface UserPreferences {
  selectedProfiles: {
    printer?: string;
    print?: string;
    filament?: string;
  };
  ui: {
    sidebarWidth?: number;
  };
}
```

The identifier is the existing OrcaSlicer profile `name` field. A selection's
category (`printer`, `print`, or `filament`) supplies the necessary namespace;
no new vendor/model/variant identifier is introduced.

- Electron and Web implement the same `UserPreferencesRepository` contract.
  Electron writes a small preferences file in user data; Web uses localStorage.
- `sidebarWidth` and other common UI preferences are persisted in both hosts.
- Future host-only UI data may use platform namespaces. Shared preferences must
  not acquire Electron-only concepts.
- User-created profiles, profile-definition persistence, project data, models,
  transforms, settings edits, slice results, and G-code are not persisted in
  the first release.

On boot, after all available profiles are initialized, the runtime restores
selections through the C++ bridge in this order: printer, print, filament. It
accepts the bridge's resulting compatible combination rather than duplicating
compatibility logic in TypeScript. A missing profile name falls back to that
category's system default and logs to the console. The resolved combination is
immediately written back to preferences.

## 8. Interaction and Lifecycle

- The Web UI aims to retain the desktop application's current core features,
  not create a reduced mobile-style slicer page.
- Web G-code export triggers a standard browser file download. Electron keeps
  its native save dialog.
- Imported models and work in progress are ephemeral. Both hosts will warn
  before leaving when models or unexported results would be lost; the exact
  host confirmation mechanism is an adapter detail.
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

The refactor is not complete until all of the following hold:

1. Shared-package unit tests run with no Electron runtime.
2. Chrome Web E2E covers import, system-profile selection, slicing, preview,
   layer inspection, and G-code download.
3. A real threaded wasm64 Chrome flow verifies COOP/COEP deployment.
4. A real serial wasm64 Chrome flow verifies the fallback path.
5. Existing Electron core E2E continues to pass.

Mocks remain appropriate for fast unit/UI tests but cannot replace real WASM
verification of either artifact.

## 11. Explicitly Deferred Work

- Drag-and-drop import for Electron and Web.
- PWA, Service Worker, installation, offline guarantees, and cache migration.
- Mobile Chrome product support; every new feature must nevertheless assess it.
- Profile package validation, signatures, hashes, compatibility gates,
  independent online updates, rollback, and on-demand vendor loading.
- Cloud accounts, cloud profile delivery/synchronization, user-created profile
  persistence, and conflict resolution.
- Project/model/result/G-code persistence and project save/load.
- Remote slicing implementation.
- Rich startup error page, retry behavior, and user-visible profile fallback
  notification.
- Complete About page and expanded legal information.

## 12. Relationship to Existing Specifications

This specification extends the approved Electron GUI rewrite design in
`doc/2026-08-12-electron-gui-rewrite-design.md`. It replaces the desktop-only
assumption that the Electron renderer is the application boundary, while
preserving the existing C++ bridge rule: `packages/slicer-wasm/src/client` is
the only JavaScript layer that touches the WASM module.

Implementation work must update this specification, `spec/Grand Plan.md`, and
the high-level development plan in step with delivered milestones.
