#pragma once
#include "nlohmann/json.hpp"
namespace Slic3r::Neo::Bridge::PaintingBridge {
void settle_dependencies();
bool use_deferred_projection();
nlohmann::json material_projection();
nlohmann::json tower_projection();
}
