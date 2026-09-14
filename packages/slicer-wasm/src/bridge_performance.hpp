#pragma once

#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace Slic3r::Neo::Bridge::Performance {

using Timings = std::vector<std::pair<std::string, double>>;

double now_ms();
void record(std::string operation, Timings timings);
nlohmann::json take();

} // namespace Slic3r::Neo::Bridge::Performance
