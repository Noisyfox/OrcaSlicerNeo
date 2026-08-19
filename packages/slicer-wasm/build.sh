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
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"            # gitignored scratch space
ORCA_SRC="$PKG_DIR/cpp"                            # pinned submodule = the source
SHIM_INCLUDE="$WORK_DIR/shim-include"              # generated tbb/*.h forwarding headers
GEN_INCLUDE="$WORK_DIR/gen"                        # generated headers (libslic3r_version.h, openssl/md5.h)
BUILD_DIR="$WORK_DIR/build"
OUT_DIR="$PKG_DIR/out"
WASM_THREADING="${WASM_THREADING:-1}"
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
  # Serial boost::thread stand-in (Boost.Thread has no Emscripten backend).
  # libslic3r references it from dead-but-compiled code (Print, GCodeSender,
  # Thread, ProjectTask, PrintConfig, MultiMaterialSegmentation,
  # TriangleMeshSlicer). Same forwarding pattern as the TBB shim.
  mkdir -p "$SHIM_INCLUDE/boost/thread"
  cp "$PKG_DIR/shim/boost-thread.hpp" "$SHIM_INCLUDE/boost-thread.hpp"
  printf '#pragma once\n#include "../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread.hpp"
  printf '#pragma once\n#include "../../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread/mutex.hpp"
  printf '#pragma once\n#include "../../boost-thread.hpp"\n' > "$SHIM_INCLUDE/boost/thread/lock_guard.hpp"
  # libnoise stand-in (FuzzySkin.cpp includes <libnoise/noise.h>).
  mkdir -p "$SHIM_INCLUDE/libnoise"
  cp "$PKG_DIR/shim/libnoise/noise.h" "$SHIM_INCLUDE/libnoise/noise.h"
  # libjpeg stand-in (GCode/Thumbnails.cpp includes <jpeglib.h>/<jerror.h>;
  # stubs/jpeg-stub.cpp provides the no-op implementations).
  cp "$PKG_DIR/shim/jpeglib.h" "$SHIM_INCLUDE/jpeglib.h"
  cp "$PKG_DIR/shim/jerror.h" "$SHIM_INCLUDE/jerror.h"
  log "Shim headers written (TBB + boost::thread + libnoise + libjpeg)."
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

mkdir -p "$WORK_DIR" "$OUT_DIR" "$GEN_INCLUDE"
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
  -DORCA_SRC="$ORCA_SRC" \
  -DSHIM_INCLUDE="$SHIM_INCLUDE" \
  -DGEN_INCLUDE="$GEN_INCLUDE" \
  -DEIGEN_INCLUDE="$EIGEN_INCLUDE" \
  -DBOOST_INCLUDE="$BOOST_INCLUDE" \
  -DCEREAL_INCLUDE="$CEREAL_INCLUDE" \
  -DWASM_THREADING="$WASM_THREADING" \
  -DWASM_PTHREAD_POOL_SIZE="$WASM_PTHREAD_POOL_SIZE" \
  -DTBB_ROOT="$TBB_ROOT" \
  -DPRELOAD_FILES="$INFO_DIR@/info" \
  || die "CMake configure failed. Fix include paths / missing deps and re-run."

log "Building (emmake ninja) — expect to iterate on compile errors"
emmake ninja -C "$BUILD_DIR" orca_slice || die "Build failed. Common next steps:
  - Missing <tbb/X.h>: add X to TBB_HEADERS in build.sh and re-run.
  - Undefined symbol from an excluded file (SLA/CGAL/OCCT): add a stub in
    stubs/ or exclude its caller via DROP_PATTERNS in CMakeLists.txt.
  - Boost/Eigen not found: fix *_INCLUDE paths (run fetch-deps.sh first)."

# ---------------- Collect artifacts ----------------
# Fail loudly: a missing artifact is a build defect, not a warning. The .data
# is the --preload-file info bundle — emcc emits it at link
# time, so absence here means the link step regressed. The listing below is
# evidence in the CI log (size tells the curated vs full-bundle case apart).
for f in orca_slice.js orca_slice.wasm orca_slice.data; do
  [[ -f "$BUILD_DIR/$f" ]] || die "Build did not produce $BUILD_DIR/$f — check the link step above"
  cp -f "$BUILD_DIR/$f" "$OUT_DIR/"
done
ls -la "$OUT_DIR"
log "Done. Artifacts in $OUT_DIR/"
log "Smoke test: node harness/run-slice.mjs --module out/orca_slice.js \\
     --stl fixtures/cube.stl --config fixtures/config.json"
