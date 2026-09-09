#pragma once

#include <cstdint>
#include <string>

#include "bridge_state.hpp"
#include "history/ProjectHistory.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::HistoryMetadata {

using json = nlohmann::json;

std::string history_entry_id(std::uint64_t id);
bool parse_history_entry_id(const char* value, std::uint64_t& id);
bool parse_history_jump_direction(const char* value, History::JumpDirection& direction);
json parse_history_context(const char* context_cstr);

json default_history_context(const BridgeState& state,
                             const json& plate_session,
                             const json& filament_state);
json canonical_history_context(const BridgeState& state,
                               json context,
                               const json& plate_session,
                               const json& filament_state);

// Context records retain the current model version but deliberately do not
// advance BridgeState::history_revision.  The model state is supplied by the
// caller so this metadata layer never reaches through a global or copies a
// Model/PresetBundle.
void record_history_context(BridgeState& state,
                            const std::string& label,
                            const json& requested,
                            const json& plate_session,
                            const json& filament_state,
                            const History::ModelState& model_state);
void record_active_plate_context(BridgeState& state,
                                 const json& plate_session,
                                 const json& filament_state,
                                 const History::ModelState& model_state);

json history_status_json(const BridgeState& state);
json restore_diagnostics_json(const BridgeState& state);

} // namespace Slic3r::Neo::Bridge::HistoryMetadata
