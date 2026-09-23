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
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Print.hpp"
#include "bridge_preset_drafts.hpp"
#include "history/TimestampedHistory.hpp"
#include "history/MeshCaptureCache.hpp"
#include "history/MutableObjectCaptureCache.hpp"
#include "plate_runtime_registry.hpp"
#include "nlohmann/json.hpp"

#ifdef ORCA_WASM_THREADING
#include <tbb/global_control.h>
#include <tbb/task_arena.h>
#endif

namespace Slic3r::Neo::Bridge {

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
    // Preset Editor Printer/Filament overlays are session-local sparse native
    // values. They never replace a collection's edited Preset instance.
    PresetDraftRegistry preset_drafts;
    // Unlike history_revision (which invalidates stale commands), this branchable
    // counter makes every accepted draft command an observable history root,
    // including a reset that leaves an already-empty overlay unchanged.
    std::uint64_t preset_draft_revision = 0;
    Model       model;
    // FFF per-plate native ownership. Selected-plate slice/result/export/
    // cancel operations resolve this registry; no singleton Print or result
    // owner remains in BridgeState.
    PlateRuntimeRegistry plate_runtime_registry;
    // History is deliberately Worker/WASM owned. TimestampedHistory retains
    // the canonical three roots and names every operation with explicit
    // before/after logical timestamps.
    History::TimestampedHistory history;
    nlohmann::json history_live_context = nlohmann::json::object();
    // Native mesh owners are retained across repeated live-model captures,
    // while shared-owner keys keep cache identity safe across replacement.
    History::Codec::MeshCaptureCache mesh_capture_cache;
    History::Codec::MutableObjectCaptureCache mutable_object_capture_cache;
    struct HistoryTransaction {
        std::string id;
        std::string label;
        nlohmann::json before_context;
        History::TimestampedRoots before_roots;
        // Runtime-only rollback state for an aborted transaction. History
        // roots intentionally normalize input revisions, while an abort must
        // restore the exact pre-edit presentation guards and stamps.
        std::map<std::string, std::uint64_t> before_plate_input_revisions;
        PlateRuntimeRegistry::LifecycleSnapshots before_lifecycle;
        bool coalesced { false };
        std::string parent_id;
        // Every command submitted through an active transaction must still
        // target the model revision that transaction captured.  This prevents
        // a delayed renderer gesture from mutating a newly restored branch.
        std::uint64_t base_history_revision { 0 };
        // Scoped configuration targets touched by this transaction.  The
        // commit response turns these identities into complete map
        // replacements at the committed revision.
        std::set<std::pair<std::string, std::string>> native_scoped_config_targets;
    };
    std::optional<HistoryTransaction> active_history_transaction;
    // Nested/coalesced transactions are intentionally dormant: they publish
    // no independent history entry and have no UI. Keeping a stack here gives
    // future painting/support tools one safe outer transaction boundary.
    std::vector<HistoryTransaction> nested_history_transactions;
    std::uint64_t next_history_transaction_id = 1;
    // Every native asynchronous task shares one runtime-only, monotonic
    // identity domain.  IDs are never serialized and never reused during a
    // WASM session; renderer projection epochs remain separate UI-only tokens.
    std::uint64_t next_async_task_id = 1;
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
    };
    std::vector<PlateSessionPlate> plate_session_plates;
    std::string current_plate_id;
    std::map<std::size_t, std::string> instance_plate_ids;
    std::map<std::string, std::set<std::size_t>> plate_out_of_bounds_ids;
    std::set<std::size_t> parked_instance_ids;
    // Test-only fault injection used to prove that publication rollback keeps
    // the already-closed, empty replacement session atomic. It is deliberately
    // one-shot and is never set by application code.
    bool inject_project_commit_failure = false;
    // Instances touched by a pending committed transform. The renderer may
    // send one setModelTransform call per composite, but recomputation is
    // deliberately deferred until the complete global operation has settled.
    std::set<std::size_t> pending_membership_instance_ids;
    // Per-plate slice-input generations. Selection and preview-only reads do
    // not advance these values; a committed model/configuration mutation does
    // so only for plates containing an instance before or after the command.
    std::map<std::string, std::uint64_t> plate_input_revisions;
    // Runtime-only session allocator.  History frames may retain old numeric
    // revisions as context, but live stamps never come from those values.
    std::uint64_t next_plate_input_stamp = 1;
    // Runtime-only derived projections. The input stamp is authoritative;
    // explicit invalidation is only an optimization, never the validity proof.
    // Display order also affects indexed tower coordinates/custom G-code.
    // Never serialized into project or history state.
    struct PrimeTowerProjectionCacheEntry {
        std::uint64_t input_stamp;
        int display_index;
        nlohmann::json projection;
    };
    std::map<std::string, PrimeTowerProjectionCacheEntry> prime_tower_projection_cache;

    BridgeState();
};

BridgeState& state();

inline std::uint64_t allocate_plate_input_stamp(BridgeState& bridge_state)
{
    if (bridge_state.next_plate_input_stamp == std::numeric_limits<std::uint64_t>::max())
        throw std::overflow_error("plate input stamp allocator exhausted");
    return bridge_state.next_plate_input_stamp++;
}

} // namespace Slic3r::Neo::Bridge
