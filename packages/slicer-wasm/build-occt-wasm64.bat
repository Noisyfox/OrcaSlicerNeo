@echo off
REM Build and stage the OCCT 7.6.0 XCAF/STEP closure for one wasm64 variant.
setlocal EnableExtensions
set "PKG_DIR=%~dp0"
for %%i in ("%PKG_DIR%.") do set "PKG_DIR=%%~fi"
if defined WORK_DIR (set "WORK_DIR=%WORK_DIR%") else (set "WORK_DIR=%PKG_DIR%\.work")
set "THREADING_EXPLICIT=0"
if defined WASM_THREADING (
  set "THREADING_EXPLICIT=1"
  set "WASM_THREADING=%WASM_THREADING: =%"
) else (set "WASM_THREADING=1")
if defined WASM_ARTIFACT_VARIANT (
  set "ARTIFACT_VARIANT=%WASM_ARTIFACT_VARIANT: =%"
) else if "%WASM_THREADING%"=="0" (set "ARTIFACT_VARIANT=serial") else (set "ARTIFACT_VARIANT=threaded")
if not "%WASM_THREADING%"=="0" if not "%WASM_THREADING%"=="1" (echo [occt] ERROR: WASM_THREADING must be 0 or 1.& exit /b 1)
if /i "%ARTIFACT_VARIANT%"=="serial" (
  if "%THREADING_EXPLICIT%"=="1" if not "%WASM_THREADING%"=="0" (echo [occt] ERROR: serial variant requires WASM_THREADING=0.& exit /b 1)
  set "WASM_THREADING=0"
) else if /i "%ARTIFACT_VARIANT%"=="threaded" (
  if "%THREADING_EXPLICIT%"=="1" if not "%WASM_THREADING%"=="1" (echo [occt] ERROR: threaded variant requires WASM_THREADING=1.& exit /b 1)
  set "WASM_THREADING=1"
) else (echo [occt] ERROR: WASM_ARTIFACT_VARIANT must be serial or threaded.& exit /b 1)
if defined WASM_BUILD_JOBS (set "BUILD_JOBS=%WASM_BUILD_JOBS%") else (set "BUILD_JOBS=4")
set "DEPS=%WORK_DIR%\deps"
set "OCCT_VER=7.6.0"
set "OCCT_SOURCE=%DEPS%\occt-%OCCT_VER%"
set "OCCT_BUILD=%WORK_DIR%\occt-build-%ARTIFACT_VARIANT%"
set "OCCT_STAGE=%OCCT_SOURCE%\stage-wasm64-%ARTIFACT_VARIANT%"
set "OCCT_PATCH=%PKG_DIR%\patches\0008-occt-7.6.0-freetype-a-tags.patch"
set "OCCT_FLAGS=-m64 -sUSE_FREETYPE=1"
if not "%WASM_THREADING%"=="0" set "OCCT_FLAGS=-m64 -sUSE_FREETYPE=1 -pthread"
if "%WASM_THREADING%"=="0" if not "%OCCT_FLAGS%"=="-m64 -sUSE_FREETYPE=1" (echo [occt] ERROR: serial flags unexpectedly enable pthread.& exit /b 1)
if "%WASM_THREADING%"=="1" if not "%OCCT_FLAGS%"=="-m64 -sUSE_FREETYPE=1 -pthread" (echo [occt] ERROR: threaded flags do not enable pthread.& exit /b 1)

