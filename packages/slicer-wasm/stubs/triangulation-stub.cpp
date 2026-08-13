// stubs/triangulation-stub.cpp — link stand-ins for Slic3r::Triangulation.
// src/libslic3r/Triangulation.cpp is dropped (DROP_PATTERNS "Triangulation":
// it implements a Constrained Delaunay triangulation via CGAL, which has no
// WASM dep set), but the symbols must still resolve for its kept callers:
//   * Emboss.cpp (text embossing, GUI-only — not in the v1 slice path)
//   * GCode/WipeTower.cpp (wipe-tower 3D mesh faces for 3MF/display export —
//     geometry for the G-code itself lives in WipeTowerGenerator, which does
//     not use this API)
// Empty results are never exercised by the v1 slice.
#include "Triangulation.hpp"

#include <vector>

namespace Slic3r {

Triangulation::Indices Triangulation::triangulate(const Points &, const HalfEdges &) { return {}; }
Triangulation::Indices Triangulation::triangulate(const Polygon &) { return {}; }
Triangulation::Indices Triangulation::triangulate(const Polygons &) { return {}; }
Triangulation::Indices Triangulation::triangulate(const ExPolygon &) { return {}; }
Triangulation::Indices Triangulation::triangulate(const ExPolygons &) { return {}; }

} // namespace Slic3r
