# WASM boost log: file + console sinks, JS-controllable level

2026-08-21

## Problem

libslic3r emits `BOOST_LOG_TRIVIAL` records throughout the FDM path (Config,
Arrange, BuildVolume, CutUtils, …), and the wasm64 Boost archives already
include `libboost_log`/`libboost_log_setup` (build-boost-wasm64.sh) with the
ABI-tag defines in place (CMakeLists "Boost.Log ABI tag" comment). But the
WASM module never registered any sinks, so `logging::core` dropped every
record: nothing appeared on the console, no log file existed. Debugging the
module meant adding `fprintf(stderr, …)` by hand.

## Design

A small shared TU (`packages/slicer-wasm/src/wasm_log.cpp` + `wasm_log.hpp`)
owns the boost::log setup; both entry points of the `orca_slice` module call
it, so the bridge app path and the CLI/harness path behave identically:

- **Console sink**: `synchronous_sink<text_ostream_backend>` on `std::clog`
  (browser → DevTools console; Node harness → stdout).
- **File sink**: `synchronous_sink<text_file_backend>` on `/tmp/orca.log`
  (MEMFS). `text_file_backend` defaults to `out|trunc` (fresh file per module
  session) but `auto_flush=false` (text_file_backend.hpp:606) — the bridge
  sets `auto_flush=true` explicitly, otherwise records would sit in the C++
  stream buffer unseen while the JS side reads the live file. No rotation
  configured. The client reads it back through `Module.FS.readFile` (same
  mechanism as `/out.gcode` in `exportGcode`).
- **Formatter** (shared by both sinks):
  `[%Y-%m-%d %H:%M:%S.%f] [severity] message`.
- **Severity filter** comes from a level string
  (`trace|debug|info|warning|error|fatal`, default `info`).

### Level control

The level is a JS-side value, passed into C++ where C++ can't poll JS:

- **Bridge path**: `orc_init`'s JSON argument (previously an ignored legacy
  preferences slot) now carries `{"log_level": "debug"}`. The client's
  `init()` reads `globalThis.ORCA_LOG_LEVEL` — the global JS variable — in
  the worker scope and forwards it. `apps/*` worker entries may seed it, e.g.
  `globalThis.ORCA_LOG_LEVEL = import.meta.env.VITE_LOG_LEVEL` (the desktop +
  web worker entries do this when the env var is set). Since init is the only
  place the level is read, changing the variable mid-session has no effect —
  acceptable for "for now" (the user explicitly chose the `orc_init` channel
  over C++ polling a global per bridge call).
- **CLI path** (`slice_main.cpp` main, harness): one EM_JS function reads
  `globalThis.ORCA_LOG_LEVEL` in Node, so the harness sets
  `globalThis.ORCA_LOG_LEVEL = 'debug'` before `callMain` to control the
  level.

`wasm_log::init_with_level()` is idempotent (sinks installed once, level
re-applied), so calling it from both entry points is safe.

### Known quirk (threaded build)

Log records emitted from TBB pthreads print into that pthread's own worker
console context in DevTools, not the module's main console. The file sink is
thread-neutral and captures everything, so `/tmp/orca.log` is the reliable
channel.

## Files

- `packages/slicer-wasm/src/wasm_log.cpp` / `wasm_log.hpp` (new)
- `packages/slicer-wasm/src/bridge.cpp` — `orc_init` parses `log_level`
- `packages/slicer-wasm/src/slice_main.cpp` — init at `main()` start
- `packages/slicer-wasm/CMakeLists.txt` — add `wasm_log.cpp` to
  `ORCA_SLICE_SRC`
- `packages/slicer-wasm/src/client/client.ts` — `init()` forwards
  `globalThis.ORCA_LOG_LEVEL`; new `readLog()`
- `packages/slicer-wasm/src/client/types.ts` — `ReadLogResult`, `SlicerClient.readLog`
- `packages/slicer-runtime/src/slicer/slicer.worker.ts` — seed the global from
  `VITE_LOG_LEVEL` when set
- `packages/slicer-wasm/harness/run-slice.mjs` — log spot-check
- `apps/desktop`/`apps/web` worker entries — same env-var seed (if present)

## Verification

- Harness smoke (both variants): set `globalThis.ORCA_LOG_LEVEL`, run a
  slice, assert `/tmp/orca.log` exists and is non-empty; console gets
  records at the requested severity.
- `pnpm test` / `pnpm typecheck` (mock-module `orc_init` contract updated).
- Quick WASM build (`scripts\build-windows.bat quick`), smoke both variants.
