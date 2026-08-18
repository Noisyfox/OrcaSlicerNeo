#!/usr/bin/env bash
# ----------------------------------------------------------------
# -------- Fetch pinned upstream oneTBB source for WASM ----------
# ----------------------------------------------------------------
# The threaded slicer build must use a real oneTBB, not the serial API shim.
# Keep the source out of the repository and pin its immutable Git commit so
# every local/CI build sees the same scheduler implementation.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPS="${WORK_DIR:-$PKG_DIR/.work}/deps"
TBB_COMMIT="${WASM_TBB_COMMIT:-3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3}"
TBB_DIR="$DEPS/oneTBB-$TBB_COMMIT"
ARCHIVE="$DEPS/oneTBB-$TBB_COMMIT.tar.gz"

mkdir -p "$DEPS"

if [[ -f "$TBB_DIR/CMakeLists.txt" ]]; then
  echo "[onetbb] Source already present: $TBB_DIR"
  exit 0
fi

echo "[onetbb] Fetching pinned oneTBB $TBB_COMMIT"
curl --fail --location --retry 3 --silent --show-error \
  --output "$ARCHIVE" \
  "https://github.com/uxlfoundation/oneTBB/archive/$TBB_COMMIT.tar.gz"
tar xzf "$ARCHIVE" -C "$DEPS"

EXTRACTED="$DEPS/oneTBB-$TBB_COMMIT"
[[ -f "$EXTRACTED/CMakeLists.txt" ]] || {
  echo "[onetbb] ERROR: expected $EXTRACTED/CMakeLists.txt after extraction" >&2
  exit 1
}
echo "$TBB_COMMIT" > "$EXTRACTED/.orca-pinned-commit"
echo "[onetbb] Ready: $EXTRACTED"
