#!/usr/bin/env bash
# ----------------------------------------------------------------
# ------------ OrcaSlicerNeo: libslic3r -> WASM build ------------
# ----------------------------------------------------------------
# Builds the pinned C++ submodule (packages/slicer-wasm/cpp) into a single
# Emscripten module: real oneTBB pthread runtime, scaffold CMake, bridge + CLI driver.
# Inherited from the phase-0 spike's build.sh and adapted: no clone step (the
# submodule IS the source pin), wasm64-first, full preset bundle embedded.
# patches/*.patch are applied to the submodule working tree here, at build
# time — the submodule itself stays pristine (read-only, pinned SHA).
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
#   ./build.sh --debug        # libslic3r + bridge at -g -O0 (embedded DWARF,
#                             # interactive source-level debugging; deps stay release)
#   (or set WASM_DEBUG=1)
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"            # gitignored scratch space
ORCA_SRC="$PKG_DIR/cpp"                            # pinned submodule = the source
WASM_THREADING="${WASM_THREADING:-1}"
ARTIFACT_VARIANT="${WASM_ARTIFACT_VARIANT:-$([[ "$WASM_THREADING" == "0" ]] && echo serial || echo threaded)}"
VARIANT_WORK_DIR="$WORK_DIR/$ARTIFACT_VARIANT"
SHIM_INCLUDE="$VARIANT_WORK_DIR/shim-include"
GEN_INCLUDE="$VARIANT_WORK_DIR/gen"
BUILD_DIR="$VARIANT_WORK_DIR/build"
OUT_DIR="${WASM_OUT_DIR:-$PKG_DIR/out/$ARTIFACT_VARIANT}"
VALIDATE_WASM="$PKG_DIR/../../scripts/validate-wasm.mjs"
# Emscripten evaluates this expression in the runtime and creates one pthread
# worker per available logical core. Callers can override it for profiling.
WASM_PTHREAD_POOL_SIZE="${WASM_PTHREAD_POOL_SIZE:-navigator.hardwareConcurrency}"
WASM_TBB_COMMIT="${WASM_TBB_COMMIT:-3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3}"
TBB_ROOT="$WORK_DIR/deps/oneTBB-$WASM_TBB_COMMIT/stage-wasm64-pthreads"

# Header-only / Emscripten-built dependency include dirs (fetch-deps.sh,
# build-boost-wasm64.sh). Overridable for CI.
EIGEN_INCLUDE="${EIGEN_INCLUDE:-$WORK_DIR/deps/eigen-5.0.1}"
BOOST_INCLUDE="${BOOST_INCLUDE:-$WORK_DIR/deps/boost-1.84.0}"
CEREAL_INCLUDE="${CEREAL_INCLUDE:-$WORK_DIR/deps/cereal-1.3.0/include}"
DRACO_ROOT="$WORK_DIR/deps/draco-1.5.7/stage-wasm64-$ARTIFACT_VARIANT"
DRACO_INCLUDE="${DRACO_INCLUDE:-$DRACO_ROOT/include}"
DRACO_ARCHIVE="${DRACO_ARCHIVE:-$DRACO_ROOT/lib/libdraco.a}"
OCCT_ROOT="${OCCT_ROOT:-$WORK_DIR/deps/occt-7.6.0/stage-wasm64-$ARTIFACT_VARIANT}"

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
  version concurrent_unordered_map concurrent_unordered_set concurrent_map
  concurrent_queue parallel_pipeline
)

