# 2026-08-15 — Pure-cmd build pipeline (.bat, no Git Bash)

## Why

Git Bash is broken on the dev machine (`bash --version` exits 255), so every
build script that needed MSYS was unreachable. Decision: duplicate the whole
pipeline as self-contained Windows cmd `.bat` files that work with zero bash
dependencies. The `.sh` originals stay for Linux/macOS/CI; on Windows the
`.bat` is the primary path.

## What was ported

| File | Port of | Notes |
|---|---|---|
| `packages/slicer-wasm/fetch-deps.bat` | `fetch-deps.sh` | curl (PATH, else System32) + `tar.exe` (bsdtar handles zip/gz) + Boost's own `bootstrap.bat`/`.\b2.exe headers` |
| `packages/slicer-wasm/build-boost-wasm64.bat` | `build-boost-wasm64.sh` | b2 with `user-config-wasm.jam` (absolute em++/emar/emranlib paths from `where`) |
| `packages/slicer-wasm/build.bat` | `build.sh` | patches (idempotent `git apply`), serial shim headers, version header from submodule, `emcmake` configure, `emmake ninja`, stage 3 artifacts |
| `scripts/build-windows.bat` | `scripts/build-windows.sh` (rewritten, was a bash wrapper) | `env deps boost build full quick shim smoke test dev e2e` + `-j/--profiles/--no-env/-v`; auto-activates emsdk via `emsdk_env.bat` |
| `.gitattributes` | new | `*.bat text eol=crlf` — cmd misparses LF-only batch files |

`build-windows.bat quick` is the incremental loop for bridge changes:
auto-activate emsdk → `emmake ninja -C .work\build orca_slice` → copy the 3
artifacts to `out\`.

## Gotchas discovered (cmd batch language)

These cost the most debugging time; any future `.bat` work must respect them.

### 1. `NoDefaultCurrentDirectoryInExePath=1` — bare names return 9009 / "not recognized"

This machine sets the env var machine-wide (CVE-2010-2729 mitigation). cmd
**skips the current directory** when resolving a bare executable name, so
`b2.exe` in the CWD fails with `9009: 'b2.exe' is not recognized` while
`.\b2.exe` runs fine. Git Bash worked because MSYS resolution ignores it.

The flag is wider than exes: **bare `.bat`/`.cmd` names in `call` fail the
same way** — proven 2026-08-15 by Boost's engine `build.bat`, whose
`call guess_toolset.bat` / `call config_toolset.bat` die with `'guess_toolset
.bat' is not recognized` under the flag. (Clearing the env var in-process
restores CWD search immediately — cmd re-reads it per call — and an empty
value reads as "flag off", verified empirically; see gotcha #7.)

