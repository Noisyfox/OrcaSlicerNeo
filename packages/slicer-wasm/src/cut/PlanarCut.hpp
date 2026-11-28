#pragma once

#include "libslic3r/Model.hpp"
#include "CutGroove.hpp"

namespace Slic3r::Neo::Cutting {

struct CutPieces;
enum class SideAction { Discard, Keep, PlaceOnCut, Flip };

struct PlanarCutOptions {
    Vec3d center = Vec3d::Zero();
    Eigen::Matrix3d rotation = Eigen::Matrix3d::Identity();
    struct Grouping {
        Transform3d plane = Transform3d::Identity();
        std::vector<size_t> toggled;
    };
    std::optional<Grouping> grouping;
    CutConnectors connectors;
    std::optional<Dovetail> groove;
    SideAction upper = SideAction::PlaceOnCut;
    SideAction lower = SideAction::Keep;
    bool as_parts = false;
    bool keep_paint = false;
};

// Returns independently owned objects. The reference instance locates the
// world-space plane. All instances of the source participate in the result.
Model stage_planar_cut(const ModelObject& source, ObjectID reference, const PlanarCutOptions& options,
                       const CutPieces* reviewed = nullptr, bool assembled_preview = false);

} // namespace Slic3r::Neo::Cutting
