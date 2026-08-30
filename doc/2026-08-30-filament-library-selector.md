# Filament Library Selector Completeness

**Date:** 2026-08-30

**Status:** Implemented — serial native verification complete. The runtime
recovers to the serial artifact if a threaded artifact cannot instantiate, and
the staging step rejects malformed WebAssembly artifacts.

**Scope:** Make every successfully installed FFF filament profile available in
the shared filament selector while retaining OrcaSlicer's native compatibility
and generic-profile supersession rules.

## Accepted behaviour

- The application installs all bundled profile packages before the slicer
  starts. Every filament profile that the resulting `PresetBundle` loaded is
  available to the picker; a legacy per-filament installed-state list must not
  hide profiles from a successfully installed package.
- The bridge continues to use OrcaSlicer's `PresetBundle` compatibility state.
  A generic OrcaFilamentLibrary profile is shown when compatible, except where
  OrcaSlicer marks it superseded by a printer-specific profile with the same
  alias. The application does not reimplement that matching in TypeScript.
- Failed vendor-package installs remain absent because their profiles never
  reach the native bundle.
- A malformed or incomplete threaded WASM artifact cannot block startup on an
  otherwise capable host: the Worker retries the serial artifact. The build
  staging command refuses to copy invalid WebAssembly to host public assets.
- Emscripten link outputs are verified before every staging boundary. If an
  interrupted or failed `wasm-opt` pass left a partial final module that Ninja
  would otherwise consider current, the build drivers discard only those final
  generated files and force a fresh link.

## Verification

- `pnpm --filter @orca/slicer-wasm test` passes (75 tests), including generic
  library candidates in the atomic snapshot and fallback contract.
- `pnpm test` passes (all workspace tests) and `pnpm typecheck` passes.
- `pnpm --filter @orca/desktop test:e2e` passes (22 passed; 2 existing
  platform-gated tests skipped).
- The native profile-compatibility smoke fixture covers a generic library
  profile, its printer-specific superseding profile, and the generic fallback
  on a different printer. It passes against the serial WASM artifact.
- The threaded link currently fails in Emscripten's `wasm-opt` with `parse
  exception: invalid UTF-8 string`. Its partial output is invalid WebAssembly
  (browser error `unknown section code #0x4e`); the staging validation rejects
  it and the Worker safely falls back to serial while that toolchain issue is
  investigated.
- `pnpm --filter @orca/desktop test:e2e:real` passes all 18 real-WASM Electron
  checks with the malformed threaded artifact present, verifying the serial
  fallback on the actual startup path.
- A clean threaded `-O3` relink with Emscripten 6.0.6 succeeds; its staged
  artifact passes `WebAssembly.compile` before the real-WASM Electron tests.
- `scripts\\build-windows.bat smoke --variant threaded` and the native profile
  compatibility smoke both pass against that rebuilt artifact. The complete
  workspace test/typecheck suites, regular desktop Electron suite (22 passed,
  2 skipped), and the real-WASM Electron suite (18 passed) also pass.
