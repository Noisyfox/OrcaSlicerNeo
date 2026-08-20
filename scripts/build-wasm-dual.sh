#!/usr/bin/env bash
# Build both production wasm64 variants. Each invocation has its own CMake
# cache and output directory, so a serial build can never accidentally reuse
# pthread objects (or vice versa).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PKG="$ROOT/packages/slicer-wasm"

# --debug (or WASM_DEBUG=1): build both variants with embedded DWARF (-g -O0
# for the libslic3r part only, see build.sh). Forwarded via env so each
# variant build behaves exactly like a direct invocation of build.sh.
DEBUG="${WASM_DEBUG:-0}"
for arg in "$@"; do
  case "$arg" in
    --debug) DEBUG=1 ;;
    *) echo "[wasm-dual] Unknown option: $arg" >&2; exit 1 ;;
  esac
done

WASM_THREADING=1 WASM_ARTIFACT_VARIANT=threaded WASM_DEBUG="$DEBUG" bash "$PKG/build.sh"
WASM_THREADING=0 WASM_ARTIFACT_VARIANT=serial WASM_DEBUG="$DEBUG" bash "$PKG/build.sh"

node "$ROOT/scripts/stage-wasm.mjs"
