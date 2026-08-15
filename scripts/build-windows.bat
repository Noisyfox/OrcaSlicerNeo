@echo off
REM ================================================================
REM build-windows.bat - Windows cmd driver for the local build loop
REM
REM Pure cmd - NO Git Bash required. Calls the cmd-native pipeline:
REM   packages\slicer-wasm\fetch-deps.bat        (deps / full)
REM   packages\slicer-wasm\build-boost-wasm64.bat (boost / full)
REM   packages\slicer-wasm\build.bat             (build / shim)
REM
REM Command surface (identical to scripts\build-windows.sh):
REM   build-windows.bat <command> [options]
REM     e.g.  build-windows.bat help
REM           build-windows.bat quick -j 8
REM           build-windows.bat full
REM
REM Commands: env deps boost build full quick shim smoke test dev
REM e2e help. Options: -j N, --jobs N, --profiles <dir>, --no-env, -v.
REM ================================================================
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%.") do set "SCRIPT_DIR=%%~fi"
set "ROOT=%SCRIPT_DIR%\.."
cd /d "%ROOT%"

set "PKG=%ROOT%\packages\slicer-wasm"
set "WORK=%PKG%\.work"
set "BUILD_DIR=%WORK%\build"
set "OUT_DIR=%PKG%\out"
set "BOOST_STAGE=%WORK%\deps\boost-1.84.0\stage-wasm64\lib"

set "JOBS="
set "PROFILES_DIR="
set "AUTO_ENV=1"

REM ---------------- arg parsing ----------------
set "CMD=%~1"
if not defined CMD set "CMD=help"
shift
:parse
if "%~1"=="" goto :parsed
if /i "%~1"=="-j"          (set "JOBS=%~2" & shift & shift & goto :parse)
if /i "%~1"=="--jobs"      (set "JOBS=%~2" & shift & shift & goto :parse)
if /i "%~1"=="--profiles"  (set "PROFILES_DIR=%~2" & shift & shift & goto :parse)
if /i "%~1"=="--no-env"    (set "AUTO_ENV=0" & shift & goto :parse)
if /i "%~1"=="-v"          (echo on & shift & goto :parse)
if /i "%~1"=="-h"          (call :usage & exit /b 0)
if /i "%~1"=="--help"      (call :usage & exit /b 0)
echo [winbuild] ERROR: Unknown option: %~1 ^(see --help^)
exit /b 1
:parsed

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
echo   build     Full packages\slicer-wasm\build.bat ^(patches submodule, shim,
echo             configure, ninja, stage to out\^). Requires boost archives;
echo             fetches deps automatically if missing.
echo   full      deps + boost + build - the complete cold-start path.
echo   quick     INCREMENTAL: ninja in .work\build + stage the 3 artifacts to
echo             out\. The fast loop for bridge/CMake changes - no configure,
echo             no patch re-apply, seconds-to-minutes.
echo   shim      Regenerate the TBB/boost::thread/libnoise/libjpeg shim headers
echo             ^(build.bat --shim-only^) after editing TBB_HEADERS in build.bat.
echo   smoke     Run both harnesses against out\: run-slice.mjs + bridge-smoke.mjs.
echo   test      vitest + typecheck for slicer-wasm and desktop.
echo   dev       Launch the Electron app in dev mode ^(pnpm --filter desktop dev^).
echo   e2e       Playwright Electron e2e ^(pnpm --filter desktop test:e2e^).
echo   help      This help.
echo.
echo Options:
echo   -j N, --jobs N   Parallelism for ninja / b2 ^(quick/build/boost^).
echo                    Default: ninja auto; BOOST_JOBS=4 as upstream.
echo   --profiles ^<dir^> WASM_PROFILES_DIR override for `build`/`full`
echo                    ^(a curated dir = lighter .data bundle; default is the
echo                    full profiles tree^).
echo   --no-env         Skip emsdk auto-activation ^(expect emcmake on PATH^).
echo   -v               echo on ^(print every command^).
exit /b 0

