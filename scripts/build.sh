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
#   build     Full dual-variant build via scripts/build-wasm-dual.sh:
#             both wasm64 variants (threaded + serial) + stage into the
#             renderer. Requires boost archives; fetches deps automatically
#             if missing.
#   full      deps + boost + build — the complete cold-start path.
#   quick     INCREMENTAL: ninja in .work/threaded/build and
#             .work/serial/build + stage the 3 artifacts to out/<variant>.
#             The fast loop for bridge/CMake changes — no configure, no
#             patch re-apply, seconds-to-minutes. Use --variant to limit
#             to one build tree.
#   shim      Regenerate the TBB/boost::thread/libnoise/libjpeg shim headers
#             (build.sh --shim-only) after editing TBB_HEADERS in build.sh.
#   smoke     Run both harnesses against out/threaded and out/serial:
#             run-slice.mjs + bridge-smoke.mjs (--variant to limit).
#   test      vitest + typecheck for slicer-wasm and desktop.
#   dev       Launch the Electron app in dev mode (pnpm --filter desktop dev).
#   e2e       Playwright Electron e2e (pnpm --filter desktop test:e2e).
#   help      This help.
#
# Options:
#   -j N, --jobs N   Parallelism for ninja / b2 (quick/build/boost).
#                    Default: ninja auto; BOOST_JOBS=4 as upstream.
#   --variant threaded|serial|both
#                    Build/verify one variant, or both (default: both).
#   --no-env         Skip emsdk auto-activation (expect emcmake on PATH).
#   --debug          Build with embedded DWARF: libslic3r + bridge at
#                    -g -O0 (deps stay release -O3). Applies at configure
#                    time (build/full); for quick the tree must have been
#                    configured with it (checked, with a clear error).
#   -v, --verbose    set -x (print every command).
#
# emsdk vs PATH: if emcc/emcmake are already on PATH (Homebrew emscripten,
# or an emsdk env already sourced), the script uses them as-is. Otherwise
# it auto-activates an emsdk install found via the EMSDK env var or
# emsdk_env.sh on PATH — disable with --no-env.
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
PKG="$ROOT/packages/slicer-wasm"
WORK="$PKG/.work"
# Variant trees follow packages/slicer-wasm/build.sh: .work/<variant>/build,
# out/<variant>. OUT_DIR is the legacy single-artifact location kept in sync
# for the threaded variant.
OUT_DIR="$PKG/out"
BOOST_STAGE="$WORK/deps/boost-1.84.0/stage-wasm64/lib"

JOBS=""            # "" = toolchain default
AUTO_ENV=1
VARIANT=both
DEBUG=0

usage() { sed -n '2,59p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------- emsdk auto-activation ----------------
# Already on PATH (Homebrew emscripten, sourced emsdk env)? Use it as-is;
# else source emsdk_env.sh from the EMSDK env var, or found on PATH.
# --no-env skips the search and requires emcmake on PATH.
ensure_emsdk() {
  if command -v emcmake >/dev/null 2>&1; then
    log "emcc: $(emcc --version | head -1)"
    return 0
  fi
  [[ "$AUTO_ENV" == 1 ]] || die "emcmake not on PATH (pass --no-env only when emsdk is already active)."
  local emsdk_env=""
  if [[ -n "${EMSDK:-}" && -f "$EMSDK/emsdk_env.sh" ]]; then
    emsdk_env="$EMSDK/emsdk_env.sh"
  elif command -v emsdk_env.sh >/dev/null 2>&1; then
    emsdk_env="$(command -v emsdk_env.sh)"
  fi
  if [[ -n "$emsdk_env" ]]; then
    log "Activating emsdk at $(dirname "$emsdk_env")"
    # shellcheck disable=SC1090
    source "$emsdk_env" >/dev/null 2>&1 || die "sourcing $emsdk_env failed"
    command -v emcmake >/dev/null 2>&1 || die "emsdk_env.sh sourced but emcmake still missing"
    log "emcc: $(emcc --version | head -1)"
    return 0
  fi
  die "Emscripten not found. Set EMSDK to an emsdk install (containing emsdk_env.sh), put emsdk_env.sh on PATH, or add emcc/emcmake to PATH (e.g. brew install emscripten)."
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
    --variant)
      [[ $# -ge 2 ]] || die "Option $1 requires an argument (see --help)"
      VARIANT="$2"; shift 2
      [[ "$VARIANT" == threaded || "$VARIANT" == serial || "$VARIANT" == both ]] || \
        die "--variant must be 'threaded', 'serial' or 'both' (got '$VARIANT')"
      ;;
    --no-env)    AUTO_ENV=0; shift ;;
    --debug)     DEBUG=1; shift ;;
    -v|--verbose) set -x; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

NINJA_JOBS=(); [[ -n "$JOBS" ]] && NINJA_JOBS=(-j "$JOBS")

