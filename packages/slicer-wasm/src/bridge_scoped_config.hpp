// ----------------------------------------------------------------
// Native scoped configuration commands for the Neo WASM bridge.
//
// Native Project, Plate, ModelObject, and ModelVolume configs are the only
// authorities.  The snapshot returned by this module is a disposable
// Worker-to-React projection of those native values.
// ----------------------------------------------------------------
#pragma once

#include <string>
#include <vector>

#include "bridge_state.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::ScopedConfig {

using json = nlohmann::json;

json empty_native_scoped_config_snapshot();
bool valid_native_scoped_config_snapshot(const json& snapshot);

void apply_native_config_values(DynamicPrintConfig& config, const json& values);
void apply_native_config_values(ModelConfig& config, const json& values);
void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates);

json native_scoped_config_result();
json native_scoped_config_snapshot();

} // namespace Slic3r::Neo::Bridge::ScopedConfig
