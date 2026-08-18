# OrcaSlicerNeo: Repository Structure & Engineering Guidelines

**Architecture:** Monorepo (pnpm workspaces)
**Stack:** Electron + React + TypeScript + Vite + shadcn/ui (frontend); C++17
`libslic3r` compiled to WebAssembly via Emscripten (slicing core)
**Runtime pin:** Node + pnpm pinned via Volta (established monorepo convention)
**License:** AGPL-3.0 (fork of OrcaSlicer)

---

## 1. Executive Summary

This repository builds the next-generation OrcaSlicer desktop GUI on Electron,
reusing the C++ slicing core (`libslic3r`) by compiling it to WASM with
Emscripten. It enforces:

1. **Minimal C++ footprint:** the submodule (`packages/slicer-wasm/cpp/`) is
   modified only through `packages/slicer-wasm/patches/*.patch` or deliberate,
   documented submodule commits. All WASM-specific build logic lives in the
   scaffold (`packages/slicer-wasm/`), never in the upstream build system.
2. **One artifact, six platforms:** the same `.wasm` ships on Windows x64/arm64,
   Linux x64/arm64, macOS x64/arm64.
3. **A clean C++↔JS seam:** an extern "C", JSON-in/JSON-out bridge is the only
   interface; binary data (meshes, toolpaths) crosses as heap buffers. The JS
   client in `packages/slicer-wasm/src/client/` is the only JS that touches the
   WASM module.
4. **Documentation-first:** dated docs in `doc/`, approved designs in `spec/`
   (repo convention).

---

## 2. Repository Overview

```text
orca-slicer-neo/
├── apps/
│   └── desktop/                  # Electron app
│       ├── src/main/             # window mgmt, native dialogs, session (COOP/COEP)
│       ├── src/preload/          # contextBridge API (contextIsolation: true)
│       └── src/renderer/         # React app: shadcn/ui, zustand, react-three-fiber viewport
├── packages/
│   └── slicer-wasm/              # WASM slicer module (AGPL)
│       ├── cpp/                  # git submodule → Noisyfox/OrcaSlicer @ pinned SHA
│       ├── CMakeLists.txt        # scaffold: GLOB_RECURSE + DROP_PATTERNS + stubs/
│       ├── stubs/                # empty stubs for dropped-feature symbols
│       ├── shim/_serial.hpp      # serial TBB shim (+ parallel_pipeline stand-in)
│       ├── patches/              # .patch files applied by build.sh
│       ├── src/                  # bridge.cpp (extern "C") + slice_main.cpp (CLI)
│       ├── src/client/           # typed JS client + Web Worker glue
│       ├── harness/              # Node smoke runner + mock-module self-test
│       ├── fixtures/             # cube.stl generator, starter config.json
│       ├── build.sh              # emsdk env → patches → shim gen → emcmake → artifacts
│       └── build-boost-wasm64.sh # Emscripten Boost 1.84 build
├── doc/                          # dated engineering docs (YYYY-MM-DD-topic.md)
├── spec/                         # approved specs
├── tools/                        # dev utilities
├── scripts/                      # CI / packaging scripts
├── tests/                        # e2e (Playwright Electron) + fixtures
├── package.json                  # root scripts
└── pnpm-workspace.yaml
```

---

## 3. Document Conventions

- `doc/` — engineering docs, dated `YYYY-MM-DD-topic.md` (repo convention).
  Header block: title, date, status, scope. Current: `2026-08-12-electron-gui-rewrite-design.md`.
- `spec/` — approved designs (moved from `doc/` or written directly when approved).
- Root docs: `README.md`, `AGENTS.md` (imported by `CLAUDE.md`),
  `project_structure_and_guidelines.md` (this file).
- Any feature/design change must be reflected in `doc/`; approved → `spec/`.

---

## 4. WASM Build Guidelines

See the design doc §C++/WASM Build and the spike's README iterate loop. Key rules:

