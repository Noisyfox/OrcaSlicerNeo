// ----------------------------------------------------------------
// Multi-filament bridge domain.
//
// The domain owns mutable filament state/history sidecars, atomic command
// transactions, the session projection, and their narrow ABI facade.  It
// never copies the immutable PresetBundle catalogue and does not change the
// bridge protocol or exported function signatures.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "bridge_state.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::Filament {

using json = nlohmann::json;

namespace State {

json config_metadata_json(const DynamicPrintConfig& config);
json history_state_json(const PresetBundle& bundle);

void apply_filament_state_metadata(PresetBundle& bundle, const json& encoded);

struct StagedMutableState {
    std::vector<std::string> names;
    std::vector<std::vector<std::string>> ams_multi_colour_filment;
    Preset edited_filament;
};

StagedMutableState stage_mutable(const PresetBundle& catalog, const json& encoded);
void apply_mutable(BridgeState& bridge, PresetBundle& bundle,
                   StagedMutableState&& staged);

} // namespace State

namespace Commands {

struct Runtime {
    std::function<json()> filament_snapshot;
};

json command_error(const char* code, const std::string& message);

void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& snapshot, bool strict_slot_arrays = true,
                                 bool require_all_slot_arrays = false);
void validate_filament_candidate_components(
    const std::vector<std::string>& filament_presets,
    const DynamicPrintConfig& project,
    const DynamicPrintConfig& printer,
    int nozzle_count,
    bool flexible_slots,
    Model& model,
    const std::vector<BridgeState::PlateSessionPlate>& plates,
    const json& snapshot,
    bool strict_slot_arrays = true,
    bool require_all_slot_arrays = false);
void recalculate_filament_flush(PresetBundle& bundle);
std::vector<std::vector<int>> min_flush_volumes_for_config(
    const DynamicPrintConfig& full, std::size_t filament_count,
    std::size_t nozzle_count);

const char* apply_remembered_filament_rack_command(const char* request_cstr,
                                                    const Runtime& runtime);
json select_filament_slot_preset_command(const json& request, const Runtime& runtime);
json set_filament_slot_colour_command(const json& request, const Runtime& runtime);
json add_filament_command(const json& request, const Runtime& runtime);
json delete_or_merge_filament_command(const json& request, bool merge,
                                      const Runtime& runtime);
json assign_filament_command(const json& request, const Runtime& runtime);
json set_filament_routing_command(const json& request, const Runtime& runtime);

} // namespace Commands

namespace Session {

json filament_session_snapshot_json();
Commands::Runtime filament_command_runtime();

} // namespace Session

} // namespace Slic3r::Neo::Bridge::Filament
