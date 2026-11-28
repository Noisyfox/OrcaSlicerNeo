#pragma once
#include "libslic3r/Model.hpp"

namespace Slic3r::Neo::Cutting {
// Draft positions are in world coordinates. Radius and height are millimeters.
std::vector<size_t> invalid_cut_connectors(const ModelObject& source, int instance, const Transform3d& world_plane,
                                           const CutConnectors& connectors);
void add_cut_connectors(ModelObject& staged, const Vec3d& instance_offset, const Transform3d& world_plane,
                        const CutConnectors& connectors);
}
