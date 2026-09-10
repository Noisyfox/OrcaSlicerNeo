// ----------------------------------------------------------------
// Native Prime Tower projection for the Neo bridge.
//
// This is deliberately a read-only feature module.  It computes the
// prepare-scene estimate from Worker-owned native model/configuration state;
// no renderer payload participates in eligibility or geometry.
// ----------------------------------------------------------------
#pragma once

#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::PrimeTower {

using json = nlohmann::json;

json projection_json();

} // namespace Slic3r::Neo::Bridge::PrimeTower
