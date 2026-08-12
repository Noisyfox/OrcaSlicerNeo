#!/usr/bin/env bash
# ----------------------------------------------------------------
# ------------ OrcaSlicerNeo: libslic3r -> WASM build ------------
# ----------------------------------------------------------------
# Builds the pinned C++ submodule (packages/slicer-wasm/cpp) into a single
# Emscripten module: serial TBB shim, scaffold CMake, bridge + CLI driver.
# Inherited from the phase-0 spike's build.sh and adapted: no clone step (the
# submodule IS the source pin), wasm64-first, curated preset subset embedded.
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
  version concurrent_unordered_map concurrent_map concurrent_queue
  parallel_pipeline
)

generate_shim() {
  log "Generating serial TBB shim headers in $SHIM_INCLUDE/tbb"
  mkdir -p "$SHIM_INCLUDE/tbb" "$SHIM_INCLUDE/oneapi/tbb"
  local rel="$PKG_DIR/shim/_serial.hpp"
  for name in "${TBB_HEADERS[@]}"; do
    printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/tbb/${name}.h"
    printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/oneapi/tbb/${name}.h"
  done
  printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/tbb/tbb.h"
  printf '#pragma once\n#include "%s"\n' "$rel" > "$SHIM_INCLUDE/oneapi/tbb.h"
  log "Shim headers written."
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

mkdir -p "$WORK_DIR" "$OUT_DIR" "$GEN_INCLUDE"
generate_shim

# ---------------- Dependency staging ----------------
if [[ ! -d "$BOOST_INCLUDE/boost" ]]; then
  log "Running fetch-deps.sh (Eigen/Boost/cereal + generated headers)"
  bash "$PKG_DIR/fetch-deps.sh" || die "fetch-deps.sh failed"
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

# ---------------- Curated preset subset (for orc_init) ----------------
# Embed one vendor (Bambu Lab) + its index. PresetBundle::load_presets reads
# <data_dir>/system/*.json + vendor dirs (machine/process/filament). The full
# resources/profiles bundle lands via --preload-file in Milestone 3.
embed_presets() {
  local src="$ORCA_SRC/resources/profiles"
  local dst="$WORK_DIR/embed/system"
  rm -rf "$WORK_DIR/embed"
  mkdir -p "$dst"
  cp "$src/BBL.json" "$dst/"
  cp -a "$src/BBL" "$dst/"
  log "Embedded curated presets from $src/BBL into $dst"
}
embed_presets

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
  -DEMBED_FILE="$WORK_DIR/embed/system@/system" \
  || die "CMake configure failed. Fix include paths / missing deps and re-run."

log "Building (emmake ninja) — expect to iterate on compile errors"
emmake ninja -C "$BUILD_DIR" orca_slice || die "Build failed. Common next steps:
  - Missing <tbb/X.h>: add X to TBB_HEADERS in build.sh and re-run.
  - Undefined symbol from an excluded file (SLA/CGAL/OCCT): add a stub in
    stubs/ or exclude its caller via DROP_PATTERNS in CMakeLists.txt.
  - Boost/Eigen not found: fix *_INCLUDE paths (run fetch-deps.sh first)."

# ---------------- Collect artifacts ----------------
cp -f "$BUILD_DIR"/orca_slice.js  "$OUT_DIR"/ 2>/dev/null || true
cp -f "$BUILD_DIR"/orca_slice.wasm "$OUT_DIR"/ 2>/dev/null || true
log "Done. Artifacts in $OUT_DIR/"
log "Smoke test: node harness/run-slice.mjs --module out/orca_slice.js \\
     --stl fixtures/cube.stl --config fixtures/config.ini"
