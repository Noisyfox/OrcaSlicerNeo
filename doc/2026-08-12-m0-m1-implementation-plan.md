# M0/M1 Implementation Plan: Repo Scaffold + WASM Core

Date: 2026-08-12
Status: Approved (writing-plans session, 2026-08-12)
Scope: Milestone 0 (Foundation) + Milestone 1 (WASM Core) of
[`spec/Grand Plan.md`](../spec/Grand%20Plan.md)

> **Historical note (2026-09-14):** This plan records the pre-STEP M0/M1
> scaffold and its then-current dependency decisions. STEP/OCCT was later
> restored and delivered in `doc/2026-09-13-step-import-support.md`; references
> below to the old `Model.hpp` guard, `SLIC3R_WASM_NO_OCCT`, or STEP being
> dropped describe that historical plan and are not active build instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the monorepo (pnpm workspaces, `packages/slicer-wasm/` +
`apps/desktop/` skeletons, C++ submodule pinned) and build the WASM slicing
core: libslic3r compiles to a single Emscripten module that slices a fixture
end-to-end through the Node smoke harness, with the extern "C" bridge API
compiled in.

**Architecture:** The C++ slicing core (`libslic3r`) from the pinned submodule
is compiled to WASM (wasm64, serial-first) by a standalone scaffold CMake +
build script inherited from the phase-0 spike, with a serial TBB shim, a
curated embedded preset subset, and a new `bridge.cpp` (extern "C",
JSON-in/JSON-out) alongside the retained `slice_main.cpp` CLI driver. One
`.wasm` module serves the Node smoke harness now and the renderer Web Worker in
Milestone 2.

**Tech Stack:** Emscripten 6.x (`emcmake`/`emmake ninja`, `-sMEMORY64`), CMake
3.20+, Ninja, bash, C++17, Eigen 5.0.1 / Boost 1.84.0 (wasm64 archives) /
cereal 1.3.0, nlohmann/json (in-tree), pnpm 10 + Volta, electron-vite, React
18 + TypeScript 5.

## Global Constraints

Copied verbatim from the approved design (`doc/2026-08-12-electron-gui-rewrite-design.md`)
and the roadmap docs — every task's requirements implicitly include these:

- **Submodule is read-only**: `packages/slicer-wasm/cpp/` → `Noisyfox/OrcaSlicer`
  pinned at `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`. Changes only via
  `packages/slicer-wasm/patches/*.patch`; never ad-hoc edits.
- **wasm64 consistency**: every object, the Boost archives, and the link agree
  on `-sMEMORY64`. Fallback to wasm32 + `GCode.hpp` size_t fix only if the
  toolchain blocks wasm64.
- **Serial-first**: no `-pthread` in the final link; the TBB shim runs
  parallel primitives inline. Parallelism is Milestone 4.
- **Dependency pins**: Eigen 5.0.1, Boost 1.84.0, cereal 1.3.0 (matches the
  submodule's `deps/*.cmake` pins).
- **Formats**: STL + 3MF only (`/Format/3mf` is re-added; STEP/OCCT dropped).
- **Bridge rules**: extern "C", JSON-in/JSON-out, synchronous on the worker
  thread; binary buffers cross via the heap (`_malloc`/`_free` + HEAPU8).
  The JS client (`packages/slicer-wasm/src/client`) is the only JS that talks
  to the module; renderer code goes through it (Milestone 2).
- **Link flags** (design §C++/WASM Build): `-O3 -fexceptions -sMEMORY64
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sEXIT_RUNTIME=0 -sINVOKE_RUN=0
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall,cwrap,
  UTF8ToString,_malloc,_free -sDISABLE_EXCEPTION_CATCHING=0`.
- **WASM build is iterative**: `TBB_HEADERS` / `DROP_PATTERNS` / `stubs/` /
  bridge-signature drift are the documented fix loops (AGENTS.md §WASM Build
  Workflow). Do not "fix" by editing the submodule.
- **Docs-first**: dated engineering notes in `doc/` (`YYYY-MM-DD-topic.md`);
  keep `spec/Grand Plan.md` + `doc/high_level_dev_plan.md` in sync with work.
- **Naming**: bridge functions `orc_*`; module name `orca_slice`; output dir
  `packages/slicer-wasm/out/`; scratch dir `packages/slicer-wasm/.work/`
  (gitignored, ~50 GB budget for the dep build).
- **Repo hygiene**: the phase-0 spike's project name must never be written into
  any file, commit message, or git history state of this repo. Reference the
  spike only as "the phase-0 spike (external reference implementation)". Its
  files are copied by name from the spike checkout (its location is known to the
  repo owner; it is not named in this repo).
- **Licensing**: AGPL-3.0 throughout (root `LICENSE` is a Milestone 3 task).

---

### Task 1: Root workspace (pnpm + Volta + gitignore)

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.gitignore`

**Interfaces:**
- Produces: workspace package names `slicer-wasm` (`packages/slicer-wasm`) and
  `desktop` (`apps/desktop`) that Tasks 2–3 register; root scripts
  `dev` / `typecheck` / `build:wasm` / `smoke` used by Tasks 3, 8–10.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "orca-slicer-neo",
  "version": "0.0.0",
  "private": true,
  "description": "Next-generation OrcaSlicer GUI: Electron + React + WASM libslic3r",
  "packageManager": "pnpm@10.0.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm --filter desktop dev",
    "typecheck": "pnpm -r typecheck",
    "build:wasm": "bash packages/slicer-wasm/build.sh",
    "smoke": "node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.ini"
  },
  "volta": { "node": "22.14.0", "pnpm": "10.0.0" }
}
```

- [ ] **Step 2: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
dist/
out/
*.local
.DS_Store
packages/slicer-wasm/.work/
packages/slicer-wasm/out/
```

- [ ] **Step 4: Verify the workspace resolves**

Run: `pnpm install`
Expected: exit 0, "Lockfile is up to date"-style output (workspace globs may
currently match nothing).

- [ ] **Step 5: Confirm the runtime pins**

Run: `volta pin node && volta pin pnpm && node --version && pnpm --version`
Expected: `volta pin` rewrites the `volta` block to exact current versions
(node 22.x, pnpm 10.x) and both commands print matching versions. If `volta`
is not installed, install it first (https://volta.sh), or run the same with
`npx pnpm` and set `engines` only.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml .gitignore pnpm-lock.yaml
git commit -m "chore: add pnpm workspace root (volta-pinned, node 22 / pnpm 10)"
```

---

### Task 2: `packages/slicer-wasm` package skeleton

**Files:**
- Create: `packages/slicer-wasm/package.json`, `packages/slicer-wasm/tsconfig.json`,
  `packages/slicer-wasm/.gitignore`, `packages/slicer-wasm/src/client/index.ts`

**Interfaces:**
- Consumes: workspace registration from Task 1.
- Produces: package `slicer-wasm` (typecheckable); the folder homes for the
  WASM scaffold (Task 5), the shim (Task 6), Boost (Task 7), the build
  (Task 8), harness/fixtures (Task 5), and the bridge (Task 10). The typed
  client API itself is Milestone 2 (Epic 2.1).

- [ ] **Step 1: Write `packages/slicer-wasm/package.json`**

```json
{
  "name": "slicer-wasm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "WASM libslic3r module: Emscripten build scaffold + bridge + typed JS client",
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Write `packages/slicer-wasm/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "WebWorker"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `packages/slicer-wasm/.gitignore`**

```
node_modules/
.work/
out/
```

- [ ] **Step 4: Write `packages/slicer-wasm/src/client/index.ts`**

```ts
// The typed JS client + Web Worker glue land in Milestone 2 (Epic 2.1).
// This module is where the promise-based bridge API (loadModel, getPresets,
// getOptionMetadata, slice, getSliceResult, exportGcode, cancel) will live.
export const CLIENT_VERSION = '0.0.0-m0';
```

- [ ] **Step 5: Verify install + typecheck**

Run: `pnpm install && pnpm --filter slicer-wasm typecheck`
Expected: exit 0, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/slicer-wasm
git commit -m "chore: add slicer-wasm package skeleton"
```

---

### Task 3: `apps/desktop` skeleton (electron-vite shell)

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/electron.vite.config.ts`,
  `apps/desktop/tsconfig.json`, `apps/desktop/tsconfig.node.json`,
  `apps/desktop/tsconfig.web.json`, `apps/desktop/src/main/index.ts`,
  `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/index.html`,
  `apps/desktop/src/renderer/src/main.tsx`,
  `apps/desktop/src/renderer/src/App.tsx`,
  `apps/desktop/src/renderer/src/env.d.ts`

**Interfaces:**
- Consumes: workspace registration from Task 1.
- Produces: package `desktop` with `dev`/`build`/`typecheck` scripts; the
  preload API object `window.orca` (Milestone 2 extends it with dialogs/file
  IO/window controls); the main window entry point Milestone 2's COOP/COEP
  session setup and dialogs attach to.

- [ ] **Step 1: Write `apps/desktop/package.json`**

```json
{
  "name": "desktop",
  "version": "0.0.0",
  "private": true,
  "description": "OrcaSlicerNeo desktop app (Electron)",
  "main": "out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "electron": "^34.0.0",
    "electron-vite": "^2.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Write `apps/desktop/electron.vite.config.ts`**

```ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
  },
});
```

- [ ] **Step 3: Write the tsconfigs**

`apps/desktop/tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

