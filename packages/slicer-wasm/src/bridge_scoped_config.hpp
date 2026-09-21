// ----------------------------------------------------------------
// Native scoped configuration commands for the Neo WASM bridge.
//
// Native Project, Plate, ModelObject, and ModelVolume configs are the only
// authorities.  The snapshot returned by this module is a disposable
// Worker-to-React projection of those native values.
// ----------------------------------------------------------------
#pragma once

#include <cstdint>
#include <utility>
#include <string>
#include <set>
#include <vector>

#include "bridge_state.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::ScopedConfig {

using json = nlohmann::json;
using NativeScopedConfigTarget = std::pair<std::string, std::string>;
using NativeScopedConfigTargets = std::vector<NativeScopedConfigTarget>;

// These are the per-plate configuration keys exposed as editable scoped
// overrides by Neo. Native BBS plate metadata/config contains additional
// structural and derived fields that remain outside the generic scope surface.
bool is_editable_plate_override_key(const std::string& key);

json empty_native_scoped_config_snapshot();
bool valid_native_scoped_config_snapshot(const json& snapshot);

void apply_native_config_values(DynamicPrintConfig& config, const json& values);
void apply_native_config_values(ModelConfig& config, const json& values);
void replace_native_config_values(DynamicPrintConfig& config, const json& values);
void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates);

json native_scoped_config_result();
json native_scoped_config_snapshot();
NativeScopedConfigTargets native_scoped_config_removed_targets(
    const json& before_snapshot, const json& after_snapshot);
json native_scoped_config_full_transport(std::uint64_t revision);
json native_scoped_config_full_transport(
    std::uint64_t revision, const NativeScopedConfigTargets& removed_targets);
json native_scoped_config_affected_transport(
    const json& snapshot,
    const NativeScopedConfigTargets& targets,
    std::uint64_t revision);
json native_scoped_config_affected_transport(
    const json& snapshot,
    const NativeScopedConfigTargets& targets,
    std::uint64_t revision,
    const NativeScopedConfigTargets& removed_targets);

} // namespace Slic3r::Neo::Bridge::ScopedConfig
