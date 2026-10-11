# Printer Bed Display

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

## Printer bed models and artwork

- The atomic profile snapshot also exposes `bed_model`, resolved in the Worker
  using Orca's native system-preset and printer-model resource lookup. Installed
  vendor resources take priority over bundled resources. No printer-name table
  or separate HTTP asset deployment is introduced.
  The native bundled `resources/profiles` fallback maps to Neo's `/system`
  mount in the bridge; installed vendor paths pass through unchanged.
- Prepare and Preview retain one STL geometry per scene; only the current
  plate renders it. Switching plates reuses that geometry at the new origin. Geometry
  remains in slicer Z-up coordinates; placement follows `Bed3D::update_model_offset`,
  in the pinned core: vendor models use the printable bounding-box center and
  the -0.45 mm Z offset, followed by the native plate origin. The updated core
  at `489cbe9184` restores stock Bambu STL coordinates: paths containing
  `bbl-3dp-` additionally subtract half of the third printable-area point's X
  and Y coordinates, exactly as Orca does. Standard P1P and A1 mini profiles
  therefore place their bed models at local XY `(0, 0)`; other vendor models
  retain their centered placement. This affects decorative geometry only;
  printable polygons, grids, artwork, and slicer coordinates are unchanged.
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
- Model and artwork visibility follows Orca's `Camera::is_looking_downward`:
  they render only when the camera's world forward direction has negative Z.
  Upward and horizontal views hide both, while grids retain their existing
  visibility. Switching back restores the same loaded resources.
- This change uses existing desktop-layout support on both hosts. It adds no
  mobile input requirement; mobile remains deferred. Resource bytes are read
  through the Worker client, and a small vendor STL is parsed once in the
  renderer and reused when switching plates, rather than copied per plate.