where emcmake >nul 2>nul
if errorlevel 1 (echo [occt] ERROR: activate emsdk first.& exit /b 1)
where emcc >nul 2>nul
if errorlevel 1 (echo [occt] ERROR: emcc not found.& exit /b 1)
where cmake >nul 2>nul
if errorlevel 1 (echo [occt] ERROR: cmake not found.& exit /b 1)
where ninja >nul 2>nul
if errorlevel 1 (echo [occt] ERROR: ninja not found.& exit /b 1)
if not defined EMSCRIPTEN if defined EMSDK set "EMSCRIPTEN=%EMSDK%\upstream\emscripten"
if not defined EMSCRIPTEN (echo [occt] ERROR: EMSCRIPTEN must name the Emscripten directory.& exit /b 1)
if not exist "%OCCT_SOURCE%\CMakeLists.txt" call "%PKG_DIR%\fetch-deps.bat"
if errorlevel 1 exit /b 1
if not exist "%OCCT_SOURCE%\CMakeLists.txt" (echo [occt] ERROR: OCCT source unavailable.& exit /b 1)

findstr /l /c:"const auto* aTags" "%OCCT_SOURCE%\src\StdPrs\StdPrs_BRepFont.cxx" >nul
if errorlevel 1 (
  if not exist "%OCCT_SOURCE%\.git" git -C "%OCCT_SOURCE%" init -q
  git -C "%OCCT_SOURCE%" apply --check "%OCCT_PATCH%"
  if errorlevel 1 (echo [occt] ERROR: could not validate OCCT patch.& exit /b 1)
  git -C "%OCCT_SOURCE%" apply "%OCCT_PATCH%"
  if errorlevel 1 (echo [occt] ERROR: could not apply OCCT patch.& exit /b 1)
)
set "FREETYPE_SYSROOT=%EMSCRIPTEN%\cache\sysroot"
if not exist "%FREETYPE_SYSROOT%\include\freetype2\ft2build.h" (echo [occt] ERROR: Emscripten FreeType headers missing.& exit /b 1)
set "FREETYPE_ARCHIVE=%EMSCRIPTEN%\cache\sysroot\lib\wasm64-emscripten\libfreetype.a"
if not exist "%FREETYPE_ARCHIVE%" if exist "%EMSCRIPTEN%\cache\sysroot\lib\wasm64-emscripten\pic\libfreetype.a" set "FREETYPE_ARCHIVE=%EMSCRIPTEN%\cache\sysroot\lib\wasm64-emscripten\pic\libfreetype.a"
if not exist "%FREETYPE_ARCHIVE%" (
  echo [occt] Materializing the wasm64 FreeType port
  emcc "%PKG_DIR%\stubs\freetype-port-probe.c" %OCCT_FLAGS% -sERROR_ON_UNDEFINED_SYMBOLS=1 -sSTANDALONE_WASM=1 -o "%OCCT_BUILD%\freetype-port-probe.wasm"
  if errorlevel 1 exit /b 1
)
if not exist "%FREETYPE_ARCHIVE%" (echo [occt] ERROR: wasm64 FreeType port archive missing.& exit /b 1)

echo [occt] Configuring OCCT %OCCT_VER% ^(%ARTIFACT_VARIANT% wasm64^)
emcmake cmake -S "%OCCT_SOURCE%" -B "%OCCT_BUILD%" -G Ninja ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 ^
  -DCMAKE_CXX_STANDARD=17 ^
  -DCMAKE_CXX_FLAGS="%OCCT_FLAGS%" ^
  -DCMAKE_EXE_LINKER_FLAGS="%OCCT_FLAGS%" ^
  -DBUILD_LIBRARY_TYPE=Static ^
  -DBUILD_MODULE_ApplicationFramework=OFF ^
  -DBUILD_MODULE_DataExchange=ON ^
  -DBUILD_MODULE_FoundationClasses=OFF ^
  -DBUILD_MODULE_ModelingAlgorithms=OFF ^
  -DBUILD_MODULE_ModelingData=OFF ^
  -DBUILD_MODULE_Draw=OFF ^
  -DBUILD_MODULE_Visualization=OFF ^
  -DBUILD_DOC_Overview=OFF ^
  -DUSE_TK=OFF -DUSE_TBB=OFF -DUSE_FFMPEG=OFF -DUSE_VTK=OFF ^
  -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_FREETYPE=ON ^
  -D3RDPARTY_FREETYPE_DIR= ^
  -D3RDPARTY_FREETYPE_INCLUDE_DIR_freetype2="%FREETYPE_SYSROOT%\include\freetype2" ^
  -D3RDPARTY_FREETYPE_INCLUDE_DIR_ft2build="%FREETYPE_SYSROOT%\include\freetype2" ^
  -DFREETYPE_LIBRARY_RELEASE="%FREETYPE_ARCHIVE%" ^
  -DFREETYPE_LIBRARY_DEBUG="%FREETYPE_ARCHIVE%"
