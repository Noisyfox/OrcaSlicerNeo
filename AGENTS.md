# Repository Guidelines

## Architecture & Scope

- OrcaSlicerNeo rebuilds the OrcaSlicer GUI as a shared React app
  (**React + TypeScript + Vite + shadcn/ui**) with two thin hosts: an
  **Electron** desktop app (`apps/desktop`) and a static **Web** app
  (`apps/web`), with the C++ slicing core (`libslic3r`) compiled to
  **WebAssembly (Emscripten)** and called from JS.
- The wxWidgets GUI is **not** ported and not compiled in the WASM build.
- Monorepo managed by pnpm workspaces (`apps/*`, `packages/*`), runtime pinned
  via Volta (following established monorepo conventions).
- Target platforms: Windows x64/arm64, Linux x64/arm64, macOS x64/arm64 — all
  ship both wasm64 variants; the Web target is desktop Chrome 133+ with
  WebGL 2 and wasm64 (see
  `spec/Web-Electron Shared Application Architecture.md`).
- Keep the C++ submodule changes **minimal**: `libslic3r` is reused as-is;
  modifications happen only through `packages/slicer-wasm/patches/*.patch` or
  deliberate submodule commits, never ad-hoc edits.
- Licensing: AGPL-3.0 throughout (fork of AGPL OrcaSlicer).

## Authoritative Documents

- Read `spec/Web-Electron Shared Application Architecture.md` **before any
  coding** — it is the approved design for the current milestone (shared
  Electron + static-Web application). `doc/2026-08-12-electron-gui-rewrite-design.md`
  remains the approved design for the delivered desktop vertical slice
  (load STL/3MF → configure → slice → 3D preview → export G-code) it extends.
- Read `doc/high_level_dev_plan.md` for the roadmap and `spec/Grand Plan.md`
  for the milestone checklist; keep both in sync with delivered work.
- Read `project_structure_and_guidelines.md` for structure and engineering
  constraints.
- Read `doc/` for dated engineering docs; create task-specific notes there.
- Approved designs live in `spec/`. Any feature/design change must be reflected
  in `doc/` and, once approved, `spec/`.

## Project Structure

- `apps/desktop/`: Electron host — `src/main/` (windows, dialogs, session
  config), `src/preload/` (contextBridge API), `src/renderer/` (thin entry
  composing the shared app with the Electron adapter).
- `apps/web/`: static Web host — Vite app, browser adapters (file picker /
  Blob download, localStorage preferences), capability gate and
  unsupported-environment screen.
- `packages/slicer-app/`: shared React UI — components, stores, viewport,
  styles (used by both hosts; an import-direction guard test keeps it free
  of host/Electron/Node dependencies).
- `packages/slicer-runtime/`: shared runtime — Worker/WASM asset resolution,
  profile installation into MEMFS, startup gate and capability selection.
- `packages/platform-contract/`: injected platform contracts (models,
  exports, preferences, runtime, chrome) + context provider.
- `packages/profile-resources/`: deterministic profile package build
  (versioned manifest + core/vendor ZIPs from upstream profile
  organization).
- `packages/slicer-wasm/`: the WASM slicer module.
  - `cpp/`: git submodule → `Noisyfox/OrcaSlicer` (pinned SHA). Do not commit
    changes to the submodule pointer casually; update it with intent.
  - `CMakeLists.txt`, `stubs/`, `shim/_serial.hpp`, `patches/`: the Emscripten
    build scaffold (spike-derived; see the design doc).
  - `src/`: `bridge.cpp` (extern "C" API) + `slice_main.cpp` (CLI driver).
  - `src/client/`: typed JS client + Web Worker glue.
  - `build.sh`, `build-boost-wasm64.sh`, `fetch-deps.sh` (+ `.bat` ports,
    cmd-native, no Git Bash): WASM build pipeline.
- `doc/`: dated engineering docs (`YYYY-MM-DD-topic.md`, repo convention).
- `spec/`: approved specs.
- `tools/ scripts/`: dev utilities, CI/packaging scripts.

## Key paths

