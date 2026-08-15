@echo off
REM ================================================================
REM build-windows.bat - Windows entry point for scripts/build-windows.sh
REM
REM Requires Git for Windows (Git Bash). Forwards all arguments to the
REM bash driver, so the command surface is identical:
REM
REM   build-windows.bat <command> [options]
REM     e.g.  build-windows.bat help
REM           build-windows.bat quick -j 8
REM           build-windows.bat full
REM
REM See scripts/build-windows.sh (or `build-windows.bat help`) for the
REM full command list: env deps boost build full quick shim smoke
REM test dev e2e. Options: -j N, --profiles <dir>, --no-env, -v.
REM ================================================================
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%.."

REM ---- Locate Git Bash: PATH first, then standard install paths ----
set "BASH="
where bash >nul 2>nul && set "BASH=bash"
if not defined BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles%\Git\usr\bin\bash.exe" set "BASH=%ProgramFiles%\Git\usr\bin\bash.exe"

if not defined BASH (
  echo [build-windows] Git Bash not found on PATH or in standard install paths.
  echo   Install Git for Windows: https://git-scm.com/download/win
  echo   then re-run, or call scripts\build-windows.sh from a Git Bash shell.
  exit /b 1
)

REM ---- Forward to the bash driver ----
if "%~1"=="" (
  "%BASH%" "scripts/build-windows.sh" help
) else (
  "%BASH%" "scripts/build-windows.sh" %*
)
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo [build-windows] Failed with exit code %RC% - see the output above.
  pause
)
exit /b %RC%
