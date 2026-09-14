// ----------------------------------------------------------------
// Worker-owned history transaction and restore runtime for the Neo bridge.
// ----------------------------------------------------------------
#pragma once

#include <functional>
#include <optional>

#include "bridge_state.hpp"
#include "history/MeshCaptureCache.hpp"
#include "history/MutableObjectCaptureCache.hpp"
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
// Record navigation context without recapturing the immutable model archive.
void record_active_plate_context(const Runtime& runtime, json requested = {});

} // namespace Slic3r::Neo::Bridge::HistoryRuntime

namespace Slic3r::Neo::History::Codec {

// Scalar-only diagnostics for one model capture. The bridge publishes these
// values only for normal history transactions; the capture result and its
// cache/reuse semantics are independent of this optional sink.
struct CaptureTimings {
    double collection_cache_ms = 0.0;
    double mutable_object_archive_ms = 0.0;
    double immutable_mesh_retention_ms = 0.0;
    double total_ms = 0.0;
};

// Capture the mutable object records and shared immutable mesh payloads used
// by Neo's object-history store. The no-cache overload is useful for isolated
// callers; bridge paths pass their Worker-owned cache explicitly.
ModelState capture_model_state(const Model& model);
ModelState capture_model_state(const Model& model, MeshCaptureCache& mesh_cache);
ModelState capture_model_state(const Model& model, MeshCaptureCache& mesh_cache,
                               MutableObjectCaptureCache& object_cache);
ModelState capture_model_state(const Model& model, MeshCaptureCache& mesh_cache,
                               MutableObjectCaptureCache& object_cache,
                               CaptureTimings* timings);

// Reconstruct a transient model from a retained history state. model_template
// supplies the non-history model defaults needed while materializing a fresh
// object graph; it is never accessed through bridge-global state.
Model stage_model(const Model& model_template, const RestoreState& restored);

bool model_state_equal(const ModelState& lhs, const ModelState& rhs);

} // namespace Slic3r::Neo::History::Codec

namespace Slic3r::Neo::Bridge::HistoryRuntime {

// Add Plate changes only the runtime plate session and the world transforms
// of instances moved by the display-grid reflow.  Keep this receipt opaque to
// ProjectHistory; the bridge validates and applies it against the live model.
struct AddPlateHistoryFrame {
    // Absent means the grid reflow did not move any instance.  Keeping this
    // optional avoids allocating or serializing an empty position receipt.
    std::optional<nlohmann::json> before_transforms;
    std::optional<nlohmann::json> after_transforms;
};

} // namespace Slic3r::Neo::Bridge::HistoryRuntime

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
void record_history_context_reusing_current_model(BridgeState& state,
                                                  const std::string& label,
                                                  const json& context);
void record_active_plate_context(BridgeState& state,
                                 const json& plate_session,
                                 const json& filament_state,
                                 const History::ModelState& model_state);

json history_status_json(const BridgeState& state);
json restore_diagnostics_json(const BridgeState& state);

// The sole mutation path for the Worker-owned history epoch. Call this after
// a committed mutation/restore or an externally visible abort. Exceptional
// compensation may restore a saved epoch directly, but normal epochs never
// move backwards.
std::uint64_t advance_history_epoch(BridgeState& state);

// Execute one revision-producing ProjectHistory append as the bridge's atomic
// history-publication boundary. Callers supply only the append operation; a
// successful append is the sole condition that advances the observed epoch.
bool commit_history_entry(BridgeState& state, const std::function<bool()>& append);

} // namespace Slic3r::Neo::Bridge::HistoryMetadata
