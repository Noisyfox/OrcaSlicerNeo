#pragma once

#include <string>
#include <vector>
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r { class Print; }

namespace Slic3r::Neo::Bridge::NozzleMapping {

// Capacity is a total, never an identity or decomposition of real feeders.
std::vector<int> decode_capacities(const DynamicPrintConfig& config, std::size_t nozzles);
void normalize_capacities(DynamicPrintConfig& project, std::size_t nozzles);
void restore_remembered_capacities();
nlohmann::json configure_memory(const nlohmann::json& request);
DynamicPrintConfig full_config(const std::string& plate_id, bool apply_extruder = true);
void validate_slice(const std::string& plate_id);
void initialize_plate(DynamicPrintConfig& settings);
nlohmann::json mutate(const nlohmann::json& request);
nlohmann::json projection(const std::string& plate_id);
nlohmann::json set_device_material_context(const nlohmann::json& context);
void apply_device_materials(Print& print);

} // namespace Slic3r::Neo::Bridge::NozzleMapping
