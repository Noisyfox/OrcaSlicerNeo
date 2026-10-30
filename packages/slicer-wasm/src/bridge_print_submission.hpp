#pragma once

#include "plate_runtime_registry.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::PrintSubmission {
// Callers hold the slicing lock and validate the completed-result receipt.
nlohmann::json describe(PlateRuntimeRegistry::Entry& entry);
nlohmann::json export_package(PlateRuntimeRegistry::Entry& entry, const std::string& filename_base, const nlohmann::json& material_ids);
}