# ---------------- per-variant helpers ----------------
# Incremental ninja + stage for ONE variant ($1 = threaded|serial).
quick_variant() {
  local v="$1" bd="$WORK/$1/build" outd="$PKG/out/$1"
  [[ -d "$bd" ]] || die "No build tree at $bd — run: bash scripts/build.sh build"
  # --debug is a configure-time decision: quick only re-runs ninja, so verify
  # the tree was actually configured with WASM_DEBUG rather than silently
  # staging a release module.
  if [[ "$DEBUG" == 1 ]] && ! grep -q '^WASM_DEBUG:BOOL=ON' "$bd/CMakeCache.txt"; then
    die "Tree $bd was configured without WASM_DEBUG — run: bash scripts/build.sh build --debug (reconfigures both variants)"
  fi
  log "Incremental: emmake ninja -C $bd orca_slice ${NINJA_JOBS[*]+"${NINJA_JOBS[*]}"}"
  emmake ninja -C "$bd" orca_slice ${NINJA_JOBS[@]+"${NINJA_JOBS[@]}"}
  for f in orca_slice.js orca_slice.wasm orca_slice.data; do
    [[ -f "$bd/$f" ]] || die "Build did not produce $bd/$f"
    cp -f "$bd/$f" "$outd/"
  done
  # threaded keeps the historical single-artifact location for existing Node
  # smoke and Electron scripts; the dual entry point and Web host consume the
  # explicit variant directories.
  if [[ "$v" == threaded && "$outd" != "$OUT_DIR" ]]; then
    mkdir -p "$OUT_DIR"
    for f in orca_slice.js orca_slice.wasm orca_slice.data; do cp -f "$outd/$f" "$OUT_DIR/"; done
  fi
  log "Staged $v to $outd:"
  ls -la "$outd"
}

# Harnesses against ONE variant ($1 = threaded|serial).
smoke_variant() {
  local v="$1" m="$PKG/out/$1/orca_slice.js"
  [[ -f "$m" ]] || die "Missing $m — run: bash scripts/build.sh build"
  ( cd "$PKG" && node harness/run-slice.mjs --module "out/$v/orca_slice.js" --stl fixtures/cube.stl --config fixtures/config.json )
  ( cd "$PKG" && node harness/bridge-smoke.mjs "out/$v/orca_slice.js" fixtures/cube.stl )
}

case "$CMD" in
  # ---------------- env ----------------
  env)
    if command -v emcmake >/dev/null 2>&1; then
      echo "emsdk already active: emcc $(emcc --version | head -1)"
    else
      echo "emsdk NOT active. In your shell, run:"
      if [[ -n "${EMSDK:-}" && -f "$EMSDK/emsdk_env.sh" ]]; then
        echo "  source $EMSDK/emsdk_env.sh"
        echo "(found at $EMSDK — the script auto-activates it for other commands)"
        exit 0
      fi
      if command -v emsdk_env.sh >/dev/null 2>&1; then
        echo "  source $(command -v emsdk_env.sh)"
        echo "(found on PATH — the script auto-activates it for other commands)"
        exit 0
      fi
      echo "  source <emsdk-path>/emsdk_env.sh   # after installing emsdk"
      echo "(or set EMSDK=<emsdk-path> and re-run — the script auto-activates it)"
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

  # ---------------- dual-variant build (threaded + serial + stage) ----------------
  build)
    ensure_emsdk
    [[ -d "$BOOST_STAGE" ]] || die "Boost wasm64 archives missing ($BOOST_STAGE) — run: bash scripts/build.sh boost"
    if [[ "$DEBUG" == 1 ]]; then
      bash "$ROOT/scripts/build-wasm-dual.sh" --debug
    else
      bash "$ROOT/scripts/build-wasm-dual.sh"
    fi
    ;;

  # ---------------- cold start ----------------
  full)
    ensure_emsdk
    bash "$PKG/fetch-deps.sh"
    BOOST_JOBS="${JOBS:-4}" bash "$PKG/build-boost-wasm64.sh"
    if [[ "$DEBUG" == 1 ]]; then
      bash "$ROOT/scripts/build-wasm-dual.sh" --debug
    else
      bash "$ROOT/scripts/build-wasm-dual.sh"
    fi
    ;;

  # ---------------- incremental ninja loop (both variants unless --variant) ----------------
  quick)
    ensure_emsdk
    if [[ "$VARIANT" == both ]]; then
      quick_variant threaded
      quick_variant serial
    else
      quick_variant "$VARIANT"
    fi
    ;;

  # ---------------- shim only ----------------
  shim)
    bash "$PKG/build.sh" --shim-only
    ;;

  # ---------------- harnesses (both variants unless --variant) ----------------
  smoke)
    for f in fixtures/cube.stl fixtures/config.json; do
      [[ -f "$PKG/$f" ]] || die "Missing $PKG/$f — run: bash scripts/build.sh build"
    done
    if [[ "$VARIANT" == both ]]; then
      smoke_variant threaded
      smoke_variant serial
    else
      smoke_variant "$VARIANT"
    fi
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
