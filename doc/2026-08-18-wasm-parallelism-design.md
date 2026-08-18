# WASM Parallelism Design

Date: 2026-08-18
Status: Implementing
Scope: Enable real libslic3r TBB parallelism in the Emscripten slicer module.

## Goal

Replace the inline serial TBB compatibility layer in the threaded WASM build
with upstream oneTBB, so the existing `tbb::parallel_*` work in libslic3r can
use multiple WebAssembly pthreads while `orc_slice` continues to run behind the
existing renderer Web Worker boundary.

## Constraints and Decisions

- The C++ submodule remains unchanged. All work is confined to the WASM build
  scaffold, dependency scripts, harnesses, and documentation.
- Use upstream oneTBB at pinned commit
  `3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3`. Its published WASM support
  builds a static library through Emscripten and uses pthreads by default.
- The threaded build passes `-pthread` when compiling every target and when
  linking. Emscripten requires both; this also enables `__EMSCRIPTEN_PTHREADS__`.
- Pre-create a pthread worker pool with
  `-sPTHREAD_POOL_SIZE=Math.min(4,navigator.hardwareConcurrency)`. The
  desktop module itself is already a renderer worker; a larger nested pool
  caused Chromium to abort a multi-object slice with `Error: unwind`. This
  expression still uses every core on smaller machines while preserving the
  verified four-worker budget on larger ones.
- Use oneTBB's runtime `global_control(max_allowed_parallelism, cores)` and a
  matching task arena in bridge startup, where `cores` is the minimum of
  `emscripten_num_logical_cores()` and the configured four-worker budget.
  Both build values remain explicit overrides for controlled profiling.
- Do not install the dynamic JavaScript progress callback in a threaded
  module. oneTBB can invoke the callback from a pthread whose Wasm function
  table does not track a renderer-worker `addFunction` table growth; Chromium
  then traps with `table index is out of bounds` and surfaces `Error: unwind`.
  The UI retains its operation-level `Slicing…` state; serial/mock builds keep
  detailed progress until a cross-pthread-safe callback transport is added.
- Preserve `-sALLOW_MEMORY_GROWTH=1`. Emscripten documents that heap views held
  by JavaScript must be refreshed after growth; the client already obtains a
  fresh `HEAPU8` view for each bridge call. The threaded build will use
  `-sMALLOC=mimalloc` to reduce allocator lock contention.
- The existing serial shim remains available behind an explicit CMake/build
  option (`WASM_THREADING=OFF`). A threaded WebAssembly binary cannot fall back
  to serial at runtime when `SharedArrayBuffer` is unavailable, so packaging
  will select the threaded build by default and can stage the serial artifact
  for unsupported environments.
- Existing COOP/COEP response headers remain mandatory for the desktop
  renderer and packaged `app://` scheme. They are already installed by the
  Electron main process; this work adds an automated assertion.

## Incremental Delivery

1. **Design and baseline.** Record decisions and baseline the existing serial
   artifact/harness behavior. Acceptance: docs reviewed, existing unit suite
   still passes.
2. **Pinned oneTBB dependency.** Add fetch/build scripts for the pinned source
   and a tiny C++ runtime probe that proves multiple TBB workers execute.
   Acceptance: a pthread wasm64 module builds and the Node probe observes more
   than one worker index.
3. **Thread-aware build scaffold.** Add `WASM_THREADING` and pool-size options;
   select real oneTBB headers/library for the threaded variant and the existing
   shim only for serial. Apply compatible compiler/linker flags to every
   target. Acceptance: configure output proves the intended variant and rejects
   a missing oneTBB library.
4. **Bridge scheduler guard.** Configure oneTBB parallelism at bridge startup
   and export a diagnostic reporting threading availability and effective
   concurrency. Acceptance: bridge smoke validates the diagnostic, while the
   ordinary slice API contract is unchanged.
5. **End-to-end verification.** Rebuild, run the TBB probe, both Node harnesses,
   workspace tests/typechecks, and Electron e2e. Add CI coverage for the
   threaded build/probe. Acceptance: cube slice output remains valid and the
   threaded probe demonstrates actual concurrent worker execution.

Each completed step is independently verified and committed before the next
one begins.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| A worker-start deadlock leaves TBB serial | Pre-create the Emscripten pthread pool and prove worker indexes in a runtime probe. |
| A serial shim header shadows oneTBB | Generate shim forwarding headers only for `WASM_THREADING=OFF`; threaded include paths start with oneTBB. |
| Toolchain/dependency mismatch | Pin source commit, build oneTBB with the same Emscripten SDK and wasm64/pthread flags as the module. |
| Heap growth invalidates JS views | Read `HEAPU8` at marshaling time; never cache it across calls. |
| Unsupported shared-memory runtime | Keep a separate, explicit serial build variant; do not claim a single artifact can silently fall back. |
| Pthread invokes a dynamically-added JS callback | Omit that callback for the threaded module; preserve operation-level slice state and keep serial progress support. |

## Verification Matrix

| Layer | Check |
| --- | --- |
| oneTBB | Standalone `parallel_for` probe reports at least two unique `tbb::this_task_arena::current_thread_index()` values. |
| WASM bridge | Thread diagnostic reports enabled and effective concurrency is at least two; existing bridge smoke remains green. |
| Slice | Existing cube smoke produces G-code with `G1` moves. |
| Client/app | Existing Vitest/typecheck and Playwright flows remain green. |
| Real multi-model app | Two copies of an external STL, with a profile that has no exclusion area, slice, render, and export without `unwind`. |
| Headers | Electron's `app://` response maintains both COOP and COEP headers. |

## References

- Emscripten pthread support: <https://emscripten.org/docs/porting/pthreads.html>
- oneTBB WASM support: <https://github.com/uxlfoundation/oneTBB/blob/master/WASM_Support.md>
