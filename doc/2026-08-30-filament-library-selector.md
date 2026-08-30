# Filament Library Selector Completeness

**Date:** 2026-08-30

**Status:** Implemented — serial native verification complete; the threaded
quick build remains blocked by a wasm-opt parse failure.

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

## Verification

- `pnpm --filter @orca/slicer-wasm test` passes (75 tests), including generic
  library candidates in the atomic snapshot and fallback contract.
- `pnpm test` passes (all workspace tests) and `pnpm typecheck` passes.
- `pnpm --filter @orca/desktop test:e2e` passes (22 passed; 2 existing
  platform-gated tests skipped).
- The native profile-compatibility smoke fixture covers a generic library
  profile, its printer-specific superseding profile, and the generic fallback
  on a different printer. It passes against the serial WASM artifact.
- `scripts\\build-windows.bat quick` compiled the changed bridge, but the
  threaded link then failed in Emscripten's `wasm-opt` with `parse exception:
  invalid UTF-8 string`; no native smoke result is claimed.
