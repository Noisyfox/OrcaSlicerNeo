#pragma once

#include "libslic3r/ExPolygon.hpp"
#include "libslic3r/Model.hpp"

namespace Slic3r::Neo::Cutting {
// Section polygons in plane-local XY. Modifiers do not contribute solid area.
ExPolygons cut_section(const ModelObject& source, const ModelInstance& reference, const Transform3d& plane);
}
