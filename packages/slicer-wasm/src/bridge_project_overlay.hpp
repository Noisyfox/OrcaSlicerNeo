// ----------------------------------------------------------------
// Project configuration overlay for the Neo WASM bridge.
//
// This module owns the canonical project/object/part override state,
// native configuration validation, and the three overlay C ABI exports.
// Project persistence consumes only the small pure/application helpers below.
// ----------------------------------------------------------------
#pragma once

#include <string>
#include <vector>

#include "bridge_state.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::ProjectOverlay {

using json = nlohmann::json;

json empty_project_config_overlay();
bool valid_project_config_overlay(const json& overlay);
void strip_plate_coordinate_overrides(json& overlay);

void apply_overlay_to_config(DynamicPrintConfig& config, const json& values);
void apply_overlay_to_config(ModelConfig& config, const json& values);
void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates);
void apply_plate_overlay_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates,
                                    const json& overlay);

json project_config_overlay_metadata();
json project_config_overlay_result();

} // namespace Slic3r::Neo::Bridge::ProjectOverlay
