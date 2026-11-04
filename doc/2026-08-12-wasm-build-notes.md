# WASM Build and Runtime Reference

**Updated:** 2026-10-28
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
stages only threaded wasm64 and profile resources for Electron; it does not rebuild WASM.

The Web-only wasm32 fallback is built with
`node scripts/build-wasm32.mjs build [--variant threaded|serial|both]` (default:
both). `deps` bootstraps its separate dependencies in Linux CI; `prepare`
generates its isolated scaffold without compiling, and `verify-deps` checks
the staged prefixes. On Windows the build invokes the generated copy of
`scripts\build-windows.bat`; dependency helpers remain cmd-native. The driver
reuses the authoritative native files without changing wasm64 cache inputs,
sets 32-bit pointers and a 4 GiB heap limit with on-demand growth, and collects
artifacts under `out/wasm32/<variant>`. Emscripten keeps its wasm32 heap-growth
ceiling one 64 KiB page below 4 GiB to avoid wrapping the heap size to zero.
The initial heap remains 64 MiB. `scripts/stage-web.mjs` adds these only to
Web's private public assets. Electron continues to use `scripts/stage.mjs`
and wasm64.

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
Draco, OCCT/XCAF for STEP, NLopt for arrangement and the complete CGAL,
GMP/GMPXX, MPFR and CORE closure for Mesh Boolean. Fetch/build scripts and
CMake own exact versions, library sets and feature exclusions. OCCT builds with
`USE_FREETYPE=OFF`; its staged manifest records that setting. A normal `build`
rebuilds older OCCT stages automatically. A `quick` build rejects them with a
rebuild instruction before linking.

Mesh Boolean compiles the complete pinned `MeshBoolean.cpp` in its own
target, retaining the original libigl code and both CGAL and MCUT wrappers.
The normal shell and cmd build drivers invoke the same
[`dependencies/cgal/build.mjs`](../packages/slicer-wasm/dependencies/cgal/build.mjs)
helper. It verifies source archive hashes and stages static numerical
libraries by address width, threading mode, compiler identity and recipe.
It uses the pinned upstream C/C++ sources with generic C arithmetic and a
small CMake build overlay; native GMP generator programs produce tables for
the requested WASM limb width. A native C99 compiler is required for these
build tools; Emscripten compiles all runtime libraries. Orca's GMP
configure-probe compatibility fix is retained. No Bash
or MSYS runtime is needed by this helper on Windows.

The numerical recipe and manifests are owned by that helper. CGAL TUs use
`CGAL_USE_GMPXX=1` and `CGAL_ALWAYS_ROUND_TO_NEAREST=1`; serial builds also
use `CGAL_HAS_NO_THREADS=1` and MPFR without TLS/shared caches. The MCUT
external-dependency patch is applied to a private source copy under the
variant build directory. Its API manager threads default to enabled and
remain enabled in the threaded artifact; serial builds execute packaged
tasks inline with Context-owned perturbation state. The checked-out Orca
submodule is not patched by dependency preparation.

To prepare or verify a numerical stage directly, use the same command on
any build host (select `wasm32` or `threaded` as needed):

```text
node packages/slicer-wasm/dependencies/cgal/build.mjs build --target wasm64 --variant serial
node packages/slicer-wasm/dependencies/cgal/build.mjs verify --target wasm64 --variant serial
```

After a normal build has configured the serial tree, enable and run the
optional real numerical/wrapper acceptance target:

```text
cmake -S packages/slicer-wasm -B packages/slicer-wasm/.work/serial/build -DNEO_MESH_BOOLEAN_TEST=ON
cmake --build packages/slicer-wasm/.work/serial/build --target mesh_boolean_backend_test --parallel 2
node packages/slicer-wasm/harness/run-mesh-boolean-backend.mjs packages/slicer-wasm/.work/serial/build/mesh_boolean_backend_test.mjs --browser
```

The test runner exercises a Node Worker and, with `--browser`, a headless
Chrome Worker. Serial browser execution deliberately omits cross-origin
isolation and checks that no internal Workers are created. Threaded browser
execution uses isolation and shared memory. This target tests exact CORE
arithmetic, MPFR directed rounding and the original libigl/CGAL/MCUT wrappers,
including Context creation, reuse, interleaving and native perturbation
fixtures. It adds no test ABI to the production module. Product behavior and
remaining acceptance are specified in
[Object List and Parts](../spec/ObjectList-and-Parts.md#10-mesh-boolean-design).

The typed project-command suite uses an existing complete module and real
geometry, painting, history and 3MF persistence. Build profile resources first;
select the artifact with `ORCA_MESH_BOOLEAN_MODULE`:

```sh
pnpm --filter @orca/profile-resources build
ORCA_MESH_BOOLEAN_MODULE="$PWD/packages/slicer-wasm/.work/serial/build/orca_slice.js" pnpm --filter @orca/slicer-wasm exec vitest run harness/mesh-boolean.native.test.mjs
```

By default this suite skips its two fault-only cases. To verify publication
compensation and the native positive-Part fallback, explicitly configure that
same build tree with `-DNEO_MESH_BOOLEAN_COMMAND_TEST=ON`, rebuild `orca_slice`
and run with `ORCA_MESH_BOOLEAN_FAULTS=1` in addition to the module variable.
The suite checks that the artifact's hook state matches the requested mode.
Restore the option to `OFF` and rebuild before staging a production artifact.
Normal full/quick drivers always reset it to `OFF`; CI keeps fault modules in
the build tree and uploads only the separate production outputs.

After building the required production artifacts, the
[shared Mesh Boolean host journey](../scripts/run-mesh-boolean-e2e.mjs) stages
and verifies the native payloads, builds the application with E2E read probes
and exercises both entry points through real UI input:

```sh
node scripts/run-mesh-boolean-e2e.mjs
```

Use `--desktop-only` or `--web-only` for a focused host gate. `--serial`
selects non-isolated Web execution; Electron retains its production threaded
runtime. Add `--wasm32` for the real Memory64-incompatible WebKit gate, with or
without `--serial`. A Web build requires the complete four-artifact staging set
described above, even when a particular journey selects only wasm64.

An explicit larger-model Chrome gate imports synthetic STL through the browser
picker, executes the Gizmo and waits for renderer/history publication after
WASM memory grows beyond 4 GiB. It is skipped by ordinary focused journeys:

```sh
ORCA_MESH_BOOLEAN_LARGE=1 node scripts/run-mesh-boolean-e2e.mjs --web-only
```

For reproducible native scale measurements, select each production artifact
in turn with the same runner. Its typed-client bundle is generated from the
current source using the existing Vite build dependency:

```sh
node packages/slicer-wasm/harness/mesh-boolean-scale.mjs --module packages/slicer-wasm/out/serial/orca_slice.js --levels 4,5,6,7 --report /tmp/mesh-boolean-scale.json
```

The default operations are Union, Difference and Intersection. The report
identifies the native payload and records input/output size, connected
components, analytical sphere-lens volume error, native command/history time,
WASM memory capacity and sampled Node process RSS. The first case includes
lazy compilation. WASM capacity is a high-water since module startup, not live
allocation; Node RSS includes the owning Worker, pthreads and fixture analysis.
The runner excludes renderer/GPU and painting-preservation timing. Run it
without concurrent build/acceptance workloads when comparing timings.

When symbols or upstream signatures change, fix the owning source/scaffold
rather than adding a renderer compatibility layer.

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
The Electron threaded temporary-file mount and Web MEMFS boundary are
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
