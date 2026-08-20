@echo off
REM ================================================================
REM build-wasm-dual.bat - build both production wasm64 variants
REM (cmd twin of scripts/build-wasm-dual.sh)
REM
REM Each invocation of packages\slicer-wasm\build.bat has its own CMake
REM cache and output directory, so a serial build can never accidentally
REM reuse pthread objects (or vice versa). Stages both variants into the
REM renderer's public dir (apps\desktop\src\renderer\public\wasm\<variant>)
REM via scripts\stage-wasm.mjs when done.
REM
REM Usage:
REM   build-wasm-dual.bat [options passed implicitly via env]
REM ================================================================
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%i in ("%SCRIPT_DIR%.") do set "SCRIPT_DIR=%%~fi"
set "ROOT=%SCRIPT_DIR%\.."
set "PKG=%ROOT%\packages\slicer-wasm"

set "WASM_THREADING=1"
set "WASM_ARTIFACT_VARIANT=threaded"
call "%PKG%\build.bat"
if errorlevel 1 exit /b 1

set "WASM_THREADING=0"
set "WASM_ARTIFACT_VARIANT=serial"
call "%PKG%\build.bat"
if errorlevel 1 exit /b 1

node "%ROOT%\scripts\stage-wasm.mjs"
exit /b %errorlevel%
