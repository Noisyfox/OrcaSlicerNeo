# M9 Step 4 — Static Web Host

**Date:** 2026-08-20  
**Status:** Implemented and verified  
**Scope:** Add the Vite static Web host and browser platform adapter while
keeping Electron's host and runtime behavior unchanged.

The Web entry gates startup on WebGL 2 and wasm64 support, injects browser file
selection/download and in-memory preferences, and uses the shared application
and runtime packages. Browser resources remain deployment-base relative. The
Web host deliberately does not add drag-and-drop, persistence, cloud/backend
calls, PWA behavior, or the dual-artifact Chrome E2E covered by Step 5.

Verification: `pnpm --filter web test` (2 passed), `pnpm --filter web build`,
`pnpm test` (all workspace tests passed), `pnpm typecheck`, and Electron E2E
(3 passed, 1 intentional skip: rejecting-model error test). The WASM quick
build and real threaded/serial Chrome E2E remain Step 5 work.
