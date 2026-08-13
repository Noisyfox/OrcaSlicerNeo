// stubs/voronoi-cgal-stubs.cpp — link stand-ins for the CGAL Voronoi-diagram
// planarity diagnostics. Geometry/VoronoiUtilsCgal.cpp is dropped
// (DROP_PATTERNS "VoronoiUtilsCgal": its headers need CGAL, which has no WASM
// dep set), but the symbols must still resolve:
//   * is_voronoi_diagram_planar_intersection is referenced only inside
//     assert() (dead under NDEBUG), yet kept as a stub for safety.
//   * is_voronoi_diagram_planar_angle is instantiated from
//     VoronoiDiagram::detect_known_issues (Voronoi.cpp:310), which v1 never
//     calls at runtime but which keeps the instantiations alive.
// The real checks are debug diagnostics; returning true ("diagram is planar")
// means no spurious NON_PLANAR_VORONOI_DIAGRAM issue is ever raised.
#include "libslic3r/Geometry/VoronoiUtilsCgal.hpp"
#include "libslic3r/Geometry/Voronoi.hpp"
#include "libslic3r/Line.hpp"
#include "libslic3r/MultiMaterialSegmentation.hpp"

#include <boost/polygon/polygon.hpp>
#include <iterator>
#include <vector>

namespace Slic3r::Geometry {

using PolygonsSegmentIndexConstIt = std::vector<Arachne::PolygonsSegmentIndex>::const_iterator;
using LinesIt                     = Lines::iterator;
using ColoredLinesConstIt         = ColoredLines::const_iterator;
using VD                          = VoronoiDiagram;

bool VoronoiUtilsCgal::is_voronoi_diagram_planar_intersection(const VD &) { return true; }

template <typename SegmentIterator>
typename boost::polygon::enable_if<
    typename boost::polygon::gtl_if<typename boost::polygon::is_segment_concept<
        typename boost::polygon::geometry_concept<typename std::iterator_traits<SegmentIterator>::value_type>::type>::type>::type,
    bool>::type
VoronoiUtilsCgal::is_voronoi_diagram_planar_angle(const VD &, SegmentIterator, SegmentIterator)
{
    return true;
}

// Explicit instantiations — must match VoronoiUtilsCgal.cpp exactly.
template bool VoronoiUtilsCgal::is_voronoi_diagram_planar_angle(const VD &, LinesIt, LinesIt);
template bool VoronoiUtilsCgal::is_voronoi_diagram_planar_angle(const VD &, VD::SegmentIt, VD::SegmentIt);
template bool VoronoiUtilsCgal::is_voronoi_diagram_planar_angle(const VD &, ColoredLinesConstIt, ColoredLinesConstIt);
template bool VoronoiUtilsCgal::is_voronoi_diagram_planar_angle(const VD &, PolygonsSegmentIndexConstIt, PolygonsSegmentIndexConstIt);

}  // namespace Slic3r::Geometry
