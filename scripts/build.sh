#!/usr/bin/env bash
# ================================================================
# build.sh — macOS/Linux build driver
# ================================================================
# One entry point for the whole local loop on macOS/Linux:
#   emsdk activation → deps → Boost wasm64 → full WASM build →
#   incremental rebuild → harnesses → unit tests → app dev/e2e.
# Wraps the proven per-step commands from the WASM build docs
# (build.sh / fetch-deps.sh / build-boost-wasm64.sh / ninja loop).
#
# Plain bash — works on macOS and Linux (bash 3.2+, no GNU-only
# extensions). The Windows twin is scripts/build-windows.bat (cmd).
#
# Usage:
#   bash scripts/build.sh <command> [options]
#
# Commands:
#   env       Print the emsdk activation line for interactive shells
#             (auto-activation below only affects this script's process).
#   deps      Fetch header-only deps (Eigen 5.0.1 / Boost 1.84 / cereal)
#             via fetch-deps.sh — idempotent.
#   boost     Cross-compile Boost 1.84 wasm64 static archives
#             (build-boost-wasm64.sh; requires `deps` first). Long first run.
#   build     Full packages/slicer-wasm/build.sh (patches submodule, shim,
#             configure, ninja, stage to out/). Requires boost archives;
#             fetches deps automatically if missing.
#   full      deps + boost + build — the complete cold-start path.
#   quick     INCREMENTAL: ninja in .work/build + stage the 3 artifacts to
#             out/. The fast loop for bridge/CMake changes — no configure,
#             no patch re-apply, seconds-to-minutes.
#   shim      Regenerate the TBB/boost::thread/libnoise/libjpeg shim headers
#             (build.sh --shim-only) after editing TBB_HEADERS in build.sh.
#   smoke     Run both harnesses against out/: run-slice.mjs + bridge-smoke.mjs.
#   test      vitest + typecheck for slicer-wasm and desktop.
#   dev       Launch the Electron app in dev mode (pnpm --filter desktop dev).
#   e2e       Playwright Electron e2e (pnpm --filter desktop test:e2e).
#   help      This help.
#
# Options:
#   -j N, --jobs N   Parallelism for ninja / b2 (quick/build/boost).
#                    Default: ninja auto; BOOST_JOBS=4 as upstream.
#   --profiles <dir> WASM_PROFILES_DIR override for `build`/`full`
#                    (a curated dir = lighter .data bundle; default is the
#                    full profiles tree).
#   --no-env         Skip emsdk auto-activation (expect emcmake on PATH).
#   -v, --verbose    set -x (print every command).
#
# emsdk vs PATH: if emcc/emcmake are already on PATH (Homebrew emscripten,
# or an emsdk env already sourced), the script uses them as-is. Otherwise
# it auto-activates an emsdk install (EMSDK, then common locations) —
# disable with --no-env.
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PKG="$ROOT/packages/slicer-wasm"
WORK="$PKG/.work"
BUILD_DIR="$WORK/build"
OUT_DIR="$PKG/out"
BOOST_STAGE="$WORK/deps/boost-1.84.0/stage-wasm64/lib"

JOBS=""            # "" = toolchain default
PROFILES_DIR=""    # "" = full bundle
AUTO_ENV=1

