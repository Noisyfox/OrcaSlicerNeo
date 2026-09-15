#pragma once

#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace Slic3r::Neo::Bridge::Performance {

using Timings = std::vector<std::pair<std::string, double>>;
using PerPlateTimings = std::vector<Timings>;

double now_ms();
void record(std::string operation, Timings timings, PerPlateTimings per_plate = {});
nlohmann::json take();

} // namespace Slic3r::Neo::Bridge::Performance
