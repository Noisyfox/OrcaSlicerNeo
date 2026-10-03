#!/usr/bin/env bash
# Build the complete NLopt static library for one wasm64 variant.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"
NLOPT_VER="2.5.0"
WASM_THREADING="${WASM_THREADING:-1}"
ARTIFACT_VARIANT="${WASM_ARTIFACT_VARIANT:-$([[ "$WASM_THREADING" == "0" ]] && echo serial || echo threaded)}"
NLOPT_SOURCE="$WORK_DIR/deps/nlopt-$NLOPT_VER"
NLOPT_BUILD="$WORK_DIR/nlopt-build-$ARTIFACT_VARIANT"
NLOPT_STAGE="${NLOPT_ROOT:-$NLOPT_SOURCE/stage-wasm64-$ARTIFACT_VARIANT}"
NLOPT_FLAGS="-m64 -fexceptions"
if [[ "$WASM_THREADING" != "0" ]]; then NLOPT_FLAGS+=" -pthread"; fi

command -v emcmake >/dev/null 2>&1 || { echo "[nlopt] Activate emsdk first" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "[nlopt] cmake not found" >&2; exit 1; }
command -v ninja >/dev/null 2>&1 || { echo "[nlopt] ninja not found" >&2; exit 1; }
if [[ -z "${EMSCRIPTEN:-}" ]]; then
  if [[ -n "${EMSDK:-}" && -d "$EMSDK/upstream/emscripten" ]]; then
    EMSCRIPTEN="$EMSDK/upstream/emscripten"
  elif command -v em-config >/dev/null 2>&1; then
    # PATH-only installs (such as Homebrew) do not set EMSDK, but em-config
    # knows the actual Emscripten root even when its commands are symlinked.
    EMSCRIPTEN="$(em-config EMSCRIPTEN_ROOT 2>/dev/null || true)"
  fi
fi
if [[ -z "${EMSCRIPTEN:-}" ]]; then
  echo "[nlopt] EMSCRIPTEN must name the Emscripten directory (set EMSCRIPTEN or EMSDK, or add em-config to PATH)" >&2
  exit 1
fi
if [[ ! -d "$EMSCRIPTEN" || ! -f "$EMSCRIPTEN/emcc" ]]; then
  echo "[nlopt] EMSCRIPTEN does not contain emcc: $EMSCRIPTEN" >&2
  exit 1
fi
export EMSCRIPTEN

if [[ ! -f "$NLOPT_SOURCE/CMakeLists.txt" ]]; then
  bash "$PKG_DIR/fetch-deps.sh"
fi

echo "[nlopt] Configuring $NLOPT_VER ($ARTIFACT_VARIANT wasm64)"
EMSCRIPTEN="$EMSCRIPTEN" emcmake cmake -S "$NLOPT_SOURCE" -B "$NLOPT_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS="$NLOPT_FLAGS" \
  -DCMAKE_CXX_FLAGS="$NLOPT_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$NLOPT_FLAGS" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DBUILD_SHARED_LIBS=OFF \
  -DNLOPT_CXX=OFF \
  -DNLOPT_PYTHON=OFF \
  -DNLOPT_OCTAVE=OFF \
  -DNLOPT_MATLAB=OFF \
  -DNLOPT_GUILE=OFF \
  -DNLOPT_SWIG=OFF
cmake --build "$NLOPT_BUILD" --target nlopt --parallel "${WASM_BUILD_JOBS:-4}"

for header in nlopt.h nlopt.hpp; do
  [[ -f "$NLOPT_BUILD/src/api/$header" ]] || { echo "[nlopt] ERROR: missing generated header $header" >&2; exit 1; }
done
[[ -f "$NLOPT_BUILD/libnlopt.a" ]] || { echo "[nlopt] ERROR: missing libnlopt.a" >&2; exit 1; }
mkdir -p "$NLOPT_STAGE/include" "$NLOPT_STAGE/lib"
cp -f "$NLOPT_BUILD/src/api/nlopt.h" "$NLOPT_BUILD/src/api/nlopt.hpp" "$NLOPT_STAGE/include/"
cp -f "$NLOPT_BUILD/libnlopt.a" "$NLOPT_STAGE/lib/libnlopt.a"
echo "[nlopt] Staged $NLOPT_STAGE/lib/libnlopt.a"