generate_shim() {
  log "Generating serial TBB shim headers in $SHIM_INCLUDE/tbb"
  mkdir -p "$SHIM_INCLUDE/tbb" "$SHIM_INCLUDE/oneapi/tbb"
  local rel="$PKG_DIR/shim/_serial.hpp"
  # Copy the serial header next to the forwarding headers so they can include
  # it by bare relative name — the MSYS absolute path (e.g. /d/projects/...)
  # does not resolve on the Windows clang driver and broke every TU.
  cp "$rel" "$SHIM_INCLUDE/_serial.hpp"
  for name in "${TBB_HEADERS[@]}"; do
    printf '#pragma once\n#include "_serial.hpp"\n' > "$SHIM_INCLUDE/tbb/${name}.h"
    printf '#pragma once\n#include "_serial.hpp"\n' > "$SHIM_INCLUDE/oneapi/tbb/${name}.h"
  done
  printf '#pragma once\n#include "_serial.hpp"\n' > "$SHIM_INCLUDE/tbb/tbb.h"
  printf '#pragma once\n#include "_serial.hpp"\n' > "$SHIM_INCLUDE/oneapi/tbb.h"
  # boost::thread compatibility shim. In the threaded variant it wraps
  # std::thread/pthreads; in the serial variant it is a deferred serial stand-in.
  # libslic3r references it from dead-but-compiled code (Print, GCodeSender,
  # Thread, ProjectTask, PrintConfig, MultiMaterialSegmentation,
  # TriangleMeshSlicer). Same forwarding pattern as the TBB shim.
  mkdir -p "$SHIM_INCLUDE/boost/thread"
  cp "$PKG_DIR/shim/boost-thread.hpp" "$SHIM_INCLUDE/boost-thread.hpp"
  printf '#pragma once\n#include "../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread.hpp"
  printf '#pragma once\n#include "../../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread/mutex.hpp"
  printf '#pragma once\n#include "../../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread/lock_guard.hpp"
  printf '#pragma once\n#include "../../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread/condition_variable.hpp"
  mkdir -p "$SHIM_INCLUDE/boost/thread/detail"
  printf '#pragma once\n#include "../../../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread/detail/thread.hpp"
  # libnoise stand-in (FuzzySkin.cpp includes <libnoise/noise.h>).
  mkdir -p "$SHIM_INCLUDE/libnoise"
  cp "$PKG_DIR/shim/libnoise/noise.h" "$SHIM_INCLUDE/libnoise/noise.h"
  # libjpeg stand-in (GCode/Thumbnails.cpp includes <jpeglib.h>/<jerror.h>;
  # stubs/jpeg-stub.cpp provides the no-op implementations).
  cp "$PKG_DIR/shim/jpeglib.h" "$SHIM_INCLUDE/jpeglib.h"
  cp "$PKG_DIR/shim/jerror.h" "$SHIM_INCLUDE/jerror.h"
  log "Shim headers written (TBB + boost::thread + libnoise + libjpeg)."
}

# ---------------- arg parsing ----------------
# --debug: rebuild the libslic3r/bridge part with -g -O0 so the final module
# embeds DWARF for interactive source-level debugging (Chrome DevTools).
# Dependencies (Boost/oneTBB/vendored deps) stay release WITHOUT debug info.
# WASM_DEBUG=1 is honored for programmatic callers (build-wasm-dual.sh).
DEBUG="${WASM_DEBUG:-0}"
SHIM_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --debug)     DEBUG=1 ;;
    --shim-only) SHIM_ONLY=1 ;;
    *) die "Unknown option: $arg (see header comment)" ;;
  esac
done
if [[ "$SHIM_ONLY" == 1 ]]; then
  mkdir -p "$WORK_DIR"
  generate_shim
  exit 0
fi
if [[ "$DEBUG" == 1 ]]; then
  log "DEBUG build: libslic3r + bridge at -g -O0 (DWARF embedded, interactive source-level debugging); deps stay release"
fi

# ---------------- Prerequisite checks ----------------
command -v git   >/dev/null 2>&1 || die "git not found"
command -v cmake >/dev/null 2>&1 || die "cmake not found"
command -v ninja >/dev/null 2>&1 || die "ninja not found"
if ! command -v emcmake >/dev/null 2>&1; then
  die "Emscripten not on PATH. Install emsdk and 'source ./emsdk_env.sh', then re-run."
fi
log "emcc: $(emcc --version | head -1)"

