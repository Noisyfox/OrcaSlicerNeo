@echo off
REM ================================================================
REM fetch-deps.bat - Windows cmd port of fetch-deps.sh
REM
REM Fetches the header-only deps (Eigen 5.0.1 / Boost 1.84 / cereal)
REM into .work\deps and writes the generated/stub headers into
REM .work\gen. Idempotent. No Git Bash required - pure cmd:
REM curl (PATH, else System32) + Windows tar.exe (bsdtar, handles
REM both .zip and .tar.gz) + Boost's own bootstrap.bat/b2.exe.
REM
REM The .sh original needs MSYS (curl, unzip, ./bootstrap.sh). Here
REM every piece is a native Windows binary; bootstrap.bat tries MSVC
REM first, then MinGW gcc, then clang (bootstrap.bat gcc/clang).
REM ================================================================
setlocal

set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
set "DEPS=%PKG_DIR%\.work\deps"
set "GEN=%PKG_DIR%\.work\gen"

REM Versions match OrcaSlicer v2.4.2 deps/ recipes (cereal 1.3.x is API-compatible).
set "EIGEN_VER=5.0.1"
set "BOOST_VER=1.84.0"
set "CEREAL_VER=1.3.0"

if not exist "%DEPS%" mkdir "%DEPS%"
if not exist "%GEN%\openssl" mkdir "%GEN%\openssl"

REM ---- curl: PATH first (Git for Windows), else the Windows system curl ----
set "CURL=curl"
where curl >nul 2>nul
if errorlevel 1 set "CURL="
if not defined CURL if exist "%SystemRoot%\System32\curl.exe" set "CURL=%SystemRoot%\System32\curl.exe"
if not defined CURL if exist "%SystemRoot%\SysWOW64\curl.exe" set "CURL=%SystemRoot%\SysWOW64\curl.exe"
if not defined CURL (
  echo [deps] ERROR: curl not found on PATH or in System32.
  exit /b 1
)

REM ---- Eigen (header-only) ----
if not exist "%DEPS%\eigen-%EIGEN_VER%\Eigen" (
  echo [deps] Fetching Eigen %EIGEN_VER%
  "%CURL%" -sL -o "%DEPS%\eigen.zip" "https://gitlab.com/libeigen/eigen/-/archive/%EIGEN_VER%/eigen-%EIGEN_VER%.zip"
  if errorlevel 1 (
    echo [deps] ERROR: Eigen download failed.
    exit /b 1
  )
  tar -xf "%DEPS%\eigen.zip" -C "%DEPS%"
  if errorlevel 1 (
    echo [deps] ERROR: Eigen extract failed.
    exit /b 1
  )
)

REM ---- Boost (modular release -> assemble unified boost/ header tree) ----
if not exist "%DEPS%\boost-%BOOST_VER%\boost\version.hpp" (
  echo [deps] Fetching Boost %BOOST_VER%
  "%CURL%" -sL -o "%DEPS%\boost.tar.gz" "https://github.com/boostorg/boost/releases/download/boost-%BOOST_VER%/boost-%BOOST_VER%.tar.gz"
  if errorlevel 1 (
    echo [deps] ERROR: Boost download failed.
    exit /b 1
  )
  tar -xf "%DEPS%\boost.tar.gz" -C "%DEPS%"
  if errorlevel 1 (
    echo [deps] ERROR: Boost extract failed.
    exit /b 1
  )
  echo [deps] Assembling unified Boost headers ^(bootstrap.bat + b2 headers^)
  pushd "%DEPS%\boost-%BOOST_VER%"
  call .\bootstrap.bat >nul 2>&1
  if errorlevel 1 (
    echo [deps] bootstrap.bat failed with the default toolset - retrying with gcc
    call bootstrap.bat gcc >nul 2>&1
  )
  if errorlevel 1 (
    echo [deps] bootstrap.bat gcc failed too - retrying with clang
    call bootstrap.bat clang >nul 2>&1
  )
  if not exist b2.exe (
    echo [deps] ERROR: bootstrap.bat did not produce b2.exe.
    echo   It needs MSVC ^(cl.exe^), MinGW gcc, or clang on PATH.
    popd
    exit /b 1
  )
  .\b2.exe headers >nul 2>&1
  if errorlevel 1 (
    echo [deps] ERROR: b2 headers failed.
    popd
    exit /b 1
  )
  popd
)

