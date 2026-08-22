@echo off
REM ================================================================
REM build-windows.bat - Windows cmd driver for the local build loop
REM
REM Pure cmd - NO Git Bash required. Calls the cmd-native pipeline:
REM   packages\slicer-wasm\fetch-deps.bat        (deps / full)
REM   packages\slicer-wasm\build-boost-wasm64.bat (boost / full)
REM   scripts\build-wasm-dual.bat               (build / full: both
REM     wasm64 variants - threaded + serial - via build.bat, then stage)
REM   packages\slicer-wasm\build.bat            (shim; variants)
REM
REM Command surface (macOS/Linux twin: scripts\build.sh — plain bash):
REM   build-windows.bat <command> [options]
REM     e.g.  build-windows.bat help
REM           build-windows.bat quick -j 8
REM           build-windows.bat full
REM
REM Commands: env deps boost build full quick shim smoke test dev
REM e2e help. Options: -j N, --jobs N, --no-env, --debug, -v.
REM ================================================================
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%.") do set "SCRIPT_DIR=%%~fi"
set "ROOT=%SCRIPT_DIR%\.."
cd /d "%ROOT%"

set "PKG=%ROOT%\packages\slicer-wasm"
set "WORK=%PKG%\.work"
REM Variant trees follow packages\slicer-wasm\build.bat: .work\<variant>\build,
REM out\<variant>. OUT_DIR is the legacy single-artifact location kept in sync
REM for the threaded variant.
set "OUT_DIR=%PKG%\out"
set "BOOST_STAGE=%WORK%\deps\boost-1.84.0\stage-wasm64\lib"

set "JOBS="
set "AUTO_ENV=1"
set "VARIANT="
set "DBG=0"

REM ---------------- arg parsing ----------------
set "CMD=%~1"
if not defined CMD set "CMD=help"
shift
:parse
if "%~1"=="" goto :parsed
if /i "%~1"=="-j"          (set "JOBS=%~2" & shift & shift & goto :parse)
if /i "%~1"=="--jobs"      (set "JOBS=%~2" & shift & shift & goto :parse)
if /i "%~1"=="--variant"   (set "VARIANT=%~2" & shift & shift & goto :parse)
if /i "%~1"=="--no-env"    (set "AUTO_ENV=0" & shift & goto :parse)
if /i "%~1"=="--debug"     (set "DBG=1" & shift & goto :parse)
if /i "%~1"=="-v"          (echo on & shift & goto :parse)
if /i "%~1"=="-h"          (call :usage & exit /b 0)
if /i "%~1"=="--help"      (call :usage & exit /b 0)
echo [winbuild] ERROR: Unknown option: %~1 ^(see --help^)
exit /b 1
:parsed

REM --variant default: both variants. threaded|serial|both may be named.
if not defined VARIANT set "VARIANT=both"
if /i not "%VARIANT%"=="threaded" if /i not "%VARIANT%"=="serial" if /i not "%VARIANT%"=="both" (
  echo [winbuild] ERROR: --variant must be threaded, serial or both ^(got %VARIANT%^).
  exit /b 1
)

REM ---------------- dispatch ----------------
set "KNOWN=0"
if /i "%CMD%"=="help"  (set "KNOWN=1" & call :usage)
if /i "%CMD%"=="env"   (set "KNOWN=1" & call :cmd_env)
if /i "%CMD%"=="deps"  (set "KNOWN=1" & call :cmd_deps)
if /i "%CMD%"=="boost" (set "KNOWN=1" & call :cmd_boost)
if /i "%CMD%"=="build" (set "KNOWN=1" & call :cmd_build)
if /i "%CMD%"=="full"  (set "KNOWN=1" & call :cmd_full)
if /i "%CMD%"=="quick" (set "KNOWN=1" & call :cmd_quick)
if /i "%CMD%"=="shim"  (set "KNOWN=1" & call :cmd_shim)
if /i "%CMD%"=="smoke" (set "KNOWN=1" & call :cmd_smoke)
if /i "%CMD%"=="test"  (set "KNOWN=1" & call :cmd_test)
if /i "%CMD%"=="dev"   (set "KNOWN=1" & call :cmd_dev)
if /i "%CMD%"=="e2e"   (set "KNOWN=1" & call :cmd_e2e)

