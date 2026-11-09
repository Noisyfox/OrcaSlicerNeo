@echo off
REM Build the pinned OCCT STEP closure using the host-neutral dependency recipe.
setlocal EnableExtensions
if not defined WASM_THREADING (
  if "%WASM_ARTIFACT_VARIANT%"=="serial" (set "WASM_THREADING=0") else (set "WASM_THREADING=1")
)
if not defined WASM_ARTIFACT_VARIANT (
  if "%WASM_THREADING%"=="0" (set "WASM_ARTIFACT_VARIANT=serial") else (set "WASM_ARTIFACT_VARIANT=threaded")
)
if "%WASM_ARTIFACT_VARIANT%"=="serial" if not "%WASM_THREADING%"=="0" (echo [occt] ERROR: variant and WASM_THREADING disagree.& exit /b 1)
if "%WASM_ARTIFACT_VARIANT%"=="threaded" if not "%WASM_THREADING%"=="1" (echo [occt] ERROR: variant and WASM_THREADING disagree.& exit /b 1)
node "%~dp0dependencies\external\build.mjs" build --library occt --target wasm64 --variant "%WASM_ARTIFACT_VARIANT%"
exit /b %errorlevel%
