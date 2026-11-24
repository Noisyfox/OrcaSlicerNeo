#pragma once
#include "libslic3r/Model.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::HeightRanges {
nlohmann::json rows(const ModelObject& object);
}
