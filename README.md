# OrcaSlicerNeo

A next-generation OrcaSlicer GUI — one shared **React + TypeScript + Vite +
shadcn/ui** application with thin **Electron** (desktop) and **static Web**
hosts, with the C++ slicing core (`libslic3r`) reused as-is and compiled to
**WebAssembly** via Emscripten.

The existing wxWidgets GUI is not ported. Two wasm64 variants — `threaded`
(oneTBB + pthreads) and `serial` (TBB shim fallback) — built from the same
bridge serve all six desktop platforms and the Web target; the runtime picks
`threaded` when the host is cross-origin isolated and falls back to `serial`.

## Status

- **Design approved** — see [doc/2026-08-12-electron-gui-rewrite-design.md](doc/2026-08-12-electron-gui-rewrite-design.md)
- Feasibility proven by the phase-0 compile spike (GO verdict 2026-07-24) —
  see CLAUDE.md → Reference for details
- **Milestones 1–8 delivered** (2026-08-13 → 2026-08-18): WASM core, Electron
  vertical slice, packaging/hardening, preset management, move gizmo,
  multi-volume selection, add/clear scene; **Milestone 9 delivered 2026-08-20**:
  shared Web–Electron application architecture (one React app with thin
  Electron and static-Web hosts) — see
  [doc/high_level_dev_plan.md](doc/high_level_dev_plan.md),
  [spec/Grand Plan.md](spec/Grand Plan.md), and the approved
  [Web–Electron architecture spec](spec/Web-Electron%20Shared%20Application%20Architecture.md)
  for the roadmap

## Layout

```
apps/desktop/          Electron host (main / preload / renderer entry)
apps/web/              static Web host (Vite; browser adapters, capability gate)
packages/slicer-wasm/  WASM slicer module: build scaffold + bridge + JS client
  cpp/                 git submodule → Noisyfox/OrcaSlicer (the C++ source)
packages/slicer-app/   shared React UI (components, stores, viewport, styles)
packages/slicer-runtime/ shared runtime + worker glue (asset resolution, profiles)
packages/platform-contract/ injected platform contracts (host adapters)
packages/profile-resources/ profile package build (manifest + core/vendor ZIPs)
doc/                   dated engineering docs (YYYY-MM-DD-topic.md)
spec/                  approved specs
tools/ scripts/        dev utilities, CI scripts
```

See [project_structure_and_guidelines.md](project_structure_and_guidelines.md) and
[AGENTS.md](AGENTS.md) for structure and engineering conventions.

## Building

### Prerequisites

- **Node.js ≥ 24** and **pnpm** (pinned via Volta: node 24.19.0 / pnpm 10.34.5;
  the workspace also declares `packageManager: pnpm@11.21.0`)
- **Git** — the C++ core is a submodule
  (`packages/slicer-wasm/cpp` → `Noisyfox/OrcaSlicer`)
- **Emscripten (emsdk)** — only needed for the WASM build. The build driver
  auto-activates an emsdk install (`C:\emsdk` first on Windows; `$HOME/emsdk`
  and friends on macOS/Linux), or uses `emcc`/`emcmake` already on PATH
  (e.g. Homebrew emscripten). Run `<driver> env` to see the activation line.
- **CMake (≥ 3.20) and Ninja** — used by the WASM build (`emcmake cmake
  -G Ninja` configure, `emmake ninja` build) and the dep builds. emsdk
  bundles both, so auto-activation covers them; if you use an emscripten
  without them (e.g. Homebrew emscripten or `--no-env`), install them
  separately (`brew install cmake ninja` on macOS, your distro's packages
  on Linux, or the official installers on Windows).
- **Visual Studio Build Tools (MSVC C++ workload)** — Windows only. The
  dependency fetch compiles Boost's own `b2.exe` with the host compiler:
  `fetch-deps.bat` prefers `cl.exe`, falling back to MinGW gcc / clang.
  Run the build from a **Visual Studio Developer prompt** (or run
  `vcvars64.bat` first) so `cl.exe` is on PATH.
