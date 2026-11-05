@echo off
REM ================================================================
REM Fetch the pinned upstream oneTBB source used by the threaded WASM build.
REM It intentionally lives in .work\deps, never in the libslic3r submodule.
REM ================================================================
setlocal EnableExtensions

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
if defined WORK_DIR (set "WORK_DIR=%WORK_DIR%") else (set "WORK_DIR=%PKG_DIR%\.work")
set "DEPS=%WORK_DIR%\deps"
if defined WASM_TBB_COMMIT (set "TBB_COMMIT=%WASM_TBB_COMMIT%") else (set "TBB_COMMIT=3cdc6f6558ba23ec9ceed92078b49dc664ed5bf3")
set "TBB_DIR=%DEPS%\oneTBB-%TBB_COMMIT%"
set "ARCHIVE=%DEPS%\oneTBB-%TBB_COMMIT%.tar.gz"

if exist "%TBB_DIR%\CMakeLists.txt" (
  echo [onetbb] Source already present: %TBB_DIR%
  exit /b 0
)

if not exist "%DEPS%" mkdir "%DEPS%"
echo [onetbb] Fetching pinned oneTBB %TBB_COMMIT%
node "%PKG_DIR%\..\..\scripts\download-dependency.mjs" "https://github.com/uxlfoundation/oneTBB/archive/%TBB_COMMIT%.tar.gz" "%ARCHIVE%"
if errorlevel 1 (
  echo [onetbb] ERROR: download failed.
  exit /b 1
)
tar -xf "%ARCHIVE%" -C "%DEPS%"
if errorlevel 1 (
  echo [onetbb] ERROR: extraction failed.
  exit /b 1
)
if not exist "%TBB_DIR%\CMakeLists.txt" (
  echo [onetbb] ERROR: expected %TBB_DIR%\CMakeLists.txt after extraction.
  exit /b 1
)
> "%TBB_DIR%\.orca-pinned-commit" echo %TBB_COMMIT%
echo [onetbb] Ready: %TBB_DIR%
