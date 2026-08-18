# Repository Guidelines

## Architecture & Scope

- OrcaSlicerNeo is a desktop GUI rewrite of OrcaSlicer: **Electron + React +
  TypeScript + Vite + shadcn/ui**, with the C++ slicing core (`libslic3r`)
  compiled to **WebAssembly (Emscripten)** and called from JS.
- The wxWidgets GUI is **not** ported and not compiled in the WASM build.
- Monorepo managed by pnpm workspaces (`apps/*`, `packages/*`), runtime pinned
  via Volta (following established monorepo conventions).
- Target platforms: Windows x64/arm64, Linux x64/arm64, macOS x64/arm64 — all
  ship the same `.wasm`.
- Keep the C++ submodule changes **minimal**: `libslic3r` is reused as-is;
  modifications happen only through `packages/slicer-wasm/patches/*.patch` or
  deliberate submodule commits, never ad-hoc edits.
- Licensing: AGPL-3.0 throughout (fork of AGPL OrcaSlicer).

## Authoritative Documents

- Read `doc/2026-08-12-electron-gui-rewrite-design.md` **before any coding** —
  it is the approved design for the current milestone (v1 vertical slice:
  load STL/3MF → configure → slice → 3D preview → export G-code).
- Read `doc/high_level_dev_plan.md` for the roadmap and `spec/Grand Plan.md`
  for the milestone checklist; keep both in sync with delivered work.
- Read `project_structure_and_guidelines.md` for structure and engineering
  constraints.
- Read `doc/` for dated engineering docs; create task-specific notes there.
- Approved designs live in `spec/`. Any feature/design change must be reflected
  in `doc/` and, once approved, `spec/`.

## Project Structure

- `apps/desktop/`: Electron app — `src/main/` (windows, dialogs, session
  config), `src/preload/` (contextBridge API), `src/renderer/` (React app,
  react-three-fiber viewport, shadcn/ui).
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
- `tools/ scripts/ tests/`: dev utilities, CI/packaging scripts, e2e tests and
  fixtures.

## Key paths

| Path | What it is |
|---|---|
| `doc/2026-08-12-electron-gui-rewrite-design.md` | **Approved design — read before coding.** Architecture, bridge API table, decisions, risks |
| `doc/high_level_dev_plan.md` / `spec/Grand Plan.md` | Roadmap + milestone checklist (keep in sync with work) |
| `packages/slicer-wasm/cpp/` | git submodule → `Noisyfox/OrcaSlicer` (C++ source, pinned SHA). Treat as read-only except via `patches/` |
| `packages/slicer-wasm/src/bridge.cpp` | extern "C" bridge API (the C++↔JS seam) |
| `packages/slicer-wasm/src/client/` | typed JS client + worker glue (the only JS that touches the WASM module) |
| `apps/desktop/src/` | Electron main / preload / renderer |

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
  below; `quick` is the incremental ninja loop for bridge changes. The driver
  auto-activates emsdk (`C:\emsdk` first) and takes `-j N`, `--profiles <dir>`,
  `--no-env`, `-v`. cmd gotchas for .bat edits (NoDefaultCurrentDirectoryInExePath,
  paren-block escaping, CRLF): see `doc/2026-08-15-cmd-build-pipeline.md`.
- WASM: `packages\slicer-wasm\build.bat` (cmd; `call <emsdk>\emsdk_env.bat`
  first, or use the driver; ~50 GB disk for the dep build)
- Node smoke: `node packages/slicer-wasm/harness/run-slice.mjs --module out/orca_slice.js --stl fixtures/cube.stl --config fixtures/config.json`
- App dev: `pnpm --filter desktop dev` (electron-vite)
- e2e: `pnpm --filter desktop test:e2e` (Playwright Electron)

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
  the WASM module; renderer code goes through it.

## Golden rules

1. **libslic3r is reused with minimum changes.** Prefer build-scaffold exclusions,
   stubs, and shim headers over editing the submodule. Any submodule edit needs a
   `patches/*.patch` (or an intentional, documented submodule commit).
2. **Docs first.** New work gets a dated note in `doc/` before/with code; approved
   designs move to `spec/`. Follow the repo's doc conventions (dated
   `YYYY-MM-DD-topic.md`).

## Testing

- Node smoke tests (no Electron): `packages/slicer-wasm/harness/` pattern —
  stage fixtures into MEMFS, run via `callMain`, validate G-code output.
- Unit (`vitest`): client + stores against a mock Emscripten module (no emsdk).
- e2e (Playwright Electron): drive the full v1 flow in the packaged app.
