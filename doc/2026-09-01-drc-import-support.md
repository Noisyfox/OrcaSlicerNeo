# DRC Import Support

**Status:** Discovery — implementation not started

## Accepted product behaviour

- The first delivery supports importing `.drc` files only.  DRC export is out
  of scope for this delivery.
- DRC has the same user entry points as the current STL support: the existing
  in-app **Add Model** flow in both the Electron and Web hosts.  It does not
  add drag-and-drop import, operating-system file association, or opening a
  DRC file from outside the application.
- An imported DRC is appended to the current plate.  It never replaces the
  existing scene.
- Placement matches the current STL behaviour: centre the imported mesh on
  the XY origin, rest it on the bed, and do not perform collision avoidance or
  automatic arrangement.  Multiple imported models may overlap.
- Compatibility follows OrcaSlicer's DRC model-import behaviour.  Accept any
  valid Draco triangular-mesh file, including files not produced by
  OrcaSlicer.  Import only positions and triangular faces; colour, normals,
  texture coordinates, materials, metadata, hierarchy, instances, and slicer
  settings are not preserved.
- Draco point clouds, malformed files, files that cannot be decoded, and files
  without usable triangle geometry fail atomically: show an understandable
  error, add no partial model, and preserve the current scene and any existing
  slice result.

## Constraints

- The shared React application remains host-neutral.  Electron and Web file
  access continue to be supplied through platform contracts.
- The Web implementation must ship all decoder resources with the application;
  it must not depend on a third-party CDN at runtime.
