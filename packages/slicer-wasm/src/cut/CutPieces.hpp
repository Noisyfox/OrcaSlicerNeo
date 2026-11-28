#pragma once
#include "libslic3r/CutUtils.hpp"
#include "libslic3r/ExPolygon.hpp"

namespace Slic3r::Neo::Cutting {
struct CutPieces {
    Model model;
    std::vector<Cut::Part> parts;
    ExPolygons sections;
    std::vector<std::vector<size_t>> section_pieces;
    bool section_active(size_t index, const std::set<size_t>& toggled) const;
    bool accepts_connector(const Vec3d& plane_local, const std::set<size_t>& toggled) const;
};

// Volume index in this staged multipart object identifies a piece for the
// lifetime of the reference pose, including center moves within that plane.
CutPieces prepare_cut_pieces(const ModelObject& source, int instance, const Transform3d& world_plane);
}