- **~50 GB free disk space** for the dependency build (Boost source + wasm64
  archives, Eigen, cereal)

### Setup

```bash
git clone --recurse-submodules <repo-url>   # or: git submodule update --init --recursive
cd OrcaSlicerNeo
pnpm install
```

### Build the WASM module

All-in-one driver (no Git Bash needed):

```bat
:: Windows — run from a Visual Studio Developer prompt (x64 Native Tools
:: Command Prompt / Developer PowerShell), so cl.exe is on PATH:
scripts\build-windows.bat full -j 8
```

```bash
# macOS / Linux (plain bash)
bash scripts/build.sh full -j 8
```

`full` is the cold-start path: fetch header-only deps (Eigen / Boost 1.84 /
cereal) → cross-compile Boost 1.84 wasm64 static archives → patch the
submodule, apply the shim, configure with CMake + Emscripten, ninja-build
both wasm64 variants (threaded + serial, separate CMake/output trees), and
stage each variant's `orca_slice.{js,wasm,data}` set to
`packages/slicer-wasm/out/{threaded,serial}/`.

For iterating on bridge/CMake changes after a first full build, use the
incremental loop — seconds-to-minutes, no configure or patch re-apply:

```bat
scripts\build-windows.bat quick -j 8
```

```bash
bash scripts/build.sh quick -j 8
```

Other driver subcommands: `deps` (fetch deps only), `boost` (Boost wasm64
only), `build` (full build, requires Boost archives), `shim` (regenerate
TBB/shim headers), `smoke` (run the Node harnesses against both variants in
`out/`), `test` (slicer-wasm vitest + typecheck; the whole workspace runs via
`pnpm -r test` / `pnpm -r typecheck`), `dev` (launch the Electron app),
`e2e` (Playwright Electron), `env`, `help`.

### Verify: slice a cube

```bash
node packages/slicer-wasm/harness/run-slice.mjs \
  --module packages/slicer-wasm/out/serial/orca_slice.js \
  --stl packages/slicer-wasm/fixtures/cube.stl \
  --config packages/slicer-wasm/fixtures/config.json
```

(or just `<driver> smoke` — it runs the slice and bridge harnesses against
both the `threaded` and `serial` variants)

### Run the app / tests

```bash
pnpm --filter desktop dev      # Electron dev mode (also: <driver> dev)
pnpm --filter web dev          # browser app — Vite dev server (http://localhost:5173)
pnpm --filter web build        # production web build
pnpm --filter web preview      # serve the production build locally
pnpm -r test                   # vitest suites
pnpm -r typecheck
pnpm --filter desktop test:e2e # Playwright Electron e2e (also: <driver> e2e)
pnpm --filter web test:e2e:threaded # Chrome e2e against the threaded wasm
pnpm --filter web test:e2e:serial   # Chrome e2e against the serial fallback
pnpm --filter web test:non-root    # production build served from a subpath
```

**Web app prerequisites.** Unlike the Electron app, the browser host has no
mock mode — build the WASM module first (`<driver> full` or `quick`; the
`predev` hook stages it from `packages/slicer-wasm/out/` and warns instead of
failing if it's missing, but slicing won't work until the module is staged).
The app requires **WebGL 2 and wasm64**, i.e. Chrome 133 or later, and the dev
server sends COOP/COEP headers so the threaded build can use
SharedArrayBuffer; set `ORCA_WEB_NO_ISOLATION=1` to run without isolation
(the serial e2e uses this to exercise the real serial artifact).

## Licensing

AGPL-3.0. OrcaSlicerNeo is a fork of AGPL OrcaSlicer; the Electron app, the WASM
module, and the `libslic3r` core all inherit the AGPL. See the design doc's
Licensing section.
