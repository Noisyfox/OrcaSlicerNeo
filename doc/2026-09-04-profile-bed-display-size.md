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
