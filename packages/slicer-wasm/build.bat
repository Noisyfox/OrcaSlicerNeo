@echo off
REM ================================================================
REM build.bat - Windows cmd port of build.sh
REM
REM Builds the pinned C++ submodule (packages\slicer-wasm\cpp) into a
REM single Emscripten module: real oneTBB pthread runtime, scaffold CMake, bridge
REM + CLI driver. patches\*.patch are git-applied to the submodule
REM working tree here, at build time - the submodule itself stays
REM pristine (read-only, pinned SHA). No Git Bash required - pure cmd:
REM emsdk_env.bat activation, emcmake/emmake .exe launchers, Windows
REM git/cmake/ninja/tar.
REM
REM NOT push-button - the WASM build is an iteration surface. Re-run
REM after each fix; steps are idempotent. See AGENTS.md "WASM Build
REM Workflow" for the TBB_HEADERS / DROP_PATTERNS / stubs / API-drift
REM fix loops.
REM
REM Usage:
REM   build.bat                full run (deps + configure + build)
REM   build.bat --shim-only    just (re)generate the TBB shim headers
REM ================================================================
setlocal

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
if defined WORK_DIR (set "WORK_DIR=%WORK_DIR%") else (set "WORK_DIR=%PKG_DIR%\.work")
set "ORCA_SRC=%PKG_DIR%\cpp"
set "SHIM_INCLUDE=%WORK_DIR%\shim-include"
set "GEN_INCLUDE=%WORK_DIR%\gen"
set "BUILD_DIR=%WORK_DIR%\build"
set "OUT_DIR=%PKG_DIR%\out"
if not defined WASM_THREADING set "WASM_THREADING=1"
REM Nested Chromium workers use every core on smaller machines, up to the
REM verified four-worker budget; callers may override it for profiling.
if not defined WASM_PTHREAD_POOL_SIZE set "WASM_PTHREAD_POOL_SIZE=Math.min(4,navigator.hardwareConcurrency)"
if not defined WASM_TBB_MAX_CONCURRENCY set "WASM_TBB_MAX_CONCURRENCY=4"
if not defined WASM_TBB_COMMIT set "WASM_TBB_COMMIT=3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3"
set "TBB_ROOT=%WORK_DIR%\deps\oneTBB-%WASM_TBB_COMMIT%\stage-wasm64-pthreads"

REM Header-only / Emscripten-built dependency include dirs (fetch-deps.bat,
REM build-boost-wasm64.bat). Overridable for CI.
if defined EIGEN_INCLUDE (set "EIGEN_INCLUDE=%EIGEN_INCLUDE%") else (set "EIGEN_INCLUDE=%WORK_DIR%\deps\eigen-5.0.1")
if defined BOOST_INCLUDE (set "BOOST_INCLUDE=%BOOST_INCLUDE%") else (set "BOOST_INCLUDE=%WORK_DIR%\deps\boost-1.84.0")
if defined CEREAL_INCLUDE (set "CEREAL_INCLUDE=%CEREAL_INCLUDE%") else (set "CEREAL_INCLUDE=%WORK_DIR%\deps\cereal-1.3.0\include")

REM ---------------- TBB shim header generation ----------------
REM Every <tbb/NAME.h> libslic3r may include forwards to shim\_serial.hpp. Add
REM names here as compile errors reveal more includes.
set "TBB_HEADERS=tbb parallel_for parallel_for_each parallel_reduce parallel_sort parallel_invoke blocked_range blocked_range2d enumerable_thread_specific combinable spin_mutex mutex spin_rw_mutex queuing_mutex task_group task_arena global_control task_scheduler_init concurrent_vector tick_count scalable_allocator cache_aligned_allocator tbb_allocator partitioner version concurrent_unordered_map concurrent_unordered_set concurrent_map concurrent_queue parallel_pipeline"

if "%~1"=="--shim-only" goto :shim_only

