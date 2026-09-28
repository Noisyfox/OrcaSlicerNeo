# WASM File Manager

**Date:** 2026-09-28

**Status:** Accepted

**Scope:** Inspect and download files from the active Emscripten filesystem in the shared Web/Electron application.

## Accepted behavior

- Help contains **File Manager…**. It is available during startup, after startup failure, and after the WASM runtime is ready. It opens one non-modal floating window; reopening the command raises the existing window.
- The window stays above the application's other panels, supports dragging by its title bar and resizing from a visible handle, and remains usable within the viewport. It does not block interaction with the application behind it.
- The title area shows the current absolute Emscripten path. The directory listing has exactly two columns: **Name** and **Size**. Its first row is `../`; at `/` that row is disabled. Directory names end in `/`.
- A visible **Refresh** title-bar action re-reads the current directory. It lets users inspect files mounted during startup and retry after a transient listing error without closing the window.
- Disabled rows do not show hover styling or a pointer cursor.
- The listing uses the shared shadcn `Table` primitives while preserving the existing scroll viewport, sticky header, row navigation, keyboard activation, and download behavior.
- Components import `cn()` directly from the standalone shadcn `cn` package, matching the generated shadcn UI components.
- Double-clicking `../` navigates to the parent; double-clicking a directory
  enters it; double-clicking a regular file asks the host to download it under
  its exact file name and bytes, without inferring a file type or adding an
  extension. File sizes are shown in bytes. Directory sizes are left blank.
- Filesystem operations run through the typed Worker client. The shared UI does not access the Emscripten module directly. Web uses a browser download; Electron uses a native save dialog.
- A failed listing or download shows an error in the window without losing the current path. Closing and reopening the window starts at `/`.

## Boundaries

- The manager provides navigation and download for the current session's filesystem contents. Filesystem modification is outside this feature.
- The window is topmost within the application. The Web host has no operating-system window to place above other applications.
- Desktop pointer and keyboard access are supported. Mobile use is deferred under the shared application's desktop-browser policy.
- Directory listings return metadata only. File bytes cross the Worker boundary only when a user requests a download; large-file memory behavior follows the existing binary export boundary.

## Verification

- The focused File Manager unit tests cover root navigation, directory and file rows, exact download name/bytes, failed listing/download state, keyboard and pointer move/resize, and viewport containment.
- Shared menu, command, and host-adapter suites pass for the Help command and download boundary. Affected package suites pass: slicer-app 86 files/676 tests, desktop 11 files/71 tests, and platform-contract 2 files/15 tests. Typechecks pass for slicer-app, desktop, platform-contract, and web.
- The Web Playwright test passes against the real Worker runtime, covering menu open, navigation, reopening/focus while already open, drag, resize, containment, and close/reopen at `/`. It also downloads the bundled `/info/nozzle_info.json` through the browser host and checks the exact filename, downloaded byte count against the listed size, and JSON contents. Open menubar popovers remain interactive above the floating window.
- The focused Electron Playwright test passes for Help open, navigation, drag, resize, containment, and close/reopen at `/`. The Electron e2e build and renderer CSS smoke check pass.
- Independent acceptance reran repository tests and typechecks, the real-Worker Web download E2E, the focused Electron E2E, renderer CSS smoke, and the complete branch diff check; all passed.
- After adopting shadcn `Table` and the standalone `cn` package, the slicer-app suite passes (87 files/678 tests), slicer-app/desktop/web typechecks pass, and the focused real-Worker Web File Manager E2E passes. The File Manager unit test checks the Table markup, sticky header, scroll ownership, and existing navigation/download behavior.
- The disabled-row hover regression is covered by the focused File Manager suite (5 tests); the slicer-app typecheck and focused real-Worker Web File Manager E2E pass.