REM ---- cereal (header-only) ----
if not exist "%DEPS%\cereal-%CEREAL_VER%\include\cereal" (
  echo [deps] Fetching cereal %CEREAL_VER%
  "%CURL%" -sL -o "%DEPS%\cereal.tar.gz" "https://github.com/USCiLab/cereal/archive/refs/tags/v%CEREAL_VER%.tar.gz"
  if errorlevel 1 (
    echo [deps] ERROR: cereal download failed.
    exit /b 1
  )
  tar -xf "%DEPS%\cereal.tar.gz" -C "%DEPS%"
  if errorlevel 1 (
    echo [deps] ERROR: cereal extract failed.
    exit /b 1
  )
)

REM ---- Generated / stub headers ----
echo [deps] Writing generated + stub headers in .work\gen
> "%GEN%\libslic3r_version.h" echo #ifndef __SLIC3R_VERSION_H
>> "%GEN%\libslic3r_version.h" echo #define __SLIC3R_VERSION_H
>> "%GEN%\libslic3r_version.h" echo #define SLIC3R_APP_NAME "OrcaSlicer"
>> "%GEN%\libslic3r_version.h" echo #define SLIC3R_APP_KEY "OrcaSlicer"
>> "%GEN%\libslic3r_version.h" echo #define SLIC3R_VERSION "2.4.2"
>> "%GEN%\libslic3r_version.h" echo #define SoftFever_VERSION "2.4.2"
>> "%GEN%\libslic3r_version.h" echo #ifndef GIT_COMMIT_HASH
>> "%GEN%\libslic3r_version.h" echo #define GIT_COMMIT_HASH "0000000"
>> "%GEN%\libslic3r_version.h" echo #endif
>> "%GEN%\libslic3r_version.h" echo #define SLIC3R_BUILD_ID "OrcaSlicer-2.4.2-wasm-spike"
>> "%GEN%\libslic3r_version.h" echo #define BBL_INTERNAL_TESTING 0
>> "%GEN%\libslic3r_version.h" echo #define ORCA_CHECK_GCODE_PLACEHOLDERS 0
>> "%GEN%\libslic3r_version.h" echo #endif

REM Classic OpenSSL MD5 API (declarations only; codegen. A real build links a
REM small MD5 implementation).
> "%GEN%\openssl\md5.h" echo #ifndef SPIKE_OPENSSL_MD5_H
>> "%GEN%\openssl\md5.h" echo #define SPIKE_OPENSSL_MD5_H
>> "%GEN%\openssl\md5.h" echo #include ^<stddef.h^>
>> "%GEN%\openssl\md5.h" echo #ifdef __cplusplus
>> "%GEN%\openssl\md5.h" echo extern "C" {
>> "%GEN%\openssl\md5.h" echo #endif
>> "%GEN%\openssl\md5.h" echo #define MD5_DIGEST_LENGTH 16
>> "%GEN%\openssl\md5.h" echo typedef struct MD5state_st { unsigned int A,B,C,D,Nl,Nh,data[16],num; } MD5_CTX;
>> "%GEN%\openssl\md5.h" echo int MD5_Init(MD5_CTX*);
>> "%GEN%\openssl\md5.h" echo int MD5_Update(MD5_CTX*, const void*, size_t);
>> "%GEN%\openssl\md5.h" echo int MD5_Final(unsigned char*, MD5_CTX*);
>> "%GEN%\openssl\md5.h" echo unsigned char* MD5(const unsigned char*, size_t, unsigned char*);
>> "%GEN%\openssl\md5.h" echo #ifdef __cplusplus
>> "%GEN%\openssl\md5.h" echo }
>> "%GEN%\openssl\md5.h" echo #endif
>> "%GEN%\openssl\md5.h" echo #endif

echo [deps] Done. deps in %DEPS%, generated headers in %GEN%
exit /b 0