`apps/desktop/tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["electron.vite.config.ts", "src/main/**/*", "src/preload/**/*"]
}
```

`apps/desktop/tsconfig.web.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/renderer/**/*"]
}
```

- [ ] **Step 4: Write `apps/desktop/src/main/index.ts`**

```ts
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload will need node builtins for file IO in Milestone 2
    },
  });

  win.on('ready-to-show', () => win.show());

  // electron-vite sets ELECTRON_RENDERER_URL in dev; load the built file otherwise.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 5: Write `apps/desktop/src/preload/index.ts`**

```ts
import { contextBridge } from 'electron';

// Milestone 2 extends this API with native dialogs, file read/write, and
// window controls. For now expose a version marker so the renderer can
// assert the preload bridge is alive.
contextBridge.exposeInMainWorld('orca', {
  version: '0.0.0-m0-shell',
});
```

- [ ] **Step 6: Write the renderer files**

`apps/desktop/src/renderer/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>OrcaSlicerNeo</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/desktop/src/renderer/src/main.tsx`:

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

`apps/desktop/src/renderer/src/App.tsx`:

```tsx
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>OrcaSlicerNeo</h1>
      <p>M0 shell — the WASM slicer and the settings/preview UI land in Milestones 1–2.</p>
      {window.orca ? <p>preload bridge: {window.orca.version}</p> : null}
    </main>
  );
}
```

`apps/desktop/src/renderer/src/env.d.ts`:

```ts
/// <reference types="vite/client" />

interface Window {
  orca?: { version: string };
}
```

- [ ] **Step 7: Verify install, typecheck, build**

Run: `pnpm install && pnpm --filter desktop typecheck && pnpm --filter desktop build`
Expected: exit 0; `apps/desktop/out/main/index.js` and
`apps/desktop/out/renderer/index.html` exist.

- [ ] **Step 8: Smoke-launch the shell (manual, 10 s)**

Run: `pnpm --filter desktop dev`
Expected: an "OrcaSlicerNeo" window opens with the M0 shell text; close it and
Ctrl-C the dev server.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop
git commit -m "feat: add electron-vite desktop shell (main/preload/renderer)"
```

---

### Task 4: Pin the C++ submodule

**Files:**
- Create: `.gitmodules`, `packages/slicer-wasm/cpp/` (gitlink)

**Interfaces:**
- Produces: `packages/slicer-wasm/cpp/` = OrcaSlicer source tree at
  `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`; `ORCA_SRC` for Tasks 5–9.
  `$ORCA_SRC/src/libslic3r` is the libslic3r root; `$ORCA_SRC/deps_src/` holds
  the vendored deps; `$ORCA_SRC/resources/profiles` holds the preset bundle.

- [ ] **Step 1: Add the submodule and pin it**

```bash
git submodule add git@github.com:Noisyfox/OrcaSlicer.git packages/slicer-wasm/cpp
git -C packages/slicer-wasm/cpp checkout b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde
git add .gitmodules packages/slicer-wasm/cpp
```

- [ ] **Step 2: Verify the pin**

