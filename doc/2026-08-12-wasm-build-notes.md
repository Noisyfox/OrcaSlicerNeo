# WASM Build and Runtime Reference

**Updated:** 2026-10-12
**Status:** Current engineering reference
**Scope:** Native build ownership, artifacts and runtime constraints.

## Build entry points

[README](../README.md#building) owns prerequisites and the command catalogue.
Use `scripts\build-windows.bat` from a Visual Studio developer environment on
Windows; use `scripts/build.sh` on macOS/Linux. Driver `help` is authoritative
for flags. `full` prepares dependencies and builds; `build` reconfigures;
`quick` rebuilds an already configured tree; `smoke` validates artifacts.
Use pnpm for workspace development, tests, typechecks and host E2E.

The scaffold [CMakeLists.txt](../packages/slicer-wasm/CMakeLists.txt) selects
the native source/dependency closure. Both variants use wasm64 (`-m64`),
matching every object, static archive and final link. `out/threaded/` and
`out/serial/` contain separate JS/WASM/data artifacts. `scripts/stage.mjs`
stages them and profile resources for the hosts; it does not rebuild WASM.

The Web-only wasm32 fallback is built with
`node scripts/build-wasm32.mjs build [--variant threaded|serial|both]` (default:
both). `deps` bootstraps its separate dependencies in Linux CI; `prepare`
generates its isolated scaffold without compiling, and `verify-deps` checks
the staged prefixes. On Windows the build invokes the generated copy of
`scripts\build-windows.bat`; dependency helpers remain cmd-native. The driver
reuses the authoritative native files without changing wasm64 cache inputs,
sets 32-bit pointers and a 2 GiB heap limit, and collects artifacts under
`out/wasm32/<variant>`. `scripts/stage-web.mjs` adds these only to Web's private
public assets. Electron continues to use `scripts/stage.mjs` and wasm64.

## Source and dependency ownership

The superproject gitlink is the exact Orca revision. Make native adaptations
on `dev/orcaslicerneo-wasm`, validate and commit them, then deliberately update
the gitlink. Do not maintain Orca source patches or a parallel list of historical
pins. Before distributing a superproject commit that updates the gitlink, publish
its referenced submodule commit to the configured submodule remote so clean
clones and CI can fetch it. External dependency patches remain in
`packages/slicer-wasm/patches/`.

The WASM scaffold compiles libslic3r and the headless Neo adapters, excluding
wxWidgets. Its dependency closure includes Boost, oneTBB for threaded builds,
Draco, OCCT/XCAF for STEP and NLopt for arrangement. Fetch/build scripts and
CMake own exact versions, library sets and feature exclusions. When symbols
or upstream signatures change, fix the owning source/scaffold rather than
adding a renderer compatibility layer.

## Native compile-time macro policy

This policy applies to Neo adaptations inside the Orca submodule
(`packages/slicer-wasm/cpp/`). It does not rename the scaffold's bridge, shim,
test or profiling switches.

`ORC_NEO_WASM` is the single identity macro for those adaptations. Fixed Neo
behavior uses `#if ORC_NEO_WASM` (or `#if !ORC_NEO_WASM` for the desktop
implementation), rather than a separate feature switch. This includes source
JSON vendor loading, Worker-managed profile installation and backup-manager
stubs. Neo-specific adaptations must not use `__EMSCRIPTEN__` as a substitute
for this policy boundary.

Only behavior that must be independently enabled, such as threading,
standalone tests, fault injection or profiling, gets a separate switch. All
Neo-owned switches introduced in the submodule use the `ORC_NEO_WASM_` prefix.
At every submodule C++ use site,
combine the switch with the identity macro, for example:

```cpp
#if ORC_NEO_WASM && ORC_NEO_WASM_FEATURE
// Optional Neo implementation.
#endif
#if ORC_NEO_WASM && !ORC_NEO_WASM_FEATURE
// Neo implementation with the option disabled.
#endif
```

Configure these submodule policy macros through the scaffold's directory-wide
`add_compile_definitions`, so every translation unit gets the same values.
The identity macro is `1` in Neo; optional switches must be numeric `0` or `1`, so use `#if`
rather than `#ifdef`. Do not configure macros on individual sources or targets,
or define build switches inside submodule source files. For an optional switch,
keep its CMake option, build-driver environment variable, CI, harnesses and
documentation on the same name. Existing submodule adaptations are fixed policy
and need no optional switch. There are no legacy submodule macro aliases.

Toolchain and third-party contract macros retain their required names (for
example `__EMSCRIPTEN__`, `BOOST_HAS_THREADS` and `LIBNEST2D_THREADING_tbb`).
This policy does not rename upstream/toolchain macros or modify third-party
headers. Native desktop builds leave `ORC_NEO_WASM` undefined (equivalent to
zero in these `#if` conditions), preserving the desktop branches.

## Threading, shims and memory

Threaded builds compile and link with pthread support, use upstream oneTBB,
a precreated worker pool and mimalloc. Default pool size follows exposed logical
cores; bridge startup configures matching oneTBB global control/task arena with
a nonzero fallback. Controlled profiling may override pool size. Threaded include
paths must not select serial shim headers. Keep memory growth enabled and build
dependencies with the same SDK, wasm64 and pthread flags. Serial builds use the serial TBB shim;
they are separate artifacts, not a runtime mode inside a threaded binary.
The Boost.Thread compatibility layer follows each variant's execution model.
Boost.Log compilation flags must match the staged static library ABI.
Use the [shared architecture](../spec/Web-Electron%20Shared%20Application%20Architecture.md)
for host capability selection and the
[per-plate specification](../spec/Per-Plate%20Print%20Architecture.md) for
task/cancellation semantics.

Only `packages/slicer-wasm/src/client/` calls Emscripten. Binary marshaling uses
heap allocations and fresh views; never cache a heap view across memory growth.
The runtime owns worker/module creation, assets, resources and disposal.
Electron uses a Node Worker in a utility process; Web uses a browser Worker.
The Electron threaded temporary-file mount and serial/Web MEMFS boundaries are
defined in [Native Python Plugin Architecture](../spec/Native%20Python%20Plugin%20Architecture.md).

Task progress uses the common native FIFO and typed client delivery. Main-runtime
producers can notify JavaScript after releasing the FIFO mutex; pthreads publish
only to shared memory. Do not reintroduce dynamically registered JavaScript
callbacks on oneTBB pthreads or a second project-load progress channel.

### Boost thread and native logging contracts

The serial Boost.Thread shim defers execution; the threaded shim uses real
`std::thread` join/detach behavior. Mutex, unique-lock, lock-guard and condition
variable adapters retain standard atomic unlock/wait/relock semantics; never
lock an already owned mutex twice. Thread stack-size attributes may be accepted
but are not promised to apply through portable `std::thread`. This does not
re-enable GUI/network/BBS manager code; oneTBB remains the production parallel
scheduler.

The shared native logger installs synchronous `std::clog` and `/tmp/orca.log`
sinks once, truncates the session log, flushes each record, and does not rotate
files. The format is `[%Y-%m-%d %H:%M:%S.%f] [severity] message`. Supported levels
are trace, debug, info, warning, error and fatal; the native default is info,
while shipped host configuration selects warning. Read `ORCA_LOG_LEVEL` during
initialization (CLI: before `callMain`), not on every call; mid-session changes
do not reconfigure it. Pthread console delivery depends on the worker context;
the file sink is thread-neutral. The file is created when a record passes the
filter, and `/tmp` follows the host's NODEFS/MEMFS contract above.

## Profiles and assets

Profiles are independently built ZIP resources, not a WASM preload bundle.
Core resources mount under `/system`; installed vendor packages live under
`/profiles` and active vendors link into `/system`. Startup installs core,
OrcaFilamentLibrary, Custom and activated printer vendors; Setup Wizard installs the
remaining catalogue in the existing runtime. Successful installs are reused.
The `resources/info` preload remains separate. See
[Setup Wizard](../spec/Setup%20Wizard%20and%20Profile%20Activation.md).

Web assets resolve relative to the deployed module/base, including subpaths.
Vite public Emscripten modules load through the client/runtime URL boundary,
not application imports. Electron reads packaged, asar-unpacked native assets
locally; the guarded loopback origin serves its renderer. Startup subscriptions
must not repeat profile installation or initialize a second live module.

### Packaged renderer origin

Electron serves the renderer from an in-process HTTP server bound only to
`127.0.0.1` on an ephemeral port. Validate Host against that port's loopback
names, reject path traversal outside the renderer root, and emit no permissive
CORS headers. Keep correct WASM/data MIME types and asar-aware resource loading.
Development uses its configured Vite origin. Do not reintroduce `file://`, a
custom `app://` Worker origin, blob-relative module assets, or the removed
Chromium dedicated-worker flag as a workaround. Cross-origin isolation headers
remain required for browser threaded WASM. Session URL tokens and additional
CSP hardening were candidates, not delivered guarantees.

## Debugging and validation

[Windows cmd pipeline](2026-08-15-cmd-build-pipeline.md) records quoting,
executable lookup and CRLF requirements.
[WASM DWARF builds](2026-08-20-wasm-dwarf-debug-build.md) records debug flags
and the required reconfigure/restore workflow. Test/profile build gates must
be compiled out of ordinary artifacts.

Use [testing guidelines](testing_guidelines.md) to select focused builds and
harnesses. Current client declarations and bridge sources own ABI details;
old milestone JSON examples and one-off build logs are not an API reference.
No test or artifact rebuild is implied by this documentation consolidation.