| Path | What it is |
|---|---|
| `spec/Web-Electron Shared Application Architecture.md` | **Approved design — read before coding.** Shared Electron + Web architecture, contracts, decisions |
| `doc/2026-08-12-electron-gui-rewrite-design.md` | Approved design for the delivered desktop vertical slice |
| `doc/high_level_dev_plan.md` / `spec/Grand Plan.md` | Roadmap + milestone checklist (keep in sync with work) |
| `packages/slicer-app/` `packages/slicer-runtime/` | Shared React UI / runtime glue (used by both hosts) |
| `packages/platform-contract/` `packages/profile-resources/` | Injected platform contracts / profile package build |
| `packages/slicer-wasm/cpp/` | git submodule → `Noisyfox/OrcaSlicer` (C++ source, pinned SHA). Treat as read-only except via `patches/` |
| `packages/slicer-wasm/src/bridge.cpp` | extern "C" bridge API (the C++↔JS seam) |
| `packages/slicer-wasm/src/client/` | typed JS client + worker glue (the only JS that touches the WASM module) |
| `apps/desktop/src/` | Electron main / preload / renderer entry |
| `apps/web/src/` | static Web host entry + adapters |

## Reference (do not reinvent)

The phase-0 spike (external reference implementation, GO verdict 2026-07-24)
proved feasibility and contains reusable machinery:
- `shim/_serial.hpp` — serial TBB shim (copy; add `parallel_pipeline` stand-in)
- `build-boost-wasm64.sh` — Boost 1.84 for wasm64
- `cmake/CMakeLists.txt` — GLOB + `DROP_PATTERNS` scaffold
- `patches/0001-model-hpp-guard-step-include.patch` — Model.hpp STEP guard
- `harness/` — Node smoke runner + mock-module self-test pattern
- `FINDINGS.md` — per-file compile recipe, remaining blockers, wasm64 rationale

## Build commands

- All-in-one driver (Windows): `scripts/build-windows.bat help` — pure cmd,
  **no Git Bash**. Same driver on macOS/Linux: `scripts/build.sh help`
  (plain bash; uses emcc/emcmake from PATH first — e.g. Homebrew
  emscripten — then falls back to auto-activating an emsdk install;
  `--no-env` skips that). Subcommands
  `env deps boost build full quick shim smoke test dev e2e` wrap every step
  below. `build`/`full` produce the production **dual-variant** set
  (threaded + serial wasm64 via `scripts/build-wasm-dual.bat` /
  `build-wasm-dual.sh`, staged into the renderer by `scripts/stage-wasm.mjs`);
  `quick` is the incremental ninja loop for bridge changes, rebuilding both
  variant trees by default (`--variant threaded|serial` limits it); `smoke`
  runs the harnesses against both variants. The driver auto-activates emsdk
  (`C:\emsdk` first) and takes `-j N`, `--variant`, `--no-env`, `--debug`, `-v`.
  `--debug` (or `WASM_DEBUG=1`) builds the libslic3r/bridge part with `-g -O0`
  so the module embeds DWARF for interactive source-level debugging in Chrome
  DevTools; deps (Boost/oneTBB/vendored) stay release without debug info — see
  `doc/2026-08-20-wasm-dwarf-debug-build.md`. cmd gotchas for .bat edits
  (NoDefaultCurrentDirectoryInExePath, paren-block escaping, CRLF): see
  `doc/2026-08-15-cmd-build-pipeline.md`.
- WASM: `packages\slicer-wasm\build.bat` (cmd; `call <emsdk>\emsdk_env.bat`
  first, or use the driver; ~50 GB disk for the dep build)
- Node smoke: `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json` (variants live under `out/{threaded,serial}/`)
- App dev: `pnpm --filter desktop dev` (electron-vite) / `pnpm --filter web dev` (Vite)
- e2e: `pnpm --filter desktop test:e2e` (Playwright Electron); `pnpm --filter web test:e2e:threaded` / `test:e2e:serial` (Playwright Chrome, real artifacts)

## WASM Build Workflow (iterative — do not expect push-button)

The WASM build is an iteration surface, not a finished pipeline. When it fails:

> On Windows (no Git Bash), run the `.bat` ports via `scripts\build-windows.bat`;
> the iterate loop below is identical. cmd gotchas that have cost real
> debugging time: bare exe names fail with 9009 on machines with
> `NoDefaultCurrentDirectoryInExePath` set (always call `.\b2.exe` etc.),
> unescaped `)` in echo text closes `if (...)` blocks early, and .bat must be
> CRLF. Details: `doc/2026-08-15-cmd-build-pipeline.md`.

