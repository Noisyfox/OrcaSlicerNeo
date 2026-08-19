# WASM Build Notes

Date: 2026-08-13
Status: Delivered — Milestone 1 (WASM Core) acceptance verified 2026-08-13
Scope: The record a fresh engineer needs to rebuild the WASM slicing module
(`packages/slicer-wasm`) from a clean checkout: machine prerequisites, exact
commands, the patch set, the iterate-loop fixes actually hit, the bridge JSON
contract, and the known M2 work. Companion to the approved design
(`doc/2026-08-12-electron-gui-rewrite-design.md`), the milestone checklist
(`spec/Grand Plan.md`), and `doc/high_level_dev_plan.md`.

## Overview

`packages/slicer-wasm` compiles the pinned C++ submodule
(`cpp/` → `Noisyfox/OrcaSlicer`, SHA `b97ca3c0ac`) into a single Emscripten
module: serial TBB shim, scaffold CMake with a denylist of dropped v1
features, the extern "C" bridge API, and the CLI driver — all wasm64. The
build machinery is inherited from the phase-0 spike and adapted (no clone
step, wasm64-first, curated preset subset embedded). Artifacts land in
`packages/slicer-wasm/out/` (`orca_slice.js` + `orca_slice.wasm`).

The build is **not push-button** — it is an iteration surface. When it fails,
work the loops in AGENTS.md ("WASM Build Workflow") and this note's
"iterate-loop fixes" section. Everything below was verified on the delivery
machine on 2026-08-13; smoke both harnesses before declaring a rebuild green.

## Machine prerequisites (delivery machine, Task 7 findings)

These are mandatory for a rebuild on a fresh machine.

