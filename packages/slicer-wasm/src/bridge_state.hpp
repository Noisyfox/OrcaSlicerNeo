// ----------------------------------------------------------------
// Worker-owned state for the Neo bridge.
//
// This header intentionally contains only the state aggregate shared by the
// bridge's internal business helpers.  The extern "C" ABI and its JSON
// operations remain in bridge.cpp.
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

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "history/ProjectHistory.hpp"
#include "history/MeshCaptureCache.hpp"
#include "history/MutableObjectCaptureCache.hpp"
#include "plate_runtime_registry.hpp"
#include "nlohmann/json.hpp"

#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#include <tbb/task_arena.h>
#endif

namespace Slic3r::Neo::Bridge {

// Native-only receipt for a transform history frame.  The core history store
// keeps this behind RestoreState::DirectFrame; the bridge validates stable IDs
// against the live model before applying it.
struct TransformHistoryRecord {
    std::size_t object_index { 0 };
    std::size_t volume_index { 0 };
    std::size_t instance_index { 0 };
    std::size_t object_id { 0 };
    std::size_t volume_id { 0 };
    std::size_t instance_id { 0 };
    Slic3r::Geometry::Transformation before_instance;
    Slic3r::Geometry::Transformation after_instance;
    Slic3r::Geometry::Transformation before_volume;
    Slic3r::Geometry::Transformation after_volume;
};

struct BridgeState {
#ifdef ORCA_WASM_THREADING
    // Match the pre-created Emscripten pthread pool at runtime. This avoids a
    // fixed compile-time cap while ensuring oneTBB does not ask for more
    // worker threads than the loader supplied.
    const int tbb_max_concurrency;
    tbb::global_control tbb_concurrency;
    tbb::task_arena tbb_arena;
#endif
    AppConfig profile_config;
    PresetBundle presets;
    Model       model;
    Print       print;
    // FFF per-plate native ownership.  Selected-plate slice/result/export/
    // cancel operations resolve this registry; the legacy single Print stays
    // in place for untouched mutation/history paths until their later steps.
    PlateRuntimeRegistry plate_runtime_registry;
    // Project-owned overrides are kept in the Worker/WASM session. React only
    // receives a render projection and never becomes their source of truth.
    nlohmann::json project_config_overlay =
        nlohmann::json{{"project", nlohmann::json::object()},
                       {"objects", nlohmann::json::object()},
                       {"parts", nlohmann::json::object()},
                       {"plates", nlohmann::json::object()}};
    // Step 2 history is deliberately Worker/WASM owned. ProjectHistory owns
    // keyed mutable object versions and shared immutable mesh data.
    History::ProjectHistory history;
    // Native mesh owners are retained across repeated live-model captures,
    // while shared-owner keys keep cache identity safe across replacement.
    History::Codec::MeshCaptureCache mesh_capture_cache;
    History::Codec::MutableObjectCaptureCache mutable_object_capture_cache;
    struct HistoryTransaction {
        std::string id;
        std::string label;
        History::Category category { History::Category::Project };
        nlohmann::json before_context;
        History::ModelState before_model;
        bool coalesced { false };
        std::string parent_id;
        // Every command submitted through an active transaction must still
        // target the model revision that transaction captured.  This prevents
        // a delayed renderer gesture from mutating a newly restored branch.
        std::uint64_t base_history_revision { 0 };
        // Add Plate is the one structural command whose history can be
        // represented without recapturing the model.  The command fills the
        // before-transform receipt as it discovers which instances reflow.
        bool add_plate_delta = false;
        bool add_plate_mutated = false;
        std::optional<nlohmann::json> add_plate_before_transforms;
        std::optional<nlohmann::json> add_plate_after_transforms;
        // Move history is recorded only when the transaction's sole model
        // mutation is orc_set_model_transforms.  Other model commands mark
        // this candidate invalid before commit, so a label alone can never
        // select the sparse restore path.
        bool transform_delta_candidate = false;
        bool transform_delta_mutated = false;
        bool transform_delta_invalidated = false;
        std::vector<TransformHistoryRecord> transform_records;
        PlateRuntimeRegistry::LifecycleSnapshots before_plate_runtime_lifecycle;
    };
    std::optional<HistoryTransaction> active_history_transaction;
    // Nested/coalesced transactions are intentionally dormant: they publish
    // no independent history entry and have no UI. Keeping a stack here gives
    // future painting/support tools one safe outer transaction boundary.
    std::vector<HistoryTransaction> nested_history_transactions;
    std::uint64_t next_history_transaction_id = 1;
    std::uint64_t history_revision = 0;
    // Test-visible counter makes the no-PresetBundle history boundary
    // executable: history restores must use the minimal mutable frame below.
    std::uint64_t history_minimal_mutable_restore_count = 0;
    // Project import is the one audited boundary that intentionally stages a
    // complete PresetBundle copy so native embedded-preset loading remains
    // transactional. History paths must never increment this counter.
    std::uint64_t full_preset_bundle_copy_count = 0;
    std::size_t next_filament_colour_index = 0;
    bool history_disabled = false;
    // The current completed preview owns the exported G-code in MEMFS. Keep
    // only its identity and file metadata here: full source text must never
    // be copied into the initial preview JSON or retained as a second string.
    std::uint32_t preview_result_id = 0;
    std::string preview_gcode_path;
    std::size_t preview_gcode_size = 0;
    std::vector<std::size_t> preview_gcode_line_ends;
    bool preview_text_available = false;
    // The current result is deliberately single-plate until Step 8 adds the
    // per-plate result cache. Keep its operation identity beside the result
    // so export cannot accidentally consume a result for another plate or
    // revision after selection/editing races.
    std::string preview_plate_id;
    std::uint64_t preview_plate_revision = 0;
    // Runtime-only identity for the headless plate session. These records are
    // deliberately independent from native plate_index values and are never
    // persisted. Membership is derived from the live Model, not maintained by
    // the renderer.
    struct PlateSessionPlate {
        std::string id;
        std::string name;
        int display_index = 0;
        Vec3d origin = Vec3d::Zero();
        bool locked = false;
        DynamicPrintConfig settings;
        nlohmann::json settings_metadata = nlohmann::json::object();
        // Ordered key/value records retain unknown native metadata without
        // colliding with the bridge's own schema. Values are intentionally
        // strings because that is the native model_settings.config wire type.
        nlohmann::json opaque_metadata = nlohmann::json::array();
        // Future Neo per-plate fields are copied through without interpreting
        // them, so newer producers can round-trip them through this version.
        nlohmann::json future_metadata = nlohmann::json::object();
    };
    std::vector<PlateSessionPlate> plate_session_plates;
    std::string current_plate_id;
    std::map<std::size_t, std::string> instance_plate_ids;
    std::map<std::string, std::set<std::size_t>> plate_out_of_bounds_ids;
    std::set<std::size_t> parked_instance_ids;
    struct PendingProjectRestore {
        std::string token;
        std::vector<unsigned char> bytes;
        std::string display_name;
        std::uint64_t base_history_revision { 0 };
        std::size_t base_history_cursor { 0 };
        std::string base_filament_state;
        std::string base_model_state;
        std::string base_overlay;
    };
    std::optional<PendingProjectRestore> pending_project_restore;
    // Test-only fault injection used by the native atomic-commit fixture. It
    // is deliberately one-shot and is never set by application code.
    bool inject_project_commit_failure = false;
    // Instances touched by a pending committed transform. The renderer may
    // send one setModelTransform call per composite, but recomputation is
    // deliberately deferred until the complete global operation has settled.
    std::set<std::size_t> pending_membership_instance_ids;
    // Per-plate slice-input generations. Selection and preview-only reads do
    // not advance these values; a committed model/configuration mutation does
    // so only for plates containing an instance before or after the command.
    std::map<std::string, std::uint64_t> plate_input_revisions;
    // Runtime-only derived Prime Tower projections keyed by stable plate id.
    // Never serialized into project or history state.
    std::map<std::string, nlohmann::json> prime_tower_projection_cache;

    BridgeState();
};

BridgeState& state();

inline void invalidate_transform_delta_candidate(BridgeState& bridge_state)
{
    if (bridge_state.active_history_transaction &&
        bridge_state.active_history_transaction->transform_delta_candidate)
        bridge_state.active_history_transaction->transform_delta_invalidated = true;
}

} // namespace Slic3r::Neo::Bridge
