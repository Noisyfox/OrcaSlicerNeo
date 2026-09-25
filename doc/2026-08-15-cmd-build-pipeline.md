# 2026-08-15 — Pure-cmd build pipeline (.bat, no Git Bash)

## Why

Git Bash is broken on the dev machine (`bash --version` exits 255), so every
build script that needed MSYS was unreachable. Decision: duplicate the whole
pipeline as self-contained Windows cmd `.bat` files that work with zero bash
dependencies. The `.sh` originals stay for Linux/macOS/CI; on Windows the
`.bat` is the primary path. `scripts/build-windows.sh` — the bash driver for
the *Windows* loop only — was removed 2026-08-15 once the `.bat` port
covered every command; nothing outside Git Bash-on-Windows referenced it.
The driver's macOS/Linux twin is `scripts/build.sh` (plain bash, added
2026-08-15: same `env deps boost build full quick shim smoke test dev e2e
help` surface, emsdk auto-activation that first uses emcc/emcmake already on
PATH — e.g. Homebrew emscripten — before falling back to an emsdk install).

## What was ported

| File | Port of | Notes |
|---|---|---|
| `packages/slicer-wasm/fetch-deps.bat` | `fetch-deps.sh` | curl (PATH, else System32) + `tar.exe` (bsdtar handles zip/gz) + Boost's own `bootstrap.bat`/`.\b2.exe headers` |
| `packages/slicer-wasm/build-boost-wasm64.bat` | `build-boost-wasm64.sh` | b2 with `user-config-wasm.jam` (absolute em++/emar/emranlib paths from `where`) |
| `packages/slicer-wasm/build.bat` | `build.sh` | patches (idempotent `git apply`), serial shim headers, version header from submodule, `emcmake` configure, `emmake ninja`, stage 3 artifacts. Variant-aware since 2026-08-20: `WASM_THREADING`/`WASM_ARTIFACT_VARIANT` select `.work\<variant>` + `out\<variant>` (threaded also mirrors to `out\`) |
| `scripts/build-wasm-dual.bat` | `scripts/build-wasm-dual.sh` | both wasm64 variants (threaded + serial) back to back, then `node scripts\stage-wasm.mjs` stages them into `apps\desktop\src\renderer\public\wasm\<variant>` |
| `scripts/build-windows.bat` | `scripts/build-windows.sh` (rewritten, was a bash wrapper; the `.sh` itself removed 2026-08-15, replaced on macOS/Linux by `scripts/build.sh`) | `env deps boost build full quick shim smoke test dev e2e` + `-j/--variant/--no-env/-v`; auto-activates emsdk via `emsdk_env.bat`. `build`/`full` run the dual build; `quick`/`smoke` cover both variants unless `--variant` limits them |
| `.gitattributes` | new | `*.bat text eol=crlf` — cmd misparses LF-only batch files |

`build-windows.bat quick` is the incremental loop for bridge changes:
auto-activate emsdk → `emmake ninja -C .work\<variant>\build orca_slice` →
copy the 3 artifacts to `out\<variant>\` (threaded also to `out\`). Runs
both variants by default; `--variant threaded|serial` limits to one tree.

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
"C:\Users\<user>\.pyenv\..."` — **jam treats `\` as an escape in string
literals**, so b2 parsed the path as `C:Users\<user>\...` and its python
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

### 8. Bare `.cmd` invocation inside a `call :label` body — "cannot find the batch label"

A line inside a `call :label` subroutine that invokes another **batch file
bare** (e.g. `pnpm --filter desktop dev`, where `pnpm` resolves to
`pnpm.CMD`) kills the pending call frame: cmd hands the batch context to the
inner `.cmd`, and when it ends, the return to the `call :label` position
can no longer be resolved — cmd aborts with

    The system cannot find the batch label specified - cmd_dev

The failure is instant (0.1 s, nothing of the inner batch's output
appears) and hits *every* `call :label` whose body runs a batch file bare.
Repro chain (proved 2026-08-15): `build-windows.bat dev` → dispatch
`call :cmd_dev` → body `pnpm --filter desktop dev` → pnpm.CMD → error.
Swapping the first token for a non-batch (`x ...`) runs the body cleanly
(`'x' is not recognized`); running `pnpm --filter desktop dev` directly
(no outer batch) never shows the error. Root cause: `pnpm` is a `.CMD`
shim (`C:\Users\<user>\AppData\Local\pnpm\bin\pnpm.CMD`) — the classic
"invoke a batch from a batch without `call`" hand-over, made fatal by the
outer `call :label` frame.

Rule: **inside `call :label` subroutines, always prefix batch-file
invocations with `call`** (`call pnpm --filter desktop dev`). Fixed in all
three subroutines that run pnpm (`test`, `dev`, `e2e` — 6 lines total).
Verified: `dev` launches the electron app (preload built, vite dev server
up, app stays running); `test` runs all four pnpm suites green.

### 9. Editing a `.bat` while cmd is executing it corrupts the parse — garbage commands, phantom subroutine runs

cmd reads a batch file **lazily in chunks from a byte offset**, not
line-by-line from a held copy. If the file is truncated-and-rewritten
(a `Write`/editor save, or a line-ending normalization) while a cmd
process is mid-execution, the offset misaligns: the next read lands
mid-file, and cmd re-executes arbitrary lines. Observed 2026-08-20
while a 20-minute `build-windows.bat build` ran in the background and
the file was edited concurrently (unused vars removed + CRLF
re-normalized):

1. The in-flight `build` completed fine (both variants + staging).
2. On return, the driver's `exit /b %errorlevel%` misparsed →
   `'errorlevel' is not recognized`.
3. cmd then **re-executed the body of `:cmd_full` out of nowhere** —
   the log shows `fetch-deps.bat` → `build-boost-wasm64.bat` → a full
   second dual build, none of which the `build` command should run.
4. The second run's return collapsed into more garbage (`'f' is not
   recognized`, `The system cannot find the batch label specified -
   cmd_quick)`) and exit 1.

The file itself was fine — a re-run of the identical command with the
file untouched exited cleanly. Rule: **never modify a `.bat` (or
re-normalize its line endings) while a cmd process is executing it**,
including background driver runs; edit only between runs. The
misparse signature is distinctive — bare tokens as commands
(`'errorlevel'`, `'f'`), or a `call :label)` with a glued paren — and
should never be debugged as a file bug without first ruling out a
mid-run edit.

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