if "%KNOWN%"=="0" (
  echo [winbuild] Unknown command: %CMD% ^(see help^)
  set "RC=1"
) else (
  set "RC=%errorlevel%"
)
if not "%RC%"=="0" (
  echo.
  echo [winbuild] Failed with exit code %RC% - see the output above.
  pause
)
exit /b %RC%

REM ================= subroutines =================

:usage
echo build-windows.bat ^<command^> [options]
echo.
echo Commands:
echo   env       Print the emsdk activation line for interactive shells
echo             ^(auto-activation below only affects this process^).
echo   deps      Fetch header-only deps ^(Eigen 5.0.1 / Boost 1.84 / cereal^)
echo             via fetch-deps.bat - idempotent.
echo   boost     Cross-compile Boost 1.84 wasm64 static archives
echo             ^(build-boost-wasm64.bat; requires `deps` first^). Long first run.
echo   build     Full dual-variant build via scripts\build-wasm-dual.bat:
echo             both wasm64 variants ^(threaded + serial^) + stage into
echo             the renderer. Requires boost archives; fetches deps
echo             automatically if missing.
echo   full      deps + boost + build - the complete cold-start path.
echo   quick     INCREMENTAL: ninja in .work\threaded\build and
echo             .work\serial\build + stage the 3 artifacts to out\^<variant^>.
echo             The fast loop for bridge/CMake changes - no configure,
echo             no patch re-apply, seconds-to-minutes. Use --variant to
echo             limit to one build tree.
echo   shim      Regenerate the TBB/boost::thread/libnoise/libjpeg shim headers
echo             ^(build.bat --shim-only^) after editing TBB_HEADERS in build.bat.
echo   smoke     Run both harnesses against out\threaded and out\serial:
echo             run-slice.mjs + bridge-smoke.mjs ^(--variant to limit^).
echo   test      vitest + typecheck for @orca/slicer-wasm and @orca/desktop.
echo   dev       Launch the Electron app in dev mode ^(pnpm --filter @orca/desktop dev^).
echo   e2e       Playwright Electron e2e ^(pnpm --filter @orca/desktop test:e2e^).
echo   help      This help.
echo.
echo Options:
echo   -j N, --jobs N   Parallelism for ninja / b2 ^(quick/build/boost^).
echo                    Default: ninja auto; BOOST_JOBS=4 as upstream.
echo   --variant threaded^|serial^|both
echo                    Build/verify one variant, or both ^(default: both^).
echo   --no-env         Skip emsdk auto-activation ^(expect emcmake on PATH^).
echo   --debug          Build with embedded DWARF: libslic3r + bridge at
echo                    -g -O0 ^(deps stay release -O3^). Applies at configure
echo                    time ^(build/full^); for quick the tree must have been
echo                    configured with it ^(checked, with a clear error^).
echo   -v               echo on ^(print every command^).
exit /b 0

REM ---- locate an emsdk install: EMSDK env var, else emsdk_env.bat on PATH ----
:find_emsdk
set "EMSDK_DIR="
if defined EMSDK if exist "%EMSDK%\emsdk_env.bat" set "EMSDK_DIR=%EMSDK%"
if not defined EMSDK_DIR (
  for /f "delims=" %%i in ('where emsdk_env 2^>nul') do if not defined EMSDK_DIR set "EMSDK_DIR=%%~dpi"
)
if defined EMSDK_DIR if "%EMSDK_DIR:~-1%"=="\" set "EMSDK_DIR=%EMSDK_DIR:~0,-1%"
exit /b 0

