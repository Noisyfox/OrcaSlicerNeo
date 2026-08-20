# 2026-08-20 — WASM debug build (`--debug` / `WASM_DEBUG`)

## Why

The WASM slicing module (`orca_slice`) is normally built release-only (`-O3`,
no debug info), so a bridge/slicing bug inside the module is a black box.
This adds an opt-in **debug mode** to the whole build pipeline (sh **and** bat)
that produces an **interactive, source-level debuggable** module with
**DWARF embedded in the final `.wasm`** — debuggable in Chrome DevTools
("DWARF debugging" experiment) with working breakpoints, single-stepping and
variable inspection in the C++ sources.

## Scope (deliberate)

Only the **libslic3r/OrcaSlicer part** carries debug info:

- `slic3r_core` (the libslic3r sources) — `-g -O0` instead of `-O3`
- `orca_slice` TUs (`src/bridge.cpp`, `src/slice_main.cpp`) — `-g -O0`
- link (`orca_slice`) — `-O0 -g` (embeds the DWARF sections in the `.wasm`,
  no `-gsource-map`, no external files) + `-sASSERTIONS=1` (runtime asserts;
  default at `-O0`, pinned explicitly so they cannot silently vanish)

**Dependencies stay release `-O3` WITHOUT debug info and are not rebuilt:**
Boost (`build-boost-wasm64.*`), oneTBB (`build-onetbb.*`), and the vendored
`deps_core` sources (expat, miniz, admesh, clipper, qhull, glu-libtess,
semver, qoi) keep their existing `-O3` compile options with no `-g`.

Trade-off accepted: debug compiles noticeably slower and the module is several
times larger (DWARF bloat). Run release `build` (no flag) to restore the
release module in place.

## Flag surface (uniform across sh + bat)

| Surface | Behavior |
|---|---|
| `build-windows.bat build --debug` / `bash scripts/build.sh build --debug` | dual-variant build with embedded DWARF + stage |
| `build-windows.bat full --debug` / `bash scripts/build.sh full --debug` | cold-start path with embedded DWARF |
| `build.bat --debug` / `./build.sh --debug` | single variant (env `WASM_THREADING`/`WASM_ARTIFACT_VARIANT` as usual) |
| `build-wasm-dual.bat --debug` / `build-wasm-dual.sh --debug` | direct dual build |
| `WASM_DEBUG=1` (env) | honored by `build.sh`/`build.bat` for programmatic callers; the dual builders forward via env |
| `quick --debug` | does **not** reconfigure — ninja reuses the cached tree. The driver verifies `CMakeCache.txt` actually contains `WASM_DEBUG:BOOL=ON` and fails with an actionable message otherwise (run `build --debug` to reconfigure). |

Flag plumbing: `scripts/build-windows.bat` / `scripts/build.sh` (drivers) →
`scripts/build-wasm-dual.bat` / `build-wasm-dual.sh` (dual) →
`packages/slicer-wasm/build.bat` / `build.sh` (single variant; adds
`-DWASM_DEBUG=ON/OFF` to the emcmake configure) → `CMakeLists.txt`
(`option(WASM_DEBUG ...)` decides the flag set).

## Usage

```bat
REM Windows (cmd)
build-windows.bat build --debug
```

```bash
# macOS / Linux
bash scripts/build.sh build --debug
```

Artifacts land in the usual places (`packages/slicer-wasm/out/<variant>/`,
staged by `stage-wasm.mjs` into the renderer's public dir) — same names,
same dirs, debug content inside the `.wasm`. A `--debug` build replaces the
release module in place; a plain `build` restores release.

## Debugging in Chrome DevTools

1. `pnpm --filter web dev` (or the desktop app) with the debug module staged.
2. Chrome DevTools → Settings → Experiments → enable **"DWARF debugging"**.
3. Sources panel: the C++ sources resolve via the embedded DWARF; set
   breakpoints in `bridge.cpp` / libslic3r, step, inspect locals.

Notes:
- C++ sources must be on disk at the paths recorded at build time — build on
  the same checkout you debug against.
- Paused-in-wasm state is not perfect at `-O0` (some Emscripten
  runtime/glue frames are wasm-generated), but libslic3r frames are fully
  debuggable.
- `-sASSERTIONS=1` makes Emscripten runtime contract violations throw
  descriptive errors instead of failing silently — expected in debug builds.

## Verification recipe

```bash
# 1. DWARF sections present in the final module (emsdk's LLVM):
"<emsdk>/upstream/bin/llvm-dwarfdump" packages/slicer-wasm/out/threaded/orca_slice.wasm --show-sections
#    expect .debug_info / .debug_line / .debug_abbrev / ... ; module size
#    several× the release build.
# 2. Behavior unchanged:
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/threaded/orca_slice.js \
     --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
# 3. Deps untouched: boost/oneTBB archives are never recompiled by the debug
#    path (they do not receive -g).
# 4. Release restore: plain `build` puts WASM_DEBUG:BOOL=OFF back in the cache
#    and ninja rebuilds the affected objects at -O3.
# 5. quick guard: on a release-configured tree, `quick --debug` fails with
#    "configured without WASM_DEBUG - run: build --debug".
```

## Implementation notes

- `CMakeLists.txt`: `option(WASM_DEBUG ...)`; `slic3r_core` and `orca_slice`
  compile options branch on it; the link's `-O3` is hoisted into
  `ORCA_LINK_OPTIMIZE` (`-O0 -g` when debug); `-sASSERTIONS=1` appended under
  `WASM_DEBUG`. `deps_core` compile options are intentionally untouched.
- `-fexceptions` is kept in debug mode (bridge error contract; see
  `wasm-bridge-exceptions-flag` memory / M4 probe).
- `.bat` changes follow the cmd gotchas in
  `doc/2026-08-15-cmd-build-pipeline.md` (CRLF, escaped parens, `shift` loops
  at top level, `%errorlevel%` read outside paren blocks).
