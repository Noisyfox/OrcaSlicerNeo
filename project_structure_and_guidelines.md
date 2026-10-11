# OrcaSlicerNeo: Repository Structure & Engineering Guidelines

**Architecture:** Monorepo (pnpm workspaces)
**Stack:** Electron + React + TypeScript + Vite + shadcn/ui (frontend); C++17
`libslic3r` compiled to WebAssembly via Emscripten (slicing core)
**Runtime pin:** Node + pnpm pinned via Volta (established monorepo convention)
**License:** AGPL-3.0 (fork of OrcaSlicer)

---

## 1. Executive Summary

Internal APIs follow a single current contract. Do not introduce backward
compatibility layers, deprecated aliases, legacy payload fallbacks, or parallel
old/new formats. Change producers, consumers, mocks, and tests together.

This repository builds the next-generation OrcaSlicer desktop GUI on Electron,
reusing the C++ slicing core (`libslic3r`) by compiling it to WASM with
Emscripten. It enforces:

1. **Minimal C++ footprint:** the submodule (`packages/slicer-wasm/cpp/`) is
   modified directly through validated commits on its `dev/orcaslicerneo-wasm`
   branch, followed by a deliberate superproject pin update. Do not add Orca
   source patches; patches are reserved for external dependencies. All WASM build logic lives in
   the scaffold (`packages/slicer-wasm/`), never in the upstream build system.
2. **One bridge, many hosts:** the same extern "C" bridge ships as two wasm64
   variants — `threaded` (upstream oneTBB + pthreads; selected when the host is
   cross-origin isolated) and `serial` (TBB shim fallback) — on Windows
   x64/arm64, Linux x64/arm64, macOS x64/arm64, and the static Web host.
3. **A clean C++↔JS seam:** an extern "C", JSON-in/JSON-out bridge is the only
   interface; binary data (meshes, toolpaths) crosses as heap buffers. The JS
   client in `packages/slicer-wasm/src/client/` is the only JS that touches the
   WASM module.
