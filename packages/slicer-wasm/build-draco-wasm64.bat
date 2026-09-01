@echo off
REM Build the complete Google Draco C++ static library for one wasm64 variant.
setlocal EnableExtensions

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
if defined WORK_DIR (set "WORK_DIR=%WORK_DIR%") else (set "WORK_DIR=%PKG_DIR%\.work")
if defined DRACO_VER (set "DRACO_VER=%DRACO_VER%") else (set "DRACO_VER=1.5.7")
if defined WASM_THREADING (set "WASM_THREADING=%WASM_THREADING%") else (set "WASM_THREADING=1")
if defined WASM_ARTIFACT_VARIANT (set "ARTIFACT_VARIANT=%WASM_ARTIFACT_VARIANT%") else if "%WASM_THREADING%"=="0" (set "ARTIFACT_VARIANT=serial") else (set "ARTIFACT_VARIANT=threaded")
if defined WASM_BUILD_JOBS (set "BUILD_JOBS=%WASM_BUILD_JOBS%") else (set "BUILD_JOBS=4")
set "DRACO_SOURCE=%WORK_DIR%\deps\draco-%DRACO_VER%"
set "DRACO_BUILD=%WORK_DIR%\draco-build-%ARTIFACT_VARIANT%"
set "DRACO_STAGE=%DRACO_SOURCE%\stage-wasm64-%ARTIFACT_VARIANT%"
set "DRACO_FLAGS=-m64"
if not "%WASM_THREADING%"=="0" set "DRACO_FLAGS=-m64 -pthread"

where emcmake >nul 2>nul
if errorlevel 1 (
  echo [draco] ERROR: activate emsdk first.
  exit /b 1
)
if not defined EMSCRIPTEN if defined EMSDK set "EMSCRIPTEN=%EMSDK%\upstream\emscripten"
if not defined EMSCRIPTEN (
  echo [draco] ERROR: EMSCRIPTEN must name the Emscripten directory.
  exit /b 1
)
if not exist "%DRACO_SOURCE%\CMakeLists.txt" call "%PKG_DIR%\fetch-deps.bat"
if errorlevel 1 exit /b 1

echo [draco] Configuring %DRACO_VER% ^(%ARTIFACT_VARIANT% wasm64^)
emcmake cmake -S "%DRACO_SOURCE%" -B "%DRACO_BUILD%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_C_FLAGS="%DRACO_FLAGS%" ^
  -DCMAKE_CXX_FLAGS="%DRACO_FLAGS%" ^
  -DCMAKE_EXE_LINKER_FLAGS="%DRACO_FLAGS%" ^
  -DBUILD_SHARED_LIBS=OFF ^
  -DDRACO_JS_GLUE=OFF ^
  -DDRACO_TESTS=OFF
if errorlevel 1 exit /b 1
cmake --build "%DRACO_BUILD%" --target draco_static --parallel %BUILD_JOBS%
if errorlevel 1 exit /b 1
if not exist "%DRACO_BUILD%\libdraco.a" (
  echo [draco] ERROR: missing %DRACO_BUILD%\libdraco.a
  exit /b 1
)
if not exist "%DRACO_BUILD%\draco\draco_features.h" (
  echo [draco] ERROR: missing %DRACO_BUILD%\draco\draco_features.h
  exit /b 1
)
if not exist "%DRACO_STAGE%\include\draco" mkdir "%DRACO_STAGE%\include\draco"
if not exist "%DRACO_STAGE%\lib" mkdir "%DRACO_STAGE%\lib"
xcopy "%DRACO_SOURCE%\src\draco\*" "%DRACO_STAGE%\include\draco\" /e /i /y >nul
if errorlevel 1 exit /b 1
copy /y "%DRACO_BUILD%\draco\draco_features.h" "%DRACO_STAGE%\include\draco\draco_features.h" >nul
if errorlevel 1 exit /b 1
copy /y "%DRACO_BUILD%\libdraco.a" "%DRACO_STAGE%\lib\libdraco.a" >nul
if errorlevel 1 exit /b 1
echo [draco] Staged %DRACO_STAGE%\lib\libdraco.a
