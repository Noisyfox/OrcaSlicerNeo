param([ValidateSet('threaded', 'serial')][string]$Variant = 'serial')
$ErrorActionPreference = 'Stop'
$wasmRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$buildRoot = Join-Path $wasmRoot ".work/$Variant/build"
$outputRoot = Join-Path $wasmRoot ".work/vendor-config-$Variant"
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
# Reuse the current Windows driver's configured toolchain, ABI and dependencies.
# Only this separate test executable replaces the production CLI main object.
$commands = & ninja -C $buildRoot -t commands orca_slice
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect configured native build' }
$compile = @($commands | Where-Object { $_ -match ' -c .*src/slice_main.cpp$' })[0]
if (!$compile) { throw 'Configured compile command is missing' }
$source = (Join-Path $wasmRoot 'harness/vendor-config-native.cpp').Replace('\', '/')
$testObject = (Join-Path $outputRoot 'native-rule.cpp.o').Replace('\', '/')
$compile = $compile.Substring(0, $compile.IndexOf(' -MD -MT ')) + " -o `"$testObject`" -c `"$source`""
$ninjaText = Get-Content -Raw (Join-Path $buildRoot 'build.ninja')
$edge = [regex]::Match($ninjaText, '(?m)^build orca_slice.js: [^\r\n]+').Value
$objects = ($edge -replace '^build orca_slice.js: \S+ ', '') -split ' \|' | Select-Object -First 1
$linkBlock = $ninjaText.Substring($ninjaText.IndexOf($edge))
$libraries = [regex]::Match($linkBlock, '(?m)^  LINK_LIBRARIES = ([^\r\n]+)').Groups[1].Value
if (!$objects -or !$libraries) { throw 'Configured native link inputs are missing' }
$response = ($objects + ' ' + $libraries).Replace('$:', ':').Replace('$ ', ' ')
$response = $response.Replace('CMakeFiles/orca_slice.dir/src/slice_main.cpp.o', "`"$testObject`"")
$testResponse = (Join-Path $outputRoot 'native-rule.rsp').Replace('\', '/')
[IO.File]::WriteAllText($testResponse, $response)
$outputModule = (Join-Path $outputRoot 'orca_slice.js').Replace('\', '/')
$link = $commands[-1].Replace('@CMakeFiles\orca_slice.rsp', "@`"$testResponse`"").Replace('-o orca_slice.js', "-o `"$outputModule`"")
$repoRoot = (Resolve-Path (Join-Path $wasmRoot '../..')).Path
$envHelp = & (Join-Path $repoRoot 'scripts/build-windows.bat') env
$activation = @($envHelp | Where-Object { $_ -match '^\s*call "[^"]+emsdk_env.bat"' } | ForEach-Object { $_.Trim() })
if ($activation.Count -gt 0) {
    $compile = $activation[0] + ' && ' + $compile
    $link = $activation[0] + ' && ' + $link
}
Push-Location $buildRoot
try {
    & $env:ComSpec /d /s /c $compile
    if ($LASTEXITCODE -ne 0) { throw 'Native API test compilation failed' }
    & $env:ComSpec /d /s /c $link
    if ($LASTEXITCODE -ne 0) { throw 'Native API test linking failed' }
} finally { Pop-Location }
& node (Join-Path $PSScriptRoot 'vendor-config-native.mjs') $outputModule
if ($LASTEXITCODE -ne 0) { throw 'Native API test failed' }
