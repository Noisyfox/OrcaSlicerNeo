@echo off
REM ================================================================
REM Build pinned oneTBB for wasm64 + pthreads, then link a runtime probe.
REM The source/stage live in .work\deps and are shared with the slicer build.
REM ================================================================
setlocal EnableExtensions

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
if defined WORK_DIR (set "WORK_DIR=%WORK_DIR%") else (set "WORK_DIR=%PKG_DIR%\.work")
if defined WASM_TBB_COMMIT (set "TBB_COMMIT=%WASM_TBB_COMMIT%") else (set "TBB_COMMIT=3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3")
if defined WASM_PTHREAD_POOL_SIZE (set "POOL_SIZE=%WASM_PTHREAD_POOL_SIZE%") else (set "POOL_SIZE=4")
if defined WASM_BUILD_JOBS (set "BUILD_JOBS=%WASM_BUILD_JOBS%") else (set "BUILD_JOBS=4")
set "TBB_SOURCE=%WORK_DIR%\deps\oneTBB-%TBB_COMMIT%"
set "TBB_BUILD=%WORK_DIR%\onetbb-build"
set "TBB_STAGE=%TBB_SOURCE%\stage-wasm64-pthreads"
set "OUT_DIR=%PKG_DIR%\out"

where emcmake >nul 2>nul
if errorlevel 1 (
  echo [onetbb] ERROR: activate emsdk first.
  exit /b 1
)
where em++ >nul 2>nul
if errorlevel 1 (
  echo [onetbb] ERROR: em++ not found.
  exit /b 1
)
if not exist "%TBB_SOURCE%\CMakeLists.txt" call "%PKG_DIR%\fetch-onetbb.bat"
if errorlevel 1 exit /b 1

echo [onetbb] Configuring %TBB_COMMIT% ^(wasm64 + pthreads^)
emcmake cmake -S "%TBB_SOURCE%" -B "%TBB_BUILD%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_CXX_FLAGS="-m64 -pthread" ^
  -DCMAKE_EXE_LINKER_FLAGS="-m64 -pthread" ^
  -DBUILD_SHARED_LIBS=OFF ^
  -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DTBB_STRICT=OFF ^
  -DTBBMALLOC_BUILD=ON -DTBBMALLOC_PROXY_BUILD=OFF ^
  -DTCM_BUILD=OFF ^
  -DTBB_DISABLE_HWLOC_AUTOMATIC_SEARCH=ON ^
  -DCMAKE_INSTALL_PREFIX="%TBB_STAGE%"
if errorlevel 1 exit /b 1
cmake --build "%TBB_BUILD%" --parallel %BUILD_JOBS%
if errorlevel 1 exit /b 1
cmake --install "%TBB_BUILD%"
if errorlevel 1 exit /b 1
if not exist "%TBB_STAGE%\lib\libtbb.a" (
  echo [onetbb] ERROR: missing %TBB_STAGE%\lib\libtbb.a
  exit /b 1
)
if not exist "%TBB_STAGE%\lib\libtbbmalloc.a" (
  echo [onetbb] ERROR: missing %TBB_STAGE%\lib\libtbbmalloc.a
  exit /b 1
)
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
echo [onetbb] Linking runtime proof ^(pthread pool: %POOL_SIZE%^)
em++ -O3 -m64 -pthread -I"%TBB_STAGE%\include" "%PKG_DIR%\harness\tbb-parallelism-probe.cpp" "%TBB_STAGE%\lib\libtbb.a" "%TBB_STAGE%\lib\libtbbmalloc.a" ^
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node ^
  -sPTHREAD_POOL_SIZE=%POOL_SIZE% -sALLOW_MEMORY_GROWTH=1 ^
  -sEXPORTED_RUNTIME_METHODS=callMain -sEXPORTED_FUNCTIONS=_main ^
  -o "%OUT_DIR%\orca_tbb_probe.js"
if errorlevel 1 exit /b 1
echo [onetbb] Run: node harness\run-tbb-parallelism-probe.mjs out\orca_tbb_probe.js