Run: `git -C packages/slicer-wasm/cpp rev-parse HEAD && git submodule status`
Expected: both print `b97ca3c0ace8cb04eb520d86417fbe13b7ddbdde`.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: add OrcaSlicer submodule pinned to b97ca3c0ac"
```

---

### Task 5: Inherit the WASM scaffold from the phase-0 spike

Copy the proven machinery wholesale (design §C++/WASM Build: "do not
reinvent"). Source: the phase-0 spike checkout (external reference
implementation — its location is known to the repo owner). Every file listed
below exists in the spike under the name shown.

**Files:**
- Create (copied verbatim from the spike):
  - `packages/slicer-wasm/fetch-deps.sh` — fetches Eigen 5.0.1 / Boost 1.84.0 /
    cereal 1.3.2 into `.work/deps` and writes generated headers into
    `.work/gen` (`libslic3r_version.h` stub, `openssl/md5.h` declarations).
    Adjust the cereal version to `1.3.0` (matches the submodule's
    `deps/Cereal/Cereal.cmake` pin; API-identical).
  - `packages/slicer-wasm/build-boost-wasm64.sh` — b2 + Emscripten toolset,
    12 static archives. Do not change its flags.
  - `packages/slicer-wasm/shim/_serial.hpp` — serial TBB shim.
  - `packages/slicer-wasm/patches/0001-model-hpp-guard-step-include.patch`
    — `SLIC3R_WASM_NO_OCCT` guard in `Model.hpp`.
  - `packages/slicer-wasm/src/slice_main.cpp` — CLI driver (verify it still
    compiles against the pinned SHA: `Model::read_from_file` 4-arg call and
    `Print::export_gcode` 3-arg call are confirmed present at this SHA).
  - `packages/slicer-wasm/harness/run-slice.mjs`, `harness/mock-module.mjs`,
    `harness/selftest.mjs`
  - `packages/slicer-wasm/fixtures/make-cube.mjs`, `fixtures/config.ini`
- Create (adapted — full content below): `packages/slicer-wasm/build.sh`,
  `packages/slicer-wasm/CMakeLists.txt`
- Create (new, written below): `packages/slicer-wasm/stubs/md5.cpp`

**Interfaces:**
- Consumes: `$ORCA_SRC` submodule from Task 4.
- Produces: `build.sh` entry points `--shim-only` (generates
  `.work/shim-include/tbb/*.h`), full run (configure + build → `out/orca_slice.js`
  + `.wasm`); `fetch-deps.sh` (→ `.work/deps`, `.work/gen`); CMake target
  `orca_slice` (module) + `slic3r_core` (static lib); env vars
  `EIGEN_INCLUDE` / `BOOST_INCLUDE` / `CEREAL_INCLUDE` / `GEN_INCLUDE`.

- [ ] **Step 1: Copy the verbatim spike files**

From the spike checkout, copy the files listed above to their
`packages/slicer-wasm/` destinations (create `shim/`, `patches/`, `src/`,
`harness/`, `fixtures/`, `stubs/` as needed). Adjust `fetch-deps.sh`
`CEREAL_VER="1.3.2"` → `"1.3.0"`. Do not copy the spike's README/FINDINGS
(their content is already represented in this repo's docs).

- [ ] **Step 2: Write `packages/slicer-wasm/build.sh`**

```bash
#!/usr/bin/env bash
# ----------------------------------------------------------------
# ------------ OrcaSlicerNeo: libslic3r -> WASM build ------------
# ----------------------------------------------------------------
# Builds the pinned C++ submodule (packages/slicer-wasm/cpp) into a single
# Emscripten module: serial TBB shim, scaffold CMake, bridge + CLI driver.
# Inherited from the phase-0 spike's build.sh and adapted: no clone step (the
# submodule IS the source pin), wasm64-first, curated preset subset embedded.
#
# NOT push-button — the WASM build is an iteration surface. Re-run after each
# fix; steps are idempotent. See AGENTS.md "WASM Build Workflow" for the
# TBB_HEADERS / DROP_PATTERNS / stubs / API-drift fix loops.
#
# Prerequisites: emsdk on PATH (emcc/emcmake), cmake >= 3.20, ninja, git,
# python3, ~50 GB free disk.
#
# Usage:
#   ./build.sh                # full run (deps + boost + configure + build)
#   ./build.sh --shim-only    # just (re)generate the TBB shim headers
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"            # gitignored scratch space
ORCA_SRC="$PKG_DIR/cpp"                            # pinned submodule = the source
SHIM_INCLUDE="$WORK_DIR/shim-include"              # generated tbb/*.h forwarding headers
GEN_INCLUDE="$WORK_DIR/gen"                        # generated headers (libslic3r_version.h, openssl/md5.h)
BUILD_DIR="$WORK_DIR/build"
OUT_DIR="$PKG_DIR/out"

# Header-only / Emscripten-built dependency include dirs (fetch-deps.sh,
# build-boost-wasm64.sh). Overridable for CI.
EIGEN_INCLUDE="${EIGEN_INCLUDE:-$WORK_DIR/deps/eigen-5.0.1}"
BOOST_INCLUDE="${BOOST_INCLUDE:-$WORK_DIR/deps/boost-1.84.0}"
CEREAL_INCLUDE="${CEREAL_INCLUDE:-$WORK_DIR/deps/cereal-1.3.0/include}"

log()  { printf '\033[1;36m[wasm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[wasm] WARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[wasm] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------- TBB shim header generation ----------------
# Every <tbb/NAME.h> libslic3r may include forwards to shim/_serial.hpp. Add
# names here as compile errors reveal more includes.
TBB_HEADERS=(
  tbb parallel_for parallel_for_each parallel_reduce parallel_sort parallel_invoke
  blocked_range blocked_range2d enumerable_thread_specific combinable
  spin_mutex mutex spin_rw_mutex queuing_mutex task_group task_arena
  global_control task_scheduler_init concurrent_vector tick_count
  scalable_allocator cache_aligned_allocator tbb_allocator partitioner
  version concurrent_unordered_map concurrent_map concurrent_queue
  parallel_pipeline
)

generate_shim() {
  log "Generating serial TBB shim headers in $SHIM_INCLUDE/tbb"
  mkdir -p "$SHIM_INCLUDE/tbb" "$SHIM_INCLUDE/oneapi/tbb"
  local rel="$PKG_DIR/shim/_serial.hpp"
  for name in "${TBB_HEADERS[@]}"; do
    printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/tbb/${name}.h"
    printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/oneapi/tbb/${name}.h"
  done
  printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/tbb/tbb.h"
  printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/oneapi/tbb.h"
  log "Shim headers written."
}

if [[ "${1:-}" == "--shim-only" ]]; then
  mkdir -p "$WORK_DIR"
  generate_shim
  exit 0
fi

# ---------------- Prerequisite checks ----------------
command -v git   >/dev/null 2>&1 || die "git not found"
command -v cmake >/dev/null 2>&1 || die "cmake not found"
command -v ninja >/dev/null 2>&1 || die "ninja not found"
if ! command -v emcmake >/dev/null 2>&1; then
  die "Emscripten not on PATH. Install emsdk and 'source ./emsdk_env.sh', then re-run."
fi
log "emcc: $(emcc --version | head -1)"

mkdir -p "$WORK_DIR" "$OUT_DIR" "$GEN_INCLUDE"
generate_shim

# ---------------- Dependency staging ----------------
if [[ ! -d "$BOOST_INCLUDE/boost" ]]; then
  log "Running fetch-deps.sh (Eigen/Boost/cereal + generated headers)"
  bash "$PKG_DIR/fetch-deps.sh" || die "fetch-deps.sh failed"
fi

# ---------------- Version header (fork-derived) ----------------
# Replaces the spike's static stub: version + commit hash come from the
# pinned submodule so G-code/3MF metadata matches the actual source.
# (Note: no `local` here — this is script top level, not a function.)
{
  ver="$(git -C "$ORCA_SRC" describe --tags --always 2>/dev/null || echo 0.0.0)"
  githash="$(git -C "$ORCA_SRC" rev-parse --short HEAD 2>/dev/null || echo 0000000)"
  cat > "$GEN_INCLUDE/libslic3r_version.h" <<EOF
#ifndef __SLIC3R_VERSION_H
#define __SLIC3R_VERSION_H
#define SLIC3R_APP_NAME "OrcaSlicer"
#define SLIC3R_APP_KEY "OrcaSlicer"
#define SLIC3R_VERSION "$ver"
#define SoftFever_VERSION "$ver"
#define GIT_COMMIT_HASH "$githash"
#define SLIC3R_BUILD_ID "OrcaSlicer-$ver-wasm"
#define BBL_INTERNAL_TESTING 0
#define ORCA_CHECK_GCODE_PLACEHOLDERS 0
#endif
EOF
} > /dev/null
log "Wrote $GEN_INCLUDE/libslic3r_version.h (SLIC3R_VERSION=$(git -C "$ORCA_SRC" describe --tags --always 2>/dev/null || echo 0.0.0))"

# ---------------- Curated preset subset (for orc_init) ----------------
# Embed one vendor (Bambu Lab) + its index. PresetBundle::load_presets reads
# <data_dir>/system/*.json + vendor dirs (machine/process/filament). The full
# resources/profiles bundle lands via --preload-file in Milestone 3.
embed_presets() {
  local src="$ORCA_SRC/resources/profiles"
  local dst="$WORK_DIR/embed/system"
  rm -rf "$WORK_DIR/embed"
  mkdir -p "$dst"
  cp "$src/BBL.json" "$dst/"
  cp -a "$src/BBL" "$dst/"
  log "Embedded curated presets from $src/BBL into $dst"
}
embed_presets

# ---------------- Configure + build ----------------
log "Configuring stripped libslic3r + bridge + CLI (emcmake)"
emcmake cmake -S "$PKG_DIR" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DORCA_SRC="$ORCA_SRC" \
  -DSHIM_INCLUDE="$SHIM_INCLUDE" \
  -DGEN_INCLUDE="$GEN_INCLUDE" \
  -DEIGEN_INCLUDE="$EIGEN_INCLUDE" \
  -DBOOST_INCLUDE="$BOOST_INCLUDE" \
  -DCEREAL_INCLUDE="$CEREAL_INCLUDE" \
  -DEMBED_FILE="$WORK_DIR/embed/system@/system" \
  || die "CMake configure failed. Fix include paths / missing deps and re-run."

log "Building (emmake ninja) — expect to iterate on compile errors"
emmake ninja -C "$BUILD_DIR" orca_slice || die "Build failed. Common next steps:
  - Missing <tbb/X.h>: add X to TBB_HEADERS in build.sh and re-run.
  - Undefined symbol from an excluded file (SLA/CGAL/OCCT): add a stub in
    stubs/ or exclude its caller via DROP_PATTERNS in CMakeLists.txt.
  - Boost/Eigen not found: fix *_INCLUDE paths (run fetch-deps.sh first)."

# ---------------- Collect artifacts ----------------
cp -f "$BUILD_DIR"/orca_slice.js  "$OUT_DIR"/ 2>/dev/null || true
cp -f "$BUILD_DIR"/orca_slice.wasm "$OUT_DIR"/ 2>/dev/null || true
log "Done. Artifacts in $OUT_DIR/"
log "Smoke test: node harness/run-slice.mjs --module out/orca_slice.js \\
     --stl fixtures/cube.stl --config fixtures/config.ini"
```

- [ ] **Step 3: Write `packages/slicer-wasm/CMakeLists.txt`**

```cmake
# ----------------------------------------------------------------
# ------------ Stripped libslic3r + bridge + CLI -> WASM ---------
# ----------------------------------------------------------------
# Standalone target compiling ONLY the FDM slice path of libslic3r plus the
# bridge (src/bridge.cpp) and CLI driver (src/slice_main.cpp), sidestepping
# the upstream two-stage native dep build. Configure via emcmake (build.sh).
#
# This is a scaffold: DROP_PATTERNS and the compile defines are the iteration
# surface (AGENTS.md "WASM Build Workflow").
cmake_minimum_required(VERSION 3.20)
project(orca_slicer_wasm CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "Configure with emcmake (Emscripten toolchain required).")
endif()

# ---- Required paths (passed by build.sh) ----
foreach(var ORCA_SRC SHIM_INCLUDE GEN_INCLUDE)
  if(NOT DEFINED ${var} OR "${${var}}" STREQUAL "")
    message(FATAL_ERROR "${var} must be set (-D${var}=...).")
  endif()
endforeach()

set(LIBSLIC3R_ROOT "${ORCA_SRC}/src/libslic3r")

# ---- Source set: all libslic3r .cpp minus the dropped v1 features ----
file(GLOB_RECURSE LIBSLIC3R_SRC CONFIGURE_DEPENDS "${LIBSLIC3R_ROOT}/*.cpp")

# Denylist: dropped for the FDM v1 (pull in OpenVDB/CGAL/OCCT/networking).
# NOTE: "/Format/3mf" is intentionally NOT here — 3MF is re-added for v1
# (Format/3mf.cpp + Format/bbs_3mf.cpp; expat/miniz/fast_float are in-tree).
set(DROP_PATTERNS
  "/SLA/"                 # resin pipeline
  "OpenVDBUtils"          # OpenVDB grid conversion (hollowing)
  "Hollowing"             # OpenVDB
  "CutSurface"            # CGAL
  "MeshBoolean"           # CGAL boolean ops
  "/Format/STEP"          # OpenCASCADE
  "PrintConfig_test"
  "TriangleMeshSlicer_test"
)
foreach(pattern ${DROP_PATTERNS})
  list(FILTER LIBSLIC3R_SRC EXCLUDE REGEX "${pattern}")
endforeach()

# Hand-written stubs for symbols referenced from kept code but defined in
# dropped files (e.g. md5.cpp for the openssl/md5.h declarations).
file(GLOB STUB_SRC CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/stubs/*.cpp")

add_library(slic3r_core STATIC ${LIBSLIC3R_SRC} ${STUB_SRC})

target_include_directories(slic3r_core PUBLIC
  "${SHIM_INCLUDE}"          # serial TBB shim FIRST, ahead of any real tbb
  "${GEN_INCLUDE}"           # generated headers: libslic3r_version.h, openssl/md5.h
  "${ORCA_SRC}/src"
  "${LIBSLIC3R_ROOT}"
)
# Emscripten-built / header-only dependency includes (set by build.sh).
foreach(dep EIGEN_INCLUDE BOOST_INCLUDE CEREAL_INCLUDE)
  if(DEFINED ${dep} AND NOT "${${dep}}" STREQUAL "")
    target_include_directories(slic3r_core PUBLIC "${${dep}}")
  endif()
endforeach()
# In-tree vendored deps (deps_src/ inside the submodule) — the spike's proven
# include set from its per-file compile recipe.
target_include_directories(slic3r_core PUBLIC
  "${ORCA_SRC}/deps_src"
  "${ORCA_SRC}/deps_src/libigl"
  "${ORCA_SRC}/deps_src/miniz"
  "${ORCA_SRC}/deps_src/clipper2/Clipper2Lib/include"
  "${ORCA_SRC}/deps_src/expat"
  "${ORCA_SRC}/deps_src/glu-libtess/include"
  "${ORCA_SRC}/deps_src/libnest2d/include"
  "${ORCA_SRC}/deps_src/qhull/src"
)

# Compile defines libslic3r expects (spike-proven set + WASM guards). The
# version macros come from GEN_INCLUDE/libslic3r_version.h (build.sh writes it).
target_compile_definitions(slic3r_core PUBLIC
  USE_TBB
  TBB_USE_CAPTURED_EXCEPTION=0
  SLIC3R_WASM_NO_OCCT
  BOOST_NO_CXX98_FUNCTION_BASE
)
# Single-threaded: no pthreads in v1 (serial TBB shim).
target_compile_options(slic3r_core PRIVATE -O3 -fexceptions -Wno-unused)

# ---- Module: bridge + CLI driver -> single WASM module ----
add_executable(orca_slice
  "${CMAKE_CURRENT_SOURCE_DIR}/src/bridge.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/slice_main.cpp"
)
target_link_libraries(orca_slice PRIVATE slic3r_core)
set_target_properties(orca_slice PROPERTIES OUTPUT_NAME "orca_slice" SUFFIX ".js")
target_link_options(orca_slice PRIVATE
  -O3 -fexceptions
  -sMEMORY64
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=64MB
  -sEXIT_RUNTIME=0
  -sINVOKE_RUN=0
  -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall,cwrap,UTF8ToString,_malloc,_free
  -sDISABLE_EXCEPTION_CATCHING=0
  -sALLOW_TABLE_GROWTH=1
)
if(DEFINED EMBED_FILE AND NOT "${EMBED_FILE}" STREQUAL "")
  target_link_options(orca_slice PRIVATE "--embed-file=${EMBED_FILE}")
endif()
```

- [ ] **Step 4: Write `packages/slicer-wasm/stubs/md5.cpp`**

The spike only declared the classic OpenSSL MD5 API (in the generated
`openssl/md5.h`); a real linked build needs the implementation (`Utils.hpp`
and `Format/bbs_3mf.cpp` call `MD5_Init/Update/Final`). Public-domain MD5
(RFC 1321, Colin Plumb reference implementation):

```cpp
// stubs/md5.cpp — public-domain MD5 (RFC 1321) so the generated
// <openssl/md5.h> declarations resolve at link time. Used by Utils.hpp
// (bbl_calc_md5) and Format/bbs_3mf.cpp (plate gcode md5).
// After Colin Plumb's public-domain reference implementation.
#include <openssl/md5.h>

#include <cstdint>
#include <cstring>

namespace {

using u32 = std::uint32_t;
using u8  = std::uint8_t;

inline u32 rotl(u32 x, int c) { return (x << c) | (x >> (32 - c)); }

void transform(u32 state[4], const u8 block[64]) {
    static const u32 K[64] = {
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
        0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
        0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391};
    static const int S[64] = {
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21};

    u32 a = state[0], b = state[1], c = state[2], d = state[3];
    u32 M[16];
    for (int i = 0; i < 16; ++i)
        M[i] = u32(block[i * 4]) | (u32(block[i * 4 + 1]) << 8) |
               (u32(block[i * 4 + 2]) << 16) | (u32(block[i * 4 + 3]) << 24);
    for (int i = 0; i < 64; ++i) {
        u32 f;
        int g;
        if (i < 16) {
            f = (b & c) | (~b & d);
            g = i;
        } else if (i < 32) {
            f = (d & b) | (~d & c);
            g = (5 * i + 1) % 16;
        } else if (i < 48) {
            f = b ^ c ^ d;
            g = (3 * i + 5) % 16;
        } else {
            f = c ^ (b | ~d);
            g = (7 * i) % 16;
        }
        u32 tmp = d;
        d = c;
        c = b;
        b = b + rotl(a + f + K[i] + M[g], S[i]);
        a = tmp;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
}

}  // namespace

extern "C" {

int MD5_Init(MD5_CTX* ctx) {
    ctx->A = 0x67452301;
    ctx->B = 0xefcdab89;
    ctx->C = 0x98badcfe;
    ctx->D = 0x10325476;
    ctx->Nl = 0;
    ctx->Nh = 0;
    ctx->num = 0;
    return 1;
}

int MD5_Update(MD5_CTX* ctx, const void* data, size_t len) {
    const u8* p = static_cast<const u8*>(data);
    u32 old = ctx->Nl;
    ctx->Nl = old + u32(len << 3);
    if (ctx->Nl < old) ++ctx->Nh;
    ctx->Nh += u32(len >> 29);

    u32 t = (old >> 3) & 0x3f;  // bytes already buffered
    if (t) {
        u32 want = 64 - t;
        if (len < want) {
            std::memcpy(ctx->data + (t >> 2), p, len);
            ctx->num = t + u32(len);
            return 1;
        }
        std::memcpy(ctx->data + (t >> 2), p, want);
        u32 s[4] = {ctx->A, ctx->B, ctx->C, ctx->D};
        u8 block[64];
        std::memcpy(block, ctx->data, 64);
        transform(s, block);
        ctx->A = s[0];
        ctx->B = s[1];
        ctx->C = s[2];
        ctx->D = s[3];
        ctx->num = 0;
        p += want;
        len -= want;
    }
    while (len >= 64) {
        u32 s[4] = {ctx->A, ctx->B, ctx->C, ctx->D};
        transform(s, p);
        ctx->A = s[0];
        ctx->B = s[1];
        ctx->C = s[2];
        ctx->D = s[3];
        p += 64;
        len -= 64;
    }
    if (len) {
        std::memcpy(ctx->data, p, len);
        ctx->num = u32(len);
    }
    return 1;
}

int MD5_Final(u8 digest[MD5_DIGEST_LENGTH], MD5_CTX* ctx) {
    // Append 0x80 + zeros to 56 mod 64, then the 64-bit bit length, feed the
    // whole tail through Update (which already has the buffered bytes), emit.
    const u32 t = (ctx->Nl >> 3) & 0x3f;
    const u64 bits = (u64(ctx->Nh) << 32) | u64(ctx->Nl);
    // Padding: 0x80 followed by zeros up to 56, then 8 length bytes (LE).
    // Build the padded message and feed it through Update.
    size_t total = t;
    u8 tail[128];
    size_t tail_len = 0;
    tail[tail_len++] = 0x80;
    while (((total + tail_len) % 64) != 56) tail[tail_len++] = 0;
    for (int i = 0; i < 8; ++i) tail[tail_len++] = u8(bits >> (8 * i));
    MD5_Update(ctx, tail, tail_len);
    u32 s[4] = {ctx->A, ctx->B, ctx->C, ctx->D};
    for (int i = 0; i < 4; ++i) {
        digest[i * 4] = u8(s[i]);
        digest[i * 4 + 1] = u8(s[i] >> 8);
        digest[i * 4 + 2] = u8(s[i] >> 16);
        digest[i * 4 + 3] = u8(s[i] >> 24);
    }
    return 1;
}

}  // extern "C"
```

> Note: `MD5_Final` above re-enters `MD5_Update` with the padding + length
> tail, which relies on `ctx->Nl/Nh` still holding the pre-padding bit count
> and `num` the buffered byte count — correct per RFC 1321 §3.4. If the linker
> or a smoke check ever disagrees, verify against a known vector
> (`MD5("abc") == 900150983cd24fb0d6963f7d28e17f72`).

- [ ] **Step 5: Verify the harness self-test passes (no emsdk needed)**

Run: `node packages/slicer-wasm/harness/selftest.mjs`
Expected: exit 0 (runs `runSlice` against the mock module: staging, callMain,
read-back, `validateGcode` all exercised).

- [ ] **Step 6: Verify the shim generation works**

Run: `bash packages/slicer-wasm/build.sh --shim-only`
Expected: `.work/shim-include/tbb/*.h` (incl. `parallel_pipeline.h`) and
`oneapi/tbb/*.h` exist.

- [ ] **Step 7: Verify fetch-deps (network, ~1 GB, few minutes)**

Run: `bash packages/slicer-wasm/fetch-deps.sh`
Expected: `.work/deps/eigen-5.0.1/`, `.work/deps/boost-1.84.0/boost/version.hpp`,
`.work/deps/cereal-1.3.0/include/cereal/`, `.work/gen/libslic3r_version.h`,
`.work/gen/openssl/md5.h` exist.

- [ ] **Step 8: Commit**

```bash
git add packages/slicer-wasm
git commit -m "build: inherit WASM scaffold from phase-0 spike (build.sh, CMake, shim, md5 stub)"
```

---

### Task 6: Serial `parallel_pipeline` stand-in (TBB shim)

`GCode.cpp` uses the oneTBB-2021 pipeline API: `make_filter` stages chained
with `&`, driven by `tbb::parallel_pipeline(12, pipeline)` with the generator
stage receiving `tbb::flow_control&` (verified at the pinned SHA, lines
4249–4335). The spike's shim lacks this — the design doc's known gap. The
serial stand-in runs the generator until `fc.stop()`, feeding each item
through the remaining stages in order.

**Files:**
- Modify: `packages/slicer-wasm/shim/_serial.hpp` (add `#include <tuple>` to
  the include block; append the pipeline section before `namespace oneapi`)
- Create: `packages/slicer-wasm/shim/pipeline_test.cpp`

**Interfaces:**
- Produces: `tbb::flow_control`, `tbb::filter_mode` (enum class),
  `tbb::make_filter<In,Out>(mode, fn)`, chaining `operator&`,
  `tbb::parallel_pipeline(tokens, chain)` — the exact surface `GCode.cpp`
  uses.

- [ ] **Step 1: Append the pipeline stand-in to `_serial.hpp`**

Insert `#include <tuple>` into the include block, then append before the
`namespace oneapi` block (inside `namespace tbb`):

```cpp
// ---------------- parallel_pipeline (serial stand-in) ----------------
// oneTBB-2021 pipeline API as used by GCode.cpp: stages are built with
// make_filter<In, Out>(filter_mode, functor) and chained with `&`; the first
// stage (Input = void) is the generator: it receives a tbb::flow_control& and
// returns items until it calls fc.stop(). Serially we run the generator until
// it stops, feeding each item through the remaining stages in order.
class flow_control {
public:
    void stop() { m_stopped = true; }
    bool is_stopped() const { return m_stopped; }
private:
    bool m_stopped = false;
};

enum class filter_mode { parallel, serial_in_order, serial_out_of_order };

template <typename Input, typename Output, typename Functor>
class filter {
public:
    using input_type  = Input;
    using output_type = Output;

    filter(filter_mode, Functor f) : m_functor(std::move(f)) {}

    template <typename... Args>
    Output operator()(Args&&... args) const {
        return m_functor(std::forward<Args>(args)...);
    }

private:
    Functor m_functor;
};

template <typename Input, typename Output, typename Functor>
filter<Input, Output, Functor> make_filter(filter_mode mode, Functor f) {
    return filter<Input, Output, Functor>(mode, std::move(f));
}

// Chained stages. `filters` is public so operator& can splice chains.
template <typename... Filters>
class filter_chain {
public:
    using tuple_t = std::tuple<Filters...>;
    explicit filter_chain(Filters... fs) : filters(std::move(fs)...) {}
    template <std::size_t I>
    auto& stage() { return std::get<I>(filters); }
    tuple_t filters;
};

template <typename F1, typename F2>
auto operator&(const F1& f1, const F2& f2) {
    return filter_chain<F1, F2>(f1, f2);
}

template <typename... Fs, typename Fn>
auto operator&(filter_chain<Fs...> chain, Fn f) {
    return std::apply(
        [&](auto&&... fs) {
            return filter_chain<Fs..., Fn>(std::forward<Fs>(fs)..., std::move(f));
        },
        std::move(chain).filters);
}

namespace detail {
// Feed one item through stages [I, N) of a chain. The last stage may output void.
template <std::size_t I, typename Chain, typename T>
void feed(Chain& chain, T&& item) {
    auto& stage = chain.template stage<I>();
    using stage_t = std::decay_t<decltype(stage)>;
    using out_t   = typename stage_t::output_type;
    if constexpr (std::is_void_v<out_t>) {
        stage(std::forward<T>(item));
    } else {
        auto next = stage(std::forward<T>(item));
        if constexpr (I + 1 < std::tuple_size_v<typename Chain::tuple_t>)
            feed<I + 1>(chain, std::move(next));
    }
}
}  // namespace detail

template <typename... Fs>
void parallel_pipeline(std::size_t /*token_count*/, filter_chain<Fs...> chain) {
    auto& generator = chain.template stage<0>();
    using gen_t = std::decay_t<decltype(generator)>;
    static_assert(std::is_void_v<typename gen_t::input_type>,
                  "first pipeline stage must be a generator (void input)");
    flow_control fc;
    while (!fc.is_stopped()) {
        auto item = generator(fc);
        if (fc.is_stopped()) break;
        if constexpr (sizeof...(Fs) > 1)
            detail::feed<1>(chain, std::move(item));
    }
}

