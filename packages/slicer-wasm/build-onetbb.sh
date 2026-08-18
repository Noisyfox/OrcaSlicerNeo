#!/usr/bin/env bash
# ----------------------------------------------------------------
# ----- Build pinned oneTBB + an independent WASM pthread probe ---
# ----------------------------------------------------------------
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"
TBB_COMMIT="${WASM_TBB_COMMIT:-3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3}"
TBB_SOURCE="$WORK_DIR/deps/oneTBB-$TBB_COMMIT"
TBB_BUILD="$WORK_DIR/onetbb-build"
TBB_STAGE="$WORK_DIR/deps/oneTBB-$TBB_COMMIT/stage-wasm64-pthreads"
OUT_DIR="$PKG_DIR/out"
POOL_SIZE="${WASM_PTHREAD_POOL_SIZE:-4}"

command -v emcmake >/dev/null 2>&1 || { echo "[onetbb] Activate emsdk first" >&2; exit 1; }
command -v em++ >/dev/null 2>&1 || { echo "[onetbb] em++ not found" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "[onetbb] cmake not found" >&2; exit 1; }
command -v ninja >/dev/null 2>&1 || { echo "[onetbb] ninja not found" >&2; exit 1; }

if [[ ! -f "$TBB_SOURCE/CMakeLists.txt" ]]; then
  bash "$PKG_DIR/fetch-onetbb.sh"
fi

echo "[onetbb] Configuring $TBB_COMMIT (wasm64 + pthreads)"
emcmake cmake -S "$TBB_SOURCE" -B "$TBB_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS="-m64 -pthread" \
  -DCMAKE_EXE_LINKER_FLAGS="-m64 -pthread" \
  -DBUILD_SHARED_LIBS=OFF \
  -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DTBB_STRICT=OFF \
  -DTBBMALLOC_BUILD=ON -DTBBMALLOC_PROXY_BUILD=OFF \
  -DTCM_BUILD=OFF \
  -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON \
  -DCMAKE_INSTALL_PREFIX="$TBB_STAGE"
cmake --build "$TBB_BUILD" --parallel "${WASM_BUILD_JOBS:-4}"
cmake --install "$TBB_BUILD"

TBB_ARCHIVE="$TBB_STAGE/lib/libtbb.a"
[[ -f "$TBB_ARCHIVE" ]] || { echo "[onetbb] ERROR: missing $TBB_ARCHIVE" >&2; exit 1; }
TBBMALLOC_ARCHIVE="$TBB_STAGE/lib/libtbbmalloc.a"
[[ -f "$TBBMALLOC_ARCHIVE" ]] || { echo "[onetbb] ERROR: missing $TBBMALLOC_ARCHIVE" >&2; exit 1; }
mkdir -p "$OUT_DIR"
echo "[onetbb] Linking runtime proof (pthread pool: $POOL_SIZE)"
em++ -O3 -m64 -pthread \
  -I"$TBB_STAGE/include" "$PKG_DIR/harness/tbb-parallelism-probe.cpp" "$TBB_ARCHIVE" "$TBBMALLOC_ARCHIVE" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sPTHREAD_POOL_SIZE="$POOL_SIZE" -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_RUNTIME_METHODS=callMain \
  -sEXPORTED_FUNCTIONS=_main \
  -o "$OUT_DIR/orca_tbb_probe.js"
echo "[onetbb] Run: node harness/run-tbb-parallelism-probe.mjs out/orca_tbb_probe.js"
