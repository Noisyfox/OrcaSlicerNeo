# DRC Import Support

**Status:** Design ready for approval — implementation not started

## Accepted product behaviour

- The first delivery supports importing `.drc` files only.  DRC export is out
  of scope for this delivery.
- DRC has the same user entry points as the current STL support: the existing
  in-app **Add Model** flow in both the Electron and Web hosts.  It does not
  add drag-and-drop import, operating-system file association, or opening a
  DRC file from outside the application.
- An imported DRC is appended to the current plate.  It never replaces the
  existing scene.
- A single DRC triangular mesh becomes one model object with one volume, even
  when its triangle set contains disconnected shells.  Do not automatically
  split it into separate objects or volumes; this matches the existing STL
  path and upstream DRC loader.
- Preserve OrcaSlicer source-name behaviour for every model format.  Pass a
  sanitized selected-file basename to the existing loader as its MEMFS staging
  filename instead of always using `uploaded_model.<ext>`.  This gives STL and
  DRC their selected filename where their upstream loaders derive an object
  name from the input path, while project formats such as 3MF retain the names
  defined inside the project.  Never pass a host absolute path into shared
  state or the WASM filesystem.
- Placement matches the current STL behaviour: centre the imported mesh on
  the XY origin, rest it on the bed, and do not perform collision avoidance or
  automatic arrangement.  Multiple imported models may overlap.
- Interpret DRC position values as millimetres, exactly as STL input is
  interpreted.  Preserve the source X/Y/Z axes and handedness without unit
  conversion, axis swapping, mirroring, or rotation.  The loader may reverse
  triangle winding only when needed to correct a negative signed volume; that
  operation must not alter vertex coordinates.
- Compatibility follows OrcaSlicer's DRC model-import behaviour.  Accept any
  valid Draco triangular-mesh file, including files not produced by
  OrcaSlicer.  Import only positions and triangular faces; colour, normals,
  texture coordinates, materials, metadata, hierarchy, instances, and slicer
  settings are not preserved.
- Draco point clouds and ordinary malformed or undecodable files that the
  upstream loader reports as failures fail atomically: show an understandable
  error, add no partial model, and preserve the current scene and any existing
  slice result.  Do not harden or patch upstream `DRC.cpp` for pathological
  decodable streams (for example, a triangular mesh with no `POSITION`
  attribute) that expose an existing upstream fault; these remain outside this
  delivery's failure guarantee.
- User-facing failures use one concise message, “Unable to import DRC file”.
  Decoder-specific diagnostics belong in the runtime log rather than in the
  UI.
- DRC adds no file-size, triangle-count, or post-decompression memory limit.
  Like the current STL support and OrcaSlicer, it is bounded by the resources
  available to the running application.

## Constraints

- The shared React application remains host-neutral.  Electron and Web file
  access continue to be supplied through platform contracts.
- The Web implementation must ship all decoder resources with the application;
  it must not depend on a third-party CDN at runtime.
- Prefer the upstream C++ implementation.  Restore and compile the existing
  `libslic3r/Format/DRC.cpp` and `.hpp` and use a C++ Draco static dependency
  in both the threaded and serial wasm64 artifacts.  The bridge may connect
  the existing model-import flow but must not reimplement DRC parsing.
- Source Draco using the same dependency pattern as the existing WASM build:
  download it into the untracked `.work/deps` directory and build it from
  source for both wasm64 variants.  Pin the same source as the upstream
  `cpp/deps/Draco/Draco.cmake` recipe: Draco 1.5.7 from
  `https://github.com/google/draco/archive/refs/tags/1.5.7.zip`, verified with
  SHA-256 `27b72ba2d5ff3d0a9814ad40d4cb88f8dc89a35491c0866d952473f8f9416b77`.
  Do not add a Draco Git submodule or use a runtime CDN.
- Compile the complete upstream Draco encoder and decoder library.  The first
  product delivery exposes import only, but retaining the complete library
  avoids splitting or stubbing the upstream `DRC.cpp` translation unit.
- Configure the native static-library build with `DRACO_JS_GLUE=OFF`; its
  generated JavaScript wrapper is not used by this C++ integration.  Draco
  1.5.7 also requires the Emscripten directory in the `EMSCRIPTEN` environment
  variable while configuring.

## Required validation gate

- Upstream DRC input currently uses `boost::iostreams::mapped_file_source` to
  map the staged input file before passing its bytes to Draco.  Verify that
  this works with the Emscripten MEMFS input path before implementing the
  feature further.
- If that validation fails, stop work and request a new decision.  Do not
  patch the upstream DRC implementation or introduce a replacement adapter
  without explicit approval.

## Feasibility result

- The required gate passed in an isolated 2026-09-01 probe.  A wasm64 program
  using the existing Boost `mapped_file_source` successfully read a MEMFS
  file.  Draco 1.5.7 built as a complete static library for both serial
  (`-m64`) and threaded (`-m64 -pthread`) configurations.