- **Iterate, don't panic:** the WASM build is expected to fail and be fixed via
  `TBB_HEADERS` (build.sh), `DROP_PATTERNS` (CMakeLists.txt), `stubs/`, or
  bridge signature drift fixes. Each failure class has a documented fix.
- **wasm64 (`-sMEMORY64`)**: builds wasm64 consistently (objects, Boost,
  link). Fallback to wasm32 + the `GCode.hpp` size_t fix only if toolchain
  issues block wasm64.
- **Serial-first**: no `-pthread` in v1; the TBB shim runs parallel primitives
  inline. Parallelism (wasmtbb + pthreads + COOP/COEP) is a later phase.
- **Formats**: STL + 3MF in v1 (STEP/OCCT dropped). Thumbnails dropped
  (`ThumbnailsGeneratorCallback` = nullptr).
- **Resources**: v1 embeds a curated preset subset (`--embed-file`); full
  `resources/profiles` bundle via `--preload-file` later.
- **Memory ownership** across the bridge: JS allocates with `_malloc`, copies
  bytes into `HEAPU8`, calls, reads result (JSON string pointer or binary
  buffer pointer+length), then `_free`s.

---

## 5. Frontend Guidelines

- **Stack**: React + TypeScript + Vite (electron-vite), Tailwind + shadcn/ui,
  zustand for state, react-three-fiber + drei for the 3D viewport.
- **Imports (code style)**: UI elements follow the shadcn alias convention —
  `@/components/ui/*` and `@/lib/utils`, never relative paths (`@` →
  `src/renderer/src`, wired in tsconfig.web.json / electron.vite.config.ts /
  vitest.config.ts). Business-logic imports (stores, slicer client, feature
  components) may stay relative.
- **Security**: `contextIsolation: true`, `nodeIntegration: false`, renderer
  talks to the OS only through the preload `contextBridge` API.
- **Process model**: WASM runs in a renderer Web Worker; binary data transfers
  to the viewport via transferable ArrayBuffers (no IPC hops).
- **Settings UI**: rendered generically from `orc_get_option_metadata()` JSON —
  never duplicate option definitions in TS.
- **i18n**: English only in v1; i18next + `.po`→JSON conversion later.

---

## 6. Testing

| Layer | Tool | Where |
|---|---|---|
| WASM module (no Electron) | Node smoke harness (MEMFS + `callMain`) | `packages/slicer-wasm/harness/` |
| Client/stores (no emsdk) | vitest + mock Emscripten module | `packages/slicer-wasm/src/client/*.test.ts` |
| Full app | Playwright (Electron) | `tests/e2e/` |

Slice cross-check: output for `fixtures/cube.stl` must be consistent with
desktop OrcaSlicer for the same profile (the spike's GO criterion).

### Required development and verification workflow

1. Work from a dedicated development branch. Before starting a new issue,
   commit verified work already in the tree so it remains a distinct change.
2. Keep changes in complete, independently testable units. Verify and commit
   each unit before moving to the next one; do not combine unrelated fixes in
   one final commit.
3. Use `pnpm` for all workspace development, unit-test, typecheck, and
   Electron e2e commands. Do not use npm or yarn. The native WASM quick build
   is the deliberate exception: use `scripts\build-windows.bat quick` on
   Windows or `scripts/build.sh quick` on macOS/Linux whenever changing the
   WASM bridge, its build scaffold, or generated artifacts.
4. Before handoff, run `pnpm test`, `pnpm typecheck`, the applicable quick
   WASM build, and `pnpm --filter desktop test:e2e`. Where the execution
   environment sandboxes Electron, obtain approval to run e2e outside that
   sandbox. Report the results, including any known intentional skips.

---

## 7. Licensing

AGPL-3.0 throughout — fork of AGPL OrcaSlicer; the Electron app, the WASM
module, and `libslic3r` all inherit the AGPL. Carry a root `LICENSE` (AGPL-3.0)
and honor source-offer obligations when distributing builds.
