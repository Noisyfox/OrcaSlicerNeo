#!/usr/bin/env bash
# Build the complete Google Draco C++ static library for one wasm64 variant.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"
DRACO_VER="${DRACO_VER:-1.5.7}"
WASM_THREADING="${WASM_THREADING:-1}"
ARTIFACT_VARIANT="${WASM_ARTIFACT_VARIANT:-$([[ "$WASM_THREADING" == "0" ]] && echo serial || echo threaded)}"
DRACO_SOURCE="$WORK_DIR/deps/draco-$DRACO_VER"
DRACO_BUILD="$WORK_DIR/draco-build-$ARTIFACT_VARIANT"
DRACO_STAGE="$DRACO_SOURCE/stage-wasm64-$ARTIFACT_VARIANT"
DRACO_FLAGS="-m64"
if [[ "$WASM_THREADING" != "0" ]]; then DRACO_FLAGS+=" -pthread"; fi

command -v emcmake >/dev/null 2>&1 || { echo "[draco] Activate emsdk first" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "[draco] cmake not found" >&2; exit 1; }
command -v ninja >/dev/null 2>&1 || { echo "[draco] ninja not found" >&2; exit 1; }
if [[ -z "${EMSCRIPTEN:-}" && -n "${EMSDK:-}" && -d "$EMSDK/upstream/emscripten" ]]; then
  export EMSCRIPTEN="$EMSDK/upstream/emscripten"
fi
[[ -n "${EMSCRIPTEN:-}" ]] || { echo "[draco] EMSCRIPTEN must name the Emscripten directory" >&2; exit 1; }

if [[ ! -f "$DRACO_SOURCE/CMakeLists.txt" ]]; then
  bash "$PKG_DIR/fetch-deps.sh"
fi

echo "[draco] Configuring $DRACO_VER ($ARTIFACT_VARIANT wasm64)"
EMSCRIPTEN="$EMSCRIPTEN" emcmake cmake -S "$DRACO_SOURCE" -B "$DRACO_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$DRACO_FLAGS" \
  -DCMAKE_CXX_FLAGS="$DRACO_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$DRACO_FLAGS" \
  -DBUILD_SHARED_LIBS=OFF \
  -DDRACO_JS_GLUE=OFF \
  -DDRACO_TESTS=OFF
cmake --build "$DRACO_BUILD" --target draco_static --parallel "${WASM_BUILD_JOBS:-4}"

DRACO_ARCHIVE="$DRACO_BUILD/libdraco.a"
DRACO_FEATURES="$DRACO_BUILD/draco/draco_features.h"
[[ -f "$DRACO_ARCHIVE" ]] || { echo "[draco] ERROR: missing $DRACO_ARCHIVE" >&2; exit 1; }
[[ -f "$DRACO_FEATURES" ]] || { echo "[draco] ERROR: missing $DRACO_FEATURES" >&2; exit 1; }
mkdir -p "$DRACO_STAGE/include/draco" "$DRACO_STAGE/lib"
cp -R "$DRACO_SOURCE/src/draco/." "$DRACO_STAGE/include/draco/"
cp -f "$DRACO_FEATURES" "$DRACO_STAGE/include/draco/draco_features.h"
cp -f "$DRACO_ARCHIVE" "$DRACO_STAGE/lib/libdraco.a"
echo "[draco] Staged $DRACO_STAGE/lib/libdraco.a"