REM ---------------- Prerequisite checks ----------------
where git >nul 2>nul
if errorlevel 1 (
  echo [wasm] ERROR: git not found.
  exit /b 1
)
where cmake >nul 2>nul
if errorlevel 1 (
  echo [wasm] ERROR: cmake not found.
  exit /b 1
)
where ninja >nul 2>nul
if errorlevel 1 (
  echo [wasm] ERROR: ninja not found.
  exit /b 1
)
where emcmake >nul 2>nul
if errorlevel 1 (
  echo [wasm] ERROR: Emscripten not on PATH. Install emsdk and run:
  echo   call ^<emsdk^>\emsdk_env.bat
  echo then re-run.
  exit /b 1
)
for /f "delims=" %%i in ('emcc --version 2^>nul') do if not defined EMCC_VER set "EMCC_VER=%%i"
echo [wasm] %EMCC_VER%

REM ---------------- Patch the submodule (build-time, idempotent) ----------------
REM The pinned submodule is pristine; every packages\slicer-wasm\patches\*.patch
REM is git-applied to its working tree here. Already-applied runs are skipped;
REM a patch that neither applies nor is applied is a hard error.
for %%p in ("%PKG_DIR%\patches\*.patch") do (
  if exist "%%p" (
    git -C "%ORCA_SRC%" apply --check "%%p" >nul 2>nul
    if not errorlevel 1 (
      git -C "%ORCA_SRC%" apply "%%p"
      if errorlevel 1 (
        echo [wasm] ERROR: git apply failed for %%~nxp.
        exit /b 1
      )
      echo [wasm] Applied %%~nxp
    ) else (
      git -C "%ORCA_SRC%" apply --reverse --check "%%p" >nul 2>nul
      if not errorlevel 1 (
        echo [wasm] Already applied: %%~nxp
      ) else (
        echo [wasm] ERROR: Patch %%~nxp neither applies cleanly nor is already applied - submodule at %ORCA_SRC% needs review.
        exit /b 1
      )
    )
  )
)

if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if not exist "%GEN_INCLUDE%" mkdir "%GEN_INCLUDE%"

:shim_only
REM ---------------- Serial TBB shim (also the --shim-only path) ----------------
echo [wasm] Generating serial TBB shim headers in %SHIM_INCLUDE%\tbb
if not exist "%SHIM_INCLUDE%\tbb" mkdir "%SHIM_INCLUDE%\tbb"
if not exist "%SHIM_INCLUDE%\oneapi\tbb" mkdir "%SHIM_INCLUDE%\oneapi\tbb"
REM Copy the serial header next to the forwarding headers so they can include
REM it by bare relative name - native cmd paths resolve everywhere, unlike the
REM MSYS absolute paths that broke every TU under the Windows clang driver.
copy /y "%PKG_DIR%\shim\_serial.hpp" "%SHIM_INCLUDE%\_serial.hpp" >nul
for %%n in (%TBB_HEADERS%) do (
  > "%SHIM_INCLUDE%\tbb\%%n.h" echo #pragma once
  >> "%SHIM_INCLUDE%\tbb\%%n.h" echo #include "_serial.hpp"
  > "%SHIM_INCLUDE%\oneapi\tbb\%%n.h" echo #pragma once
  >> "%SHIM_INCLUDE%\oneapi\tbb\%%n.h" echo #include "_serial.hpp"
)
> "%SHIM_INCLUDE%\tbb\tbb.h" echo #pragma once
>> "%SHIM_INCLUDE%\tbb\tbb.h" echo #include "_serial.hpp"
> "%SHIM_INCLUDE%\oneapi\tbb.h" echo #pragma once
>> "%SHIM_INCLUDE%\oneapi\tbb.h" echo #include "_serial.hpp"
REM Serial boost::thread stand-in (Boost.Thread has no Emscripten backend).
REM libslic3r references it from dead-but-compiled code. Same forwarding
REM pattern as the TBB shim.
if not exist "%SHIM_INCLUDE%\boost\thread" mkdir "%SHIM_INCLUDE%\boost\thread"
copy /y "%PKG_DIR%\shim\boost-thread.hpp" "%SHIM_INCLUDE%\boost-thread.hpp" >nul
> "%SHIM_INCLUDE%\boost\thread.hpp" echo #pragma once
>> "%SHIM_INCLUDE%\boost\thread.hpp" echo #include "../boost-thread.hpp"
> "%SHIM_INCLUDE%\boost\thread\mutex.hpp" echo #pragma once
>> "%SHIM_INCLUDE%\boost\thread\mutex.hpp" echo #include "../../boost-thread.hpp"
> "%SHIM_INCLUDE%\boost\thread\lock_guard.hpp" echo #pragma once
>> "%SHIM_INCLUDE%\boost\thread\lock_guard.hpp" echo #include "../../boost-thread.hpp"
REM libnoise stand-in (FuzzySkin.cpp includes <libnoise/noise.h>).
if not exist "%SHIM_INCLUDE%\libnoise" mkdir "%SHIM_INCLUDE%\libnoise"
copy /y "%PKG_DIR%\shim\libnoise\noise.h" "%SHIM_INCLUDE%\libnoise\noise.h" >nul
REM libjpeg stand-in (GCode/Thumbnails.cpp includes <jpeglib.h>/<jerror.h>;
REM stubs\jpeg-stub.cpp provides the no-op implementations).
copy /y "%PKG_DIR%\shim\jpeglib.h" "%SHIM_INCLUDE%\jpeglib.h" >nul
copy /y "%PKG_DIR%\shim\jerror.h" "%SHIM_INCLUDE%\jerror.h" >nul
echo [wasm] Shim headers written (TBB + boost::thread + libnoise + libjpeg).

