#!/usr/bin/env bash
# Build both production wasm64 variants. Each invocation has its own CMake
# cache and output directory, so a serial build can never accidentally reuse
# pthread objects (or vice versa).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PKG="$ROOT/packages/slicer-wasm"

WASM_THREADING=1 WASM_ARTIFACT_VARIANT=threaded bash "$PKG/build.sh"
WASM_THREADING=0 WASM_ARTIFACT_VARIANT=serial bash "$PKG/build.sh"

node "$ROOT/scripts/stage-wasm.mjs"