if errorlevel 1 exit /b 1
cmake --build "%OCCT_BUILD%" --target TKBO TKBRep TKCAF TKCDF TKernel TKG2d TKG3d TKGeomAlgo TKGeomBase TKHLR TKLCAF TKMath TKMesh TKPrim TKService TKShHealing TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase TKTopAlgo TKV3d TKVCAF TKXCAF TKXDESTEP TKXSBase --parallel %BUILD_JOBS%
if errorlevel 1 exit /b 1

set "LIB_DIR="
for /f "delims=" %%D in ('dir /s /b /ad "%OCCT_BUILD%" 2^>nul ^| findstr /r /i "\\lib$"') do if not defined LIB_DIR set "LIB_DIR=%%D"
if not defined LIB_DIR (echo [occt] ERROR: OCCT library output directory not found.& exit /b 1)
for %%T in (TKBO TKBRep TKCAF TKCDF TKernel TKG2d TKG3d TKGeomAlgo TKGeomBase TKHLR TKLCAF TKMath TKMesh TKPrim TKService TKShHealing TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase TKTopAlgo TKV3d TKVCAF TKXCAF TKXDESTEP TKXSBase) do if not exist "%LIB_DIR%\lib%%T.a" (echo [occt] ERROR: missing OCCT archive lib%%T.a.& exit /b 1)
if not exist "%OCCT_BUILD%\include\opencascade\Standard.hxx" (echo [occt] ERROR: generated OCCT headers missing.& exit /b 1)

if exist "%OCCT_STAGE%" rmdir /s /q "%OCCT_STAGE%"
mkdir "%OCCT_STAGE%\include\opencascade" 2>nul
mkdir "%OCCT_STAGE%\include\freetype2" 2>nul
mkdir "%OCCT_STAGE%\lib" 2>nul
xcopy "%OCCT_BUILD%\include\opencascade\*" "%OCCT_STAGE%\include\opencascade\" /e /i /y >nul
if errorlevel 1 exit /b 1
for %%T in (TKBO TKBRep TKCAF TKCDF TKernel TKG2d TKG3d TKGeomAlgo TKGeomBase TKHLR TKLCAF TKMath TKMesh TKPrim TKService TKShHealing TKSTEP TKSTEP209 TKSTEPAttr TKSTEPBase TKTopAlgo TKV3d TKVCAF TKXCAF TKXDESTEP TKXSBase) do copy /y "%LIB_DIR%\lib%%T.a" "%OCCT_STAGE%\lib\" >nul

copy /y "%FREETYPE_ARCHIVE%" "%OCCT_STAGE%\lib\libfreetype.a" >nul
xcopy "%FREETYPE_SYSROOT%\include\freetype2\*" "%OCCT_STAGE%\include\freetype2\" /e /i /y >nul
> "%OCCT_STAGE%\manifest.txt" echo OCCT=%OCCT_VER%
>> "%OCCT_STAGE%\manifest.txt" echo variant=%ARTIFACT_VARIANT%
>> "%OCCT_STAGE%\manifest.txt" echo flags=%OCCT_FLAGS%
>> "%OCCT_STAGE%\manifest.txt" echo freetype=Emscripten port
echo [occt] Staged OCCT archives and FreeType at %OCCT_STAGE%