Rule: **always invoke executables with an explicit `.\` path** (`.\b2.exe`,
`.\bootstrap.bat`) in `.bat` files. Verify with `where`/`if exist` before use
where the exe might be missing.

### 2. Paren-block parser trap — unescaped `)` closes the block early

Inside `if (...)` / `for (...)` blocks, an unescaped `)` in `echo` text
(e.g. `echo ... (bootstrap.bat + b2 headers)`) terminates the block at that
`)`, so every following line executes **top-level, regardless of the guard**.
Proven by minimal repro: a `if 0==1 ( ... )` block still ran its body.

Rule: inside blocks, escape parens in text as `^( ... ^)`.

### 3. CRLF is mandatory

The Write tool (and most editors on Linux) write LF. cmd misparses LF-only
batch files (multiline blocks get misread). All `.bat` are CRLF and pinned by
`.gitattributes`; after any edit, verify no bare-LF lines.

### 4. Stale auto-generated `project-config.jam` → `'C:Users' is not recognized`

b2 auto-loads `project-config.jam` from the boost root. The bash-era
`bootstrap.sh` generated one containing `using python : 3.12 :
"C:\Users\noisyfox\.pyenv\..."` — **jam treats `\` as an escape in string
literals**, so b2 parsed the path as `C:Users\noisyfox\...` and its python
toolset init tried to *run* that as a command → `'C:Users' is not
recognized` on every b2 invocation (non-fatal; boost builds fine without
python, which is why the error hid under b2's noise). b2 never regenerates
the file. Fix: both `fetch-deps.bat` and `build-boost-wasm64.bat` delete it
defensively before running b2.

### 5. emsdk activation

`emsdk_env.bat` is a one-liner (`@call "%~dp0emsdk" construct_env`) with no
`setlocal`, so the environment persists in the calling cmd process. Both
`C:\emsdk` and `D:\emsdk` exist on this machine; the search order in
`build-windows.bat :find_emsdk` prefers `C:\emsdk` (its cache was warm for
the last-known-good build; activating another install clears that cache).

### 5b. `-sMEMORY64` is deprecated — use `-m64`

em++ 6.0.4 warns on every invocation with the old spelling: *"MEMORY64 is
deprecated (prefer the standard -m64 or --target=wasm64 flags)"*. The
flag must match at compile **and** link (`CMakeLists.txt`:
`add_compile_options(-m64)` + the `target_link_options` list) **and** in
the boost b2 `cxxflags`/`cflags` (`build-boost-wasm64.bat` / `.sh`), or
the deprecation warning reappears on the next em++ invocation that
carries the old flag. Verified: full rebuild with `-m64` produces zero
MEMORY64 warnings and the smoke harnesses pass on the resulting wasm64
binary.

### 6. Forward-slash normalization keeps the CMake cache byte-identical

`%VAR:\=/%` converts native paths to the `F:/MyProject/...` form CMake stores,
so a `.bat`-configured tree matches a Git-Bash-configured one — no rebuild
churn on reconfigure.

### 7. Boost `bootstrap.bat` cannot auto-detect the toolset — pass it explicitly

First-time deps (`fetch-deps.bat` when `boost/` is missing) build `b2.exe`
via Boost's `bootstrap.bat`, and its auto-detect is doubly broken on this
box (root-caused + fixed 2026-08-15):

1. `build.bat` calls `guess_toolset.bat` / `config_toolset.bat` as bare
   names → dead under `NoDefaultCurrentDirectoryInExePath=1` (gotcha #1).
2. With CWD search restored (flag cleared), vswhere finds VS 2026+/18 and
   sets `VSUNKCOMNTOOLS` → toolset `vcunk` — but Boost 1.84's
   `config_toolset.bat` has **no `vcunk` case** → `"Unknown toolset:
   vcunk"`. Auto-detect is broken for VS 2026+ on *any* machine, flag or
   not. (Repro output: `Found with vswhere ...VS\18\Enterprise` then
   `Unknown toolset: vcunk`.)

Fix in `fetch-deps.bat`: clear the flag for the bootstrap section only
(`set "NoDefaultCurrentDirectoryInExePath="`, restore after — empty reads
as off), then probe the host compiler with `where` (`cl` → `bootstrap.bat
msvc`, else `g++` → `gcc`, else `clang` → `clang`) and pass it **explicitly
** — the explicit-toolset path skips `guess_toolset.bat` entirely. Verified:
`bootstrap.bat msvc` + flag cleared builds a working b2.exe (B2 4.10) with
cl from the VS dev prompt. The gcc/clang retries remain for machines where
the probe finds nothing; with no compiler at all the failure is honest
("needs MSVC/MinGW gcc/clang on PATH").

Consequence for first-time setup: run `build-windows.bat full` (or
`fetch-deps.bat`) from a **VS developer prompt** (cl on PATH) or with
MinGW/clang on PATH. A plain cmd with no compiler on PATH cannot bootstrap
boost on this machine — this was masked before because the deps tree always
pre-existed, and the bash-era `bootstrap.sh` (MSYS) didn't go through cmd's
bare-name resolution.

Also fixed in the same pass: the retry chain called `bootstrap.bat gcc`
*bare* (would fail under the flag) — now `.\bootstrap.bat gcc`.

## Verification (2026-08-15, all from plain cmd)

- `fetch-deps.bat` — idempotent re-run: guards skip, gen headers rewritten, exit 0.
- `build.bat --shim-only` — shim headers regenerated, exit 0.
- `build.bat` (emsdk active) — 7 patches idempotent ("Already applied"),
  version header from submodule (`v2.2.0-5908-gb97ca3c0ac`), configure +
  ninja + stage, exit 0. (Full rebuild: emsdk sysroot cache regenerated once
  under the active install.)
- `build-windows.bat help` / `env` / `quick` — usage renders, emsdk
  auto-activation works, incremental ninja (2 steps) + staging.
- `build-windows.bat smoke` — run-slice.mjs: G-code OK (13234 lines);
  bridge-smoke.mjs: all assertions PASS.
- `build-windows.bat boost` — b2 wasm64 rebuild in progress (jam now points
  at C:\emsdk, so all 13 libs rebuild once; ~30-60 min). The b2 invocation
  itself is the same form that produced the existing working archives.