- The unmodified upstream `Format/DRC.cpp` compiled as wasm64 against that
  library.  An isolated link probe resolved its Draco and Boost.Iostreams
  dependencies; its only deliberately tolerated unresolved symbols belonged
  to the rest of libslic3r and Boost.Log, which were outside the probe.
- Continue with the direct upstream implementation; no fallback patch or
  replacement adapter is needed based on this validation.

## Implementation plan

1. **Stage Draco for both wasm64 variants.** Extend `fetch-deps.sh` and its
   cmd-native `.bat` counterpart to download the pinned archive into
   `.work/deps`, validate its SHA-256 before extraction, and retain no
   downloaded source in the repository.  Add matching `build-draco-wasm64`
   shell and cmd-native scripts, modelled on the existing oneTBB dependency
   build.  They build the complete `draco_static` archive separately for the
   serial and threaded variants, with `-m64` (and `-pthread` for threaded),
   `DRACO_JS_GLUE=OFF`, and tests disabled.  The scripts stage the source
   headers, CMake-generated `draco_features.h`, and `libdraco.a` under the
   variant's untracked dependency directory.
2. **Restore the upstream format in the WASM build.** In
   `packages/slicer-wasm/CMakeLists.txt`, remove only the DRC exclusion,
   require the staged Draco include/archive paths, add both source and
   generated include roots to `slic3r_core`, and link `draco_static` into the
   final module.  Remove only the DRC stand-ins from
   `stubs/format-stubs.cpp`; retain the unrelated SVG stubs.  No submodule
   file and no upstream `DRC.cpp` source is edited.
3. **Preserve the selected-file name through the existing bridge.** Extend the
   typed `SlicerClient.addModel`/Worker request and the `orc_add_model` bridge
   call with a sanitized basename in addition to the extension.  Stage bytes
   at `/tmp/<sanitized-basename>` (with a safe extension fallback), never a
   host path.  This lets upstream STL and DRC naming run unchanged, while 3MF
   keeps its project-defined names.  Keep the current temporary-model parse,
   post-load centring/bed placement, and append-on-success sequence.
4. **Expose the same picker capability in both hosts.** Pass the existing
   `ModelFile.displayName` from shared scene actions to the runtime, and add
   `drc` to the Electron model filter and Web input `accept` list.  No new
   platform contract, picker route, host privilege, or UI surface is needed.
   Map a returned DRC-load failure to the agreed generic UI message while
   retaining the original bridge/Draco diagnostic in worker logs.
5. **Add a compact, attributable fixture set and layered verification.** Store
   the approved four Google Draco 1.5.7 fixtures with their notice.  Extend
   the bridge smoke harness to import the three mesh fixtures, check object
   structure, vertex/index counts and bounding boxes, check filename
   propagation for both DRC and STL, verify DRC append/failed-import atomicity,
   and slice one imported DRC to non-empty G-code.  Add mock-client and shared
   action tests for the widened filename argument and generic DRC error.
   Extend the real Electron and real Web threaded/serial Playwright flows to
   select a DRC fixture, render it, and slice it.  Point cloud and test-time
   truncation cover the agreed rejection paths.

## Delivery sequence

- Commit 1: reproducible Draco fetch/build and CMake restoration, verified by
  a serial and threaded quick WASM build plus the existing smoke harness.
- Commit 2: bridge/client basename propagation and both host picker filters,
  verified by focused unit tests, typecheck, and the existing Electron mock
  E2E.
- Commit 3: licensed fixtures and native/real-artifact DRC coverage,
  verified by both bridge-smoke variants, real Electron E2E, and real Web
  threaded and serial E2E.
- Before handoff, run the repository-required `pnpm test`, `pnpm typecheck`,
  dual-variant quick WASM build, and desktop E2E; report every actual result.

## Acceptance requirements

- Keep a small, representative subset of Google Draco 1.5.7 official test
  data rather than importing its full fixture collection.  Retain one compact
  triangular mesh with non-position attributes (`cube_att.drc`) and one mesh
  for each supported connectivity encoding (the `edgebreaker` and
  `sequential` `test_nm` fixtures).  Together these are the required
  non-Orca compatibility samples.
- Retain one official Draco point-cloud fixture as the representative
  unsupported-input case.  Produce malformed-input coverage by truncating a
  successful mesh fixture in the test, rather than committing another binary.
- Include the upstream Apache-2.0 licence and precise Google Draco 1.5.7
  provenance alongside the retained binary fixtures.
- Successful import must prove more than absence of an error: verify expected
  vertex and triangle counts and a tolerance-checked bounding box, then slice
  the imported model and verify that G-code is produced.
- Run the DRC success and rejection scenarios against real artifacts in all
  supported hosts and variants: Electron, Web threaded wasm64, and Web serial
  wasm64.  These are release-blocking checks.
