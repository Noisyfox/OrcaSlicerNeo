#!/usr/bin/env bash
# Build and stage the OCCT 7.6.0 XCAF/STEP closure for one wasm64 variant.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_DIR="${WORK_DIR:-$PKG_DIR/.work}"
WASM_THREADING="${WASM_THREADING:-1}"
ARTIFACT_VARIANT="${WASM_ARTIFACT_VARIANT:-$([[ "$WASM_THREADING" == "0" ]] && echo serial || echo threaded)}"
DEPS="$WORK_DIR/deps"
OCCT_VER="7.6.0"
OCCT_SOURCE="$DEPS/occt-$OCCT_VER"
OCCT_BUILD="$WORK_DIR/occt-build-$ARTIFACT_VARIANT"
OCCT_STAGE="$OCCT_SOURCE/stage-wasm64-$ARTIFACT_VARIANT"
OCCT_PATCH_DIR="$PKG_DIR/patches/occt"
OCCT_FLAGS="-m64"
[[ "$WASM_THREADING" == "0" ]] || OCCT_FLAGS+=" -pthread"
EXPECTED=(TKBO TKBRep TKCAF TKCDF TKernel TKG2d TKG3d TKGeomAlgo TKGeomBase TKHLR TKLCAF TKMath TKMesh TKPrim TKService TKShHealing TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase TKTopAlgo TKV3d TKVCAF TKXCAF TKXDESTEP TKXSBase)

die() { echo "[occt] ERROR: $*" >&2; exit 1; }
command -v emcmake >/dev/null 2>&1 || die "activate emsdk first"
command -v emcc >/dev/null 2>&1 || die "emcc not found"
command -v cmake >/dev/null 2>&1 || die "cmake not found"
command -v ninja >/dev/null 2>&1 || die "ninja not found"
[[ -f "$OCCT_SOURCE/CMakeLists.txt" ]] || bash "$PKG_DIR/fetch-deps.sh"
[[ -f "$OCCT_SOURCE/CMakeLists.txt" ]] || die "OCCT source is unavailable"

# The source archive is not a repository. git apply is used only as a
# deterministic, whitespace-aware patcher and does not modify the pinned C++.
[[ -d "$OCCT_SOURCE/.git" ]] || git -C "$OCCT_SOURCE" init -q
for patch in "$OCCT_PATCH_DIR"/*.patch; do
  [[ -e "$patch" ]] || continue
  if git -C "$OCCT_SOURCE" apply --check --unidiff-zero "$patch" 2>/dev/null; then
    git -C "$OCCT_SOURCE" apply --unidiff-zero "$patch" || die "could not apply OCCT patch $(basename "$patch")"
  elif git -C "$OCCT_SOURCE" apply --reverse --check --unidiff-zero "$patch" 2>/dev/null; then
    : # Already applied.
  else
    die "OCCT patch $(basename "$patch") neither applies nor is already applied"
  fi
done

echo "[occt] Configuring OCCT $OCCT_VER ($ARTIFACT_VARIANT wasm64)"
emcmake cmake -S "$OCCT_SOURCE" -B "$OCCT_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SIZEOF_VOID_P:INTERNAL=8 \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_CXX_STANDARD=17 \
  -DCMAKE_C_FLAGS="$OCCT_FLAGS" \
  -DCMAKE_CXX_FLAGS="$OCCT_FLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$OCCT_FLAGS" \
  -DBUILD_LIBRARY_TYPE=Static \
  -DBUILD_MODULE_ApplicationFramework=OFF \
  -DBUILD_MODULE_DataExchange=ON \
  -DBUILD_MODULE_FoundationClasses=OFF \
  -DBUILD_MODULE_ModelingAlgorithms=OFF \
  -DBUILD_MODULE_ModelingData=OFF \
  -DBUILD_MODULE_Draw=OFF \
  -DBUILD_MODULE_Visualization=OFF \
  -DBUILD_DOC_Overview=OFF \
  -DUSE_TK=OFF -DUSE_TBB=OFF -DUSE_FFMPEG=OFF -DUSE_VTK=OFF \
  -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_FREETYPE=OFF
cmake --build "$OCCT_BUILD" --target "${EXPECTED[@]}" --parallel "${WASM_BUILD_JOBS:-4}"
LIB_DIR="$(find "$OCCT_BUILD" -type d -path '*/lib' | head -n 1)"
[[ -n "$LIB_DIR" ]] || die "OCCT library output directory not found"
for toolkit in "${EXPECTED[@]}"; do
  [[ -f "$LIB_DIR/lib$toolkit.a" ]] || die "missing OCCT archive lib$toolkit.a"
done
[[ -f "$OCCT_BUILD/include/opencascade/Standard.hxx" ]] || die "missing generated OCCT headers"

rm -rf "$OCCT_STAGE"
mkdir -p "$OCCT_STAGE/include/opencascade" "$OCCT_STAGE/lib"
cp -R "$OCCT_BUILD/include/opencascade/." "$OCCT_STAGE/include/opencascade/"
for toolkit in "${EXPECTED[@]}"; do cp -f "$LIB_DIR/lib$toolkit.a" "$OCCT_STAGE/lib/"; done

printf '%s\n' "OCCT=$OCCT_VER" "variant=$ARTIFACT_VARIANT" "flags=$OCCT_FLAGS" "USE_FREETYPE=OFF" > "$OCCT_STAGE/manifest.txt"
echo "[occt] Staged ${#EXPECTED[@]} OCCT archives at $OCCT_STAGE"
