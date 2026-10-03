@echo off
REM Build the complete NLopt static library for one wasm64 variant.
setlocal EnableExtensions

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
if defined WORK_DIR (set "WORK_DIR=%WORK_DIR%") else (set "WORK_DIR=%PKG_DIR%\.work")
set "NLOPT_VER=2.5.0"
if defined WASM_THREADING (set "WASM_THREADING=%WASM_THREADING%") else (set "WASM_THREADING=1")
if defined WASM_ARTIFACT_VARIANT (set "ARTIFACT_VARIANT=%WASM_ARTIFACT_VARIANT%") else if "%WASM_THREADING%"=="0" (set "ARTIFACT_VARIANT=serial") else (set "ARTIFACT_VARIANT=threaded")
if defined WASM_BUILD_JOBS (set "BUILD_JOBS=%WASM_BUILD_JOBS%") else (set "BUILD_JOBS=4")
set "NLOPT_SOURCE=%WORK_DIR%\deps\nlopt-%NLOPT_VER%"
set "NLOPT_BUILD=%WORK_DIR%\nlopt-build-%ARTIFACT_VARIANT%"
if not defined NLOPT_ROOT set "NLOPT_ROOT=%NLOPT_SOURCE%\stage-wasm64-%ARTIFACT_VARIANT%"
set "NLOPT_STAGE=%NLOPT_ROOT%"
set "NLOPT_FLAGS=-m64 -fexceptions"
if not "%WASM_THREADING%"=="0" set "NLOPT_FLAGS=-m64 -fexceptions -pthread"

where emcmake >nul 2>nul
if errorlevel 1 (
  echo [nlopt] ERROR: activate emsdk first.
  exit /b 1
)
if not defined EMSCRIPTEN if defined EMSDK set "EMSCRIPTEN=%EMSDK%\upstream\emscripten"
if not defined EMSCRIPTEN (
  echo [nlopt] ERROR: EMSCRIPTEN must name the Emscripten directory.
  exit /b 1
)
if not exist "%NLOPT_SOURCE%\CMakeLists.txt" call "%PKG_DIR%\fetch-deps.bat"
if errorlevel 1 exit /b 1

echo [nlopt] Configuring %NLOPT_VER% ^(%ARTIFACT_VARIANT% wasm64^)
emcmake cmake -S "%NLOPT_SOURCE%" -B "%NLOPT_BUILD%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_C_FLAGS="%NLOPT_FLAGS%" ^
  -DCMAKE_CXX_FLAGS="%NLOPT_FLAGS%" ^
  -DCMAKE_EXE_LINKER_FLAGS="%NLOPT_FLAGS%" ^
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 ^
  -DBUILD_SHARED_LIBS=OFF ^
  -DNLOPT_CXX=OFF ^
  -DNLOPT_PYTHON=OFF ^
  -DNLOPT_OCTAVE=OFF ^
  -DNLOPT_MATLAB=OFF ^
  -DNLOPT_GUILE=OFF ^
  -DNLOPT_SWIG=OFF
if errorlevel 1 exit /b 1
cmake --build "%NLOPT_BUILD%" --target nlopt --parallel %BUILD_JOBS%
if errorlevel 1 exit /b 1
if not exist "%NLOPT_BUILD%\libnlopt.a" (
  echo [nlopt] ERROR: missing %NLOPT_BUILD%\libnlopt.a
  exit /b 1
)
for %%H in (nlopt.h nlopt.hpp) do (
  if not exist "%NLOPT_BUILD%\src\api\%%H" (
    echo [nlopt] ERROR: missing generated header %%H
    exit /b 1
  )
)
if not exist "%NLOPT_STAGE%\include" mkdir "%NLOPT_STAGE%\include"
if not exist "%NLOPT_STAGE%\lib" mkdir "%NLOPT_STAGE%\lib"
for %%H in (nlopt.h nlopt.hpp) do (
  copy /y "%NLOPT_BUILD%\src\api\%%H" "%NLOPT_STAGE%\include\%%H" >nul
  if errorlevel 1 exit /b 1
)
copy /y "%NLOPT_BUILD%\libnlopt.a" "%NLOPT_STAGE%\lib\libnlopt.a" >nul
if errorlevel 1 exit /b 1
echo [nlopt] Staged %NLOPT_STAGE%\lib\libnlopt.a
