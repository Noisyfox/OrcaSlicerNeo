# WASM File Manager

**Date:** 2026-09-28

**Status:** In progress

**Scope:** Inspect and download files from the active Emscripten filesystem in the shared Web/Electron application.

## Accepted behavior

- Help contains **File Manager…**. It becomes available after the WASM runtime is ready and opens one non-modal floating window. Reopening the command raises the existing window.
- The window stays above the application's other panels, supports dragging by its title bar and resizing from a visible handle, and remains usable within the viewport. It does not block interaction with the application behind it.
- The title area shows the current absolute Emscripten path. The directory listing has exactly two columns: **Name** and **Size**. Its first row is `../`; at `/` that row is disabled. Directory names end in `/`.
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

- Prove directory traversal, size metadata, root-parent behavior, and file-byte reads at the typed client boundary.
- Prove the Help command and generic download boundary in both host adapters.
- Prove window navigation, drag, resize, close/reopen, and file download in a focused primary-host interaction.
