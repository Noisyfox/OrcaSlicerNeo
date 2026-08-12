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
  - `build.sh`, `build-boost-wasm64.sh`: WASM build pipeline.
- `doc/`: dated engineering docs (`YYYY-MM-DD-topic.md`, repo convention).
- `spec/`: approved specs.
- `tools/ scripts/ tests/`: dev utilities, CI/packaging scripts, e2e tests and
  fixtures.

## WASM Build Workflow (iterative — do not expect push-button)

The WASM build is an iteration surface, not a finished pipeline. When it fails:

1. Missing `<tbb/X.h>` → add `X` to `TBB_HEADERS` in `packages/slicer-wasm/build.sh`, re-run.
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

## Testing

- Node smoke tests (no Electron): `packages/slicer-wasm/harness/` pattern —
  stage fixtures into MEMFS, run via `callMain`, validate G-code output.
- Unit (`vitest`): client + stores against a mock Emscripten module (no emsdk).
- e2e (Playwright Electron): drive the full v1 flow in the packaged app.