4. **Maintained topic documentation:** accepted designs in `spec/`, reusable
   engineering references in `doc/`; update existing owners as development changes them.

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
│       ├── cpp/                  # git submodule → Noisyfox/OrcaSlicer
│       │                             # adaptation branch; superproject pins commit
│       ├── CMakeLists.txt        # scaffold: GLOB_RECURSE + DROP_PATTERNS + stubs/
│       ├── stubs/                # empty stubs for dropped-feature symbols
│       ├── shim/_serial.hpp      # serial TBB shim (+ parallel_pipeline stand-in)
│       ├── patches/              # external dependency patches (for example, OCCT)
│       ├── src/                  # bridge.cpp (extern "C") + slice_main.cpp (CLI)
│       ├── src/client/           # typed JS client + Web Worker glue
│       ├── harness/              # Node smoke runner + mock-module self-test
│       ├── fixtures/             # cube.stl generator, starter config.json
│       ├── build.sh / build.bat  # emsdk env → shim gen → emcmake → artifacts
│       └── build-boost-wasm64.sh # Emscripten Boost 1.84 build
├── doc/                          # maintained engineering references and topic index
├── spec/                         # approved specs
├── tools/                        # dev utilities
├── scripts/                      # CI / packaging scripts (incl. build-wasm-dual.*,
│                                 #   stage.mjs, web/desktop e2e runners)
├── package.json                  # root scripts
└── pnpm-workspace.yaml
```

---

## 3. Document Conventions

- `spec/` owns accepted product behavior, architecture, and design constraints.
  The shared architecture remains the application-wide authority.
- `doc/` owns reusable build, debugging, testing, and operational references,
  plus the topic index. Existing dated filenames remain stable references;
  their dates are not a requirement to create a successor for each change.
- Root docs: `README.md`, `AGENTS.md` (imported by `CLAUDE.md`),
  `project_structure_and_guidelines.md` (this file).
- Write repository documentation in English.

The [documentation index](doc/README.md) maps topics to their current owner.
[Grand Plan](spec/Grand%20Plan.md) is the only roadmap. Git history retains
superseded designs and verification logs; do not retain duplicate phase notes.
Consolidation preserves all unrevoked decisions, positive and negative
constraints, scope, rationale and acceptance requirements. Later silence or an
implementation gap is not a decision reversal; replace only explicitly
superseded portions and retain unresolved qualification boundaries.

### Update the existing topic first

Before writing documentation, consult the index and search for the topic in
`spec/` and `doc/`. If a suitable owner exists, edit its relevant section
directly, including for feature extensions, fixes, reviews, and follow-up work.
Update affected linked contracts together; do not add a dated supplement,
implementation plan, review report, or phase log alongside the same topic.

A code change needs a documentation update only when it changes a durable
behavior, boundary, accepted decision, qualification limit, or reusable procedure.
A refactor or fix that restores the documented contract does not automatically
require a document edit. Record its implementation and verification in the PR.

Create a document only for a distinct topic with lasting value that cannot fit
coherently in an existing owner. Prefer a section before splitting a document;
task size, elapsed time, and implementation phases are not reasons to split.
Use a stable topic name, add it to the index, and link to adjacent owners instead
of duplicating them. Update the roadmap only for delivery/milestone changes.
Proposals and working plans normally stay in the issue or PR. If a substantial
new topic needs a repository draft, label its status clearly and evolve that
same record into the accepted specification; merge into an existing owner if
one is identified, removing the duplicate draft.

### Record durable decisions, not incidental implementation

Keep only information that future work needs to understand or preserve: accepted
behavior, positive and negative constraints, ownership and failure semantics,
scope exclusions, essential rationale, and necessary verification boundaries.
An implementation choice becomes normative only through an explicit design
decision; its presence in code or a passing test does not establish a mandate.

Keep symbol lists, directory inventories, wire examples, command catalogues,
and configuration values with their existing authoritative source where possible.
Link to code, schemas, scripts, or tests instead of copying their contents.
Include exact algorithms, numeric limits, UI dimensions, or technical details
only when they express an accepted contract or are necessary for a reusable
procedure. Preserve existing accepted values until explicitly superseded.

Leave task breakdowns, debugging transcripts, abandoned approaches, commit lists,
test counts, one-off timings, and pass/fail logs in commits, PRs, or test artifacts.
A measured result is not automatically a performance budget, and a workaround
is not automatically an architectural rule. Keep only the lasting conclusion,
necessary reproduction/reference information, and unresolved limitations in docs.
Do not remove still-valid decisions or qualification limits as mere "detail."

### Finish with one current account

Rewrite the affected passage into the current accepted statement instead of
appending chronological corrections. Replace only explicitly superseded rules,
preserve unaffected constraints, and distinguish proposed, accepted, delivered,
and unverified behavior. Remove stale duplicates and repair inbound references
when moving content. Before handoff, check that each new statement needs to
constrain future work or support a reusable procedure, then verify changed local
links and commands and run `git diff --check`. Report execution results in the PR
rather than adding a verification diary to the maintained document.

---

## 4. WASM Build Guidelines

See [WASM Build and Runtime Reference](doc/2026-08-12-wasm-build-notes.md). Key rules:

- **Iterate, don't panic:** the WASM build is expected to fail and be fixed via
  `TBB_HEADERS` (build.sh), `DROP_PATTERNS` (CMakeLists.txt), `stubs/`, or
  bridge signature drift fixes. Each failure class has a documented fix.
- **wasm64 (`-m64`)**: compile objects, dependencies and the final link for
  wasm64 consistently. The supported fallback is serial wasm64, not wasm32.
- **Dual-variant**: the production build produces two wasm64 variants in
  separate CMake/output trees — `threaded` (upstream oneTBB + pthreads;
  selected at runtime when the host is cross-origin isolated) and `serial`
  (the TBB shim, no pthreads). Both share one bridge/client contract.
- **Formats**: STL + 3MF + DRC + STEP/STP in the current WASM delivery.
  Thumbnails remain dropped (`ThumbnailsGeneratorCallback` = nullptr).
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
- **Process model**: Web runs WASM in a browser Worker and transfers binary
  ArrayBuffers to the viewport. Electron's utility-host migration runs WASM
  in a Node Worker inside a window-owned utility process, with a direct
  renderer MessagePort and explicit IPC copying costs. Runtime orchestration
  stays in `packages/slicer-runtime`; Web threading requires cross-origin
  isolation, while Node detects its own threading capability. Both retain
  the serial artifact. See `spec/Native Python Plugin Architecture.md` for
  the validation scope and measurements.
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

### Test and profiling instrumentation boundary

New test-, E2E-, or profile-only execution paths must be completely compiled
out of normal production artifacts. For C++ this requires a preprocessor build
gate; for renderer, Worker, and Electron code it requires a bundler-replaced
compile-time constant whose production `false` branch is eliminated. A
production artifact must not execute instrumentation, test hooks, or even a
runtime condition that decides whether to execute them.

Test/profile modules may remain packaged when doing so is convenient, but they
must have no top-level test/profile side effects in a production import path.
Verify every new gate with a production-artifact sentinel/call-site check and
the corresponding enabled test/profile build. This requirement applies to new
or modified code; existing test and E2E hooks are not retroactive cleanup work
unless a task explicitly includes them.

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