:ensure_emsdk
where emcmake >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('emcc --version 2^>nul') do if not defined EMCC_VER set "EMCC_VER=%%i"
  echo [winbuild] emcc: %EMCC_VER%
  exit /b 0
)
if "%AUTO_ENV%"=="0" (
  echo [winbuild] ERROR: emcmake not on PATH ^(--no-env only when emsdk is already active^).
  exit /b 1
)
call :find_emsdk
if not defined EMSDK_DIR (
  echo [winbuild] ERROR: Emscripten not found. Add emcc/emcmake to PATH, set EMSDK to an emsdk install, or add emsdk_env.bat to PATH.
  exit /b 1
)
echo [winbuild] Activating emsdk at %EMSDK_DIR%
call "%EMSDK_DIR%\emsdk_env.bat"
if errorlevel 1 (
  echo [winbuild] ERROR: emsdk_env.bat failed.
  exit /b 1
)
where emcmake >nul 2>nul
if errorlevel 1 (
  echo [winbuild] ERROR: emsdk_env.bat ran but emcmake still missing.
  exit /b 1
)
for /f "delims=" %%i in ('emcc --version 2^>nul') do if not defined EMCC_VER set "EMCC_VER=%%i"
echo [winbuild] emcc: %EMCC_VER%
exit /b 0

:cmd_env
where emcmake >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('emcc --version 2^>nul') do if not defined EMCC_VER set "EMCC_VER=%%i"
  echo emsdk already active: emcc %EMCC_VER%
  exit /b 0
)
echo emsdk NOT active. In cmd / PowerShell, run:
call :find_emsdk
if defined EMSDK_DIR (
  echo   call "%EMSDK_DIR%\emsdk_env.bat"
  echo ^(found at %EMSDK_DIR% - the other commands auto-activate it^)
) else (
  echo   set "EMSDK=<path-to-emsdk>"   then re-run ^(the commands auto-activate it^)
  echo   or add emcc/emcmake to PATH ^(e.g. call ^<emsdk^>\emsdk_env.bat^)
)
exit /b 0

:cmd_deps
call "%PKG%\fetch-deps.bat"
exit /b %errorlevel%

:cmd_boost
call :ensure_emsdk
if errorlevel 1 exit /b 1
if not exist "%WORK%\deps\boost-1.84.0" (
  echo [winbuild] ERROR: Boost source not staged - run: build-windows.bat deps
  exit /b 1
)
echo [winbuild] Building Boost 1.84 wasm64 archives (BOOST_JOBS=%JOBS%)
if defined JOBS (set "BOOST_JOBS=%JOBS%") else (set "BOOST_JOBS=4")
call "%PKG%\build-boost-wasm64.bat"
if errorlevel 1 exit /b 1
echo [winbuild] Boost archives in %WORK%\deps\boost-1.84.0\stage-wasm64\lib
exit /b 0

:cmd_build
call :ensure_emsdk
if errorlevel 1 exit /b 1
if not exist "%BOOST_STAGE%" (
  echo [winbuild] ERROR: Boost wasm64 archives missing ^(%BOOST_STAGE%^) - run: build-windows.bat boost
  exit /b 1
)
if "%DBG%"=="1" call "%SCRIPT_DIR%\build-wasm-dual.bat" --debug
if not "%DBG%"=="1" call "%SCRIPT_DIR%\build-wasm-dual.bat"
exit /b %errorlevel%

:cmd_full
call :ensure_emsdk
if errorlevel 1 exit /b 1
call "%PKG%\fetch-deps.bat"
if errorlevel 1 exit /b 1
if defined JOBS (set "BOOST_JOBS=%JOBS%") else (set "BOOST_JOBS=4")
call "%PKG%\build-boost-wasm64.bat"
if errorlevel 1 exit /b 1
if "%DBG%"=="1" call "%SCRIPT_DIR%\build-wasm-dual.bat" --debug
if not "%DBG%"=="1" call "%SCRIPT_DIR%\build-wasm-dual.bat"
exit /b %errorlevel%

:cmd_quick
call :ensure_emsdk
if errorlevel 1 exit /b 1
if /i "%VARIANT%"=="threaded" (
  call :quick_variant threaded
  exit /b
)
if /i "%VARIANT%"=="serial" (
  call :quick_variant serial
  exit /b
)
call :quick_variant threaded
if errorlevel 1 exit /b 1
call :quick_variant serial
exit /b

:cmd_shim
call "%PKG%\build.bat" --shim-only
exit /b %errorlevel%

