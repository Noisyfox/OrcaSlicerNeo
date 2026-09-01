# DRC Import Support

**Status:** Discovery — implementation not started

## Accepted product behaviour

- The first delivery supports importing `.drc` files only.  DRC export is out
  of scope for this delivery.
- DRC has the same user entry points as the current STL support: the existing
  in-app **Add Model** flow in both the Electron and Web hosts.  It does not
  add drag-and-drop import, operating-system file association, or opening a
  DRC file from outside the application.
- An imported DRC is appended to the current plate.  It never replaces the
  existing scene.
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
- Compatibility follows OrcaSlicer's DRC model-import behaviour.  Accept any
  valid Draco triangular-mesh file, including files not produced by
  OrcaSlicer.  Import only positions and triangular faces; colour, normals,
  texture coordinates, materials, metadata, hierarchy, instances, and slicer
  settings are not preserved.
- Draco point clouds, malformed files, files that cannot be decoded, and files
  without usable triangle geometry fail atomically: show an understandable
  error, add no partial model, and preserve the current scene and any existing
  slice result.
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

## Acceptance requirements

- A valid Draco triangular-mesh fixture generated by a non-Orca tool is a
  required compatibility test, not an optional interoperability check.
- Successful import must prove more than absence of an error: verify expected
  vertex and triangle counts and a tolerance-checked bounding box, then slice
  the imported model and verify that G-code is produced.
- Run the DRC success and rejection scenarios against real artifacts in all
  supported hosts and variants: Electron, Web threaded wasm64, and Web serial
  wasm64.  These are release-blocking checks.