# ---------------- Patch the submodule (build-time, idempotent) ----------------
# The pinned submodule is pristine; every packages/slicer-wasm/patches/*.patch
# is git-applied to its working tree here. Already-applied runs are skipped;
# a patch that neither applies nor is applied is a hard error.
apply_patches() {
  local p
  for p in "$PKG_DIR"/patches/*.patch; do
    [[ -e "$p" ]] || continue
    if git -C "$ORCA_SRC" apply --check "$p" 2>/dev/null; then
      git -C "$ORCA_SRC" apply "$p"
      log "Applied $(basename "$p")"
    elif git -C "$ORCA_SRC" apply --reverse --check "$p" 2>/dev/null; then
      log "Already applied: $(basename "$p")"
    else
      die "Patch $(basename "$p") neither applies cleanly nor is already applied — submodule at $ORCA_SRC needs review."
    fi
  done
}
apply_patches

# A failed em++/wasm-opt invocation can leave partial target files behind.
# Remove only generated final link outputs so Ninja cannot treat its stale .js
# output as a successful link on the next invocation.
discard_invalid_link_outputs() {
  if [[ ! -e "$BUILD_DIR/orca_slice.js" && ! -e "$BUILD_DIR/orca_slice.wasm" && ! -e "$BUILD_DIR/orca_slice.data" ]]; then
    return
  fi
  if [[ -f "$BUILD_DIR/orca_slice.wasm" ]] && node "$VALIDATE_WASM" "$BUILD_DIR/orca_slice.wasm" >/dev/null 2>&1; then
    return
  fi
  log "Discarding incomplete or invalid prior WASM link output in $BUILD_DIR"
  rm -f -- "$BUILD_DIR/orca_slice.js" "$BUILD_DIR/orca_slice.wasm" "$BUILD_DIR/orca_slice.data"
}

mkdir -p "$WORK_DIR" "$OUT_DIR" "$GEN_INCLUDE"
# fetch-deps.sh historically writes the OpenSSL compatibility header in the
# shared work tree. Variant-specific CMake trees must receive the same header
# or the serial/threaded builds diverge before compilation starts.
if [[ -f "$WORK_DIR/gen/openssl/md5.h" && ! -f "$GEN_INCLUDE/openssl/md5.h" ]]; then
  mkdir -p "$GEN_INCLUDE/openssl"
  cp "$WORK_DIR/gen/openssl/md5.h" "$GEN_INCLUDE/openssl/md5.h"
fi
generate_shim

# ---------------- Dependency staging ----------------
if [[ ! -d "$BOOST_INCLUDE/boost" ]]; then
  log "Running fetch-deps.sh (Eigen/Boost/cereal + generated headers)"
  bash "$PKG_DIR/fetch-deps.sh" || die "fetch-deps.sh failed"
fi
if [[ "$WASM_THREADING" != "0" && ! -f "$TBB_ROOT/lib/libtbb.a" ]]; then
  log "Building pinned oneTBB (wasm64 + pthreads)"
  bash "$PKG_DIR/build-onetbb.sh"
fi
if [[ ! -f "$DRACO_ARCHIVE" ]]; then
  log "Building Draco 1.5.7 ($ARTIFACT_VARIANT wasm64)"
  WASM_THREADING="$WASM_THREADING" WASM_ARTIFACT_VARIANT="$ARTIFACT_VARIANT" \
    bash "$PKG_DIR/build-draco-wasm64.sh"
fi
if [[ ! -f "$OCCT_ROOT/include/opencascade/Standard.hxx" || ! -f "$OCCT_ROOT/lib/libTKXDESTEP.a" ]]; then
  log "Building OCCT 7.6.0 XCAF/STEP closure ($ARTIFACT_VARIANT wasm64)"
  WASM_THREADING="$WASM_THREADING" WASM_ARTIFACT_VARIANT="$ARTIFACT_VARIANT" \
    WORK_DIR="$WORK_DIR" "$PKG_DIR/build-occt-wasm64.sh" \
    || die "OCCT build failed"
fi
[[ -f "$OCCT_ROOT/include/opencascade/Standard.hxx" && -f "$OCCT_ROOT/lib/libTKXDESTEP.a" ]] \
  || die "staged OCCT prefix is incomplete: $OCCT_ROOT"

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

# Profile packages are installed by the runtime Worker before orc_init().
# WASM only retains the distinct /info resource needed by the bridge.
INFO_DIR="$ORCA_SRC/resources/info"
# file_packager runs as a native exe under emcc on Windows (Git Bash) and
# needs Windows paths. MSYS auto-converts plain args, but SKIPS args
# containing ';' — the list separator in -DPRELOAD_FILES — so convert
# explicitly. cygpath only exists on MSYS/Git Bash; on Linux CI this is a
# no-op and native paths are already correct. -m = forward-slash style
# (F:/...), which Windows Python and CMake both accept.
if command -v cygpath >/dev/null 2>&1; then
  INFO_DIR="$(cygpath -m "$INFO_DIR")"
fi

# ---------------- Configure + build ----------------
log "Configuring stripped libslic3r + bridge + CLI (emcmake)"
emcmake cmake -S "$PKG_DIR" -B "$BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DWASM_DEBUG="$DEBUG" \
  -DORCA_SRC="$ORCA_SRC" \
  -DSHIM_INCLUDE="$SHIM_INCLUDE" \
  -DGEN_INCLUDE="$GEN_INCLUDE" \
  -DEIGEN_INCLUDE="$EIGEN_INCLUDE" \
  -DBOOST_INCLUDE="$BOOST_INCLUDE" \
  -DCEREAL_INCLUDE="$CEREAL_INCLUDE" \
  -DDRACO_INCLUDE="$DRACO_INCLUDE" \
  -DDRACO_ARCHIVE="$DRACO_ARCHIVE" \
  -DOCCT_ROOT="$OCCT_ROOT" \
  -DWASM_THREADING="$WASM_THREADING" \
  -DWASM_PTHREAD_POOL_SIZE="$WASM_PTHREAD_POOL_SIZE" \
  -DTBB_ROOT="$TBB_ROOT" \
  -DPRELOAD_FILES="$INFO_DIR@/info" \
  || die "CMake configure failed. Fix include paths / missing deps and re-run."

log "Building (emmake ninja) — expect to iterate on compile errors"
discard_invalid_link_outputs
emmake ninja -C "$BUILD_DIR" orca_slice || die "Build failed. Common next steps:
  - Missing <tbb/X.h>: add X to TBB_HEADERS in build.sh and re-run.
  - Undefined symbol from an excluded file (SLA/CGAL/OCCT): add a stub in
    stubs/ or exclude its caller via DROP_PATTERNS in CMakeLists.txt.
  - Boost/Eigen not found: fix *_INCLUDE paths (run fetch-deps.sh first)."
node "$VALIDATE_WASM" "$BUILD_DIR/orca_slice.wasm" || die "Link produced invalid WebAssembly at $BUILD_DIR/orca_slice.wasm"

# ---------------- Collect artifacts ----------------
# Fail loudly: a missing artifact is a build defect, not a warning. The .data
# is the --preload-file info bundle — emcc emits it at link
# time, so absence here means the link step regressed. The listing below is
# evidence in the CI log (size tells the curated vs full-bundle case apart).
for f in orca_slice.js orca_slice.wasm orca_slice.data; do
  [[ -f "$BUILD_DIR/$f" ]] || die "Build did not produce $BUILD_DIR/$f — check the link step above"
  cp -f "$BUILD_DIR/$f" "$OUT_DIR/"
done
# Keep the historical single-artifact location for existing Node smoke and
# Electron scripts when the default threaded build is run directly. The dual
# entry point and Web host consume the explicit variant directories.
if [[ "$ARTIFACT_VARIANT" == "threaded" && "$OUT_DIR" != "$PKG_DIR/out" ]]; then
  mkdir -p "$PKG_DIR/out"
  for f in orca_slice.js orca_slice.wasm orca_slice.data; do cp -f "$OUT_DIR/$f" "$PKG_DIR/out/"; done
fi
ls -la "$OUT_DIR"
log "Done. Artifacts in $OUT_DIR/"
log "Smoke test: node harness/run-slice.mjs --module out/orca_slice.js \\
     --stl fixtures/cube.stl --config fixtures/config.json"