if "%~1"=="--shim-only" exit /b 0

REM ---------------- Dependency staging ----------------
if not exist "%BOOST_INCLUDE%\boost" (
  echo [wasm] Running fetch-deps.bat (Eigen/Boost/cereal + generated headers)
  call "%PKG_DIR%\fetch-deps.bat"
  if errorlevel 1 (
    echo [wasm] ERROR: fetch-deps.bat failed.
    exit /b 1
  )
)
if not "%WASM_THREADING%"=="0" if not exist "%TBB_ROOT%\lib\libtbb.a" (
  echo [wasm] Building pinned oneTBB ^(wasm64 + pthreads^)
  call "%PKG_DIR%\build-onetbb.bat"
  if errorlevel 1 exit /b 1
)

REM ---------------- Version header (fork-derived) ----------------
REM Replaces the static stub: version + commit hash come from the pinned
REM submodule so G-code/3MF metadata matches the actual source.
set "VER=0.0.0"
set "GITHASH=0000000"
for /f "delims=" %%v in ('git -C "%ORCA_SRC%" describe --tags --always 2^>nul') do set "VER=%%v"
for /f "delims=" %%h in ('git -C "%ORCA_SRC%" rev-parse --short HEAD 2^>nul') do set "GITHASH=%%h"
> "%GEN_INCLUDE%\libslic3r_version.h" echo #ifndef __SLIC3R_VERSION_H
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define __SLIC3R_VERSION_H
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define SLIC3R_APP_NAME "OrcaSlicer"
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define SLIC3R_APP_KEY "OrcaSlicer"
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define SLIC3R_VERSION "%VER%"
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define SoftFever_VERSION "%VER%"
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define GIT_COMMIT_HASH "%GITHASH%"
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define SLIC3R_BUILD_ID "OrcaSlicer-%VER%-wasm"
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define BBL_INTERNAL_TESTING 0
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #define ORCA_CHECK_GCODE_PLACEHOLDERS 0
>> "%GEN_INCLUDE%\libslic3r_version.h" echo #endif
echo [wasm] Wrote %GEN_INCLUDE%\libslic3r_version.h ^(SLIC3R_VERSION=%VER%^)

