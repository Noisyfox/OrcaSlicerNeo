// ----------------------------------------------------------------
// Worker-owned history transaction and restore runtime for the Neo bridge.
// ----------------------------------------------------------------
#pragma once

#include <functional>

#include "bridge_state.hpp"
#include "history/ProjectHistory.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "nlohmann/json.hpp"

namespace Slic3r::Neo::Bridge::HistoryRuntime {

using json = nlohmann::json;

struct Runtime {
    std::function<json()> filament_history_state;
    std::function<void()> invalidate_preview;
};

// The bridge facade supplies the two narrow callbacks that cannot be linked
// directly without making this module depend on its private projections.
Runtime runtime();

json default_history_context(const Runtime& runtime);
json canonical_history_context(const Runtime& runtime, json context);
void record_active_plate_context(const Runtime& runtime);

} // namespace Slic3r::Neo::Bridge::HistoryRuntime

namespace Slic3r::Neo::History::Codec {

// Capture the mutable object records and shared immutable mesh payloads used
// by Neo's object-history store. The codec is deliberately independent of
// bridge-owned state and receives the model it serializes explicitly.
ModelState capture_model_state(const Model& model);

// Reconstruct a transient model from a retained history state. model_template
// supplies the non-history model defaults needed while materializing a fresh
// object graph; it is never accessed through bridge-global state.
Model stage_model(const Model& model_template, const RestoreState& restored);

bool model_state_equal(const ModelState& lhs, const ModelState& rhs);

} // namespace Slic3r::Neo::History::Codec

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
// advance BridgeState::history_revision. The model state is supplied by the
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