1. Missing `<tbb/X.h>` → add `X` to `TBB_HEADERS` in `packages/slicer-wasm/build.bat` (or `build.sh`), re-run.
2. Undefined symbol from a dropped file (SLA/CGAL/OCCT) → exclude its caller via
   `DROP_PATTERNS` in `packages/slicer-wasm/CMakeLists.txt`, or add an empty stub
   in `packages/slicer-wasm/stubs/`.
3. Missing Boost/Eigen → fix include paths (Boost must be Emscripten-built via
   `build-boost-wasm64.sh`).
4. `libslic3r` API mismatch in the bridge → adjust call signatures; the API
   drifts across versions (see the spike's README for the iterate loop).

## Bridge API Rules

- extern "C", JSON-in/JSON-out, synchronous calls on the worker thread.
- Binary buffers cross via the WASM heap (`_malloc`/`_free` + `HEAPU8` views).
- Never block the UI thread from the renderer; the WASM module runs in a Web
  Worker.
- The client (`packages/slicer-wasm/src/client`) is the only JS that talks to
  the WASM module; application code goes through `slicer-runtime`, never the
  module URLs or Emscripten globals.

## Golden rules

1. **libslic3r is reused with minimum changes.** Prefer build-scaffold exclusions,
   stubs, and shim headers over editing the submodule. Any submodule edit needs a
   `patches/*.patch` (or an intentional, documented submodule commit).
2. **Docs first.** New work gets a dated note in `doc/` before/with code; approved
   designs move to `spec/`. Follow the repo's doc conventions (dated
   `YYYY-MM-DD-topic.md`).

## Required development and verification workflow

1. Start work on a dedicated development branch. Before beginning a new issue,
   commit any verified, in-scope work already in the tree; do not silently
   bundle it with the new fix.
2. Divide implementation into complete, independently testable pieces. Run the
   appropriate checks and make one commit after every such piece; do not defer
   all commits until the end of a multi-part change.
3. Use pnpm for every workspace development, unit-test, typecheck, and
   Electron e2e command. Do not substitute npm or yarn. The platform build
   driver is the intentional exception for the native WASM quick build: on
   Windows run `scripts\build-windows.bat quick` (or `scripts/build.sh quick`
   on macOS/Linux) whenever the WASM bridge, build scaffold, or generated
   artifacts are affected.
4. Before handoff, run `pnpm test`, `pnpm typecheck`, the applicable quick
   WASM build, and `pnpm --filter desktop test:e2e`. In a sandboxed execution
   environment, run Electron e2e with the required outside-sandbox approval.
   Report the actual result; a known intentionally skipped test must be named.

## Testing

- Node smoke tests (no Electron): `packages/slicer-wasm/harness/` pattern —
  stage fixtures into MEMFS, run via `callMain`, validate G-code output
  (run against both `out/threaded/` and `out/serial/` artifacts).
- Unit (`vitest`): shared packages + client against a mock Emscripten module
  (no emsdk); `packages/slicer-app/src/import-direction.test.ts` guards the
  shared packages from host dependencies.
- e2e (Playwright): drive the full v1 flow in the Electron app
  (`apps/desktop/e2e/`) and in Chrome against both real wasm64 artifacts
  (`apps/web/e2e/`, `scripts/run-web-e2e-serial.mjs`), plus a packaged-app
  runtime probe (`scripts/run-desktop-e2e-real.mjs`).

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes_tool` or `query_graph_tool` instead of Grep
- **Understanding impact**: `get_impact_radius_tool` instead of manually tracing imports
- **Code review**: `detect_changes_tool` + `get_review_context_tool` instead of reading entire files
- **Finding relationships**: `query_graph_tool` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview_tool` + `list_communities_tool`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes_tool` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context_tool` | Need source snippets for review — token-efficient |
| `get_impact_radius_tool` | Understanding blast radius of a change |
| `get_affected_flows_tool` | Finding which execution paths are impacted |
| `query_graph_tool` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes_tool` | Finding functions/classes by name or keyword |
| `get_architecture_overview_tool` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes_tool` for code review.
3. Use `get_affected_flows_tool` to understand impact.
4. Use `query_graph_tool` pattern="tests_for" to check coverage.
