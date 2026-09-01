#!/usr/bin/env bash
# ----------------------------------------------------------------
# ------------ Fetch header-only deps for the WASM spike ---------
# ----------------------------------------------------------------
# Sets up .work/deps (Eigen, Boost assembled headers, cereal) and .work/gen
# (generated/stub headers) — the external pieces the FDM core needs beyond
# OrcaSlicer's in-tree deps_src/. Idempotent. See FINDINGS.md for the proven
# per-file compile recipe. Run build.sh --shim-only for the TBB shim.
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPS="$SPIKE_DIR/.work/deps"
GEN="$SPIKE_DIR/.work/gen"
mkdir -p "$DEPS" "$GEN/openssl"

# Versions match OrcaSlicer v2.4.2 deps/ recipes (cereal 1.3.x is API-compatible).
EIGEN_VER="5.0.1"
BOOST_VER="1.84.0"
CEREAL_VER="1.3.0"
DRACO_VER="1.5.7"
DRACO_SHA256="27b72ba2d5ff3d0a9814ad40d4cb88f8dc89a35491c0866d952473f8f9416b77"

log() { printf '\033[1;36m[deps]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deps]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

verify_sha256() {
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$1" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  else
    die "sha256sum or shasum is required to verify $1"
  fi
  [[ "$actual" == "$2" ]] || die "SHA-256 mismatch for $1 (got $actual)"
}

# ---- Eigen (header-only) ----
if [[ ! -d "$DEPS/eigen-$EIGEN_VER/Eigen" ]]; then
  log "Fetching Eigen $EIGEN_VER"
  curl -sL -o "$DEPS/eigen.zip" \
    "https://gitlab.com/libeigen/eigen/-/archive/$EIGEN_VER/eigen-$EIGEN_VER.zip"
  unzip -q -o "$DEPS/eigen.zip" -d "$DEPS"
fi

# ---- Boost (modular release -> assemble unified boost/ header tree) ----
if [[ ! -f "$DEPS/boost-$BOOST_VER/boost/version.hpp" ]]; then
  log "Fetching Boost $BOOST_VER"
  curl -sL -o "$DEPS/boost.tar.gz" \
    "https://github.com/boostorg/boost/releases/download/boost-$BOOST_VER/boost-$BOOST_VER.tar.gz"
  tar xzf "$DEPS/boost.tar.gz" -C "$DEPS"
  log "Assembling unified Boost headers (b2 headers)"
  ( cd "$DEPS/boost-$BOOST_VER" && ./bootstrap.sh >/dev/null 2>&1 && ./b2 headers >/dev/null 2>&1 )
fi

# ---- cereal (header-only) ----
if [[ ! -d "$DEPS/cereal-$CEREAL_VER/include/cereal" ]]; then
  log "Fetching cereal $CEREAL_VER"
  curl -sL -o "$DEPS/cereal.tar.gz" \
    "https://github.com/USCiLab/cereal/archive/refs/tags/v$CEREAL_VER.tar.gz"
  tar xzf "$DEPS/cereal.tar.gz" -C "$DEPS"
fi

# ---- Draco (native C++ codec source; built separately per wasm variant) ----
if [[ ! -f "$DEPS/draco-$DRACO_VER/CMakeLists.txt" ]]; then
  DRACO_ARCHIVE="$DEPS/draco-$DRACO_VER.zip"
  log "Fetching Draco $DRACO_VER"
  curl -fsSL --retry 3 -o "$DRACO_ARCHIVE" \
    "https://github.com/google/draco/archive/refs/tags/$DRACO_VER.zip"
  verify_sha256 "$DRACO_ARCHIVE" "$DRACO_SHA256"
  unzip -q -o "$DRACO_ARCHIVE" -d "$DEPS"
fi

# ---- Generated / stub headers ----
log "Writing generated + stub headers in .work/gen"
cat > "$GEN/libslic3r_version.h" <<'EOF'
#ifndef __SLIC3R_VERSION_H
#define __SLIC3R_VERSION_H
#define SLIC3R_APP_NAME "OrcaSlicer"
#define SLIC3R_APP_KEY "OrcaSlicer"
#define SLIC3R_VERSION "2.4.2"
#define SoftFever_VERSION "2.4.2"
#ifndef GIT_COMMIT_HASH
#define GIT_COMMIT_HASH "0000000"
#endif
#define SLIC3R_BUILD_ID "OrcaSlicer-2.4.2-wasm-spike"
#define BBL_INTERNAL_TESTING 0
#define ORCA_CHECK_GCODE_PLACEHOLDERS 0
#endif
EOF

# Classic OpenSSL MD5 API (declarations only; codegen. A real build links a
# small MD5 implementation).
cat > "$GEN/openssl/md5.h" <<'EOF'
#ifndef SPIKE_OPENSSL_MD5_H
#define SPIKE_OPENSSL_MD5_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#define MD5_DIGEST_LENGTH 16
typedef struct MD5state_st { unsigned int A,B,C,D,Nl,Nh,data[16],num; } MD5_CTX;
int MD5_Init(MD5_CTX*);
int MD5_Update(MD5_CTX*, const void*, size_t);
int MD5_Final(unsigned char*, MD5_CTX*);
unsigned char* MD5(const unsigned char*, size_t, unsigned char*);
#ifdef __cplusplus
}
#endif
#endif
EOF

log "Done. deps in $DEPS, generated headers in $GEN"
