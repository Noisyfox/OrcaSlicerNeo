// ----------------------------------------------------------------
// Multi-filament command transactions for the Neo WASM bridge.
//
// This module owns the command parser, native candidate validation, atomic
// mutation/rollback protocol, and the multi-filament command ABI.  It consumes
// the worker-owned BridgeState and delegates projections/history codecs to the
// existing bridge modules.
// ----------------------------------------------------------------
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "bridge_state.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::FilamentCommands {

using json = nlohmann::json;

struct Runtime {
    // The filament-session projection remains owned by the bridge state
    // projection boundary. Commands call it before and after each mutation.
    std::function<json()> filament_snapshot;
};

json command_error(const char* code, const std::string& message);

void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& overlay, bool strict_slot_arrays = true,
                                 bool require_all_slot_arrays = false);
void validate_filament_candidate_components(
    const std::vector<std::string>& filament_presets,
    const DynamicPrintConfig& project,
    const DynamicPrintConfig& printer,
    int nozzle_count,
    bool flexible_slots,
    Model& model,
    const std::vector<BridgeState::PlateSessionPlate>& plates,
    const json& overlay,
    bool strict_slot_arrays = true,
    bool require_all_slot_arrays = false);
void recalculate_filament_flush(PresetBundle& bundle);
std::vector<std::vector<int>> min_flush_volumes_for_config(
    const DynamicPrintConfig& full, std::size_t filament_count,
    std::size_t nozzle_count);

const char* restore_filament_rack_command(const char* request_cstr,
                                          const Runtime& runtime);
json select_filament_slot_preset_command(const json& request, const Runtime& runtime);
json set_filament_slot_colour_command(const json& request, const Runtime& runtime);
json add_filament_command(const json& request, const Runtime& runtime);
json delete_or_merge_filament_command(const json& request, bool merge,
                                      const Runtime& runtime);
json assign_filament_command(const json& request, const Runtime& runtime);
json set_filament_routing_command(const json& request, const Runtime& runtime);

} // namespace Slic3r::Neo::Bridge::FilamentCommands