:cmd_smoke
if not exist "%PKG%\fixtures\cube.stl" (
  echo [winbuild] ERROR: Missing %PKG%\fixtures\cube.stl
  exit /b 1
)
if not exist "%PKG%\fixtures\config.json" (
  echo [winbuild] ERROR: Missing %PKG%\fixtures\config.json
  exit /b 1
)
if /i "%VARIANT%"=="threaded" (
  call :smoke_variant threaded
  exit /b
)
if /i "%VARIANT%"=="serial" (
  call :smoke_variant serial
  exit /b
)
call :smoke_variant threaded
if errorlevel 1 exit /b 1
call :smoke_variant serial
exit /b

REM ---- incremental ninja + stage for ONE variant (%1 = threaded|serial) ----
:quick_variant
set "QV=%~1"
set "QBUILD=%WORK%\%QV%\build"
set "QOUT=%PKG%\out\%QV%"
if not exist "%QBUILD%" (
  echo [winbuild] ERROR: No build tree at %QBUILD% - run: build-windows.bat build
  exit /b 1
)
REM --debug is a configure-time decision: quick only re-runs ninja, so
REM verify the tree was actually configured with WASM_DEBUG rather than
REM silently staging a release module.
if "%DBG%"=="1" (
  findstr /C:"WASM_DEBUG:BOOL=ON" "%QBUILD%\CMakeCache.txt" >nul 2>nul
  if errorlevel 1 (
    echo [winbuild] ERROR: Build tree %QBUILD% was configured without WASM_DEBUG - run: build-windows.bat build --debug
    exit /b 1
  )
)
if defined JOBS (
  emmake ninja -C "%QBUILD%" orca_slice -j %JOBS%
) else (
  emmake ninja -C "%QBUILD%" orca_slice
)
if errorlevel 1 exit /b 1
for %%f in (orca_slice.js orca_slice.wasm orca_slice.data) do (
  if not exist "%QBUILD%\%%f" (
    echo [winbuild] ERROR: Build did not produce %QBUILD%\%%f
    exit /b 1
  )
  copy /y "%QBUILD%\%%f" "%QOUT%\" >nul
)
REM The threaded variant keeps the historical single-artifact location for
REM existing Node smoke and Electron scripts; the dual entry point and Web
REM host consume the explicit variant directories.
if /i "%QV%"=="threaded" (
  if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
  for %%f in (orca_slice.js orca_slice.wasm orca_slice.data) do copy /y "%QOUT%\%%f" "%OUT_DIR%\" >nul
)
echo [winbuild] Staged %QV% to %QOUT%:
dir "%QOUT%"
exit /b 0

REM ---- harnesses against ONE variant (%1 = threaded|serial) ----
:smoke_variant
set "SV=%~1"
if not exist "%PKG%\out\%SV%\orca_slice.js" (
  echo [winbuild] ERROR: Missing %PKG%\out\%SV%\orca_slice.js - run: build-windows.bat build
  exit /b 1
)
pushd "%PKG%"
node harness\run-slice.mjs --module out\%SV%\orca_slice.js --stl fixtures\cube.stl --config fixtures\config.json
if errorlevel 1 (popd & exit /b 1)
node harness\bridge-smoke.mjs out\%SV%\orca_slice.js fixtures\cube.stl
set "RC=%errorlevel%"
popd
exit /b %RC%

:cmd_test
cd /d "%ROOT%"
call pnpm --filter @orca/slicer-wasm test
if errorlevel 1 exit /b 1
call pnpm --filter @orca/slicer-wasm typecheck
if errorlevel 1 exit /b 1
call pnpm --filter @orca/desktop test
if errorlevel 1 exit /b 1
call pnpm --filter @orca/desktop typecheck
if errorlevel 1 exit /b 1
echo [winbuild] All tests + typechecks green.
exit /b 0

:cmd_dev
cd /d "%ROOT%"
call pnpm --filter @orca/desktop dev
exit /b %errorlevel%

:cmd_e2e
cd /d "%ROOT%"
call pnpm --filter @orca/desktop test:e2e
exit /b %errorlevel%