usage() { sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------- emsdk auto-activation ----------------
# Already on PATH (Homebrew emscripten, sourced emsdk env)? Use it as-is;
# else find an emsdk install and source emsdk_env.sh. --no-env skips the
# search and requires emcmake on PATH.
ensure_emsdk() {
  if command -v emcmake >/dev/null 2>&1; then
    log "emcc: $(emcc --version | head -1)"
    return 0
  fi
  [[ "$AUTO_ENV" == 1 ]] || die "emcmake not on PATH (pass --no-env only when emsdk is already active)."
  local cand
  for cand in "${EMSDK:-}" "$HOME/emsdk" "$HOME/src/emsdk" /opt/emsdk; do
    if [[ -n "$cand" && -f "$cand/emsdk_env.sh" ]]; then
      log "Activating emsdk at $cand"
      # shellcheck disable=SC1090
      source "$cand/emsdk_env.sh" >/dev/null 2>&1 || die "sourcing $cand/emsdk_env.sh failed"
      command -v emcmake >/dev/null 2>&1 || die "emsdk_env.sh sourced but emcmake still missing"
      log "emcc: $(emcc --version | head -1)"
      return 0
    fi
  done
  die "Emscripten not found. Install emsdk and 'source <emsdk>/emsdk_env.sh' (or brew install emscripten), or set EMSDK."
}

log()  { printf '\033[1;36m[build]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[build] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------- arg parsing ----------------
CMD="${1:-help}"
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    -j|--jobs)
      [[ $# -ge 2 ]] || die "Option $1 requires an argument (see --help)"
      JOBS="$2"; shift 2 ;;
    --profiles)
      [[ $# -ge 2 ]] || die "Option $1 requires an argument (see --help)"
      PROFILES_DIR="$2"; shift 2 ;;
    --no-env)    AUTO_ENV=0; shift ;;
    -v|--verbose) set -x; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

NINJA_JOBS=(); [[ -n "$JOBS" ]] && NINJA_JOBS=(-j "$JOBS")

case "$CMD" in
  # ---------------- env ----------------
  env)
    if command -v emcmake >/dev/null 2>&1; then
      echo "emsdk already active: emcc $(emcc --version | head -1)"
    else
      echo "emsdk NOT active. In your shell, run:"
      for cand in "${EMSDK:-}" "$HOME/emsdk" "$HOME/src/emsdk" /opt/emsdk; do
        if [[ -n "$cand" && -f "$cand/emsdk_env.sh" ]]; then
          echo "  source $cand/emsdk_env.sh"
          echo "(found at $cand — the script auto-activates it for other commands)"
          exit 0
        fi
      done
      echo "  source <emsdk-path>/emsdk_env.sh   # after installing emsdk"
      echo "(or brew install emscripten — then emcc/emcmake are on PATH, no emsdk needed)"
    fi
    ;;

  # ---------------- deps ----------------
  deps)
    bash "$PKG/fetch-deps.sh"
    ;;

  # ---------------- boost wasm64 ----------------
  boost)
    ensure_emsdk
    [[ -d "$WORK/deps/boost-1.84.0" ]] || die "Boost source not staged — run: bash scripts/build.sh deps"
    log "Building Boost 1.84 wasm64 archives (BOOST_JOBS=${JOBS:-4})"
    BOOST_JOBS="${JOBS:-4}" bash "$PKG/build-boost-wasm64.sh"
    log "Boost archives in $WORK/deps/boost-1.84.0/stage-wasm64/lib"
    ;;

  # ---------------- full build.sh ----------------
  build)
    ensure_emsdk
    [[ -d "$BOOST_STAGE" ]] || die "Boost wasm64 archives missing ($BOOST_STAGE) — run: bash scripts/build.sh boost"
    if [[ -n "$PROFILES_DIR" ]]; then
      log "WASM_PROFILES_DIR=$PROFILES_DIR (lighter .data bundle)"
      WASM_PROFILES_DIR="$PROFILES_DIR" bash "$PKG/build.sh"
    else
      bash "$PKG/build.sh"
    fi
    ;;

  # ---------------- cold start ----------------
  full)
    ensure_emsdk
    bash "$PKG/fetch-deps.sh"
    BOOST_JOBS="${JOBS:-4}" bash "$PKG/build-boost-wasm64.sh"
    if [[ -n "$PROFILES_DIR" ]]; then
      WASM_PROFILES_DIR="$PROFILES_DIR" bash "$PKG/build.sh"
    else
      bash "$PKG/build.sh"
    fi
    ;;

  # ---------------- incremental ninja loop ----------------
  quick)
    ensure_emsdk
    [[ -d "$BUILD_DIR" ]] || die "No build tree at $BUILD_DIR — run: bash scripts/build.sh build"
    log "Incremental: emmake ninja -C $BUILD_DIR orca_slice ${NINJA_JOBS[*]+"${NINJA_JOBS[*]}"}"
    emmake ninja -C "$BUILD_DIR" orca_slice "${NINJA_JOBS[@]}"
    for f in orca_slice.js orca_slice.wasm orca_slice.data; do
      [[ -f "$BUILD_DIR/$f" ]] || die "Build did not produce $BUILD_DIR/$f"
      cp -f "$BUILD_DIR/$f" "$OUT_DIR/"
    done
    log "Staged to $OUT_DIR:"
    ls -la "$OUT_DIR"
    ;;

  # ---------------- shim only ----------------
  shim)
    bash "$PKG/build.sh" --shim-only
    ;;

  # ---------------- harnesses ----------------
  smoke)
    for f in out/orca_slice.js fixtures/cube.stl fixtures/config.json; do
      [[ -f "$PKG/$f" ]] || die "Missing $PKG/$f — run: bash scripts/build.sh build"
    done
    ( cd "$PKG" && node harness/run-slice.mjs --module out/orca_slice.js --stl fixtures/cube.stl --config fixtures/config.json )
    ( cd "$PKG" && node harness/bridge-smoke.mjs out/orca_slice.js fixtures/cube.stl )
    ;;

  # ---------------- unit tests + typecheck ----------------
  test)
    pnpm --filter slicer-wasm test
    pnpm --filter slicer-wasm typecheck
    pnpm --filter desktop test
    pnpm --filter desktop typecheck
    log "All tests + typechecks green."
    ;;

  # ---------------- electron app ----------------
  dev)
    cd "$ROOT" && pnpm --filter desktop dev
    ;;
  e2e)
    cd "$ROOT" && pnpm --filter desktop test:e2e
    ;;

  # ---------------- help ----------------
  help|-h)
    usage
    ;;
  *)
    die "Unknown command: $CMD (see --help)"
    ;;
esac
