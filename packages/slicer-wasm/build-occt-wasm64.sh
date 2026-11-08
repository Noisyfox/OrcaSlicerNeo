#!/usr/bin/env bash
# Build the pinned OCCT STEP closure for this WASM variant.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WASM_THREADING="${WASM_THREADING:-$([[ "${WASM_ARTIFACT_VARIANT:-threaded}" == "serial" ]] && echo 0 || echo 1)}"
VARIANT="${WASM_ARTIFACT_VARIANT:-$([[ "$WASM_THREADING" == "0" ]] && echo serial || echo threaded)}"
if [[ "$VARIANT" == "serial" && "$WASM_THREADING" != "0" || "$VARIANT" == "threaded" && "$WASM_THREADING" != "1" ]]; then
  echo "[occt] ERROR: variant and WASM_THREADING disagree" >&2
  exit 1
fi
node "$PKG_DIR/dependencies/external/build.mjs" build --library occt --target wasm64 --variant "$VARIANT"
