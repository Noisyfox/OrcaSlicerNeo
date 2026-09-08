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
2. **One bridge, many hosts:** the same extern "C" bridge ships as two wasm64
   variants — `threaded` (upstream oneTBB + pthreads; selected when the host is
   cross-origin isolated) and `serial` (TBB shim fallback) — on Windows
   x64/arm64, Linux x64/arm64, macOS x64/arm64, and the static Web host.
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
│   ├── desktop/                  # Electron host
│   │   ├── src/main/             # window mgmt, native dialogs, session (COOP/COEP)
│   │   ├── src/preload/          # contextBridge API (contextIsolation: true)
│   │   ├── src/renderer/         # thin entry: shared app + Electron adapter
│   │   └── e2e/                  # Playwright Electron specs
│   └── web/                      # static Web host (Vite)
│       ├── src/                  # entry + browser adapters (file picker / Blob,
│       │                         #   localStorage preferences, capability gate)
│       └── e2e/                  # Playwright Chrome specs (threaded + serial)
├── packages/
│   ├── slicer-app/               # shared React UI: components, stores, viewport,
│   │                             #   styles (host-free; import-direction guard)
│   ├── slicer-runtime/           # shared runtime: Worker/WASM asset resolution,
│   │                             #   profile installation, startup gate
│   ├── platform-contract/        # injected platform contracts (models, exports,
│   │                             #   preferences, runtime, chrome) + context
│   ├── profile-resources/        # deterministic profile package build
│   │                             #   (manifest + core/vendor ZIPs)
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
│       ├── build.sh / build.bat  # emsdk env → patches → shim gen → emcmake → artifacts
│       └── build-boost-wasm64.sh # Emscripten Boost 1.84 build
├── doc/                          # dated engineering docs (YYYY-MM-DD-topic.md)
├── spec/                         # approved specs
├── tools/                        # dev utilities
├── scripts/                      # CI / packaging scripts (incl. build-wasm-dual.*,
│                                 #   stage.mjs, web/desktop e2e runners)
├── package.json                  # root scripts
└── pnpm-workspace.yaml
```

---

## 3. Document Conventions

- `doc/` — engineering docs, dated `YYYY-MM-DD-topic.md` (repo convention).
  Header block: title, date, status, scope. Approved designs move to `spec/`;
  the current normative design is `spec/Web-Electron Shared Application
  Architecture.md`.
- `spec/` — approved designs (moved from `doc/` or written directly when approved).
- Root docs: `README.md`, `AGENTS.md` (imported by `CLAUDE.md`),
  `project_structure_and_guidelines.md` (this file).
- Any feature/design change must be reflected in `doc/`; approved → `spec/`.

### Single-document feature record

Start each feature or task with one dated, living task document. Update that
same document throughout discovery, decisions, implementation, and
verification; do not create a separate document for each phase. It records
only the current, accepted product behaviour and decisions, not superseded
options, implementation diary entries, bridge details, or test-run logs.

When the feature is approved, promote that same record to `spec/` (or create
it there when approval is already known) and remove any temporary or
superseded task notes in the same change. Create a separate document only when
it is an independently useful, enduring operator or architecture reference.

---

## 4. WASM Build Guidelines

See the design doc §C++/WASM Build and the spike's README iterate loop. Key rules:

- **Iterate, don't panic:** the WASM build is expected to fail and be fixed via
  `TBB_HEADERS` (build.sh), `DROP_PATTERNS` (CMakeLists.txt), `stubs/`, or
  bridge signature drift fixes. Each failure class has a documented fix.
- **wasm64 (`-sMEMORY64`)**: builds wasm64 consistently (objects, Boost,
  link). Fallback to wasm32 + the `GCode.hpp` size_t fix only if toolchain
  issues block wasm64.
- **Dual-variant**: the production build produces two wasm64 variants in
  separate CMake/output trees — `threaded` (upstream oneTBB + pthreads;
  selected at runtime when the host is cross-origin isolated) and `serial`
  (the TBB shim, no pthreads). Both share one bridge/client contract.
- **Formats**: STL + 3MF in v1 (STEP/OCCT dropped). Thumbnails dropped
  (`ThumbnailsGeneratorCallback` = nullptr).
- **Profile resources**: system profiles ship as versioned ZIP packages
  (manifest + core/vendor) built deterministically by
  `packages/profile-resources`; a Worker-side installer materializes them
  into MEMFS before `orc_init()`. No `--preload-file` profile bundle.
- **Memory ownership** across the bridge: JS allocates with `_malloc`, copies
  bytes into `HEAPU8`, calls, reads result (JSON string pointer or binary
  buffer pointer+length), then `_free`s.

---

## 5. Frontend Guidelines

- **Stack**: React + TypeScript + Vite (electron-vite for Electron, plain Vite
  for Web), Tailwind + shadcn/ui, zustand for state, react-three-fiber + drei
  for the 3D viewport. One shared app (`packages/slicer-app`) with thin hosts
  (Electron / Web).
- **Imports (code style)**: UI elements follow the shadcn alias convention —
  `@/components/ui/*` and `@/lib/utils`, never relative paths (`@/*` resolves
  per package: `packages/slicer-app` maps it to its own `src/`, and the hosts
  map it to `packages/slicer-app/src`). Shared packages must never import a
  host, Electron, Node, or an absolute path — enforced by
  `packages/slicer-app/src/import-direction.test.ts`. Business-logic imports
  (stores, slicer client, feature components) may stay relative.
- **Platform boundary**: the shared app receives platform services through
  injected contracts (`packages/platform-contract`); it never touches
  `window.orca`, Electron, Node.js, or a host persistence/asset API directly.
  Electron: `contextIsolation: true`, `nodeIntegration: false`, renderer talks
  to the OS only through the preload `contextBridge` API.
- **Process model**: WASM runs in a Web Worker; binary data transfers to the
  viewport via transferable ArrayBuffers (no IPC hops). The runtime
  (`packages/slicer-runtime`) selects the `threaded` artifact only when the
  host is cross-origin isolated, otherwise the `serial` fallback (shown as a
  non-blocking status).
- **Settings UI**: rendered generically from `orc_get_option_metadata()` JSON —
  never duplicate option definitions in TS.
- **Top-level page lifetime**: every application tab/page remains mounted for
  the lifetime of the ready application. Inactive pages must be made
  layout-neutral and inaccessible (for example, `hidden` and `inert`) rather
  than unmounted. This preserves expensive WebGL/Worker-backed state and makes
  tab switching immediate; it applies to Home, Prepare, Preview, Device, and
  future top-level pages.
- **i18n**: English only in v1; i18next + `.po`→JSON conversion later.

---

## 6. Testing

| Layer | Tool | Where |
|---|---|---|
| WASM module (no Electron) | Node smoke harness (MEMFS + `callMain`), both variants | `packages/slicer-wasm/harness/` |
| Shared packages + client (no emsdk, no Electron) | vitest + mock Emscripten module | per-package `*.test.ts` (`platform-contract`, `profile-resources`, `slicer-app`, `slicer-runtime`, `slicer-wasm/src/client/`) |
| Desktop app | Playwright Electron | `apps/desktop/e2e/` (+ packaged runtime probe via `scripts/run-desktop-e2e-real.mjs`) |
| Web app | Playwright Chrome — real threaded and serial artifacts, non-root deployment | `apps/web/e2e/`, `scripts/run-web-e2e-serial.mjs` |

Slice cross-check: output for `fixtures/cube.stl` must be consistent with
desktop OrcaSlicer for the same profile (the spike's GO criterion).

Test-layer existence does not imply that every layer runs after every change.
Execution frequency and change-to-test routing are defined by
`doc/testing_guidelines.md`. Shared behaviour is covered
exhaustively at the lowest practical layer and exercised end to end in one
primary host; the second host and second WASM variant focus on their distinct
platform/runtime seams until the release gate.

### Required development and verification workflow

1. Work from a dedicated development branch. Before starting a new issue,
   commit verified work already in the tree so it remains a distinct change.
2. Keep changes in complete, independently testable units. Verify each unit
   with the smallest risk-appropriate test set from the execution strategy and
   commit it before moving to the next one; do not combine unrelated fixes in
   one final commit.
3. Use `pnpm` for all workspace development, unit-test, typecheck, and
   Electron e2e commands. Do not use npm or yarn. The native WASM quick build
   is the deliberate exception: use `scripts\build-windows.bat quick` on
   Windows or `scripts/build.sh quick` on macOS/Linux whenever changing the
   WASM bridge, its build scaffold, or generated artifacts.
4. During implementation, prefer focused Vitest, affected-package typecheck,
   focused host E2E, and one affected WASM variant. Do not use the release
   matrix as the default edit-loop gate.
5. Before a code handoff, run `pnpm test`, `pnpm typecheck`, focused E2E for
   affected host seams, and applicable WASM checks. Common bridge/build changes
   quick-build both variants; comprehensive duplicate variant coverage is
   required only for variant-dependent changes or an explicit approved task
   requirement.
6. The complete Electron, real Web threaded/serial, dual comprehensive WASM,
   packaging, and compatibility matrix is mandatory for release/milestone
   acceptance and explicit high-risk gates. Documentation-only handoffs use
   `git diff --check` plus documentation consistency review.
7. Report commands actually run and their results, including intentional skips
   and required checks that could not be run.

### Test ownership and duplication policy

- Vitest must execute production behaviour or a runtime invariant. Pure
  interface-shape assertions belong to TypeScript compile fixtures.
- Shared React behaviour is tested primarily in `slicer-app`; host E2E repeats
  it only when Electron or browser integration can alter the result.
- The complete shared Web journey runs against one real WASM variant. The
  other variant normally proves selection/fallback plus a focused
  import-slice-export path; both full journeys remain release evidence.
- A focused Electron smoke set covers the critical journeys during development;
  extended object-list, viewport, and regression scenarios run when related
  code changes and at the release gate.
- Assertions must identify the behaviour under test. Avoid ambiguous visual
  proxies that can pass because of an unrelated camera, gizmo, or DOM change.
- Security, persistence, compatibility, memory/buffer ownership, and failure
  paths are not removed merely because a higher-level happy path overlaps them.

---

## 7. Licensing

AGPL-3.0 throughout — fork of AGPL OrcaSlicer; the Electron app, the WASM
module, and `libslic3r` all inherit the AGPL. Carry a root `LICENSE` (AGPL-3.0)
and honor source-offer obligations when distributing builds.
