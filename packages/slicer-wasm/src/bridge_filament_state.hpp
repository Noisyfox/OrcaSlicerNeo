// ----------------------------------------------------------------
// Multi-filament bridge state projections and history sidecars.
//
// This module owns serialization and staging of project-mutable filament
// fields.  It never copies the immutable PresetBundle catalogue and it does
// not own command transactions or history cursor coordination.
// ----------------------------------------------------------------
#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "bridge_state.hpp"
#include "history/ProjectHistory.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::FilamentState {

using json = nlohmann::json;

json config_metadata_json(const DynamicPrintConfig& config);
json history_state_json(const PresetBundle& bundle);

struct DirectHistoryFrame {
    std::vector<std::string> filament_presets;
    std::optional<Preset> edited_filament;
    DynamicPrintConfig project_config;
    std::vector<std::vector<std::string>> ams_multi_colour_filment;
    std::shared_ptr<const Model> model;
    std::vector<BridgeState::PlateSessionPlate> plates;
    json overlay;
    std::map<std::string, std::uint64_t> plate_input_revisions;
    std::map<std::size_t, std::string> instance_plate_ids;
    std::map<std::string, std::set<std::size_t>> plate_out_of_bounds_ids;
    std::set<std::size_t> parked_instance_ids;
    std::set<std::size_t> pending_membership_instance_ids;
    std::string current_plate_id;
    std::size_t next_filament_colour_index { 0 };
};

std::size_t direct_frame_bytes(const DirectHistoryFrame& frame,
                               const History::ModelState& model_state);
std::optional<History::RestoreState::DirectFrame>
make_direct_frame(BridgeState& bridge, std::shared_ptr<const Model> model,
                  const History::ModelState& model_state);
std::shared_ptr<const Model> current_direct_frame_model(const BridgeState& bridge);

void apply_project_sidecar(PresetBundle& bundle, const json& encoded);

struct StagedMutableState {
    std::vector<std::string> names;
    DynamicPrintConfig project_config;
    std::vector<std::vector<std::string>> ams_multi_colour_filment;
    Preset edited_filament;
};

StagedMutableState stage_mutable(const PresetBundle& catalog, const json& encoded);
void apply_mutable(BridgeState& bridge, PresetBundle& bundle,
                   StagedMutableState&& staged);

} // namespace Slic3r::Neo::Bridge::FilamentState
