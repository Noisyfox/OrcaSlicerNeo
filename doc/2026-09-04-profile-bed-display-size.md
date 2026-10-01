# Profile-based build plate display

**Date:** 2026-09-04

**Status:** Implemented

**Scope:** Keep the shared 3D build plate display aligned with the selected
printer profile.

## Accepted behaviour

- The native profile snapshot includes the selected printer's
  `printable_area` points.
- The shared viewport renders that polygon at the same XY coordinates used by
  the slicer. If the profile data is unavailable or invalid, it uses the
  existing 220 mm square fallback.
- The grid and initial camera framing use the profile's bounding dimensions.
- Changing the printer profile updates the displayed build plate and camera
  framing together with the atomic profile snapshot.
- No host-specific API or duplicate printer-size table is introduced.

## Printer bed models (2026-10-01)

- The atomic profile snapshot also exposes `bed_model`, resolved in the Worker
  using Orca's native system-preset and printer-model resource lookup. Installed
  vendor resources take priority over bundled resources. No printer-name table
  or separate HTTP asset deployment is introduced.
  The native bundled `resources/profiles` fallback maps to Neo's `/system`
  mount in the bridge; installed vendor paths pass through unchanged.
- Prepare and Preview retain one STL geometry per scene; only the current
  plate renders it. Switching plates reuses that geometry at the new origin. Geometry
  remains in slicer Z-up coordinates; placement follows `Bed3D::update_model_offset`,
  in the pinned core: centered vendor models (including BBL) and the -0.45 mm
  Z offset, followed by the native plate origin. Older Orca BBL offsets do not
  apply to the centered STL resources in this version.
- A successfully loaded model replaces the current plate's generic visible
  polygon. Other plates retain their generic backgrounds. Every plate keeps
  its grid, drawn at -0.26 mm above the model at -0.45 mm, matching the separate
  `Bed3D` and `PartPlate` draw passes. Grid colour follows current-plate state,
  and world axes are shown only at the current plate.
  The printable polygon retains bed-click and pointer-occlusion behaviour;
  decorative STL geometry does not participate in model selection.
- Missing or malformed optional STL resources fall back to the generic bed.
  Printer switching hides the old model immediately; late responses cannot
  replace the new selection. Replaced geometry is disposed on the scene owner.
- `bed_texture` exposes Orca's native SVG/PNG resource lookup through the same
  atomic snapshot and Worker filesystem as the STL. Both resources share one
  native helper for preset lookup and bundled-path adaptation. Generic artwork is mapped
  over the printable polygon's XY bounds, with the source image top aligned to
  maximum Y. Only the current plate displays it, at -0.01 mm, using alpha
  blending with depth testing and without depth writes (`PartPlate::render_logo`).
  The original SVG is rasterized with a 2048-pixel longest edge; PNG uses the
  same bounded upload size. Failed loads leave the platform and grid usable;
  stale loads, Blob URLs, replaced materials/geometry, and textures are released.
  Electron's development and built renderer CSP allow `blob:` in `img-src`
  so these filesystem-backed images can decode before canvas upload.
- Bambu-specific bed-type strips, calibration markings, extra logo polygons,
  and dual-extruder artwork layouts are deferred at the user's request. Its
  configured `bed_texture` can still use the generic path.
- This change uses existing desktop-layout support on both hosts. It adds no
  mobile input requirement; mobile remains deferred. Resource bytes are read
  through the Worker client, and a small vendor STL is parsed once in the
  renderer and reused when switching plates, rather than copied per plate.

### Verification

- `pnpm test` and `pnpm typecheck` pass.
- `scripts\build-windows.bat quick --variant serial -j 8` and
  `scripts\build-windows.bat quick --variant threaded -j 8` pass.
- `node packages/slicer-wasm/harness/bridge-smoke.mjs packages/slicer-wasm/out/serial/orca_slice.js packages/slicer-wasm/fixtures/cube.stl`
  passes, including real installed P1P STL and SVG reads.
- `node packages/slicer-wasm/harness/native-printer-transition-smoke.mjs packages/slicer-wasm/out/threaded/orca_slice.js`
  passes.
- With `VITE_USE_MOCK=1`, `pnpm --filter @orca/desktop exec electron-vite build --mode e2e`
  followed by `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts`
  passes 27 tests; the two real-model import cases are intentionally skipped.
- `pnpm --filter @orca/desktop exec playwright test --config ../../apps/web/playwright.config.ts e2e/web.e2e.ts --grep 'real printer bed STL'`
  passes against real threaded WASM. It verifies P1P/A1 mini geometry changes,
  centered coordinates, current-only model rendering, grid overlays on both
  plates, and geometry reuse when switching plate origins. It also verifies
  Prusa MK4 SVG artwork on only the current plate, its Z position, bounded
  upload size, and disabled depth writes. The screenshot was visually inspected.
- `pnpm --filter @orca/web build` passes; `bedModelStates`, `bedGridStates`, and `bedTextureStates` are absent from
  production JavaScript assets. `git diff --check` passes.
- Full dual-host/dual-variant release qualification is outside this feature's
  verification scope; real Electron and serial Web visual E2E were not run.

The generic artwork change reran the checks above, including both native builds
and smoke tests. Focused texture tests also cover rasterization, failed decoding,
stale resource reads, and disposal after replacement or unmount.

The Electron CSP correction reran `pnpm test`, `pnpm typecheck`, the mock
Electron E2E build, and `pnpm --filter @orca/desktop exec playwright test e2e/app.e2e.ts --grep 'renderer CSP'`.
The regression verifies SVG/PNG Blob decoding and readable canvas pixels under
the built renderer's actual policy. The development Vite server's HTTP response
also confirms `img-src 'self' data: blob:`. `git diff --check` passes; no WASM
build was rerun for this host-policy-only correction.