// A bare single-stage pipeline.
template <typename Input, typename Output, typename Functor>
void parallel_pipeline(std::size_t tokens, const filter<Input, Output, Functor>& f) {
    parallel_pipeline(tokens, filter_chain<filter<Input, Output, Functor>>(f));
}
```

- [ ] **Step 2: Write `shim/pipeline_test.cpp`**

Simulates GCode.cpp's stage topology (generator → transform → sink):

```cpp
// Native (host-compiler) test for the serial parallel_pipeline stand-in.
// Build:  g++ -std=c++17 -I shim shim/pipeline_test.cpp -o /tmp/pipeline_test
// Run:    /tmp/pipeline_test
#include "_serial.hpp"

#include <cassert>
#include <sstream>
#include <string>

int main() {
    std::ostringstream out;
    const int n = 5;
    tbb::parallel_pipeline(
        12,
        tbb::make_filter<void, int>(tbb::filter_mode::serial_in_order,
            [n](tbb::flow_control& fc) -> int {
                static int i = 0;
                if (i >= n) {
                    fc.stop();
                    return 0;
                }
                return i++;
            }) &
        tbb::make_filter<int, int>(tbb::filter_mode::serial_in_order,
            [](int v) { return v * 2; }) &
        tbb::make_filter<int, std::string>(tbb::filter_mode::serial_in_order,
            [](int v) { return "x" + std::to_string(v); }) &
        tbb::make_filter<std::string, void>(tbb::filter_mode::serial_in_order,
            [&](std::string&& s) { out << s << '\n'; }));
    assert(out.str() == "x0\nx2\nx4\nx6\nx8\n");
    return 0;
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `g++ -std=c++17 -I packages/slicer-wasm/shim packages/slicer-wasm/shim/pipeline_test.cpp -o /tmp/pipeline_test && /tmp/pipeline_test`
Expected: exit 0 (assert holds). If no host C++ compiler is available, run the
test via the wasm build instead (Task 8) — the shim compiles into every TU.

- [ ] **Step 4: Commit**

```bash
git add packages/slicer-wasm/shim
git commit -m "feat: serial parallel_pipeline stand-in for the TBB shim"
```

---

### Task 7: Boost 1.84 wasm64 build (long-running)

**Files:**
- Create: nothing (script from Task 5; archives land in `.work/deps/boost-1.84.0/stage-wasm64/lib/`, gitignored)

**Interfaces:**
- Consumes: `build-boost-wasm64.sh` + Boost source from Task 5/Step 7.
- Produces: `$WORK_DIR/deps/boost-1.84.0/stage-wasm64/lib/libboost_{system,filesystem,thread,atomic,chrono,date_time,iostreams,log,log_setup,locale,program_options,regex,nowide}-*.a` — the archives `slic3r_core` links (Task 8).

- [ ] **Step 1: Run the Boost build**

Run: `bash packages/slicer-wasm/build-boost-wasm64.sh`
Expected: b2 builds all 12 libraries; final `ls` lists the `.a` archives in
`stage-wasm64/lib`. Budget 30–90 minutes and ~5–10 GB disk on this machine;
run it in the background and continue to Task 8 only after it finishes.

> **Serial-first note:** the script (spike-proven) compiles with
> `-pthread` in its cxxflags. If the final link (Task 8) reports undefined
> pthread/futex symbols pulled from these archives, rebuild Boost with the
> `-pthread` removed from `cxxflags`/`cflags` (serial archives — the fix
> documented in AGENTS.md's iterate loop), then re-link.

- [ ] **Step 2: Verify the archives**

Run: `ls packages/slicer-wasm/.work/deps/boost-1.84.0/stage-wasm64/lib/*.a | wc -l`
Expected: 13 (12 libs; `nowide` splits). All names `libboost_*.a`.

---

### Task 8: Scaffold build — iterate to a linked module

This is the expected iteration surface (AGENTS.md §WASM Build Workflow). The
spike's FINDINGS.md itemizes every known failure class and its fix; the
priority fixes are baked in already (wasm64 → `size_t` class solved; shim
covers `concurrent_*` + `version.h`; `Model.hpp` STEP guard patch; qhull
include path in CMakeLists; md5 stub impl; `-I` set complete). Expect the
unknowns to be the ~10 clang-strictness tweaks and `distance_to_squared`.

**Files:**
- Create (as they surface): `packages/slicer-wasm/patches/0002-*.patch`, …
  (one patch file per submodule fix, applied by `build.sh`? No — applied
  manually per the recipe below; keep the patch files so they can be scripted
  in CI later)
- Modify: `packages/slicer-wasm/build.sh` (`TBB_HEADERS`),
  `packages/slicer-wasm/CMakeLists.txt` (`DROP_PATTERNS`, include dirs, defs)

**Interfaces:**
- Consumes: shim (Task 6), Boost archives (Task 7), deps + generated headers
  (Task 5), submodule (Task 4).
- Produces: `packages/slicer-wasm/out/orca_slice.js` + `.wasm` — the module
  Tasks 9–10 test.

- [ ] **Step 1: Apply the shipped STEP-guard patch**

Run:
```bash
cd packages/slicer-wasm/cpp
git apply ../patches/0001-model-hpp-guard-step-include.patch
git status --short   # expect: M src/libslic3r/Model.hpp (working tree only)
```
Expected: patch applies clean. **Never commit it inside the submodule** — it
must be re-applied after each submodule reset (`git submodule update`). Record
the re-apply step in `doc/` (Task 11).

- [ ] **Step 2: Configure**

Run: `bash packages/slicer-wasm/build.sh` (stop at the configure line if it
fails — expected: it dies with guidance).

- [ ] **Step 3: Iterate compile/link errors until `ninja orca_slice` succeeds**

Each failure gets one of the documented fixes:

| Failure | Fix |
|---|---|
| Missing `<tbb/X.h>` | add `X` to `TBB_HEADERS` in `build.sh`, re-run |
| Undefined symbol from a dropped file (SLA/CGAL/OCCT) | exclude its caller via `DROP_PATTERNS`, or add an empty stub in `stubs/` |
| `distance_to_squared` overload (AABBTreeLines.hpp, 3 files) | add the missing overload for Eigen vector types in a **patch file** (`patches/0002-aabbtreelines-distance-overload.patch`) |
| clang-strictness compile errors (~10 known) | collect each as a patch file (`patches/0003-*.patch` etc.), apply via `git apply` |
| Boost not found / wrong flavor | fix `*_INCLUDE` paths; verify archives are wasm64 |
| pthread/futex symbols from Boost archives | rebuild Boost without `-pthread` cxxflags (Task 7 note), re-link |
| `libslic3r_version.h` / `openssl/md5.h` missing | `GEN_INCLUDE` on the include path (CMakeLists already has it); re-run fetch-deps |
| template pedantry / missing `<sstream>` etc. | 1-line patch files, same pattern |

Recipe per fix: edit the submodule file, `git -C cpp diff > patches/NNNN-description.patch`,
`git -C cpp checkout -- <file>` (submodule stays clean), re-run `build.sh`.
The build is the test: `emmake ninja -C .work/build orca_slice` exits 0.

- [ ] **Step 4: Verify the module artifacts**

Run: `ls -la packages/slicer-wasm/out/`
Expected: `orca_slice.js` + `orca_slice.wasm` (wasm64 — check with
`node -e "const b=require('fs').readFileSync('packages/slicer-wasm/out/orca_slice.wasm'); console.log(b[8])"` → prints `2` for memory64, or simply trust the build flags).

- [ ] **Step 5: Commit the patch set + any scaffold tweaks**

```bash
git add packages/slicer-wasm/patches packages/slicer-wasm/build.sh packages/slicer-wasm/CMakeLists.txt packages/slicer-wasm/stubs
git commit -m "build: wasm module links (patches NNNN-NNNN, TBB_HEADERS +DROP, DROP_PATTERNS tweaks)"
```

---

### Task 9: Node smoke green (the M1 GO criterion)

**Files:**
- Create: `packages/slicer-wasm/fixtures/cube.stl` (generated)
- Consumes: `harness/run-slice.mjs` + `fixtures/make-cube.mjs` + `config.ini`
  (Task 5), module (Task 8).

**Interfaces:**
- Produces: the acceptance test for the whole milestone — exit 0 + valid
  G-code with `G0`/`G1` moves. Milestone 3 adds the cross-check against
  desktop OrcaSlicer output.

- [ ] **Step 1: Generate the cube fixture**

Run: `node packages/slicer-wasm/fixtures/make-cube.mjs`
Expected: `packages/slicer-wasm/fixtures/cube.stl` exists (20 mm cube).

- [ ] **Step 2: Run the smoke**

Run: `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.ini`
Expected: exit 0, `gcode: OK (… bytes, … lines)` with `G1` moves present.
The harness stages both files into MEMFS, runs `callMain(['/model.stl',
'/config.ini', '/out.gcode'])`, and validates the output.

- [ ] **Step 3: Spot-check the G-code**

Open `packages/slicer-wasm/out/` — the smoke writes to MEMFS only; to
inspect, add `--out`? No: read the bytes via the harness logs. Verify a
`G1 X… Y… E…` extrusion move and the `layer_height`-consistent Z steps appear
in the printed log (run `run-slice.mjs` with `DEBUG=1`? Not needed — print
the `[wasm]` lines from Step 2).

- [ ] **Step 4: Commit**

```bash
git add packages/slicer-wasm/fixtures/cube.stl
git commit -m "test: node smoke green — cube.stl slices to valid G-code"
```

---

### Task 10: Bridge API (`src/bridge.cpp`) + bridge smoke

The design doc's 8-function extern "C" API, compiled into the same module as
`slice_main`. Binary result buffers (toolpath marshaling) are
deliberately Milestone 2 (Epic 2.4 "Slice orchestration: config JSON →
progress → result buffers") — the client test drives their exact layout; here
`orc_get_slice_result` returns JSON stats.

**Files:**
- Create: `packages/slicer-wasm/src/bridge.cpp`, `packages/slicer-wasm/harness/bridge-smoke.mjs`

**Interfaces:**
- Consumes: `PrintConfigDef::defs()`, `PresetBundle`, `Model::read_from_file`,
  `Print::apply/validate/process/export_gcode/cancel`, `set_data_dir` —
  all confirmed at the pinned SHA (drift surface per AGENTS.md).
- Produces: exports `orc_init`, `orc_get_presets(kind)`,
  `orc_get_option_metadata`, `orc_load_model(ptr,len,ext)`,
  `orc_set_progress_callback(cb)`, `orc_slice(config_json)`,
  `orc_get_slice_result`, `orc_export_gcode`, `orc_cancel` — JSON-in/JSON-out,
  malloc'd C-string returns the JS side frees. Milestone 2's client wraps
  these exactly.

- [ ] **Step 1: Write `packages/slicer-wasm/src/bridge.cpp`**

```cpp
// ----------------------------------------------------------------
// ------------ extern "C" JSON-in/JSON-out bridge ----------------
// ----------------------------------------------------------------
// The only C++<->JS seam (design §Bridge API). Every function runs
// synchronously on the worker thread. JSON strings are returned as malloc'd
// C strings; the JS side reads them with UTF8ToString and _free()s. Binary
// buffers cross via the WASM heap (_malloc/_free + HEAPU8).
//
// Version-sensitive libslic3r APIs are the documented drift surface
// (AGENTS.md): if a signature below mismatches the pinned submodule, adjust
// here — never in the submodule.
#include <emscripten/emscripten.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/PrintConfigDef.hpp"
#include "libslic3r/Utils.hpp"

#include "nlohmann/json.hpp"

using namespace Slic3r;
using nlohmann::json;

namespace {

// Module-global state. orc_init() (re)creates the preset bundle.
AppConfig g_app_config;
PresetBundle g_presets;
Model g_model;
Print g_print;

// Copy a string into a malloc'd C string the JS side can read then _free().
const char* dup_json(const std::string& s) {
    char* out = static_cast<char*>(std::malloc(s.size() + 1));
    std::memcpy(out, s.data(), s.size());
    out[s.size()] = '\0';
    return out;
}

const char* error_json(const std::string& msg) {
    return dup_json(json{{"error", msg}}.dump());
}

std::string option_type_name(const ConfigOptionDef& def) {
    switch (def.type) {
        case coFloat:            return "float";
        case coInt:              return "int";
        case coString:           return "string";
        case coBool:             return "bool";
        case coPercent:          return "percent";
        case coFloats:           return "floats";
        case coInts:             return "ints";
        case coStrings:          return "strings";
        case coBools:            return "bools";
        case coEnum:             return "enum";
        case coFloatOrPercent:   return "float_or_percent";
        case coPercents:         return "percents";
        case coPoint:            return "point";
        case coPoints:           return "points";
        case coPoint3:           return "point3";
        case coVec3d:            return "vec3d";
        default:                 return "unknown";
    }
}

json option_def_to_json(const ConfigOptionDef& def) {
    json j;
    j["type"] = option_type_name(def);
    if (!def.label.empty()) j["label"] = def.label;
    if (!def.full_label.empty()) j["full_label"] = def.full_label;
    if (!def.tooltip.empty()) j["tooltip"] = def.tooltip;
    if (!def.category.empty()) j["category"] = def.category;
    j["mode"] = int(def.mode);
    if (!def.enum_values.empty()) j["enum_values"] = def.enum_values;
    if (!def.enum_labels.empty()) j["enum_labels"] = def.enum_labels;
    if (def.min != 0.0 || def.max != 0.0) {
        j["min"] = def.min;
        j["max"] = def.max;
    }
    if (def.default_value) j["default"] = def.default_value->serialize();
    return j;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_init() {
    try {
        // Embedded curated profiles land at /system (build.sh --embed-file);
        // /user is a writable MEMFS dir setup_directories() creates.
        set_data_dir("/");
        g_presets.setup_directories();
        g_presets.load_presets(g_app_config, ForwardCompatibilitySubstitutionRule::Enable);
        return dup_json(json{{"ok", true},
                             {"prints",   g_presets.prints.size()},
                             {"filaments", g_presets.filaments.size()},
                             {"printers",  g_presets.printers.size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_presets(const char* kind_cstr) {
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const PresetCollection* coll = nullptr;
        if (kind == "print")            coll = &g_presets.prints;
        else if (kind == "filament")    coll = &g_presets.filaments;
        else if (kind == "printer")     coll = &g_presets.printers;
        else return error_json("kind must be print|filament|printer");
        json arr = json::array();
        for (const Preset& p : coll->presets)
            arr.push_back({{"name", p.name}});
        return dup_json(json{{"presets", arr}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_option_metadata() {
    try {
        const auto& defs = PrintConfigDef::defs();
        json out = json::object();
        for (const auto& [key, def] : defs)
            out[key] = option_def_to_json(def);
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

// Model bytes arrive in the WASM heap (JS: _malloc + HEAPU8 + _free).
// Stage them to a MEMFS file so the format loaders can open a real path.
EMSCRIPTEN_KEEPALIVE const char* orc_load_model(const char* data, int len, const char* ext) {
    try {
        if (!data || len <= 0) return error_json("no model bytes");
        const std::string path =
            "/tmp/uploaded_model." + std::string(ext && *ext ? ext : "stl");
        std::FILE* f = std::fopen(path.c_str(), "wb");
        if (!f) return error_json("cannot open /tmp for model upload");
        std::fwrite(data, 1, size_t(len), f);
        std::fclose(f);

        DynamicPrintConfig dummy;
        g_model = Model::read_from_file(path, &dummy, nullptr,
                                        LoadStrategy::AddDefaultInstances);
        return dup_json(json{{"ok", true},
                             {"objects",   g_model.objects.size()},
                             {"instances", g_model.instances().size()}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

using progress_fn = void (*)(int, const char*);
progress_fn g_progress = nullptr;

EMSCRIPTEN_KEEPALIVE void orc_set_progress_callback(progress_fn cb) { g_progress = cb; }

EMSCRIPTEN_KEEPALIVE const char* orc_slice(const char* config_json) {
    try {
        DynamicPrintConfig config;
        const json cfg = json::parse(config_json ? config_json : "");
        for (auto it = cfg.begin(); it != cfg.end(); ++it) {
            const std::string& key = it.key();
            std::string value;
            if (it.value().is_array()) {
                for (const auto& v : it.value()) {
                    if (!value.empty()) value += ",";
                    value += v.is_string() ? v.get<std::string>() : v.dump();
                }
            } else if (it.value().is_string()) {
                // JSON strings use "\\n" escapes; restore real newlines for
                // multi-line values (start_gcode etc.).
                value = it.value().get<std::string>();
                std::string unescaped;
                unescaped.reserve(value.size());
                for (size_t i = 0; i < value.size(); ++i) {
                    if (value[i] == '\\' && i + 1 < value.size() && value[i + 1] == 'n') {
                        unescaped.push_back('\n');
                        ++i;
                    } else {
                        unescaped.push_back(value[i]);
                    }
                }
                value = std::move(unescaped);
            } else if (it.value().is_boolean()) {
                value = it.value().get<bool>() ? "1" : "0";
            } else {
                value = it.value().dump();
            }
            config.set_deserialize(key, value,
                                   ForwardCompatibilitySubstitutionRule::Disable);
        }

        g_print.apply(g_model, config);
        const std::string validation_error = g_print.validate();
        if (!validation_error.empty()) return error_json(validation_error);

        g_print.set_status_callback([&](const SlicingStatus& st) {
            if (g_progress) g_progress(st.percent, st.text.c_str());
        });
        g_print.process();
        g_print.set_status_default();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

// JSON stats for v1; the binary toolpath buffers land in
// Milestone 2 (Epic 2.4) where the JS client drives their layout.
EMSCRIPTEN_KEEPALIVE const char* orc_get_slice_result() {
    try {
        json out{{"ok", true}, {"objects", g_print.objects.size()}};
        if (!g_print.objects.empty())
            out["layers"] = g_print.objects.front()->layers().size();
        return dup_json(out.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_export_gcode() {
    try {
        const std::string path = "/out.gcode";
        g_print.export_gcode(path, nullptr, nullptr);
        return dup_json(json{{"ok", true}, {"path", path}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_cancel() {
    try {
        g_print.cancel();
        return dup_json(json{{"ok", true}}.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    }
}

}  // extern "C"
```

- [ ] **Step 2: Write `packages/slicer-wasm/harness/bridge-smoke.mjs`**

```js
// ----------------------------------------------------------------
// ------------ Bridge smoke: drive orc_* exports directly --------
// ----------------------------------------------------------------
// Loads the built module and exercises every bridge function end to end:
// init -> presets -> metadata -> load model -> slice (with progress) ->
// slice result -> export gcode -> cancel. The 3D-preview buffers are M2.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { argv } from 'node:process';
import { validateGcode } from './run-slice.mjs';

const [modulePath, stlPath] = argv.slice(2);
if (!modulePath || !stlPath) {
  console.error('usage: node bridge-smoke.mjs <out/orca_slice.js> <cube.stl>');
  process.exit(2);
}

const factory = (await import(pathToFileURL(modulePath).href)).default;
const Module = await factory({ noInitialRun: true, print: console.error, printErr: console.error });

// wasm64: heap pointers are BigInt — keep them as numbers for typed-array ops.
function callJson(name, argTypes, args) {
  const ptr = Module.ccall(name, 'number', argTypes, args);
  const s = Module.UTF8ToString(ptr);
  Module._free(ptr);
  return JSON.parse(s);
}

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

// 1. init (embedded curated presets)
const init = callJson('orc_init', [], []);
check('orc_init ok', init.ok === true, JSON.stringify(init));
check('init has printers', init.printers > 0, `printers=${init.printers}`);

// 2. presets
const printers = callJson('orc_get_presets', ['string'], ['printer']);
check('orc_get_presets(printer)', Array.isArray(printers.presets) && printers.presets.length > 0,
      `count=${printers.presets?.length}`);
const prints = callJson('orc_get_presets', ['string'], ['print']);
check('orc_get_presets(print)', Array.isArray(prints.presets) && prints.presets.length > 0,
      `count=${prints.presets?.length}`);

// 3. option metadata
const meta = callJson('orc_get_option_metadata', [], []);
check('orc_get_option_metadata has layer_height',
      meta.layer_height?.type === 'float', JSON.stringify(meta.layer_height));
check('metadata has fill_pattern enum', Array.isArray(meta.fill_pattern?.enum_values));

// 4. load model (bytes via the heap)
const stl = await readFile(stlPath);
const dataPtr = Number(Module._malloc(stl.length));
Module.HEAPU8.set(stl, dataPtr);
const loaded = callJson('orc_load_model', ['number', 'number', 'string'],
                        [dataPtr, stl.length, 'stl']);
Module._free(dataPtr);
check('orc_load_model ok', loaded.ok === true && loaded.objects > 0, JSON.stringify(loaded));

// 5. progress callback (wasm function table, ALLOW_TABLE_GROWTH)
let progressCalls = 0;
const cb = Module.addFunction((percent, text) => {
  progressCalls++;
}, 'vii');
Module.ccall('orc_set_progress_callback', null, ['number'], [cb]);

// 6. slice (config mirroring fixtures/config.ini, as JSON)
const configJson = {
  layer_height: 0.2, first_layer_height: 0.2, nozzle_diameter: 0.4,
  filament_diameter: 1.75, temperature: 210, first_layer_temperature: 215,
  bed_temperature: 60, first_layer_bed_temperature: 60,
  bed_shape: '0x0,220x0,220x220,0x220',
  perimeters: 2, top_solid_layers: 3, bottom_solid_layers: 3,
  fill_density: '15%', fill_pattern: 'grid',
  perimeter_speed: 60, infill_speed: 80, travel_speed: 150,
  gcode_flavor: 'marlin',
  start_gcode: 'G28\\nG1 Z5 F5000', end_gcode: 'M104 S0\\nM140 S0\\nG28 X0\\nM84',
};
const sliced = callJson('orc_slice', ['string'], [JSON.stringify(configJson)]);
check('orc_slice ok', sliced.ok === true, JSON.stringify(sliced));
check('progress fired', progressCalls > 0, `calls=${progressCalls}`);
Module.removeFunction(cb);

// 7. slice result stats
const result = callJson('orc_get_slice_result', [], []);
check('orc_get_slice_result layers > 0', result.ok === true && result.layers > 0,
      JSON.stringify(result));

// 8. export gcode (MEMFS) + validate
const exported = callJson('orc_export_gcode', [], []);
check('orc_export_gcode ok', exported.ok === true, JSON.stringify(exported));
const gcode = validateGcode(Module.FS.readFile('/out.gcode'));
check('gcode valid', gcode.ok, JSON.stringify(gcode));

// 9. cancel is safe
const cancelled = callJson('orc_cancel', [], []);
check('orc_cancel ok', cancelled.ok === true, JSON.stringify(cancelled));

process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Rebuild with the bridge included**

Run: `bash packages/slicer-wasm/build.sh`
Expected: `ninja orca_slice` links (bridge.cpp is in the CMake target from
Task 5; if `nlohmann/json.hpp` resolves to the vendored copy and any bridge
API drifted, fix per the iterate loop — each `orc_*` call maps to a confirmed
signature listed in Step 1's comment).

- [ ] **Step 4: Run the bridge smoke**

Run: `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`
Expected: all 9 checks PASS, exit 0. If `orc_get_presets` is empty, the embed
layout is off — check `load_system_presets_from_json` in the submodule's
`PresetBundle.cpp` (reads `<data_dir>/system/*.json` + vendor dirs) and adjust
`embed_presets()` in `build.sh` (e.g. embed a second vendor whose JSON doesn't
inherit from others).

- [ ] **Step 5: Commit**

```bash
git add packages/slicer-wasm/src/bridge.cpp packages/slicer-wasm/harness/bridge-smoke.mjs
git commit -m "feat: extern C bridge API (orc_init/get_presets/get_option_metadata/load_model/slice/get_slice_result/export_gcode/cancel) + bridge smoke"
```

---

### Task 11: Roadmap sync + WASM build notes

**Files:**
- Modify: `spec/Grand Plan.md` (M0 checkbox; M1 checkboxes as delivered),
  `doc/high_level_dev_plan.md` (Milestone 1 status line)
- Create: `doc/2026-08-12-wasm-build-notes.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the record a fresh engineer needs to rebuild (per
  docs-first practice: "each epic creates/updates a short sub-doc capturing
  decisions and testing notes").

- [ ] **Step 1: Update `spec/Grand Plan.md`**

Check off the M0 scaffold box; check the M1 boxes actually delivered
(patches, shim + `parallel_pipeline`, Boost build, scaffold CMake + 3MF
re-add, `bridge.cpp` API, Node smoke green). Leave M1 "Target" TBD or set it
to today's date if the milestone is done.

- [ ] **Step 2: Update `doc/high_level_dev_plan.md`**

Add a short status line to Milestone 1 ("Delivered 2026-08-12: submodule
pinned b97ca3c0ac; serial shim + pipeline stand-in; Boost 1.84 wasm64;
scaffold CMake with 3MF; bridge API; Node smoke green — see
`doc/2026-08-12-wasm-build-notes.md`").

- [ ] **Step 3: Write `doc/2026-08-12-wasm-build-notes.md`**

Header block (title/date/status/scope), then: exact build commands; the
patches applied (0001 + any from Task 8) with re-apply instructions; the
final `TBB_HEADERS` / `DROP_PATTERNS` sets; every iterate-loop fix actually
hit (missing headers, stubs, API drift adjustments); the bridge JSON contract
per function; known M2 work (binary result buffers, full preset bundle,
COOP/COEP).

- [ ] **Step 4: Verify the milestone acceptance criteria once more**

Run: `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.ini && node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add spec/Grand\ Plan.md doc/high_level_dev_plan.md doc/2026-08-12-wasm-build-notes.md
git commit -m "docs: mark M0+M1 delivered, add WASM build notes"
```

---

## Self-Review

- **Spec coverage (Grand Plan M0/M1):** submodule pin + patches → Tasks 4, 8;
  serial shim + `parallel_pipeline` → Task 6; Boost wasm64 → Task 7; scaffold
  CMake + 3MF re-add → Task 5 (Step 3: `/Format/3mf` deliberately absent from
  `DROP_PATTERNS`); `bridge.cpp` 8-function API → Task 10; Node smoke green →
  Task 9. Design-doc specifics covered: wasm64 flag set (Task 5), serial-first
  (Task 5/7 notes), curated embed (Task 5 `embed_presets`), `slice_main`
  retained (Task 5), harness/mock-module pattern (Task 5), 3MF deps verified
  in-tree (Task 5 comment).
- **Placeholder scan:** every file is written out or named as a verbatim
  spike copy; every iterate-loop entry names its concrete fix; the two
  explicitly deferred pieces (binary slice-result buffers → M2 Epic 2.4;
  `distance_to_squared`/clang patches → created from compiler output in Task 8
  with the exact recipe) are named deliverables, not "TODO".
- **Type/name consistency:** bridge export names, `TBB_HEADERS` (incl.
  `parallel_pipeline`), CMake target `orca_slice`, artifact paths
  (`out/orca_slice.js`), harness entry points (`run-slice.mjs`,
  `bridge-smoke.mjs`), and the `stubs/md5.cpp` ↔ generated
  `openssl/md5.h` contract are consistent across tasks.
- **Known residual risk (by design):** `orc_slice`'s `set_deserialize` and
  `load_presets`/`setup_directories` exact parameter lists at the pinned SHA
  may drift from the code above — Task 10 Step 3 and the Task 10 header
  comment name these as the iterate surface; the smoke is the test.
