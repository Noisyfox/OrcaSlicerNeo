#pragma once

#include <string>
#include <vector>
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::NozzleMapping {

// Capacity is a total, never an identity or decomposition of real feeders.
std::vector<int> decode_capacities(const DynamicPrintConfig& config, std::size_t nozzles);
nlohmann::json projection(const std::string& plate_id);

} // namespace Slic3r::Neo::Bridge::NozzleMapping
