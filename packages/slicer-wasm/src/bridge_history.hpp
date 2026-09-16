// ----------------------------------------------------------------
// Worker-owned history transaction and restore runtime for the Neo bridge.
// ----------------------------------------------------------------
#pragma once

#include <functional>
#include <optional>

#include "bridge_state.hpp"
#include "history/MeshCaptureCache.hpp"
#include "history/MutableObjectCaptureCache.hpp"
#include "history/TimestampedHistory.hpp"
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

// Scalar-only diagnostics for one ordinary full-model history restore. The
// bridge owns this sink; no model, context, identifiers, or payloads cross
// the diagnostic boundary.
struct RestoreTimings {
    double model_staging_deserialization_ms = 0.0;
    double immutable_mesh_reconnect_ms = 0.0;
    double plate_session_project_overlay_restore_ms = 0.0;
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
Model stage_model(const Model& model_template, const RestoreState& restored,
                  RestoreTimings* timings = nullptr);

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

json history_status_json(const BridgeState& state);
json restore_diagnostics_json(const BridgeState& state);

// The sole mutation path for the Worker-owned history epoch. Call this after
// a committed mutation/restore or an externally visible abort. Exceptional
// compensation may restore a saved epoch directly, but normal epochs never
// move backwards.
std::uint64_t advance_history_epoch(BridgeState& state);

History::TimestampedRoots capture_history_roots(BridgeState& state, const json& context,
                                                History::Codec::CaptureTimings* timings = nullptr);
bool begin_timestamped_operation(BridgeState& state, const std::string& label, const json& before_context,
                                 History::Codec::CaptureTimings* timings = nullptr);
bool commit_timestamped_operation(BridgeState& state, const json& after_context);
void abort_timestamped_operation(BridgeState& state);

} // namespace Slic3r::Neo::Bridge::HistoryMetadata
