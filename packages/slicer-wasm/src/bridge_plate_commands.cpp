// ----------------------------------------------------------------
// Plate lifecycle commands for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_plate_commands.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <emscripten/emscripten.h>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include "bridge_history_runtime.hpp"
#include "bridge_plate_session.hpp"
#include "bridge_state.hpp"

using namespace Slic3r;
using nlohmann::json;

namespace {

using Neo::Bridge::state;
using namespace Neo::Bridge::PlateSession;

constexpr int kMaxPlateCount = 36;

const char* dup_json(const std::string& text)
{
    char* result = static_cast<char*>(std::malloc(text.size() + 1));
    if (result == nullptr) return nullptr;
    std::memcpy(result, text.data(), text.size());
    result[text.size()] = '\0';
    return result;
}

const char* error_json(const std::string& message)
{
    return dup_json(json{{"error", message}}.dump());
}

} // namespace

namespace Slic3r::Neo::Bridge::PlateCommands {

json plate_configuration_mutation_snapshot(const std::string& plate_id,
                                            const char* reason)
{
    ensure_plate_session_state();
    if (find_plate(plate_id) == nullptr)
        throw std::runtime_error("plate not found");
    ++state().plate_input_revisions[plate_id];
    const std::set<std::string> affected{plate_id};
    json result = plate_session_snapshot_json();
    result["input_revisions"] = plate_revisions_json();
    result["affected_plate_ids_before"] = plate_id_array(affected);
    result["affected_plate_ids_after"] = plate_id_array(affected);
    result["affected_plate_ids"] = plate_id_array(affected);
    result["dirty_reasons"] = {reason};
    return result;
}

} // namespace Slic3r::Neo::Bridge::PlateCommands

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_reset_plate_session()
{
    try {
        reset_plate_session_state();
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_plate(const char* plate_id_cstr)
{
    try {
        ensure_plate_session_state();
        const std::string requested = plate_id_cstr ? plate_id_cstr : "";
        if (requested.empty()) return error_json("plateId is required");
        if (find_plate(requested) == nullptr)
            return error_json("plate not found");
        state().current_plate_id = requested;
        Neo::Bridge::HistoryRuntime::record_active_plate_context(
            Neo::Bridge::HistoryRuntime::runtime());
        return dup_json(plate_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_plate()
{
    try {
        ensure_plate_session_state();
        if (state().plate_session_plates.size() >= static_cast<std::size_t>(kMaxPlateCount))
            return error_json("maximum of 36 plates");
        // Editing commands may have changed instance transforms since the
        // last explicit membership read. Refresh from the live native model
        // before computing grid deltas; parked instances remain parked.
        rebuild_plate_membership(false);
        const auto affected_before = member_plate_ids();
        const PlateBounds bounds = selected_plate_bounds();
        const auto old_plates = state().plate_session_plates;
        const int new_count = static_cast<int>(old_plates.size()) + 1;
        std::map<std::size_t, Vec3d> changed;
        for (size_t index = 0; index < old_plates.size(); ++index) {
            const Vec3d delta = plate_origin_for_index(static_cast<int>(index), new_count, bounds) - old_plates[index].origin;
            if (delta == Vec3d::Zero()) continue;
            for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                if (plate_id != old_plates[index].id) continue;
                for (const auto& ref : plate_instance_refs()) {
                    if (ref.instance_id == instance_id) {
                        translate_instance(ref, delta);
                        changed[instance_id] = delta;
                        break;
                    }
                }
            }
        }
        const auto sequence = next_plate_id_sequence();
        const std::string id = "plate-session-plate-" + std::to_string(sequence);
        state().plate_session_plates.push_back({id, "Plate " + std::to_string(new_count), new_count - 1,
                                                plate_origin_for_index(new_count - 1, new_count, bounds)});
        state().plate_input_revisions[id] = 0;
        for (size_t index = 0; index < state().plate_session_plates.size(); ++index) {
            auto& plate = state().plate_session_plates[index];
            plate.display_index = static_cast<int>(index);
            plate.origin = plate_origin_for_index(static_cast<int>(index), new_count, bounds);
        }
        state().current_plate_id = id;
        // Existing memberships remain valid because reflow preserves each
        // instance's local coordinates. New/previously unprintable instances
        // are intentionally not auto-arranged here.
        const auto mutation = plate_mutation_snapshot(affected_before, {"plate-structure"},
                                                       reflow_instance_transforms(changed));
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_plate(const char* plate_id_cstr)
{
    try {
        ensure_plate_session_state();
        const std::string requested = plate_id_cstr ? plate_id_cstr : "";
        if (requested.empty()) return error_json("plateId is required");
        const auto it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
                                     [&](const auto& plate) { return plate.id == requested; });
        if (it == state().plate_session_plates.end()) return error_json("plate not found");
        if (state().plate_session_plates.size() <= 1) return error_json("at least one plate must remain");
        // Resolve ownership from current convex hulls before moving or
        // parking objects. This covers transforms applied without an
        // intervening recompute command while retaining parked semantics.
        rebuild_plate_membership(false);
        const auto affected_before = member_plate_ids();
        const PlateBounds bounds = selected_plate_bounds();
        const size_t deleted_index = static_cast<size_t>(std::distance(state().plate_session_plates.begin(), it));
        const auto old_plates = state().plate_session_plates;
        const bool deleting_current = state().current_plate_id == requested;
        const int new_count = static_cast<int>(old_plates.size()) - 1;
        std::map<std::size_t, Vec3d> changed;
        const Vec3d parking_origin = parked_origin_for_count(new_count, bounds);
        const Vec3d deleted_delta = parking_origin - old_plates[deleted_index].origin;
        std::vector<std::size_t> deleted_instances;
        for (const auto& [instance_id, plate_id] : state().instance_plate_ids)
            if (plate_id == requested) deleted_instances.push_back(instance_id);
        for (const std::size_t instance_id : deleted_instances) {
            for (const auto& ref : plate_instance_refs()) {
                if (ref.instance_id == instance_id) {
                    translate_instance(ref, deleted_delta);
                    changed[instance_id] = deleted_delta;
                    state().instance_plate_ids.erase(instance_id);
                    state().parked_instance_ids.insert(instance_id);
                    break;
                }
            }
        }
        state().plate_session_plates.erase(state().plate_session_plates.begin() + static_cast<std::ptrdiff_t>(deleted_index));
        state().plate_input_revisions.erase(requested);
        for (size_t index = 0; index < state().plate_session_plates.size(); ++index) {
            auto& plate = state().plate_session_plates[index];
            const Vec3d new_origin = plate_origin_for_index(static_cast<int>(index), new_count, bounds);
            const Vec3d delta = new_origin - old_plates[index < deleted_index ? index : index + 1].origin;
            if (delta != Vec3d::Zero()) {
                for (const auto& [instance_id, plate_id] : state().instance_plate_ids) {
                    if (plate_id != plate.id) continue;
                    for (const auto& ref : plate_instance_refs()) {
                        if (ref.instance_id == instance_id) {
                            translate_instance(ref, delta);
                            changed[instance_id] = delta;
                            break;
                        }
                    }
                }
            }
            plate.display_index = static_cast<int>(index);
            plate.origin = new_origin;
        }
        if (deleting_current) {
            const size_t selected_index = std::min(deleted_index, state().plate_session_plates.size() - 1);
            state().current_plate_id = state().plate_session_plates[selected_index].id;
        }
        // Deletion deliberately does not recompute the parked objects: they
        // remain unprintable until a later editing/recompute operation.
        const auto mutation = plate_mutation_snapshot(affected_before, {"plate-structure"},
                                                       reflow_instance_transforms(changed));
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_recompute_plate_membership()
{
    try {
        const auto affected_instances = state().pending_membership_instance_ids;
        const auto affected_before = affected_instances.empty()
            ? std::set<std::string>{}
            : member_plate_ids_for_instances(affected_instances);
        rebuild_plate_membership(true);
        const auto mutation = plate_mutation_snapshot(affected_before, {"model-transform"},
                                                       json::array(), &affected_instances);
        state().pending_membership_instance_ids.clear();
        return dup_json(mutation.dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_mark_shared_configuration_mutation()
{
    try {
        ensure_plate_session_state();
        return dup_json(shared_configuration_mutation_snapshot().dump());
    } catch (const std::exception& e) {
        return error_json(e.what());
    } catch (...) {
        return error_json("unknown C++ exception");
    }
}

} // extern "C"