- **emsdk 6.0.6 on PATH** — `emcc`/`emcmake`/`em++` must resolve in Git Bash
  (the build's prerequisite checks use `command -v`). `emsdk_env.sh` does
  **not** work in Git Bash (no `.emsdk` config), so activate the SDK at the
  system level instead: `emsdk activate 6.0.6` from a Windows shell, then add
  the emsdk `upstream/emscripten`, `upstream/bin` and Node `bin` dirs to the
  user PATH (or source `emsdk_env.bat` per shell). No per-shell exports are
  needed.
- **cmake ≥ 3.25 and ninja on PATH.** They are not provided by emsdk 6.0.6
  (the bundled `cmake/4.2.0-rc3_64bit` package dir is empty and no ninja
  ships), so install separately — your package manager, or
  `emsdk install cmake ninja` where those packages exist (the delivery machine
  uses cmake 4.4.2 and ninja 1.13.2 from the system PATH).
- **Bare-name PE toolchain shims in `packages/slicer-wasm/.work/toolchain-shims/`**
  (`em++`, `emar`, `emranlib`). b2 GLOB-matches the bare `em++` name with no
  `.exe` fallback, so Windows needs these shims that forward to the real
  emscripten binaries. Recreate on new machines; pinned to emsdk 6.0.6.
  (`.work/` is gitignored — the shims do not ship with the repo.) Add the shim
  dir to PATH for the Boost build step:
  ```bash
  export PATH="<repo>/packages/slicer-wasm/.work/toolchain-shims:$PATH"
  ```
- **`C:/Users/<user>/site-config.jam`** (b2 user config) must contain:
  ```
  project site-config : requirements <address-model>64 <target-os>linux ;
  ```
  Required for wasm64 (name-clash with the host's 32-bit builds) and for the
  `<target-os>` Linux source selection (the Boost.Jamfile picks Windows
  `windows.h` paths otherwise).
- **Boost 1.84 built via `build-boost-wasm64.sh`** — the 12-archive set
  (system, filesystem, thread, atomic, chrono, date_time, iostreams, log,
  log_setup, program_options, regex, nowide). `boost_locale` is intentionally
  skipped by Boost's own Jamfile when built without ICU/iconv — which matches
  the approved design's "12 static archives". Must be built wasm64 with
  `-pthread` so the `v2s_mt_posix` Boost.Log ABI tag matches the module
  (see iterate-loop fix 3). ~50 GB free disk for the dep build.
- **`-sMEMORY64` is deprecated in emcc 6.0.6** (prefer `-m64` /
  `--target=wasm64`). It is functional today and used throughout for wasm64
  consistency (objects, Boost archives, link); future emsdk bumps should
  migrate the flags before they break.

## Build commands

From the repo root (with the prerequisites above on PATH):

```bash
bash packages/slicer-wasm/build.sh
```

`build.sh` runs, in order: prerequisite checks → serial shim header
generation (`--shim-only` re-runs just that step) → `fetch-deps.sh` (Eigen
5.0.1 / Boost 1.84 / cereal 1.3.0 + generated headers, if not staged) →
fork-derived `libslic3r_version.h` (version + git hash from the submodule) →
curated preset embed (see below) → `emcmake` configure → `emmake ninja
orca_slice` → artifacts copied to `packages/slicer-wasm/out/`.

Smoke both harnesses (Step 4 of the milestone acceptance):

```bash
node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json
node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl
```

Both must exit 0. Note the fixture is `fixtures/config.json` — the pinned
libslic3r only loads JSON (the INI parser was dropped upstream; `config.ini`
is deleted, per ruling 2026-08-13).

## Patch set and re-apply instructions

Patches live in `packages/slicer-wasm/patches/`. The submodule's working tree
is kept dirty with the applied set (expected; never commit inside the
submodule). After any `git submodule update` (which resets the tree), re-apply
each patch in order:

```bash
cd packages/slicer-wasm/cpp
git apply ../patches/0001-model-hpp-guard-step-include.patch
git apply ../patches/0003-expolygoncollection-contains-b.patch
git apply ../patches/0004-edgegrid-remove-png-include.patch
git apply ../patches/0005-localesutils-include-sstream.patch
git apply ../patches/0006-platform-emscripten-detection.patch
git apply ../patches/0007-utils-guard-async-frontend-include.patch
```

| Patch | Purpose |
|---|---|
| `0001-model-hpp-guard-step-include.patch` | `Model.hpp` — guard `#include "Format/STEP.hpp"` behind `SLIC3R_WASM_NO_OCCT` (STEP/OCCT is dropped from the build). |
| `0003-expolygoncollection-contains-b.patch` | `ExPolygonCollection.cpp` — `contains_b()` calls `it->contains(point)`; the `contains_b` member on `ExPolygon` is gone at the pinned SHA (clang strictness). |
| `0004-edgegrid-remove-png-include.patch` | `EdgeGrid.cpp` — drop `#include <png.h>` (libpng is not built). |
| `0005-localesutils-include-sstream.patch` | `LocalesUtils.cpp` — add `#include <sstream>` (only transitive on other toolchains). |
| `0006-platform-emscripten-detection.patch` | `Platform.cpp` — `detect_platform()` reports `Platform::Linux` / `GenericLinux` under `__EMSCRIPTEN__` (no `/etc/os-release` on wasm). |
| `0007-utils-guard-async-frontend-include.patch` | `utils.cpp` — compile out the `boost::log` async-frontend include, the file/console sink globals, and `set_log_path_and_level` / `flush_logs` / `get_log_file_name` bodies under `__EMSCRIPTEN__` (avoids the boost::thread pull and keeps `get_log_file_name` well-defined). |

The numbering gap (`0002` missing) is deliberate: the `distance_to_squared`
failure class (`AABBTreeLines.hpp`) was fixed upstream between the spike's
SHA and the `b97ca3c0ac` pin, so no patch for it exists.

## Final shim / TBB_HEADERS set (`build.sh`)

Every `<tbb/X.h>` libslic3r may include forwards to `shim/_serial.hpp` (the
serial implementation; `parallel_pipeline` has a real stand-in in
`shim/_serial.hpp` plus its `pipeline_test.cpp`). Headers are generated into
`.work/shim-include/tbb/` **and** `.work/shim-include/oneapi/tbb/`.

```
tbb parallel_for parallel_for_each parallel_reduce parallel_sort parallel_invoke
blocked_range blocked_range2d enumerable_thread_specific combinable
spin_mutex mutex spin_rw_mutex queuing_mutex task_group task_arena
global_control task_scheduler_init concurrent_vector tick_count
scalable_allocator cache_aligned_allocator tbb_allocator partitioner
version concurrent_unordered_map concurrent_unordered_set concurrent_map
concurrent_queue parallel_pipeline
```

(plus `tbb.h`). `_serial.hpp` is copied next to the forwarding headers by bare
relative name — the MSYS absolute path does not resolve on the Windows clang
driver. The shim also provides a serial `boost::thread` stand-in
(`boost/thread.hpp`, `mutex`, `lock_guard` — libslic3r references it from
dead-but-compiled code), a `libnoise/noise.h` stand-in (FuzzySkin.cpp), and
`jpeglib.h`/`jerror.h` stand-ins (Thumbnails.cpp; `stubs/jpeg-stub.cpp`
provides the no-op implementations). Add names to `TBB_HEADERS` as compile
errors reveal more includes.

## Final scaffold CMake (`CMakeLists.txt`)

- `file(GLOB_RECURSE ...)` over `cpp/src/libslic3r/*.cpp`, minus
  `DROP_PATTERNS`; plus the `stubs/*.cpp` glob; plus one
  `deps_core` archive folding the in-tree vendored deps (expat=3MF XML,
  miniz=3MF zip, admesh=STL load/repair, clipper+clipper2=offset/rectclip,
  qhull=convex hull, glu-libtess=tesselation, semver, qoi).
- `DROP_PATTERNS` (denylist — dropped features pull in OpenVDB/CGAL/OCCT/
  OpenCV/networking):
  ```
  /SLA/Clustering /SLA/ConcaveHull /SLA/Pad /SLA/RasterBase /SLA/RasterToPolygons
  /SLA/Rotfinder /SLA/SpatIndex /SLA/SupportPointGenerator /SLA/SupportTree
  OpenVDBUtils Hollowing CutSurface MeshBoolean /Format/STEP /Format/DRC
  /Format/svg /Shape/TextShape /Arrange.cpp GCodeSender VoronoiUtilsCgal
  ObjColorUtils TryCatchSignalSEH Triangulation PNGReadWrite PrintConfig_test
  TriangleMeshSlicer_test pchheader
  ```
  `/Format/3mf` is deliberately **not** in the list — 3MF is re-added for v1
  (`Format/3mf.cpp` + `Format/bbs_3mf.cpp`; expat/miniz/fast_float are
  in-tree). `SLA/` is dropped wholesale except `IndexedMesh.cpp` (kept — Z
  contouring calls `sla::IndexedMesh`).
- Compile defines on `slic3r_core`:
  ```
  USE_TBB TBB_USE_CAPTURED_EXCEPTION=0 SLIC3R_WASM_NO_OCCT BOOST_NO_CXX98_FUNCTION_BASE
  BOOST_HAS_THREADS BOOST_HAS_PTHREADS BOOST_THREAD_PLATFORM_PTHREAD
  ```
- Link flags on `orca_slice`:
  ```
  -O3 -fexceptions -sMEMORY64 -sMODULARIZE=1 -sEXPORT_ES6=1
  -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB
  -sSTACK_SIZE=8388608 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0 -sFORCE_FILESYSTEM=1
  -sEXPORTED_RUNTIME_METHODS=callMain,FS,ccall,cwrap,UTF8ToString,HEAPU8,addFunction,removeFunction
  -sEXPORTED_FUNCTIONS=_main,_malloc,_free -sDISABLE_EXCEPTION_CATCHING=0
  -sALLOW_TABLE_GROWTH=1 --embed-file=.work/embed/system@/system
  ```
  Boost archives are linked as one `-Wl,--start-group` (wasm-ld is
  single-pass). Curated preset embed: one vendor (Bambu Lab) + its index,
  filtered by a Python fixpoint in `build.sh` that drops third-party filament
  entries whose `inherits` chain leaves the kept set (`load_vendor_configs_
  from_json` throws on the first missing inherit otherwise).

## Iterate-loop fixes actually hit (M0/M1)

The WASM build is an iteration surface; these are the fixes that were
actually needed to go green. All of them live in the scaffold (build.sh /
CMakeLists.txt / stubs / patches / bridge) — the submodule was never edited
ad-hoc.

1. **Shim/header adds:** `TBB_HEADERS` grew to the final set above as compile
   errors surfaced new includes (`parallel_pipeline` was the notable new
   stand-in, used only by `GCode.cpp`); boost::thread, libnoise, and libjpeg
   shims were added for dead-but-compiled TU includes.
2. **Stubs** (`packages/slicer-wasm/stubs/`): `md5.cpp` (provides the symbols
   for the generated `openssl/md5.h` declarations), `format-stubs.cpp`
   (DRC `load_drc`/`store_drc`, SVG `load_svg`), `voronoi-cgal-stubs.cpp`
   (planarity checks), `triangulation-stub.cpp` (constrained-Delaunay
   symbols), `png-stub.cpp` (image export), `jpeg-stub.cpp` (thumbnails).
3. **Boost.Log ABI tag:** without `BOOST_HAS_PTHREADS` etc., every
   `BOOST_LOG_TRIVIAL` call site compiled against the `v2s_st` namespace and
   failed to link; the archive set is built with `-pthread` so its symbols
   live in `v2s_mt_posix`. The define set opts TUs into the multithreaded ABI
   namespace while the runtime stays single-threaded.
4. **Boost 1.84 `quat_traits` diagnostic:** clang 21 promotes
   `quat_traits<Q>::template write_element_idx(...)` (boost/qvm via
   boost/geometry) to an error — suppressed with
   `-Wno-missing-template-arg-list-after-template-kw` (fixed upstream
   post-1.84).
5. **glu-libtess `LONG_MAX`:** `priorityq-heap.c` uses `LONG_MAX` without
   `<limits.h>` (transitive elsewhere); wasm libc doesn't provide it —
   compile with `-include limits.h` (scaffold-level, no submodule edit).
6. **wasm64 consistency:** Emscripten 6 emits wasm32 objects unless
   `-sMEMORY64` is given at **compile** time too (link-only is not enough) —
   `add_compile_options(-sMEMORY64)`; wasm-ld refuses mixed objects.
7. **Stack overflow (the milestone's biggest runtime crash):** the 64 KiB
   default stack overflowed the G-code export chain (deep ~34 KB GCode object
   + recursive geometry passes), clobbering .bss globals down into the
   locale-facet statics → `std::locale` crash in `tm2str`.
   `-sSTACK_SIZE=8388608` fixes it; with `ALLOW_MEMORY_GROWTH` the heap just
   starts higher.
8. **Bridge drift at the pinned SHA** (fixed in `bridge.cpp`, never in the
   submodule): module-scope statics construct before `print_config_def` →
   `BridgeState` holder is lazily constructed on first call; `ConfigOptionType`
   has no `coVec3d` (map to `"unknown"`); `PresetCollection::m_presets` is
   private → iterate public `begin()/end()` (skips generated "- default -");
   `PrintConfigDef::defs()` doesn't exist → `print_config_def.options`;
   `Model` has no instance accessor → sum per `ModelObject::instances`;
   `validate()` returns `StringObjectException` (use `.string`);
   `SlicingStatus` is nested under `PrintBase`; `Print::objects()` is an
   accessor, not a member.
9. **Bridge fix round 1 (cancel/state reset):** `orc_cancel` is strictly
   synchronous — JS cannot reenter wasm mid-slice, so a cancel can never
   interrupt an in-flight slice, and a surviving `CANCELED_BY_USER` flag
   (only `restart()` clears it) makes the next `process()` throw an
   uncatchable CppException that kills the module. `orc_cancel` therefore
   calls `cancel()` **and** `restart()` — a state reset; the module always
   survives. The catch-all `catch (...)` in `orc_slice` keeps the "a call
   either returns JSON or the module stays alive" contract.
10. **Bridge fix round 2 (unrecognized keys):** one
    `ConfigSubstitutionContext{Disable}` is threaded through every key's
    `set_deserialize` so `handle_legacy()`'s dropped keys are surfaced in a
    new additive `unrecognized_keys` field on `orc_slice`'s success JSON
    instead of vanishing (the old strict path threw the context away and the
    smoke's pre-rename keys silently sliced on defaults).
11. **Smoke/wasm64 marshaling:** `ccall` pointer args must be typed
    `'pointer'` — Emscripten 6 converts them to the BigInt the raw i64 wasm
    param requires ("Cannot convert <ptr> to a BigInt" otherwise); heap
    pointers keep Number form on the JS side; progress text arrives as BigInt
    on wasm64 → `UTF8ToString(Number(text))`.
12. **Progress-callback lifecycle:** the bridge smoke clears the callback
    (`orc_set_progress_callback(0)`) before `Module.removeFunction` — a stale
    function-table entry is a dangling pointer into the JS function table.
13. **Curated preset embed:** third-party filament entries in `BBL.json`
    (COEX, Polymaker, eSUN …) inherit from un-embedded vendor dirs and make
    `load_vendor_configs_from_json` throw; `build.sh` filters the index with
    a fixpoint over the `inherits` chains.

## Bridge JSON contract (`src/bridge.cpp`)

The bridge is the only C++↔JS seam (design §Bridge API). Every function is
extern "C", JSON-in/JSON-out, synchronous on the worker thread. JSON strings
are returned as malloc'd C strings — JS reads with `UTF8ToString` and
`_free()`s. Binary buffers cross via the WASM heap (`_malloc`/`_free` +
`HEAPU8`). Every function returns `{"error": "<message>"}` on failure, and
the module is guaranteed to survive any call. Module-global state lives in a
lazily-constructed `BridgeState` holder (AppConfig + PresetBundle + Model +
Print).

| Function | Input | Success JSON |
|---|---|---|
| `orc_init()` | — | `{"ok": true, "prints": N, "filaments": N, "printers": N}` — sets data dir `/`, `setup_directories`, `load_presets` (embedded curated subset at `/system`; `/user` is writable MEMFS). |
| `orc_get_presets(kind)` | `kind` ∈ `print`\|`filament`\|`printer` | `{"presets": [{"name": ...}, ...]}` — else `{"error": "kind must be print\|filament\|printer"}`. Iterates public range (skips generated "- default -"). |
| `orc_get_option_metadata()` | — | One object keyed by option name; each value `{type, label?, full_label?, tooltip?, category?, mode, enum_values?, enum_labels?, min?, max?, default?}`; `type` ∈ `float\|int\|string\|bool\|percent\|floats\|ints\|strings\|bools\|enum\|float_or_percent\|percents\|point\|points\|point3\|unknown` (no `coVec3d` at the pin → `unknown`). |
| `orc_load_model(data, len, ext)` | model bytes in heap + length + extension | Bytes staged to `/tmp/uploaded_model.<ext>`; `Model::read_from_file` with `LoadStrategy::AddDefaultInstances` → `{"ok": true, "objects": N, "instances": N}`. |
| `orc_set_progress_callback(cb)` | JS function via wasm table (`void(*)(int, const char*)`) | `void`. Called from `set_status_callback` with `(percent, text)` during `orc_slice`. Clear with `orc_set_progress_callback(0)` before `removeFunction`. |
| `orc_slice(config_json)` | config JSON string | Starts from `DynamicPrintConfig::full_print_config()` (optptr() null-derefs on missing keys otherwise); JSON keys applied per-key with one shared `ConfigSubstitutionContext{Disable}` (strict, no substitutions; `\\n` escapes restored to real newlines); `normalize_fdm()` → `print.apply` → `validate()` (error if non-empty) → `process()` with progress → `{"ok": true, "unrecognized_keys": [k, ...]}`. `unrecognized_keys` is additive (fix round 2): always present, empty when clean; M2 clients warn on dropped keys. |
| `orc_get_slice_result()` | — | v1 = JSON stats only: `{"ok": true, "objects": N, "layers": N}` (`layers` present when non-empty). Binary toolpath buffers are M2 (Epic 2.4). |
| `orc_export_gcode()` | — | `print.export_gcode` to MEMFS → `{"ok": true, "path": "/out.gcode"}`. |
| `orc_cancel()` | — | State reset (fix round 1): `print.cancel()` **and** `print.restart()` — a cancel can never interrupt an in-flight slice (synchronous bridge) and must not poison the next one. `{"ok": true}`. |

## Known M2 work

- **Binary slice-result buffers** (Epic 2.4): `orc_get_slice_result` currently
  returns JSON stats only; the binary toolpath buffers are the M2 client's
  layout contract.
- **Full preset bundle + `nozzle_info.json` embed:** the curated subset is
  enough for v1, but `orc_export_gcode` logs a benign
  `get_hrc_by_nozzle_type` parse error; M3 replaces the subset with the full
  `resources/profiles` via `--preload-file`.
- **Progress-callback contract for the M2 client:** on wasm64 the progress
  `text` arrives as a BigInt — `UTF8ToString(Number(text))`; and the client
  must clear via `orc_set_progress_callback(0)` before
  `Module.removeFunction` (stale table entry = dangling JS function pointer).
- **`unrecognized_keys` as client contract surface:** the M2 config UI relies
  on the additive field to warn about keys the pinned libslic3r dropped.
- **COOP/COEP headers** on the Electron session (SharedArrayBuffer headroom
  for later threading).
- **`-m64` flag drift:** `-sMEMORY64` is deprecated in emcc 6.0.6 (prefer
  `-m64` / `--target=wasm64`) — functional today, migrate on the next emsdk
  bump.

## Verification (2026-08-13, delivery machine)

- `node packages/slicer-wasm/harness/run-slice.mjs --module packages/slicer-wasm/out/orca_slice.js --stl packages/slicer-wasm/fixtures/cube.stl --config packages/slicer-wasm/fixtures/config.json` → **exit 0**, valid G-code (G1 moves)
- `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/orca_slice.js packages/slicer-wasm/fixtures/cube.stl` → **exit 0** (exercises every `orc_*` export end to end)
