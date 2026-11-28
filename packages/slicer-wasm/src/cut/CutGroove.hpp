#pragma once
#include "libslic3r/CutUtils.hpp"

namespace Slic3r::Neo::Cutting {
struct Dovetail {
    Cut::Groove profile;
    int count = 1;
    float gap = 0.f;
};
float validate_groove(const ModelObject& source, int index, const Transform3d& world_plane, const Dovetail& groove);
}