REM ---- locate an emsdk install (EMSDK env, then common locations) ----
:find_emsdk
set "EMSDK_DIR="
if defined EMSDK if exist "%EMSDK%\emsdk_env.bat" set "EMSDK_DIR=%EMSDK%"
if not defined EMSDK_DIR if exist "%USERPROFILE%\emsdk\emsdk_env.bat" set "EMSDK_DIR=%USERPROFILE%\emsdk"
if not defined EMSDK_DIR if exist "C:\emsdk\emsdk_env.bat" set "EMSDK_DIR=C:\emsdk"
if not defined EMSDK_DIR if exist "D:\emsdk\emsdk_env.bat" set "EMSDK_DIR=D:\emsdk"
if not defined EMSDK_DIR if exist "%USERPROFILE%\src\emsdk\emsdk_env.bat" set "EMSDK_DIR=%USERPROFILE%\src\emsdk"
if not defined EMSDK_DIR if exist "F:\emsdk\emsdk_env.bat" set "EMSDK_DIR=F:\emsdk"
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
  echo [winbuild] ERROR: Emscripten not found. Install emsdk and re-run, or set EMSDK.
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
  echo   call ^<emsdk-path^>\emsdk_env.bat   after installing emsdk
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
if defined PROFILES_DIR (
  echo [winbuild] WASM_PROFILES_DIR=%PROFILES_DIR% ^(lighter .data bundle^)
  set "WASM_PROFILES_DIR=%PROFILES_DIR%"
)
call "%PKG%\build.bat"
if errorlevel 1 exit /b 1
exit /b 0

:cmd_full
call :ensure_emsdk
if errorlevel 1 exit /b 1
call "%PKG%\fetch-deps.bat"
if errorlevel 1 exit /b 1
if defined JOBS (set "BOOST_JOBS=%JOBS%") else (set "BOOST_JOBS=4")
call "%PKG%\build-boost-wasm64.bat"
if errorlevel 1 exit /b 1
if defined PROFILES_DIR set "WASM_PROFILES_DIR=%PROFILES_DIR%"
call "%PKG%\build.bat"
if errorlevel 1 exit /b 1
exit /b 0

:cmd_quick
call :ensure_emsdk
if errorlevel 1 exit /b 1
if not exist "%BUILD_DIR%" (
  echo [winbuild] ERROR: No build tree at %BUILD_DIR% - run: build-windows.bat build
  exit /b 1
)
if defined JOBS (
  emmake ninja -C "%BUILD_DIR%" orca_slice -j %JOBS%
) else (
  emmake ninja -C "%BUILD_DIR%" orca_slice
)
if errorlevel 1 exit /b 1
for %%f in (orca_slice.js orca_slice.wasm orca_slice.data) do (
  if not exist "%BUILD_DIR%\%%f" (
    echo [winbuild] ERROR: Build did not produce %BUILD_DIR%\%%f
    exit /b 1
  )
  copy /y "%BUILD_DIR%\%%f" "%OUT_DIR%\" >nul
)
echo [winbuild] Staged to %OUT_DIR%:
dir "%OUT_DIR%"
exit /b 0

:cmd_shim
call "%PKG%\build.bat" --shim-only
exit /b %errorlevel%

:cmd_smoke
if not exist "%PKG%\out\orca_slice.js" (
  echo [winbuild] ERROR: Missing %PKG%\out\orca_slice.js - run: build-windows.bat build
  exit /b 1
)
if not exist "%PKG%\fixtures\cube.stl" (
  echo [winbuild] ERROR: Missing %PKG%\fixtures\cube.stl
  exit /b 1
)
if not exist "%PKG%\fixtures\config.json" (
  echo [winbuild] ERROR: Missing %PKG%\fixtures\config.json
  exit /b 1
)
pushd "%PKG%"
node harness\run-slice.mjs --module out\orca_slice.js --stl fixtures\cube.stl --config fixtures\config.json
if errorlevel 1 (popd & exit /b 1)
node harness\bridge-smoke.mjs out\orca_slice.js fixtures\cube.stl
set "RC=%errorlevel%"
popd
exit /b %RC%

:cmd_test
cd /d "%ROOT%"
pnpm --filter slicer-wasm test
if errorlevel 1 exit /b 1
pnpm --filter slicer-wasm typecheck
if errorlevel 1 exit /b 1
pnpm --filter desktop test
if errorlevel 1 exit /b 1
pnpm --filter desktop typecheck
if errorlevel 1 exit /b 1
echo [winbuild] All tests + typechecks green.
exit /b 0

:cmd_dev
cd /d "%ROOT%"
pnpm --filter desktop dev
exit /b %errorlevel%

:cmd_e2e
cd /d "%ROOT%"
pnpm --filter desktop test:e2e
exit /b %errorlevel%