REM ---------------- Full preset bundle (for orc_init) ----------------
REM The full resources\profiles tree via --preload-file, mounted at /system.
REM Override WASM_PROFILES_DIR for a lighter local build (e.g. a curated
REM dir); CI and packaging always use the full tree.
if not defined WASM_PROFILES_DIR set "WASM_PROFILES_DIR=%ORCA_SRC%\resources\profiles"
set "INFO_DIR=%ORCA_SRC%\resources\info"
echo [wasm] Preset bundle: %WASM_PROFILES_DIR%
REM file_packager runs as a native exe and needs forward-slash native paths.
REM In cmd there is no MSYS ';' mangling to work around - just normalize
REM backslashes so the CMake cache matches a Git Bash-configured tree too.
set "PRELOAD_P=%WASM_PROFILES_DIR:\=/%"
set "PRELOAD_I=%INFO_DIR:\=/%"
set "PRELOAD_FILES=%PRELOAD_P%@/system;%PRELOAD_I%@/info"
set "ORCA_SRC_CM=%ORCA_SRC:\=/%"
set "SHIM_CM=%SHIM_INCLUDE:\=/%"
set "GEN_CM=%GEN_INCLUDE:\=/%"
set "EIGEN_CM=%EIGEN_INCLUDE:\=/%"
set "BOOST_CM=%BOOST_INCLUDE:\=/%"
set "CEREAL_CM=%CEREAL_INCLUDE:\=/%"
set "TBB_CM=%TBB_ROOT:\=/%"

REM ---------------- Configure + build ----------------
echo [wasm] Configuring stripped libslic3r + bridge + CLI (emcmake)
emcmake cmake -S "%PKG_DIR%" -B "%BUILD_DIR%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DORCA_SRC="%ORCA_SRC_CM%" ^
  -DSHIM_INCLUDE="%SHIM_CM%" ^
  -DGEN_INCLUDE="%GEN_CM%" ^
  -DEIGEN_INCLUDE="%EIGEN_CM%" ^
  -DBOOST_INCLUDE="%BOOST_CM%" ^
  -DCEREAL_INCLUDE="%CEREAL_CM%" ^
  -DWASM_THREADING=%WASM_THREADING% ^
  -DWASM_PTHREAD_POOL_SIZE=%WASM_PTHREAD_POOL_SIZE% ^
  -DWASM_TBB_MAX_CONCURRENCY=%WASM_TBB_MAX_CONCURRENCY% ^
  -DTBB_ROOT="%TBB_CM%" ^
  -DPRELOAD_FILES="%PRELOAD_FILES%"
if errorlevel 1 (
  echo [wasm] ERROR: CMake configure failed. Fix include paths / missing deps and re-run.
  exit /b 1
)

echo [wasm] Building (emmake ninja) - expect to iterate on compile errors
emmake ninja -C "%BUILD_DIR%" orca_slice
if errorlevel 1 (
  echo [wasm] ERROR: Build failed. Common next steps:
  echo   - Missing ^<tbb/X.h^>: add X to TBB_HEADERS in build.bat and re-run.
  echo   - Undefined symbol from an excluded file ^(SLA/CGAL/OCCT^): add a stub in
  echo     stubs\ or exclude its caller via DROP_PATTERNS in CMakeLists.txt.
  echo   - Boost/Eigen not found: fix *_INCLUDE paths ^(run fetch-deps.bat first^).
  exit /b 1
)

REM ---------------- Collect artifacts ----------------
REM Fail loudly: a missing artifact is a build defect, not a warning. The .data
REM is the --preload-file bundle (full profiles tree) - emcc emits it at link
REM time, so absence here means the link step regressed.
for %%f in (orca_slice.js orca_slice.wasm orca_slice.data) do (
  if not exist "%BUILD_DIR%\%%f" (
    echo [wasm] ERROR: Build did not produce %BUILD_DIR%\%%f - check the link step above.
    exit /b 1
  )
  copy /y "%BUILD_DIR%\%%f" "%OUT_DIR%\" >nul
)
dir "%OUT_DIR%"
echo [wasm] Done. Artifacts in %OUT_DIR%\
echo [wasm] Smoke test: node harness\run-slice.mjs --module out\orca_slice.js --stl fixtures\cube.stl --config fixtures\config.json
exit /b 0
