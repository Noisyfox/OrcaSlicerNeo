#pragma once
#include <cstdint>
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::Arrangement {
using json = nlohmann::json;
bool active();
json finalize(std::uint64_t task_id);
}
