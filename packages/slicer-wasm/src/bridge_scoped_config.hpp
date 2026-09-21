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

// These are the per-plate keys exposed by Neo's generic scoped API: values the
// native BBS reader/writer can round-trip. The set intentionally differs from
// Orca's dedicated GUI Tab::plate_keys helper list. Native BBS plate
// metadata/config contains additional structural and derived fields that
// remain outside the generic scope surface.
bool is_editable_plate_override_key(const std::string& key);

// Native project_config owns the same controlled project-level option set as
// PresetBundle::s_project_options. Other PrintConfig options exposed by the
// Project scope are owned by the edited Print preset and are projected only
// when they differ from that preset's parent.
bool is_native_project_config_key(const std::string& key);

// Existing native filament-routing slots are Project-owned for slicing and
// history, but remain outside the generic Project/Scoped editing catalogue;
// dedicated filament commands are their only mutation authority.
bool is_bridge_owned_project_routing_key(const std::string& key);

// Apply the Project-scope root split used by scoped mutation and history
// restore. The input map contains both native project_config values and local
// edited-Print-preset differences, but never any Neo-private metadata.
void apply_project_scoped_config_snapshot(const json& values);

// Native preset selection/project-embedded membership is part of the in-memory
// history root. It is not session metadata and is never written to 3MF.
json native_print_preset_history_state();
void restore_native_print_preset_history_state(const json& values);
void sync_project_print_preset_storage();

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
