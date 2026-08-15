@echo off
REM ================================================================
REM build-boost-wasm64.bat - Windows cmd port of build-boost-wasm64.sh
REM
REM Cross-compiles the compiled Boost 1.84 components libslic3r links,
REM as wasm64 static archives, using b2 with an Emscripten toolset.
REM All 12 libs build clean (system, filesystem, thread, atomic,
REM chrono, date_time, iostreams, log, log_setup, locale,
REM program_options, regex, nowide).
REM
REM Prereqs: fetch-deps.bat has run (Boost extracted + `b2 headers`
REM assembled, which also produced b2.exe) and emsdk is active
REM (call ^<emsdk^>\emsdk_env.bat, or run scripts\build-windows.bat).
REM
REM b2 on Windows cannot resolve the bare 'em++' toolset name: its
REM check-tool GLOB misses the emsdk launchers, so the toolset init
REM dies with "provided command 'em++' not found". Pass absolute
REM Windows-style forward-slash paths instead (the path.exists branch
REM of check-tool). The .sh original got these via command -v + cygpath
REM -m; here `where` already yields native paths, and %VAR:\=/% converts
REM backslashes to forward slashes for the jam file.
REM ================================================================
setlocal

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
set "BD=%PKG_DIR%\.work\deps\boost-1.84.0"

if not defined BOOST_JOBS set "BOOST_JOBS=4"

if not exist "%BD%" (
  echo Run fetch-deps.bat first ^(no %BD%^)
  exit /b 1
)

REM ---- resolve em++/emar/emranlib (prefer the .exe launchers) ----
set "EMXX="
set "EMAR="
set "EMRANLIB="
for /f "delims=" %%i in ('where em++.exe 2^>nul') do if not defined EMXX set "EMXX=%%i"
if not defined EMXX for /f "delims=" %%i in ('where em++ 2^>nul') do if not defined EMXX set "EMXX=%%i"
for /f "delims=" %%i in ('where emar.exe 2^>nul') do if not defined EMAR set "EMAR=%%i"
if not defined EMAR for /f "delims=" %%i in ('where emar 2^>nul') do if not defined EMAR set "EMAR=%%i"
for /f "delims=" %%i in ('where emranlib.exe 2^>nul') do if not defined EMRANLIB set "EMRANLIB=%%i"
if not defined EMRANLIB for /f "delims=" %%i in ('where emranlib 2^>nul') do if not defined EMRANLIB set "EMRANLIB=%%i"

if not defined EMXX (
  echo Activate emsdk first ^(call ^<emsdk^>\emsdk_env.bat^)
  exit /b 1
)
if not defined EMAR (
  echo Activate emsdk first ^(emar missing^)
  exit /b 1
)
if not defined EMRANLIB (
  echo Activate emsdk first ^(emranlib missing^)
  exit /b 1
)

REM ---- jam toolset config (forward slashes, quoted) ----
set "EMXX=%EMXX:\=/%"
set "EMAR=%EMAR:\=/%"
set "EMRANLIB=%EMRANLIB:\=/%"
> "%BD%\user-config-wasm.jam" echo using clang : emscripten : "%EMXX%" : ^<archiver^>"%EMAR%" ^<ranlib^>"%EMRANLIB%" ;

REM locale uses the std backend (no ICU/iconv on wasm). runtime-link=static keeps
REM everything self-contained. MEMORY64 must match the libslic3r object build.
REM target-os=linux: b2 infers the TARGET os from the HOST - on Windows that
REM means threadapi=win32 + -DBOOST_USE_WINDOWS_H, which cannot compile under
REM the emscripten toolset (no windows.h/process.h). wasm64 is a POSIX target
REM (emscripten pthreads), so force the POSIX profile explicitly.
pushd "%BD%"
.\b2.exe -q --user-config=user-config-wasm.jam toolset=clang-emscripten ^
  --with-system --with-filesystem --with-thread --with-atomic --with-chrono ^
  --with-date_time --with-iostreams --with-log --with-locale ^
  --with-program_options --with-regex --with-nowide ^
  boost.locale.icu=off boost.locale.iconv=off boost.locale.posix=off boost.locale.std=on ^
  address-model=64 target-os=linux ^
  link=static threading=multi runtime-link=static variant=release ^
  cxxflags="-sMEMORY64 -pthread -std=c++17 -Wno-unused -Wno-deprecated-declarations" ^
  cflags="-sMEMORY64 -pthread" ^
  --stagedir=stage-wasm64 -j%BOOST_JOBS% stage
if errorlevel 1 (
  echo [boost-wasm64] ERROR: b2 stage failed - see the output above.
  popd
  exit /b 1
)
popd

echo === wasm64 Boost archives in %BD%\stage-wasm64\lib ===
dir /b "%BD%\stage-wasm64\lib\*.a"
exit /b 0
