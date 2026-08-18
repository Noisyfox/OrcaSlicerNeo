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
set "CURL="
for /f "delims=" %%i in ('where curl 2^>nul') do if not defined CURL set "CURL=%%i"
if not defined CURL if exist "%SystemRoot%\System32\curl.exe" set "CURL=%SystemRoot%\System32\curl.exe"
if not defined CURL if exist "%SystemRoot%\SysWOW64\curl.exe" set "CURL=%SystemRoot%\SysWOW64\curl.exe"
if not defined CURL (
  echo [onetbb] ERROR: curl not found.
  exit /b 1
)

echo [onetbb] Fetching pinned oneTBB %TBB_COMMIT%
"%CURL%" --fail --location --retry 3 --silent --show-error -o "%ARCHIVE%" "https://github.com/uxlfoundation/oneTBB/archive/%TBB_COMMIT%.tar.gz"
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
