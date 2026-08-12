#!/usr/bin/env bash
# ----------------------------------------------------------------
# ------------ Cross-compile Boost 1.84 to wasm64 ----------------
# ----------------------------------------------------------------
# Builds the compiled Boost components libslic3r links, as wasm64 static
# archives, using b2 with an Emscripten toolset. Proven 2026-07-24 — all 12
# libs build clean (system, filesystem, thread, atomic, chrono, date_time,
# iostreams, log, log_setup, locale, program_options, regex, nowide).
# Prereqs: fetch-deps.sh has run (Boost extracted + `b2 headers` assembled),
# and emsdk is active (source ~/emsdk/emsdk_env.sh).
set -euo pipefail
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BD="$SPIKE_DIR/.work/deps/boost-1.84.0"
[[ -d "$BD" ]] || { echo "Run fetch-deps.sh first (no $BD)"; exit 1; }
command -v em++ >/dev/null 2>&1 || { echo "Activate emsdk first"; exit 1; }

cd "$BD"
cat > user-config-wasm.jam <<'EOF'
using clang : emscripten : em++ : <archiver>emar <ranlib>emranlib ;
EOF

# locale uses the std backend (no ICU/iconv on wasm). runtime-link=static keeps
# everything self-contained. MEMORY64 must match the libslic3r object build.
./b2 -q --user-config=user-config-wasm.jam toolset=clang-emscripten \
  --with-system --with-filesystem --with-thread --with-atomic --with-chrono \
  --with-date_time --with-iostreams --with-log --with-locale \
  --with-program_options --with-regex --with-nowide \
  boost.locale.icu=off boost.locale.iconv=off boost.locale.posix=off boost.locale.std=on \
  link=static threading=multi runtime-link=static variant=release \
  cxxflags="-sMEMORY64 -pthread -std=c++17 -Wno-unused -Wno-deprecated-declarations" \
  cflags="-sMEMORY64 -pthread" \
  --stagedir=stage-wasm64 -j4 stage

echo "=== wasm64 Boost archives in $BD/stage-wasm64/lib ==="
ls -1 "$BD/stage-wasm64/lib"/*.a | xargs -n1 basename
