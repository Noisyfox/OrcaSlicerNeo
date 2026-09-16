#define CEREAL_FUTURE_EXPERIMENTAL

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <functional>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "bridge_history.hpp"
#include "bridge_performance.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "history/InstanceIdentity.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"

#include <cereal/archives/adapters.hpp>
#include <cereal/archives/binary.hpp>
#include <cereal/types/map.hpp>
#include <cereal/types/memory.hpp>
#include <cereal/types/optional.hpp>
#include <cereal/types/string.hpp>
#include <cereal/types/vector.hpp>

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::HistoryRuntime {

using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::Filament::Commands::validate_filament_candidate;
using Neo::Bridge::Filament::Commands::validate_filament_candidate_components;
using Neo::Bridge::Filament::State::apply_mutable;
using Neo::Bridge::Filament::State::DirectHistoryFrame;
using Neo::Bridge::Filament::State::history_state_json;
using Neo::Bridge::Filament::State::stage_mutable;
using Neo::Bridge::HistoryMetadata::history_entry_id;
using Neo::Bridge::HistoryMetadata::parse_history_context;
using Neo::Bridge::HistoryMetadata::parse_history_entry_id;
using Neo::Bridge::HistoryMetadata::parse_history_jump_direction;
using Neo::Bridge::PlateSession::plate_session_snapshot_json;
using Neo::Bridge::ProjectOverlay::empty_project_config_overlay;
using Neo::Bridge::ProjectOverlay::apply_plate_overlay_to_configs;
using Neo::Bridge::ProjectOverlay::valid_project_config_overlay;
using Neo::Bridge::SlicingPipeline::invalidate_preview_source;
using Neo::History::Codec::capture_model_state;
using Neo::Bridge::PrimeTower::NarrowHistoryFrame;

namespace {

constexpr int kMaxPlateCount = 36;

const char* duplicate_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}

const char* error_json(const std::string& message)
{
    return duplicate_json(json{{"error", message}}.dump());
}

json history_status_json()
{
    return Neo::Bridge::HistoryMetadata::history_status_json(state());
}

json current_context(const Runtime& runtime)
{
    return Neo::Bridge::HistoryMetadata::default_history_context(
        state(), plate_session_snapshot_json(), runtime.filament_history_state());
}

void validate_history_plate_session(const json& session, const Model& model)
{
    if (!session.is_object() || session.value("version", 0) != 1 ||
        !session.contains("current_plate_id") || !session["current_plate_id"].is_string() ||
        !session.contains("plates") || !session["plates"].is_array() || session["plates"].empty() ||
        session["plates"].size() > static_cast<std::size_t>(kMaxPlateCount) ||
        !session.contains("instances") || !session["instances"].is_array() ||
        !session.contains("input_revisions") || !session["input_revisions"].is_object())
        throw std::runtime_error("invalid history plate session");

    std::set<std::string> plate_ids;
    for (std::size_t index = 0; index < session["plates"].size(); ++index) {
        const auto& plate = session["plates"][index];
        if (!plate.is_object() || !plate.contains("plate_id") || !plate["plate_id"].is_string() ||
            plate["plate_id"].get<std::string>().empty() ||
            !plate_ids.insert(plate["plate_id"].get<std::string>()).second ||
            !plate.contains("display_index") || !plate["display_index"].is_number_integer() ||
            plate["display_index"].get<int>() != static_cast<int>(index) ||
            !plate.contains("origin") || !plate["origin"].is_array() || plate["origin"].size() != 3 ||
            !std::all_of(plate["origin"].begin(), plate["origin"].end(),
                         [](const json& coordinate) { return coordinate.is_number(); }) ||
            !plate.contains("name") || !plate["name"].is_string() ||
            !plate.contains("locked") || !plate["locked"].is_boolean() ||
            !plate.contains("settings") || !plate["settings"].is_object() ||
            !plate.contains("opaque_metadata") || !plate["opaque_metadata"].is_array() ||
            !plate.contains("future_metadata") || !plate["future_metadata"].is_object() ||
            !plate.contains("instance_ids") || !plate["instance_ids"].is_array() ||
            !plate.contains("out_of_bounds_instance_ids") || !plate["out_of_bounds_instance_ids"].is_array())
            throw std::runtime_error("invalid history plate record");
    }
    if (plate_ids.find(session["current_plate_id"].get<std::string>()) == plate_ids.end())
        throw std::runtime_error("history current plate is not present");

    std::set<std::size_t> model_instance_ids;
    for (const auto* object : model.objects)
        for (const auto* instance : object->instances)
            model_instance_ids.insert(instance->id().id);

    std::map<std::size_t, std::pair<std::size_t, std::size_t>> saved_instances;
    std::set<std::pair<std::size_t, std::size_t>> saved_positions;
    std::set<std::size_t> membership_ids;
    std::set<std::size_t> out_of_bounds_ids;
    for (const auto& instance : session["instances"]) {
        if (!instance.is_object() || !instance.contains("instance_id") ||
            !instance["instance_id"].is_number_integer() || instance["instance_id"].get<std::int64_t>() < 0 ||
            !instance.contains("object_index") || !instance["object_index"].is_number_integer() ||
            !instance.contains("instance_index") || !instance["instance_index"].is_number_integer() ||
            !instance.contains("plate_id") || !instance["plate_id"].is_string() ||
            !instance.contains("member") || !instance["member"].is_boolean() ||
            !instance.contains("parked") || !instance["parked"].is_boolean() ||
            !instance.contains("out_of_bounds") || !instance["out_of_bounds"].is_boolean())
            throw std::runtime_error("invalid history instance membership");
        const auto saved_id = instance["instance_id"].get<std::size_t>();
        const auto object_index = instance["object_index"].get<std::size_t>();
        const auto instance_index = instance["instance_index"].get<std::size_t>();
        if (!saved_instances.emplace(saved_id, std::make_pair(object_index, instance_index)).second ||
            !saved_positions.emplace(object_index, instance_index).second ||
            object_index >= model.objects.size() || instance_index >= model.objects[object_index]->instances.size() ||
            model.objects[object_index]->instances[instance_index]->id().id != saved_id)
            throw std::runtime_error("history instance membership does not match model");
        const std::string plate_id = instance["plate_id"].get<std::string>();
        if (plate_id.empty() != !instance["member"].get<bool>() ||
            (!plate_id.empty() && plate_ids.find(plate_id) == plate_ids.end()) ||
            (instance["parked"].get<bool>() && !plate_id.empty()) ||
            (instance["out_of_bounds"].get<bool>() && plate_id.empty()))
            throw std::runtime_error("inconsistent history instance membership");
        if (!plate_id.empty()) membership_ids.insert(saved_id);
        if (instance["out_of_bounds"].get<bool>()) out_of_bounds_ids.insert(saved_id);
    }
    std::set<std::size_t> saved_instance_ids;
    for (const auto& saved : saved_instances) saved_instance_ids.insert(saved.first);
    if (saved_instance_ids != model_instance_ids)
        throw std::runtime_error("history plate session is missing model instances");

    std::set<std::size_t> listed_members;
    std::set<std::size_t> listed_out_of_bounds;
    for (const auto& plate : session["plates"]) {
        for (const auto& value : plate["instance_ids"]) {
            if (!value.is_number_integer() || value.get<std::int64_t>() < 0 ||
                !listed_members.insert(value.get<std::size_t>()).second)
                throw std::runtime_error("duplicate history plate membership");
            const auto instance = std::find_if(session["instances"].begin(), session["instances"].end(),
                                               [&](const json& candidate) { return candidate["instance_id"] == value; });
            if (instance == session["instances"].end() || instance->at("plate_id") != plate["plate_id"])
                throw std::runtime_error("history plate membership does not match instances");
        }
        for (const auto& value : plate["out_of_bounds_instance_ids"]) {
            if (!value.is_number_integer() || value.get<std::int64_t>() < 0 ||
                !listed_out_of_bounds.insert(value.get<std::size_t>()).second)
                throw std::runtime_error("duplicate history out-of-bounds membership");
            const auto instance = std::find_if(session["instances"].begin(), session["instances"].end(),
                                               [&](const json& candidate) { return candidate["instance_id"] == value; });
            if (instance == session["instances"].end() || instance->at("plate_id") != plate["plate_id"] ||
                !instance->at("out_of_bounds").get<bool>())
                throw std::runtime_error("history out-of-bounds membership does not match instances");
        }
    }
    if (listed_members != membership_ids || listed_out_of_bounds != out_of_bounds_ids)
        throw std::runtime_error("history plate membership is incomplete");
    for (const auto& [plate_id, revision] : session["input_revisions"].items()) {
        if (plate_ids.find(plate_id) == plate_ids.end() || !revision.is_number_unsigned())
            throw std::runtime_error("invalid history plate revision");
    }
    for (const auto& plate_id : plate_ids)
        if (!session["input_revisions"].contains(plate_id))
            throw std::runtime_error("history plate revision is missing");
}

std::vector<BridgeState::PlateSessionPlate> build_history_plate_session(const json& session,
                                                                         const Model& restored_model)
{
    validate_history_plate_session(session, restored_model);
    std::vector<BridgeState::PlateSessionPlate> restored_plates;
    restored_plates.reserve(session["plates"].size());
    for (const auto& record : session["plates"]) {
        BridgeState::PlateSessionPlate plate;
        plate.id = record["plate_id"].get<std::string>();
        plate.name = record["name"].get<std::string>();
        plate.display_index = record["display_index"].get<int>();
        const auto& origin = record["origin"];
        plate.origin = Vec3d(origin[0].get<double>(), origin[1].get<double>(), origin[2].get<double>());
        plate.locked = record["locked"].get<bool>();
        plate.settings_metadata = record["settings"];
        plate.opaque_metadata = record["opaque_metadata"];
        plate.future_metadata = record["future_metadata"];
        Neo::Bridge::ProjectOverlay::apply_overlay_to_config(plate.settings, plate.settings_metadata);
        restored_plates.push_back(std::move(plate));
    }
    return restored_plates;
}

void restore_history_plate_session(const json& session, const Model& restored_model)
{
    auto restored_plates = build_history_plate_session(session, restored_model);
    state().plate_session_plates = std::move(restored_plates);
    state().current_plate_id = session["current_plate_id"].get<std::string>();
    state().instance_plate_ids.clear();
    state().plate_out_of_bounds_ids.clear();
    state().parked_instance_ids.clear();
    for (const auto& instance : session["instances"]) {
        const auto restored_id = instance["instance_id"].get<std::size_t>();
        const std::string plate_id = instance["plate_id"].get<std::string>();
        if (!plate_id.empty()) state().instance_plate_ids[restored_id] = plate_id;
        if (instance["parked"].get<bool>()) state().parked_instance_ids.insert(restored_id);
        if (instance["out_of_bounds"].get<bool>()) state().plate_out_of_bounds_ids[plate_id].insert(restored_id);
    }
}

std::map<std::string, json> history_plate_input_projection(const json& session)
{
    std::map<std::string, json> result;
    if (!session.is_object() || !session.contains("plates") || !session["plates"].is_array()) return result;
    std::map<std::string, std::set<std::size_t>> object_ids_by_plate;
    if (session.contains("instances") && session["instances"].is_array()) {
        for (const auto& instance : session["instances"]) {
            if (!instance.is_object() || !instance.contains("plate_id") || !instance["plate_id"].is_string() ||
                !instance.contains("object_id") || !instance["object_id"].is_number_unsigned()) continue;
            const auto plate_id = instance["plate_id"].get<std::string>();
            if (!plate_id.empty() && (instance.value("member", false) || instance.value("out_of_bounds", false)))
                object_ids_by_plate[plate_id].insert(instance["object_id"].get<std::size_t>());
        }
    }
    for (const auto& plate : session["plates"]) {
        if (!plate.is_object() || !plate.contains("plate_id") || !plate["plate_id"].is_string()) continue;
        // Display order, name, lock state, and current selection are context;
        // these do not change the slicer input.  Origin, local settings, and
        // membership do.
        const auto plate_id = plate["plate_id"].get<std::string>();
        result[plate_id] = json{
            {"origin", plate.value("origin", json::array())},
            {"settings", plate.value("settings", json::object())},
            {"opaque_metadata", plate.value("opaque_metadata", json::array())},
            {"future_metadata", plate.value("future_metadata", json::object())},
            // Runtime instance IDs can be rematerialized while restoring a
            // model.  Object IDs are the persistent membership identity.
            {"object_ids", object_ids_by_plate[plate_id]},
        };
    }
    return result;
}

std::map<std::size_t, std::set<std::string>> history_object_plates(const json& session)
{
    std::map<std::size_t, std::set<std::string>> result;
    if (!session.is_object() || !session.contains("instances") || !session["instances"].is_array()) return result;
    for (const auto& instance : session["instances"]) {
        if (!instance.is_object() || !instance.value("member", false) ||
            !instance.contains("object_id") || !instance["object_id"].is_number_unsigned() ||
            !instance.contains("plate_id") || !instance["plate_id"].is_string()) continue;
        const auto plate_id = instance["plate_id"].get<std::string>();
        if (!plate_id.empty()) result[instance["object_id"].get<std::size_t>()].insert(plate_id);
    }
    return result;
}

std::set<std::size_t> changed_history_objects(const Neo::History::ModelState& before,
                                              const Neo::History::ModelState& target,
                                              bool& opaque_model_change)
{
    std::set<std::size_t> changed;
    // The legacy serialized blob changes whenever any object changes.  It is
    // not an opaque input boundary: keyed mutable object records below let us
    // map that change to the owning plates and preserve unrelated results.
    opaque_model_change = before.immutable_meshes.size() != target.immutable_meshes.size();
    std::map<std::size_t, const Neo::History::MutableObject*> before_objects;
    std::map<std::size_t, const Neo::History::MutableObject*> target_objects;
    for (const auto& object : before.mutable_objects) before_objects[object.id] = &object;
    for (const auto& object : target.mutable_objects) target_objects[object.id] = &object;
    std::set<std::size_t> object_ids;
    for (const auto& [id, object] : before_objects) object_ids.insert(id);
    for (const auto& [id, object] : target_objects) object_ids.insert(id);
    for (const auto id : object_ids) {
        const auto before_it = before_objects.find(id);
        const auto target_it = target_objects.find(id);
        if (before_it == before_objects.end() || target_it == target_objects.end()) {
            changed.insert(id);
            continue;
        }
        const auto& lhs = *before_it->second;
        const auto& rhs = *target_it->second;
        // A restored archive can normalize bytes for an otherwise unchanged
        // object.  Stable volume identity is the reliable model-input edge;
        // transform edits have their own delta frame and new/removed objects
        // are handled by the object-ID set above.
        if (lhs.volume_ids != rhs.volume_ids)
            changed.insert(id);
    }
    if (before.immutable_meshes.size() == target.immutable_meshes.size()) {
        for (std::size_t index = 0; index < before.immutable_meshes.size(); ++index) {
            const auto& lhs = before.immutable_meshes[index];
            const auto& rhs = target.immutable_meshes[index];
            if (lhs.key != rhs.key || lhs.optional != rhs.optional || lhs.native.get() != rhs.native.get() ||
                (lhs.resident && rhs.resident ? *lhs.resident != *rhs.resident : bool(lhs.resident) != bool(rhs.resident)) ||
                (lhs.deferred && rhs.deferred ? *lhs.deferred != *rhs.deferred : bool(lhs.deferred) != bool(rhs.deferred))) {
                opaque_model_change = true;
                break;
            }
        }
    }
    // Adding/removing a model naturally changes the retained immutable mesh
    // set, but its keyed mutable object record already identifies the owning
    // plate.  Only treat an immutable-only change as opaque when no object
    // record can localize it.
    if (opaque_model_change && !changed.empty()) opaque_model_change = false;
    return changed;
}

void add_history_object_plates(std::set<std::string>& affected,
                               const std::set<std::size_t>& object_ids,
                               const json& before_session, const json& target_session)
{
    const auto before = history_object_plates(before_session);
    const auto target = history_object_plates(target_session);
    for (const auto object_id : object_ids) {
        if (const auto it = before.find(object_id); it != before.end()) affected.insert(it->second.begin(), it->second.end());
        if (const auto it = target.find(object_id); it != target.end()) affected.insert(it->second.begin(), it->second.end());
    }
}

void add_changed_overlay_object_plates(std::set<std::string>& affected, const json& before_overlay,
                                        const json& target_overlay, const json& before_session,
                                        const json& target_session,
                                        const std::optional<Neo::History::ModelState>& before_model,
                                        const std::optional<Neo::History::ModelState>& target_model)
{
    if (!before_overlay.is_object() && !target_overlay.is_object()) return;
    std::set<std::size_t> object_ids;
    bool unresolved = false;
    for (const char* scope : {"objects", "parts"}) {
        const auto before = before_overlay.value(scope, json::object());
        const auto target = target_overlay.value(scope, json::object());
        std::set<std::string> keys;
        if (before.is_object()) for (const auto& [key, value] : before.items()) keys.insert(key);
        if (target.is_object()) for (const auto& [key, value] : target.items()) keys.insert(key);
        for (const auto& key : keys) {
            if (before.value(key, json()) == target.value(key, json())) continue;
            std::size_t id = 0;
            try { id = static_cast<std::size_t>(std::stoull(key)); }
            catch (...) { unresolved = true; continue; }
            if (scope == std::string("objects")) {
                object_ids.insert(id);
                continue;
            }

            // Part overlay keys are stable volume IDs, not object IDs. Resolve
            // their owner from both sides of the history frame so Undo and
            // Redo invalidate every plate containing that object's instances.
            bool found = false;
            const auto add_owner = [&](const std::optional<Neo::History::ModelState>& model) {
                if (!model) return;
                for (const auto& object : model->mutable_objects) {
                    if (std::find(object.volume_ids.begin(), object.volume_ids.end(), id) == object.volume_ids.end())
                        continue;
                    object_ids.insert(object.id);
                    found = true;
                }
            };
            add_owner(before_model);
            add_owner(target_model);
            if (!found) unresolved = true;
        }
    }
    if (unresolved) {
        for (const auto& entry : history_plate_input_projection(before_session)) affected.insert(entry.first);
        for (const auto& entry : history_plate_input_projection(target_session)) affected.insert(entry.first);
    }
    add_history_object_plates(affected, object_ids, before_session, target_session);
}

std::set<std::string> history_affected_plate_ids(
    const json& before_session, const json& target_session,
    const std::optional<Neo::History::ModelState>& before_model,
    const std::optional<Neo::History::ModelState>& target_model,
    const json& before_filament, const json& target_filament,
    const json& before_overlay, const json& target_overlay,
    const std::set<std::string>& explicit_affected = {})
{
    std::set<std::string> all_ids;
    for (const auto& [id, value] : history_plate_input_projection(before_session)) all_ids.insert(id);
    for (const auto& [id, value] : history_plate_input_projection(target_session)) all_ids.insert(id);
    std::set<std::string> affected = explicit_affected;
    const auto before_plates = history_plate_input_projection(before_session);
    const auto target_plates = history_plate_input_projection(target_session);
    bool plate_projection_changed = false;
    for (const auto& id : all_ids) {
        const auto before = before_plates.find(id);
        const auto target = target_plates.find(id);
        if (before == before_plates.end() || target == target_plates.end() || before->second != target->second) {
            affected.insert(id);
            plate_projection_changed = true;
        }
    }
    if (before_filament != target_filament) affected.insert(all_ids.begin(), all_ids.end());
    const auto before_project = before_overlay.value("project", json::object());
    const auto target_project = target_overlay.value("project", json::object());
    if (before_project != target_project) affected.insert(all_ids.begin(), all_ids.end());
    const auto before_plate_overlay = before_overlay.value("plates", json::object());
    const auto target_plate_overlay = target_overlay.value("plates", json::object());
    if (before_plate_overlay.is_object() && target_plate_overlay.is_object()) {
        std::set<std::string> overlay_ids;
        for (const auto& [id, value] : before_plate_overlay.items()) overlay_ids.insert(id);
        for (const auto& [id, value] : target_plate_overlay.items()) overlay_ids.insert(id);
        for (const auto& id : overlay_ids)
            if (before_plate_overlay.value(id, json()) != target_plate_overlay.value(id, json())) affected.insert(id);
    }
    add_changed_overlay_object_plates(affected, before_overlay, target_overlay, before_session,
                                      target_session, before_model, target_model);
    // A membership/origin/settings delta already localizes model additions or
    // removals to those plates.  Avoid reinterpreting archive bytes for every
    // restored object (stage/restore can normalize unrelated object bytes).
    if (before_model && target_model && !plate_projection_changed) {
        bool opaque_model_change = false;
        const auto changed_objects = changed_history_objects(*before_model, *target_model, opaque_model_change);
        add_history_object_plates(affected, changed_objects, before_session, target_session);
        if (opaque_model_change) affected.insert(all_ids.begin(), all_ids.end());
    }
    return affected;
}

void reconcile_history_runtime_registry(
    const std::map<std::string, std::uint64_t>& previous_revisions,
    const std::set<std::string>& affected_plate_ids)
{
    std::vector<std::string> plate_ids;
    plate_ids.reserve(state().plate_session_plates.size());
    std::map<std::string, std::uint64_t> live_revisions;
    for (const auto& plate : state().plate_session_plates) {
        plate_ids.push_back(plate.id);
        const auto previous = previous_revisions.find(plate.id);
        if (previous != previous_revisions.end() && affected_plate_ids.find(plate.id) == affected_plate_ids.end())
            live_revisions.emplace(plate.id, previous->second);
        else
            live_revisions.emplace(plate.id, allocate_plate_input_stamp(state()));
    }
    state().plate_input_revisions = std::move(live_revisions);
    state().plate_runtime_registry.reconcile_history(plate_ids, affected_plate_ids);
}

void apply_add_plate_transforms(const std::optional<json>& transforms)
{
    if (!transforms) return;
    if (!transforms->is_array()) throw std::runtime_error("invalid add plate transform delta");
    const auto refs = Neo::Bridge::PlateSession::plate_instance_refs();
    using InstanceKey = std::pair<std::size_t, std::size_t>;
    std::map<InstanceKey, const Neo::Bridge::PlateSession::PlateInstanceRef*> refs_by_index;
    for (const auto& ref : refs) refs_by_index.emplace(InstanceKey{ref.object_index, ref.instance_index}, &ref);
    std::set<InstanceKey> seen;
    std::vector<std::pair<const Neo::Bridge::PlateSession::PlateInstanceRef*, const json*>> validated;
    validated.reserve(transforms->size());
    for (const auto& record : *transforms) {
        if (!record.is_object() || !record.contains("instance_id") ||
            !record["instance_id"].is_number_unsigned() || !record.contains("object_id") ||
            !record["object_id"].is_number_unsigned() || !record.contains("object_index") ||
            !record["object_index"].is_number_unsigned() || !record.contains("instance_index") ||
            !record["instance_index"].is_number_unsigned() || !record.contains("world_transform"))
            throw std::runtime_error("invalid add plate transform record");
        const InstanceKey key{record["object_index"].get<std::size_t>(), record["instance_index"].get<std::size_t>()};
        if (!seen.insert(key).second) throw std::runtime_error("duplicate add plate transform record");
        const auto it = refs_by_index.find(key);
        if (it == refs_by_index.end() ||
            it->second->object->id().id != record["object_id"].get<std::size_t>())
            throw std::runtime_error("add plate transform identity is stale");
        validated.emplace_back(it->second, &record["world_transform"]);
    }
    for (const auto& [ref, transform] : validated)
        Neo::Bridge::PlateSession::set_instance_transform(*ref, *transform);
}

json restore_add_plate_frame(const Runtime& runtime, const Neo::History::RestorePlan& plan,
                             const AddPlateHistoryFrame& frame, const json& context)
{
    if (!plan.state.direct_frame || !state().history.can_commit_restore(plan))
        throw std::runtime_error("history restore became stale");
    const double apply_started_at = Neo::Bridge::Performance::now_ms();
    const bool after_state = plan.direct_frame_after;
    const auto& transforms = after_state ? frame.after_transforms : frame.before_transforms;
    // An Add Plate entry retains the predecessor model by shared identity.
    // Leaving that entry can keep the live model and apply only the transform
    // receipt; returning from a later full-model edit stages the retained
    // target first. The plan flag distinguishes that target from a sparse
    // restore even when the complete target model is empty.
    const bool has_model = plan.model_state_present;
    Model before_model = state().model;
    const auto before_plate_session = plate_session_snapshot_json();
    const auto before_overlay = state().project_config_overlay;
    const auto before_filament = runtime.filament_history_state();
    const auto before_plate_revisions = state().plate_input_revisions;
    if (has_model) {
        state().model = Neo::History::Codec::stage_model(state().model, plan.state);
        state().mutable_object_capture_cache.clear();
    }
    try {
        apply_add_plate_transforms(transforms);
        if (!context.contains("plateSession") || !context["plateSession"].is_object())
            throw std::runtime_error("add plate history is missing plate session");
        restore_history_plate_session(context["plateSession"], state().model);
        if (!valid_project_config_overlay(context.value("projectConfigOverlay", empty_project_config_overlay())))
            throw std::runtime_error("invalid add plate project configuration overlay");
        state().project_config_overlay = context["projectConfigOverlay"];
        apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
        Neo::Bridge::PlateSession::normalize_coordinate_arrays(
            state().presets.project_config, state().plate_session_plates.size());
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
        // The persistent target is now committed.  Reconcile runtime Prints
        // by stable plate id, preserving only unchanged plate inputs.
        const auto affected = history_affected_plate_ids(
            before_plate_session, context["plateSession"], std::nullopt, std::nullopt,
            before_filament, context.value("filamentState", before_filament),
            before_overlay, context.value("projectConfigOverlay", empty_project_config_overlay()));
        reconcile_history_runtime_registry(before_plate_revisions, affected);
    } catch (...) {
        if (has_model) {
            state().model = std::move(before_model);
            state().mutable_object_capture_cache.clear();
        }
        throw;
    }
    Neo::Bridge::Performance::record("history_restore", {
        {"delta_apply", Neo::Bridge::Performance::now_ms() - apply_started_at},
        {"total", Neo::Bridge::Performance::now_ms() - apply_started_at},
    });
    Neo::Bridge::PrimeTower::invalidate_projection_cache();
    if (runtime.invalidate_preview) runtime.invalidate_preview();
    HistoryMetadata::advance_history_epoch(state());
    // Entering an Add Plate entry from a later ordinary edit stages the
    // retained predecessor model above.  That is a full model projection,
    // not a delta-only restore: the renderer must replace its structure and
    // meshes, and must not consume the sparse receipt a second time.  Only
    // adjacent direct Add Plate navigation can safely remain model-less.
    const char* model_impact = has_model ? "full" : "none";
    json response_context = context;
    response_context["plateSession"]["input_revisions"] = Neo::Bridge::PlateSession::plate_revisions_json();
    json result{{"ok", true}, {"context", response_context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}, {"direct", true},
                {"impact", {{"version", 1}, {"model", model_impact}, {"plateSession", true},
                            {"filamentRack", false}, {"projectOverlay", true},
                            {"selectionContext", true}, {"primeTower", true},
                            {"preview", "all"}}}};
    if (!has_model && transforms) result["instance_transforms"] = *transforms;
    return result;
}

json transform_json(const Slic3r::Geometry::Transformation& transform)
{
    const auto offset = transform.get_offset();
    const auto rotation = transform.get_rotation();
    const auto scale = transform.get_scaling_factor();
    const auto mirror = transform.get_mirror();
    const auto matrix = transform.get_matrix().matrix();
    return json{{"offset", {offset.x(), offset.y(), offset.z()}},
                {"rotation", {rotation.x(), rotation.y(), rotation.z()}},
                {"scale", {scale.x(), scale.y(), scale.z()}},
                {"mirror", {mirror.x(), mirror.y(), mirror.z()}},
                {"matrix", {matrix(0, 0), matrix(1, 0), matrix(2, 0), matrix(3, 0),
                             matrix(0, 1), matrix(1, 1), matrix(2, 1), matrix(3, 1),
                             matrix(0, 2), matrix(1, 2), matrix(2, 2), matrix(3, 2),
                             matrix(0, 3), matrix(1, 3), matrix(2, 3), matrix(3, 3)}}};
}

static bool transform_geometry_changed(const Slic3r::Geometry::Transformation& before,
                                       const Slic3r::Geometry::Transformation& after)
{
    const auto before_matrix = before.get_matrix().matrix();
    const auto after_matrix = after.get_matrix().matrix();
    for (int column = 0; column < 3; ++column)
        for (int row = 0; row < 3; ++row)
            if (before_matrix(row, column) != after_matrix(row, column)) return true;
    return before_matrix(2, 3) != after_matrix(2, 3);
}

bool sparse_restore(const Neo::History::RestorePlan& plan)
{
    if (!plan.direct_frame_transition || !plan.state.direct_frame) return false;
    const auto kind = plan.state.direct_frame->kind;
    return kind == Neo::History::RestoreState::DirectFrame::Kind::AddPlate ||
        kind == Neo::History::RestoreState::DirectFrame::Kind::Transform;
}

bool transform_restore_targets_live_model(const Neo::History::RestorePlan& plan)
{
    if (plan.model_state_present || !plan.state.direct_frame ||
        plan.state.direct_frame->kind != Neo::History::RestoreState::DirectFrame::Kind::Transform ||
        !plan.state.direct_frame->payload)
        return true;
    const auto frame =
        std::static_pointer_cast<const TransformHistoryFrame>(plan.state.direct_frame->payload);
    if (!frame) return true;
    for (const auto& record : frame->records) {
        const auto object = std::find_if(state().model.objects.begin(), state().model.objects.end(),
            [&record](const ModelObject* candidate) { return candidate->id().id == record.object_id; });
        if (object == state().model.objects.end()) return false;
        const auto volume = std::find_if((*object)->volumes.begin(), (*object)->volumes.end(),
            [&record](const ModelVolume* candidate) { return candidate->id().id == record.volume_id; });
        const auto instance = std::find_if((*object)->instances.begin(), (*object)->instances.end(),
            [&record](const ModelInstance* candidate) { return candidate->id().id == record.instance_id; });
        if (volume == (*object)->volumes.end() || instance == (*object)->instances.end()) return false;
    }
    return true;
}

void rebase_stale_sparse_restore(Neo::History::RestorePlan& plan)
{
    if (!sparse_restore(plan) || transform_restore_targets_live_model(plan)) return;
    if (!state().history.rebase_sparse_restore(plan))
        throw std::runtime_error("sparse history restore became stale");
}

json restore_transform_frame(const Runtime& runtime, const Neo::History::RestorePlan& plan,
                             const TransformHistoryFrame& frame, const json& context)
{
    if (!plan.state.direct_frame || !state().history.can_commit_restore(plan) || frame.records.empty())
        throw std::runtime_error("transform delta history frame is unavailable");
    const bool after_state = plan.direct_frame_after;
    const double apply_started_at = Neo::Bridge::Performance::now_ms();
    const bool has_model = plan.model_state_present;
    std::optional<Model> original_model;
    std::optional<Model> staged_model;
    if (has_model) {
        original_model.emplace(state().model);
        staged_model.emplace(Neo::History::Codec::stage_model(state().model,
            plan.state));
        state().model = std::move(*staged_model);
        state().mutable_object_capture_cache.clear();
    }
    std::vector<std::tuple<ModelObject*, ModelVolume*, ModelInstance*>> targets;
    targets.reserve(frame.records.size());
    std::set<std::tuple<std::size_t, std::size_t, std::size_t>> seen;
    try {
        for (const auto& record : frame.records) {
            if (!seen.emplace(record.object_id, record.volume_id, record.instance_id).second)
                throw std::runtime_error("duplicate transform delta history record");
            ModelObject* object = nullptr;
            if (has_model) {
                if (record.object_index >= state().model.objects.size())
                    throw std::runtime_error("transform delta object index is stale");
                object = state().model.objects[record.object_index];
            } else {
                for (auto* candidate : state().model.objects)
                    if (candidate->id().id == record.object_id) { object = candidate; break; }
                if (!object) throw std::runtime_error("transform delta object identity is stale");
            }
            ModelVolume* volume = nullptr;
            ModelInstance* instance = nullptr;
            if (has_model) {
                if (record.volume_index >= object->volumes.size() || record.instance_index >= object->instances.size())
                    throw std::runtime_error("transform delta member index is stale");
                volume = object->volumes[record.volume_index];
                instance = object->instances[record.instance_index];
            } else {
                for (auto* candidate : object->volumes)
                    if (candidate->id().id == record.volume_id) { volume = candidate; break; }
                for (auto* candidate : object->instances)
                    if (candidate->id().id == record.instance_id) { instance = candidate; break; }
            }
            if (!volume || !instance)
                throw std::runtime_error("transform delta member identity is stale: object=" +
                    std::to_string(record.object_id) + ", volume=" + std::to_string(record.volume_id) +
                    ", instance=" + std::to_string(record.instance_id));
            targets.emplace_back(object, volume, instance);
        }
    } catch (...) {
        if (original_model) state().model = std::move(*original_model);
        throw;
    }
    const auto before_plates = state().plate_session_plates;
    const auto before_current_plate = state().current_plate_id;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_revisions = state().plate_input_revisions;
    const auto before_overlay = state().project_config_overlay;
    const auto before_plate_session = plate_session_snapshot_json();
    const auto before_filament = runtime.filament_history_state();
    std::vector<std::pair<Slic3r::Geometry::Transformation, Slic3r::Geometry::Transformation>> before_transforms;
    before_transforms.reserve(targets.size());
    for (const auto& [object, volume, instance] : targets)
        before_transforms.emplace_back(instance->get_transformation(), volume->get_transformation());
    try {
        for (std::size_t index = 0; index < frame.records.size(); ++index) {
            const auto& record = frame.records[index];
            auto [object, volume, instance] = targets[index];
            instance->set_transformation(after_state ? record.after_instance : record.before_instance);
            volume->set_transformation(after_state ? record.after_volume : record.before_volume);
            object->invalidate_bounding_box();
            object->config.touch();
        }
        Neo::Bridge::PlateSession::rebuild_plate_membership(true);
        if (!context.contains("plateSession") || !context["plateSession"].is_object())
            throw std::runtime_error("transform history is missing plate session");
        restore_history_plate_session(context["plateSession"], state().model);
        if (!valid_project_config_overlay(context.value("projectConfigOverlay", empty_project_config_overlay())))
            throw std::runtime_error("invalid transform project configuration overlay");
        state().project_config_overlay = context["projectConfigOverlay"];
        apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
        Neo::Bridge::PlateSession::normalize_coordinate_arrays(
            state().presets.project_config, state().plate_session_plates.size());
        std::set<std::string> transform_affected;
        std::set<std::size_t> transform_objects;
        for (const auto& record : frame.records) transform_objects.insert(record.object_id);
        add_history_object_plates(transform_affected, transform_objects,
                                  before_plate_session, context["plateSession"]);
        const auto affected = history_affected_plate_ids(
            before_plate_session, context["plateSession"], std::nullopt, std::nullopt,
            before_filament, context.value("filamentState", before_filament),
            before_overlay, context.value("projectConfigOverlay", empty_project_config_overlay()),
            transform_affected);
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
        reconcile_history_runtime_registry(before_revisions, affected);
    } catch (...) {
        if (original_model) state().model = std::move(*original_model);
        else for (std::size_t index = 0; index < targets.size(); ++index) {
                auto [object, volume, instance] = targets[index];
                instance->set_transformation(before_transforms[index].first);
                volume->set_transformation(before_transforms[index].second);
                object->invalidate_bounding_box();
            }
        state().plate_session_plates = before_plates;
        state().current_plate_id = before_current_plate;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().plate_input_revisions = before_revisions;
        state().project_config_overlay = before_overlay;
        throw;
    }
    std::set<std::string> projection_invalidations;
    for (std::size_t index = 0; index < frame.records.size(); ++index) {
        const auto& record = frame.records[index];
        const auto before_it = before_membership.find(record.instance_id);
        const auto after_it = state().instance_plate_ids.find(record.instance_id);
        const std::string before_plate = before_it == before_membership.end() ? std::string{} : before_it->second;
        const std::string after_plate = after_it == state().instance_plate_ids.end() ? std::string{} : after_it->second;
        const auto was_out_of_bounds = [&](const auto& values, const std::string& plate_id) {
            const auto it = values.find(plate_id);
            return it != values.end() && it->second.find(record.instance_id) != it->second.end();
        };
        if (before_plate != after_plate) {
            if (!before_plate.empty()) projection_invalidations.insert(before_plate);
            if (!after_plate.empty()) projection_invalidations.insert(after_plate);
        } else if (!before_plate.empty() &&
                   was_out_of_bounds(before_out_of_bounds, before_plate) !=
                       was_out_of_bounds(state().plate_out_of_bounds_ids, after_plate)) {
            projection_invalidations.insert(before_plate);
        } else if (!before_plate.empty() &&
                   (transform_geometry_changed(record.before_instance, record.after_instance) ||
                    transform_geometry_changed(record.before_volume, record.after_volume))) {
            projection_invalidations.insert(before_plate);
        }
    }
    if (!projection_invalidations.empty())
        Neo::Bridge::PrimeTower::invalidate_projection_cache(projection_invalidations);
    if (runtime.invalidate_preview) runtime.invalidate_preview();
    HistoryMetadata::advance_history_epoch(state());
    json records = json::array();
    for (const auto& record : frame.records)
        records.push_back({{"object_id", record.object_id}, {"volume_id", record.volume_id},
                           {"instance_id", record.instance_id}, {"object_index", record.object_index},
                           {"volume_index", record.volume_index}, {"instance_index", record.instance_index},
                           {"instance_transform", transform_json(after_state ? record.after_instance : record.before_instance)},
                           {"volume_transform", transform_json(after_state ? record.after_volume : record.before_volume)}});
    Neo::Bridge::Performance::record("history_restore", {
        {"delta_apply", Neo::Bridge::Performance::now_ms() - apply_started_at},
        {"total", Neo::Bridge::Performance::now_ms() - apply_started_at},
    });
    json response_context = context;
    response_context["plateSession"]["input_revisions"] = Neo::Bridge::PlateSession::plate_revisions_json();
    return json{{"ok", true}, {"context", response_context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}, {"direct", true}, {"narrow", true},
                {"transform_receipt", {{"version", 1}, {"state", after_state ? "after" : "before"},
                                        {"before_revision", frame.before_revision},
                                        {"after_revision", frame.after_revision}, {"records", records}}},
                {"impact", {{"version", 1}, {"model", "full"}, {"plateSession", true},
                            {"filamentRack", false}, {"projectOverlay", true}, {"selectionContext", true},
                            {"primeTower", true}, {"preview", "all"}}}};
}

void validate_filament_history_mutable_state(PresetBundle& catalog, const Neo::Bridge::Filament::State::StagedMutableState& staged,
                                             Model& model, const std::vector<BridgeState::PlateSessionPlate>& plates,
                                             const json& overlay)
{
    const auto& printer = catalog.printers.get_edited_preset().config;
    validate_filament_candidate_components(staged.names, staged.project_config, printer,
        std::max(1, catalog.get_printer_extruder_count()),
        printer.opt_bool("single_extruder_multi_material") || catalog.is_bbl_vendor(),
        model, plates, overlay);
}

void restore_history_transaction_state(const json& context, const Neo::History::ModelState& model)
{
    if (!context.contains("filamentState"))
        throw std::runtime_error("history transaction is missing filament state");
    auto staged_filament_state = stage_mutable(state().presets, context["filamentState"]);
    auto staged_model = Neo::History::Codec::model_state_equal(
        capture_model_state(state().model, state().mesh_capture_cache,
                            state().mutable_object_capture_cache), model)
        ? Model(state().model) : Neo::History::Codec::stage_model(state().model, {model, {}, {}});
    auto staged_plates = state().plate_session_plates;
    if (context.contains("plateSession")) staged_plates = build_history_plate_session(context["plateSession"], staged_model);
    apply_plate_overlay_to_configs(staged_plates, context.value("projectConfigOverlay", empty_project_config_overlay()));
    validate_filament_history_mutable_state(state().presets, staged_filament_state, staged_model, staged_plates,
                                            context.value("projectConfigOverlay", empty_project_config_overlay()));
    auto before_filament_state = stage_mutable(state().presets, history_state_json(state().presets));
    const auto before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    apply_mutable(state(), state().presets, std::move(staged_filament_state));
    state().model = std::move(staged_model);
    // A restore replaces every ModelObject. Do not let a prior live-model
    // record match a newly materialized object with a coincident timestamp.
    state().mutable_object_capture_cache.clear();
    try {
        if (context.contains("plateSession")) restore_history_plate_session(context["plateSession"], state().model);
        if (valid_project_config_overlay(context["projectConfigOverlay"]))
            state().project_config_overlay = context["projectConfigOverlay"];
        apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
        Neo::Bridge::PlateSession::normalize_coordinate_arrays(
            state().presets.project_config, state().plate_session_plates.size());
    } catch (...) {
        apply_mutable(state(), state().presets, std::move(before_filament_state));
        state().model = before_model;
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        throw;
    }
}

// Move transactions intentionally do not capture a full ModelState.  Abort
// must therefore use the sparse native receipt, just like Undo/Redo, instead
// of sending the empty delta candidate through the full restore path.
void restore_transform_transaction_state(const BridgeState::HistoryTransaction& tx)
{
    std::vector<std::tuple<ModelObject*, ModelVolume*, ModelInstance*>> targets;
    targets.reserve(tx.transform_records.size());
    for (const auto& record : tx.transform_records) {
        if (record.object_index >= state().model.objects.size())
            throw std::runtime_error("transform abort object identity is stale");
        auto* object = state().model.objects[record.object_index];
        if (object->id().id != record.object_id ||
            record.volume_index >= object->volumes.size() ||
            record.instance_index >= object->instances.size())
            throw std::runtime_error("transform abort target identity is stale");
        auto* volume = object->volumes[record.volume_index];
        auto* instance = object->instances[record.instance_index];
        if (volume->id().id != record.volume_id || instance->id().id != record.instance_id)
            throw std::runtime_error("transform abort target identity is stale");
        targets.emplace_back(object, volume, instance);
    }
    for (std::size_t index = 0; index < tx.transform_records.size(); ++index) {
        const auto& record = tx.transform_records[index];
        auto [object, volume, instance] = targets[index];
        instance->set_transformation(record.before_instance);
        volume->set_transformation(record.before_volume);
        object->invalidate_bounding_box();
    }
    Neo::Bridge::PlateSession::rebuild_plate_membership(true);
    if (!tx.before_context.contains("plateSession") || !tx.before_context["plateSession"].is_object())
        throw std::runtime_error("transform abort is missing plate session");
    restore_history_plate_session(tx.before_context["plateSession"], state().model);
    if (!valid_project_config_overlay(tx.before_context.value("projectConfigOverlay", empty_project_config_overlay())))
        throw std::runtime_error("transform abort has invalid project configuration overlay");
    state().project_config_overlay = tx.before_context["projectConfigOverlay"];
    apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
    Neo::Bridge::PlateSession::normalize_coordinate_arrays(
        state().presets.project_config, state().plate_session_plates.size());
}

void validate_direct_frame(const DirectHistoryFrame& frame, const json& context)
{
    if (!frame.model || frame.filament_presets.empty() || frame.filament_presets.size() > 64 || frame.plates.empty())
        throw std::runtime_error("invalid direct filament history frame");
    for (const auto& name : frame.filament_presets)
        if (name.empty() || state().presets.filaments.find_preset(name, false, true) == nullptr)
            throw std::runtime_error("direct history filament preset is unavailable");
    if (!context.contains("plateSession")) throw std::runtime_error("direct history frame is missing plate session");
    validate_history_plate_session(context["plateSession"], *frame.model);
    if (!valid_project_config_overlay(frame.overlay)) throw std::runtime_error("invalid direct history project configuration overlay");
    if (std::none_of(frame.plates.begin(), frame.plates.end(), [&](const auto& plate) { return plate.id == frame.current_plate_id; }))
        throw std::runtime_error("direct history current plate is unavailable");
}

json restore_direct_frame(const Runtime& runtime, const Neo::History::RestorePlan& plan, const json& context)
{
    if (!plan.state.direct_frame || plan.state.direct_frame->kind != History::RestoreState::DirectFrame::Kind::Filament ||
        !plan.state.direct_frame->payload || plan.state.direct_frame->bytes == 0)
        throw std::runtime_error("direct history frame is unavailable");
    const auto frame = std::static_pointer_cast<const DirectHistoryFrame>(plan.state.direct_frame->payload);
    if (!frame) throw std::runtime_error("direct history frame is unavailable");
    validate_direct_frame(*frame, context);
    auto staged_filament_presets = frame->filament_presets;
    auto staged_project_config = frame->project_config;
    auto staged_ams_colours = frame->ams_multi_colour_filment;
    if (!frame->edited_filament) throw std::runtime_error("direct history edited filament preset is unavailable");
    auto staged_edited_filament = *frame->edited_filament;
    Model staged_model = *frame->model;
    auto staged_plates = frame->plates;
    auto staged_overlay = frame->overlay;
    auto staged_membership = frame->instance_plate_ids;
    auto staged_out_of_bounds = frame->plate_out_of_bounds_ids;
    auto staged_parked = frame->parked_instance_ids;
    auto staged_pending = frame->pending_membership_instance_ids;
    const auto staged_current_plate = frame->current_plate_id;
    const auto staged_colour_index = frame->next_filament_colour_index;
    if (!state().history.can_commit_restore(plan)) throw std::runtime_error("history restore became stale");

    const auto before_filament_presets = state().presets.filament_presets;
    const auto before_project_config = state().presets.project_config;
    const auto before_ams_colours = state().presets.ams_multi_color_filment;
    const auto before_edited = state().presets.filaments.get_edited_preset();
    Model before_model = state().model;
    const auto before_plate_session = plate_session_snapshot_json();
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    const auto before_plate_revisions = state().plate_input_revisions;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_current_plate = state().current_plate_id;
    const auto before_colour_index = state().next_filament_colour_index;
    try {
        state().presets.filament_presets = std::move(staged_filament_presets);
        state().presets.project_config = std::move(staged_project_config);
        state().presets.ams_multi_color_filment = std::move(staged_ams_colours);
        state().presets.filaments.get_edited_preset() = std::move(staged_edited_filament);
        state().model = std::move(staged_model);
        state().mutable_object_capture_cache.clear();
        state().plate_session_plates = std::move(staged_plates);
        state().project_config_overlay = std::move(staged_overlay);
        apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
        Neo::Bridge::PlateSession::normalize_coordinate_arrays(
            state().presets.project_config, state().plate_session_plates.size());
        state().instance_plate_ids = std::move(staged_membership);
        state().plate_out_of_bounds_ids = std::move(staged_out_of_bounds);
        state().parked_instance_ids = std::move(staged_parked);
        state().pending_membership_instance_ids = std::move(staged_pending);
        state().current_plate_id = staged_current_plate;
        state().next_filament_colour_index = staged_colour_index;
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
        std::set<std::string> direct_affected;
        for (const auto& plate : before_plate_session["plates"])
            direct_affected.insert(plate["plate_id"].get<std::string>());
        for (const auto& plate : context["plateSession"]["plates"])
            direct_affected.insert(plate["plate_id"].get<std::string>());
        const auto affected = history_affected_plate_ids(
            before_plate_session, context["plateSession"], std::nullopt, std::nullopt,
            runtime.filament_history_state(), context.value("filamentState", json()),
            before_overlay, context.value("projectConfigOverlay", empty_project_config_overlay()),
            direct_affected);
        reconcile_history_runtime_registry(before_plate_revisions, affected);
        ++state().history_minimal_mutable_restore_count;
    } catch (...) {
        state().presets.filament_presets = before_filament_presets;
        state().presets.project_config = before_project_config;
        state().presets.ams_multi_color_filment = before_ams_colours;
        state().presets.filaments.get_edited_preset() = before_edited;
        state().model = std::move(before_model);
        state().mutable_object_capture_cache.clear();
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        state().plate_input_revisions = before_plate_revisions;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().current_plate_id = before_current_plate;
        state().next_filament_colour_index = before_colour_index;
        throw;
    }
    Neo::Bridge::PrimeTower::invalidate_projection_cache();
    if (runtime.invalidate_preview) runtime.invalidate_preview();
    HistoryMetadata::advance_history_epoch(state());
    json response_context = context;
    response_context["plateSession"]["input_revisions"] = Neo::Bridge::PlateSession::plate_revisions_json();
    return json{{"ok", true}, {"context", response_context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}, {"direct", true},
                // A direct filament frame still replaces a complete native
                // model/session. Keep its renderer descriptor conservative.
                {"impact", {{"version", 1}, {"model", "full"}, {"plateSession", true},
                            {"filamentRack", true}, {"projectOverlay", true}, {"selectionContext", true},
                            {"primeTower", true}, {"preview", "all"}}}};
}

json restore_prime_tower_frame(const Runtime& runtime, const Neo::History::RestorePlan& plan,
                               const NarrowHistoryFrame& frame)
{
    const auto valid_footprint = [](const NarrowHistoryFrame::Footprint& footprint) {
        return std::isfinite(footprint.min_x) && std::isfinite(footprint.max_x) &&
            std::isfinite(footprint.min_y) && std::isfinite(footprint.max_y) &&
            footprint.min_x <= footprint.max_x && footprint.min_y <= footprint.max_y;
    };
    if (frame.plate_id.empty() || !frame.before_x.option_present || !frame.before_y.option_present ||
        !frame.after_x.option_present || !frame.after_y.option_present ||
        !frame.before_x.value || !frame.before_y.value || !frame.after_x.value || !frame.after_y.value)
        throw std::runtime_error("invalid prime tower narrow history frame");
    if (!state().history.can_commit_restore(plan)) throw std::runtime_error("history restore became stale");
    auto plate_it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
        [&](const auto& plate) { return plate.id == frame.plate_id; });
    if (plate_it == state().plate_session_plates.end()) throw std::runtime_error("prime tower history plate is unavailable");
    const auto& x = frame.after_state ? frame.after_x : frame.before_x;
    const auto& y = frame.after_state ? frame.after_y : frame.before_y;
    const auto& footprint = frame.after_state ? frame.after_footprint : frame.before_footprint;
    // The frame revision is historical metadata only.  A restore is a new
    // runtime input event and must receive a fresh session stamp.
    if (!valid_footprint(footprint)) throw std::runtime_error("invalid prime tower narrow history footprint");
    const auto receipt_coordinate = [](const std::string& serialized) {
        try {
            const double coordinate = std::stod(serialized);
            if (std::isfinite(coordinate)) return coordinate;
        } catch (...) {}
        throw std::runtime_error("invalid prime tower narrow history coordinate");
    };
    // Validate these before commit_restore. Publication must never fail after
    // the cursor has advanced merely because its receipt was malformed.
    const double receipt_x = receipt_coordinate(*x.value);
    const double receipt_y = receipt_coordinate(*y.value);
    const std::size_t plate_index = static_cast<std::size_t>(
        std::distance(state().plate_session_plates.begin(), plate_it));
    const auto before_settings = Neo::Bridge::PrimeTower::snapshot_coordinate_settings(
        state().presets.project_config, plate_index);
    const auto before_revision = state().plate_input_revisions[frame.plate_id];
    try {
        Neo::Bridge::PrimeTower::restore_coordinate_settings(state().presets.project_config,
            {x, y}, plate_index, 15., 220.);
        state().project_config_overlay["project"]["wipe_tower_x"] =
            state().presets.project_config.option("wipe_tower_x")->serialize();
        state().project_config_overlay["project"]["wipe_tower_y"] =
            state().presets.project_config.option("wipe_tower_y")->serialize();
        state().plate_input_revisions[frame.plate_id] = allocate_plate_input_stamp(state());
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
    } catch (...) {
        Neo::Bridge::PrimeTower::restore_coordinate_settings(
            state().presets.project_config, before_settings, plate_index, 15., 220.);
        state().project_config_overlay["project"]["wipe_tower_x"] =
            state().presets.project_config.option("wipe_tower_x")->serialize();
        state().project_config_overlay["project"]["wipe_tower_y"] =
            state().presets.project_config.option("wipe_tower_y")->serialize();
        state().plate_input_revisions[frame.plate_id] = before_revision;
        throw;
    }
    // The narrow frame rewrites only this plate's tower coordinates. Preserve
    // every unrelated plate projection, but never let the target plate reuse
    // the pre-restore JSON after Undo or Redo.
    Neo::Bridge::PrimeTower::invalidate_projection_cache({frame.plate_id});
    // History never retains slice products. A Prime Tower restore always
    // invalidates the target plate if it is the currently retained result;
    // an unrelated plate's real result is left untouched.
    state().plate_runtime_registry.invalidate_presentations({frame.plate_id});
    if (state().current_plate_id == frame.plate_id) {
        // This is deliberately after commit_restore but cannot throw: the
        // history cursor must not advance without the target result becoming
        // invalid, and cleanup must not report a failure after publication.
        try { Neo::Bridge::SlicingPipeline::invalidate_preview_result_only(); } catch (...) {}
        try { if (runtime.invalidate_preview) runtime.invalidate_preview(); } catch (...) {}
    }
    HistoryMetadata::advance_history_epoch(state());
    // This is a post-commit, frame-owned receipt. It intentionally contains no
    // renderer projection, model, or inferred live state; a later collection
    // patch may consume it without requesting every plate's tower projection.
    return json{{"ok", true}, {"context", current_context(runtime)},
                {"status", history_status_json()}, {"entryId", history_entry_id(plan.state.entry.id)},
                {"direct", true}, {"narrow", true},
                {"prime_tower_receipt", {{"version", 1}, {"state", "available"},
                    {"plate_id", frame.plate_id}, {"revision", state().plate_input_revisions[frame.plate_id]},
                    {"position", {{"x", receipt_x}, {"y", receipt_y}}},
                    {"footprint", {{"min_x", footprint.min_x}, {"max_x", footprint.max_x},
                                    {"min_y", footprint.min_y}, {"max_y", footprint.max_y}}}}},
                // This receipt is created after commit_restore. It is the sole
                // authority for skipping the expensive model/GL projection.
                {"impact", {{"version", 1}, {"model", "none"}, {"plateSession", true},
                            {"filamentRack", false}, {"projectOverlay", true}, {"selectionContext", true},
                            {"primeTower", true}, {"preview", "current-plate"}}}};
}

json restore_result(const Runtime& runtime, const Neo::History::RestorePlan& plan,
                    std::optional<std::string>* serialized_full_response)
{
    const auto parsed = json::parse(std::string(plan.state.context.begin(), plan.state.context.end()));
    if (plan.direct_frame_transition && plan.state.direct_frame &&
        plan.state.direct_frame->kind == History::RestoreState::DirectFrame::Kind::PrimeTower) {
        if (!plan.state.direct_frame->payload || plan.state.direct_frame->bytes == 0)
            throw std::runtime_error("prime tower narrow history frame is unavailable");
        const auto frame = std::static_pointer_cast<const NarrowHistoryFrame>(plan.state.direct_frame->payload);
        if (!frame) throw std::runtime_error("prime tower narrow history frame is unavailable");
        if (plan.target_cursor < plan.from_cursor) {
            auto before = *frame;
            before.after_state = false;
            return restore_prime_tower_frame(runtime, plan, before);
        }
        return restore_prime_tower_frame(runtime, plan, *frame);
    }
    if (plan.direct_frame_transition && plan.state.direct_frame &&
        plan.state.direct_frame->kind == History::RestoreState::DirectFrame::Kind::AddPlate) {
        if (!plan.state.direct_frame->payload || plan.state.direct_frame->bytes == 0)
            throw std::runtime_error("add plate delta history frame is unavailable");
        const auto frame = std::static_pointer_cast<const AddPlateHistoryFrame>(plan.state.direct_frame->payload);
        if (!frame) throw std::runtime_error("add plate delta history frame is unavailable");
        const auto context = parse_history_context(parsed.dump().c_str());
        return restore_add_plate_frame(runtime, plan, *frame, context);
    }
    if (plan.direct_frame_transition && plan.state.direct_frame &&
        plan.state.direct_frame->kind == History::RestoreState::DirectFrame::Kind::Transform) {
        if (!plan.state.direct_frame->payload || plan.state.direct_frame->bytes == 0)
            throw std::runtime_error("transform delta history frame is unavailable");
        const auto frame = std::static_pointer_cast<const TransformHistoryFrame>(plan.state.direct_frame->payload);
        if (!frame) throw std::runtime_error("transform delta history frame is unavailable");
        const auto context = parse_history_context(parsed.dump().c_str());
        return restore_transform_frame(runtime, plan, *frame, context);
    }
    const json context = parse_history_context(parsed.dump().c_str());
    if (plan.state.direct_frame &&
        plan.state.direct_frame->kind == History::RestoreState::DirectFrame::Kind::Filament)
        return restore_direct_frame(runtime, plan, context);
    const double restore_started_at = Neo::Bridge::Performance::now_ms();
    Neo::History::Codec::RestoreTimings restore_timings;
    const double equality_started_at = Neo::Bridge::Performance::now_ms();
    const auto live_model_state = capture_model_state(
        state().model, state().mesh_capture_cache, state().mutable_object_capture_cache);
    const bool model_matches_target = Neo::History::Codec::model_state_equal(live_model_state, plan.state.model);
    restore_timings.capture_model_equality_check_ms =
        Neo::Bridge::Performance::now_ms() - equality_started_at;
    Model staged_model = model_matches_target
        ? Model(state().model) : Neo::History::Codec::stage_model(state().model, plan.state, &restore_timings);
    if (!context.contains("filamentState")) throw std::runtime_error("history context is missing filament state");
    const bool filament_changed = history_state_json(state().presets) != context["filamentState"];
    std::optional<Neo::Bridge::Filament::State::StagedMutableState> staged_filament_state;
    if (filament_changed) staged_filament_state.emplace(stage_mutable(state().presets, context["filamentState"]));
    auto staged_plates = state().plate_session_plates;
    if (context.contains("plateSession")) staged_plates = build_history_plate_session(context["plateSession"], staged_model);
    apply_plate_overlay_to_configs(staged_plates, context.value("projectConfigOverlay", empty_project_config_overlay()));
    if (staged_filament_state)
        validate_filament_history_mutable_state(state().presets, *staged_filament_state, staged_model, staged_plates,
                                                context.value("projectConfigOverlay", empty_project_config_overlay()));
    else
        validate_filament_candidate(state().presets, staged_model, staged_plates,
                                    context.value("projectConfigOverlay", empty_project_config_overlay()), false);
    if (!state().history.can_commit_restore(plan)) throw std::runtime_error("history restore became stale");
    std::optional<Neo::Bridge::Filament::State::StagedMutableState> before_filament_state;
    const auto before_filament_json = history_state_json(state().presets);
    if (filament_changed) before_filament_state.emplace(stage_mutable(state().presets, history_state_json(state().presets)));
    Model before_model = state().model;
    const auto before_plate_session = plate_session_snapshot_json();
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    const auto before_plate_revisions = state().plate_input_revisions;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_current_plate = state().current_plate_id;
    if (staged_filament_state) apply_mutable(state(), state().presets, std::move(*staged_filament_state));
    state().model = std::move(staged_model);
    state().mutable_object_capture_cache.clear();
    const double plate_restore_started_at = Neo::Bridge::Performance::now_ms();
    try {
        if (context.contains("plateSession")) restore_history_plate_session(context["plateSession"], state().model);
        if (valid_project_config_overlay(context["projectConfigOverlay"])) state().project_config_overlay = context["projectConfigOverlay"];
        apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
        Neo::Bridge::PlateSession::normalize_coordinate_arrays(
            state().presets.project_config, state().plate_session_plates.size());
        restore_timings.plate_session_project_overlay_restore_ms =
            Neo::Bridge::Performance::now_ms() - plate_restore_started_at;
        const double cursor_commit_started_at = Neo::Bridge::Performance::now_ms();
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
        restore_timings.history_cursor_commit_ms =
            Neo::Bridge::Performance::now_ms() - cursor_commit_started_at;
        const auto affected = history_affected_plate_ids(
            before_plate_session, context.value("plateSession", json::object()),
            live_model_state, plan.state.model,
            before_filament_json, context.value("filamentState", json()),
            before_overlay, context.value("projectConfigOverlay", empty_project_config_overlay()));
        reconcile_history_runtime_registry(before_plate_revisions, affected);
    } catch (...) {
        if (before_filament_state) apply_mutable(state(), state().presets, std::move(*before_filament_state));
        state().model = std::move(before_model);
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        state().plate_input_revisions = before_plate_revisions;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().current_plate_id = before_current_plate;
        state().mutable_object_capture_cache.clear();
        throw;
    }
    Neo::Bridge::PrimeTower::invalidate_projection_cache();
    if (runtime.invalidate_preview) runtime.invalidate_preview();
    HistoryMetadata::advance_history_epoch(state());
    json response_context = context;
    response_context["plateSession"]["input_revisions"] = Neo::Bridge::PlateSession::plate_revisions_json();
    json result{{"ok", true}, {"context", response_context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)},
                // A full restore may have changed any model-owned domain. Do
                // not infer narrower effects from React's prior projection.
                {"impact", {{"version", 1}, {"model", "full"}, {"plateSession", true},
                            {"filamentRack", true}, {"projectOverlay", true}, {"selectionContext", true},
                            {"primeTower", true}, {"preview", "all"}}}};
    const double response_started_at = Neo::Bridge::Performance::now_ms();
    const std::string response_text = result.dump();
    const double response_json_serialization_ms = Neo::Bridge::Performance::now_ms() - response_started_at;
    Neo::Bridge::Performance::record("history_restore", {
        {"capture_model_equality_check", restore_timings.capture_model_equality_check_ms},
        {"model_staging_deserialization", restore_timings.model_staging_deserialization_ms},
        {"immutable_mesh_reconnect", restore_timings.immutable_mesh_reconnect_ms},
        {"plate_session_project_overlay_restore", restore_timings.plate_session_project_overlay_restore_ms},
        {"history_cursor_commit", restore_timings.history_cursor_commit_ms},
        {"response_json_serialization", response_json_serialization_ms},
        {"total", Neo::Bridge::Performance::now_ms() - restore_started_at},
    });
    *serialized_full_response = response_text;
    return result;
}

const char* restore_failure(const std::string& message)
{
    return duplicate_json(json{{"ok", false}, {"error", {{"code", "restore-failed"}, {"message", message}, {"retryable", true}}},
                               {"status", history_status_json()}}.dump());
}

} // namespace

json default_history_context(const Runtime& runtime)
{
    return current_context(runtime);
}

json canonical_history_context(const Runtime& runtime, json context)
{
    return Neo::Bridge::HistoryMetadata::canonical_history_context(
        state(), std::move(context), plate_session_snapshot_json(), runtime.filament_history_state());
}

} // namespace Slic3r::Neo::Bridge::HistoryRuntime

namespace {

// The native adapter uses the same archive boundary as Orca's object history:
// mutable ModelObject records contain references to immutable meshes, while
// mesh bytes are retained once by ProjectHistory's immutable data store.
struct NeoHistoryArchiveContext {
    std::map<const Slic3r::TriangleMesh*, std::string> output_mesh_keys;
    std::map<std::string, std::shared_ptr<const Slic3r::TriangleMesh>> input_meshes;
};
using NeoHistoryOutputArchive = cereal::UserDataAdapter<NeoHistoryArchiveContext, cereal::BinaryOutputArchive>;
using NeoHistoryInputArchive = cereal::UserDataAdapter<NeoHistoryArchiveContext, cereal::BinaryInputArchive>;

} // namespace

namespace cereal {

inline void save(BinaryOutputArchive& archive,
                 const std::shared_ptr<const Slic3r::TriangleMesh>& mesh)
{
    if (!mesh) {
        archive(std::string{});
        return;
    }
    const auto& keys = cereal::get_user_data<NeoHistoryArchiveContext>(archive).output_mesh_keys;
    const auto it = keys.find(mesh.get());
    if (it == keys.end()) throw std::runtime_error("history mesh reference is unavailable");
    archive(it->second);
}

inline void load(BinaryInputArchive& archive,
                 std::shared_ptr<const Slic3r::TriangleMesh>& mesh)
{
    std::string key;
    archive(key);
    if (key.empty()) {
        mesh.reset();
        return;
    }
    const auto& meshes = cereal::get_user_data<NeoHistoryArchiveContext>(archive).input_meshes;
    const auto it = meshes.find(key);
    if (it == meshes.end()) throw std::runtime_error("history mesh data is unavailable");
    mesh = it->second;
}

template<class T>
inline void save(BinaryOutputArchive& archive, T* const& object)
{
    const bool present = object != nullptr;
    archive(present);
    if (present) archive(*object);
}

template<class T>
inline void load(BinaryInputArchive& archive, T*& object)
{
    bool present = false;
    archive(present);
    object = present ? cereal::access::construct<T>() : nullptr;
    if (object) archive(*object);
}

template<class T>
inline void save_by_value(BinaryOutputArchive& archive, const T& value)
{
    archive(value);
}

template<class T>
inline void load_by_value(BinaryInputArchive& archive, T& value)
{
    archive(value);
}

template<class T>
inline void save_optional(BinaryOutputArchive& archive, const std::shared_ptr<const T>&)
{
    // Optional native caches such as convex hulls are deliberately omitted;
    // ModelVolume::load() reconstructs them from the retained mesh.
    archive(false);
}

template<class T>
inline void load_optional(BinaryInputArchive& archive, std::shared_ptr<const T>& value)
{
    bool present = false;
    archive(present);
    if (present) archive(value);
    else value.reset();
}

template <class Archive> struct specialize<Archive, Slic3r::ModelInstance*, specialization::non_member_load_save> {};
template <class Archive> struct specialize<Archive, Slic3r::ModelVolume*, specialization::non_member_load_save> {};
template <class Archive> struct specialize<Archive, std::shared_ptr<const Slic3r::TriangleMesh>, specialization::non_member_load_save> {};

} // namespace cereal

namespace Slic3r::Neo::History::Codec {
namespace {

std::string mesh_key(const TriangleMesh& mesh)
{
    // Keys are session-local references into the native owner retained by the
    // ModelState. Include the address so two independent shared owners with
    // equal geometry cannot be accidentally coalesced; the same owner keeps
    // its key across cache clears and repeated captures.
    return std::string("mesh-") + std::to_string(
        reinterpret_cast<std::uintptr_t>(&mesh));
}

} // namespace

ModelState capture_model_state(const Model& model)
{
    MeshCaptureCache cache;
    return capture_model_state(model, cache);
}

ModelState capture_model_state(const Model& model, MeshCaptureCache& mesh_cache)
{
    MutableObjectCaptureCache object_cache;
    return capture_model_state(model, mesh_cache, object_cache);
}

ModelState capture_model_state(const Model& model, MeshCaptureCache& mesh_cache,
                               MutableObjectCaptureCache& object_cache)
{
    return capture_model_state(model, mesh_cache, object_cache, nullptr);
}

ModelState capture_model_state(const Model& model, MeshCaptureCache& mesh_cache,
                               MutableObjectCaptureCache& object_cache,
                               CaptureTimings* timings)
{
    const double total_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    NeoHistoryArchiveContext archive_context;
    std::map<std::string, MeshCaptureCache::MeshPtr> native_meshes_by_key;
    std::set<MeshCaptureCache::MeshPtr, std::owner_less<MeshCaptureCache::MeshPtr>> live_meshes;
    const double collection_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    for (const auto* object : model.objects) {
        for (const auto* volume : object->volumes) {
            const auto mesh = volume->get_mesh_shared_ptr();
            if (!mesh) continue;
            live_meshes.emplace(mesh);
            if (const auto* cached = mesh_cache.find(mesh)) {
                archive_context.output_mesh_keys.emplace(mesh.get(), cached->key);
                native_meshes_by_key.emplace(cached->key, mesh);
                continue;
            }
            if (archive_context.output_mesh_keys.count(mesh.get())) continue;
            // The native owner is the retained history payload.  Do not
            // serialize a fallback blob during ordinary in-session capture.
            const auto key = mesh_key(*mesh);
            archive_context.output_mesh_keys.emplace(mesh.get(), key);
            mesh_cache.insert(mesh, {key});
            native_meshes_by_key.emplace(key, mesh);
        }
    }
    if (timings) timings->collection_cache_ms += Neo::Bridge::Performance::now_ms() - collection_started_at;
    const double immutable_retention_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    mesh_cache.retain_only(live_meshes);
    if (timings) timings->immutable_mesh_retention_ms += Neo::Bridge::Performance::now_ms() - immutable_retention_started_at;

    ModelState result;
    // Restoration is driven entirely by ObjectID-keyed mutable records and
    // shared immutable mesh records. No complete-model archive is retained as
    // a per-entry equality or restore payload.
    result.mutable_objects.reserve(model.objects.size());
    InstanceIdentityGraph instance_identity_graph;
    std::set<Neo::History::ObjectID> live_object_ids;
    const double object_collection_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    for (const auto* object : model.objects) live_object_ids.insert(object->id().id);
    object_cache.retain_only(live_object_ids);
    if (timings) timings->collection_cache_ms += Neo::Bridge::Performance::now_ms() - object_collection_started_at;
    for (const auto* object : model.objects) {
        const double object_iteration_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
        std::vector<Neo::History::ObjectID> volume_ids;
        volume_ids.reserve(object->volumes.size());
        std::vector<MutableObjectCaptureCache::MeshPtr> object_meshes;
        object_meshes.reserve(object->volumes.size());
        for (const ModelVolume* volume : object->volumes) {
            volume_ids.push_back(volume->id().id);
            object_meshes.push_back(volume->get_mesh_shared_ptr());
        }
        const InstanceIDs captured_instance_ids = instance_identity_graph.capture(*object);
        std::vector<Neo::History::ObjectID> instance_ids;
        instance_ids.reserve(captured_instance_ids.size());
        for (const ::Slic3r::ObjectID id : captured_instance_ids)
            instance_ids.push_back(id.id);
        // ModelObject derives from ObjectBase (whose timestamp is zero); use
        // the mutable object configuration timestamp as the Orca gate.
        const auto timestamp = static_cast<const ModelConfig&>(object->config).timestamp();
        const auto* cached = object_cache.find(
            object->id().id, timestamp, object_meshes, volume_ids, instance_ids);
        if (timings) timings->collection_cache_ms += Neo::Bridge::Performance::now_ms() - object_iteration_started_at;
        const double mutable_archive_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
        Bytes object_bytes;
        if (cached) {
            object_bytes = *cached->bytes;
            object_cache.record_reuse();
        } else {
            std::ostringstream stream(std::ios::binary | std::ios::out);
            NeoHistoryOutputArchive archive(archive_context, stream);
            archive(*object);
            const std::string encoded = stream.str();
            object_bytes.assign(encoded.begin(), encoded.end());
            object_cache.insert(object->id().id, timestamp,
                                std::make_shared<const Bytes>(object_bytes), object_meshes,
                                volume_ids, instance_ids);
        }
        result.mutable_objects.push_back({
            object->id().id, timestamp, std::move(object_bytes), std::move(volume_ids),
            std::move(instance_ids)});
        if (timings) timings->mutable_object_archive_ms += Neo::Bridge::Performance::now_ms() - mutable_archive_started_at;
    }
    const double immutable_result_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    result.immutable_meshes.reserve(native_meshes_by_key.size());
    for (auto& [key, mesh] : native_meshes_by_key) {
        const std::size_t native_bytes = mesh ? mesh->memsize() : 0;
        result.immutable_meshes.push_back({std::move(key), {}, {}, false, std::move(mesh), native_bytes});
    }
    if (timings) {
        timings->immutable_mesh_retention_ms += Neo::Bridge::Performance::now_ms() - immutable_result_started_at;
        timings->total_ms = Neo::Bridge::Performance::now_ms() - total_started_at;
    }
    return result;
}

Model stage_model(const Model& model_template, const RestoreState& restored,
                  RestoreTimings* timings)
{
    NeoHistoryArchiveContext archive_context;
    const double mesh_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    for (const auto& mesh : restored.model.immutable_meshes) {
        if (mesh.native) {
            archive_context.input_meshes.emplace(mesh.key, mesh.native);
            continue;
        }
        const auto& encoded = mesh.resident ? *mesh.resident : (mesh.deferred ? *mesh.deferred : Bytes{});
        if (encoded.empty()) throw std::runtime_error("history mesh data is unavailable");
        std::string bytes(encoded.begin(), encoded.end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        auto native_mesh = std::make_shared<TriangleMesh>();
        cereal::BinaryInputArchive archive(stream);
        archive(*native_mesh);
        archive_context.input_meshes.emplace(mesh.key, std::move(native_mesh));
    }
    if (timings)
        timings->immutable_mesh_reconnect_ms += Neo::Bridge::Performance::now_ms() - mesh_started_at;
    // ModelVolume's upstream undo archive deliberately omits ObjectBase, so
    // deserializing an object creates volumes with invalid IDs. Re-encode each
    // decoded volume into a normal ModelObject-created volume: the latter owns
    // a valid runtime ID while the archive restores every mutable field and
    // reconnects the retained immutable mesh.
    for (const auto& [key, mesh] : archive_context.input_meshes)
        archive_context.output_mesh_keys.emplace(mesh.get(), key);

    // Deserialize into a transient model and let Model's copy assignment
    // rebuild ModelObject-owned volume/instance links. The transient is not
    // retained by history; ProjectHistory owns only the keyed byte versions.
    const double mutable_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    Model rebuilt_model = model_template;
    rebuilt_model.clear_objects();
    InstanceIdentityGraph instance_identity_graph;
    for (const auto& object : restored.model.mutable_objects) {
        if (object.data.empty()) throw std::runtime_error("history object data is unavailable");
        std::string bytes(object.data.begin(), object.data.end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        ModelObject* native_object = rebuilt_model.add_object();
        NeoHistoryInputArchive archive(archive_context, stream);
        archive(*native_object);
        if (object.id == 0 || native_object->id().id != object.id)
            throw std::runtime_error("history object identity is unavailable");

        const std::size_t decoded_volume_count = native_object->volumes.size();
        if (object.volume_ids.size() != decoded_volume_count ||
            std::any_of(object.volume_ids.begin(), object.volume_ids.end(),
                        [](Neo::History::ObjectID id) { return id == 0; }))
            throw std::runtime_error("history volume identities are unavailable");
        std::vector<Bytes> decoded_volumes;
        decoded_volumes.reserve(decoded_volume_count);
        for (const ModelVolume* decoded : native_object->volumes) {
            std::ostringstream volume_stream(std::ios::binary | std::ios::out);
            NeoHistoryOutputArchive volume_archive(archive_context, volume_stream);
            volume_archive(*decoded);
            const std::string encoded = volume_stream.str();
            decoded_volumes.emplace_back(encoded.begin(), encoded.end());
        }
        for (std::size_t index = 0; index < decoded_volume_count; ++index)
            native_object->delete_volume(0);
        for (std::size_t index = 0; index < decoded_volumes.size(); ++index) {
            const Bytes& encoded = decoded_volumes[index];
            TriangleMesh placeholder;
            ModelVolume* materialized = native_object->add_volume(
                std::move(placeholder), ModelVolumeType::MODEL_PART, false);
            std::string volume_bytes(encoded.begin(), encoded.end());
            std::istringstream volume_stream(volume_bytes, std::ios::binary | std::ios::in);
            NeoHistoryInputArchive volume_archive(archive_context, volume_stream);
            volume_archive(*materialized);
            // ModelVolume::load deliberately skips ObjectBase. Feed the
            // separately retained native ID through the base serializer after
            // loading the mutable volume payload.
            std::ostringstream id_output(std::ios::binary | std::ios::out);
            cereal::BinaryOutputArchive id_writer(id_output);
            id_writer(Slic3r::ObjectID(object.volume_ids[index]));
            const std::string id_bytes = id_output.str();
            std::istringstream id_input(id_bytes, std::ios::binary | std::ios::in);
            cereal::BinaryInputArchive id_reader(id_input);
            id_reader(cereal::base_class<ObjectBase>(materialized));
        }

        InstanceIDs instance_ids;
        instance_ids.reserve(object.instance_ids.size());
        for (const Neo::History::ObjectID id : object.instance_ids)
            instance_ids.emplace_back(id);
        instance_identity_graph.restore(*native_object, instance_ids);
    }
    if (timings)
        timings->model_staging_deserialization_ms += Neo::Bridge::Performance::now_ms() - mutable_started_at;
    return rebuilt_model;
}

bool model_state_equal(const ModelState& lhs, const ModelState& rhs)
{
    if (lhs.serialized != rhs.serialized || lhs.mutable_objects.size() != rhs.mutable_objects.size() ||
        lhs.immutable_meshes.size() != rhs.immutable_meshes.size())
        return false;
    for (std::size_t index = 0; index < lhs.mutable_objects.size(); ++index) {
        const auto& left = lhs.mutable_objects[index];
        const auto& right = rhs.mutable_objects[index];
        if (left.id != right.id || left.timestamp != right.timestamp || left.data != right.data ||
            left.volume_ids != right.volume_ids || left.instance_ids != right.instance_ids)
            return false;
    }
    for (std::size_t index = 0; index < lhs.immutable_meshes.size(); ++index) {
        const auto& left = lhs.immutable_meshes[index];
        const auto& right = rhs.immutable_meshes[index];
        const auto bytes_equal = [](const auto& a, const auto& b) {
            return (!a && !b) || (a && b && *a == *b);
        };
        const auto native_equal = [](const auto& a, const auto& b) {
            if (!a || !b) return bool(a) == bool(b);
            std::owner_less<std::shared_ptr<const TriangleMesh>> less;
            return !less(a, b) && !less(b, a);
        };
        if (left.key != right.key || left.optional != right.optional ||
            !bytes_equal(left.resident, right.resident) || !bytes_equal(left.deferred, right.deferred))
            return false;
        if (!native_equal(left.native, right.native)) return false;
        if (left.native_bytes != right.native_bytes) return false;
    }
    return true;
}

} // namespace Slic3r::Neo::History::Codec

namespace Slic3r::Neo::Bridge::HistoryMetadata {

std::string history_entry_id(const std::uint64_t id)
{
    return std::string("entry-") + std::to_string(id);
}

bool parse_history_entry_id(const char* value, std::uint64_t& id)
{
    if (!value) return false;
    const std::string text(value);
    if (text.rfind("entry-", 0) != 0 || text.size() == 6) return false;
    try {
        std::size_t consumed = 0;
        id = std::stoull(text.substr(6), &consumed);
        return consumed == text.size() - 6;
    } catch (...) {
        return false;
    }
}

bool parse_history_jump_direction(const char* value, History::JumpDirection& direction)
{
    if (!value) return false;
    const std::string text(value);
    if (text == "undo") { direction = History::JumpDirection::Undo; return true; }
    if (text == "redo") { direction = History::JumpDirection::Redo; return true; }
    return false;
}

json parse_history_context(const char* context_cstr)
{
    if (!context_cstr || !*context_cstr)
        throw std::runtime_error("history context is required");
    const json context = json::parse(context_cstr);
    if (!context.is_object() || !context.contains("selection") ||
        !context["selection"].is_object() ||
        !context.contains("activePlateId") ||
        !(context["activePlateId"].is_null() || context["activePlateId"].is_string()) ||
        !context.contains("gizmo") ||
        !(context["gizmo"].is_null() || context["gizmo"].is_object()) ||
        !context.contains("projectConfigOverlay") ||
        !context["projectConfigOverlay"].is_object())
        throw std::runtime_error("invalid history context");
    if (context.contains("filamentState") &&
        (!context["filamentState"].is_object() || context["filamentState"].value("version", 0) != 1))
        throw std::runtime_error("invalid history filament state");
    const auto& selection = context["selection"];
    if (!selection.contains("mode") || !selection["mode"].is_string() ||
        !selection.contains("objectIds") || !selection["objectIds"].is_array() ||
        !selection.contains("partIds") || !selection["partIds"].is_array() ||
        !selection.contains("instanceIds") || !selection["instanceIds"].is_array())
        throw std::runtime_error("invalid history selection");
    for (const char* key : {"objectIds", "partIds", "instanceIds"})
        for (const auto& id : selection[key])
            if (!id.is_number_integer() || id.get<std::int64_t>() < 0)
                throw std::runtime_error("invalid history selection id");
    if (context["gizmo"].is_object() &&
        (!context["gizmo"].contains("type") || !context["gizmo"]["type"].is_string()))
        throw std::runtime_error("invalid history gizmo");
    return context;
}

json default_history_context(const BridgeState& state,
                             const json& plate_session,
                             const json& filament_state)
{
    return json{
        {"selection", {{"mode", "object"}, {"objectIds", json::array()},
                        {"partIds", json::array()}, {"instanceIds", json::array()}}},
        {"activePlateId", state.current_plate_id.empty() ? json(nullptr) : json(state.current_plate_id)},
        {"gizmo", nullptr}, {"projectConfigOverlay", state.project_config_overlay},
        {"plateSession", plate_session},
        {"filamentState", filament_state},
    };
}

json canonical_history_context(const BridgeState& state,
                               json context,
                               const json& plate_session,
                               const json& filament_state)
{
    if (!context.is_object()) context = default_history_context(state, plate_session, filament_state);
    // The Worker is authoritative for plate identity, collection, membership,
    // and revisions. React contributes only the projected editing context.
    context["activePlateId"] = state.current_plate_id.empty()
        ? json(nullptr) : json(state.current_plate_id);
    context["plateSession"] = plate_session;
    context["projectConfigOverlay"] = state.project_config_overlay;
    // Filament presets, colours, routing, matrices, and per-project config
    // are not part of ModelState. Every authoritative history context must
    // therefore carry the current native filament state.
    context["filamentState"] = filament_state;
    return context;
}

json history_status_json(const BridgeState& state)
{
    const auto entries = state.history.entries();
    const std::size_t cursor = state.history.cursor();
    json undo = json::array();
    json redo = json::array();
    for (std::size_t i = cursor; i > 0; --i) {
        const auto& entry = entries[i];
        if (entry.id == 0) continue;
        undo.push_back(json{{"id", history_entry_id(entry.id)}, {"label", entry.label},
                            {"category", "project"}});
    }
    for (std::size_t i = cursor + 1; i < entries.size(); ++i) {
        const auto& entry = entries[i];
        if (entry.id == 0) continue;
        redo.push_back(json{{"id", history_entry_id(entry.id)}, {"label", entry.label},
                            {"category", "project"}});
    }
    const auto* undo_entry = state.history.undo_entry();
    const auto* redo_entry = state.history.redo_entry();
    const auto saved = state.history.saved_checkpoint();
    const auto resources = state.history.resource_diagnostics();
    return json{
        // The visible navigation list is the filtered project stream. Keep
        // its booleans derived from the same stream so context checkpoints
        // cannot disagree with the entries exposed to the renderer.
        {"canUndo", !undo.empty()}, {"canRedo", !redo.empty()},
        {"undoLabel", undo_entry ? json(undo_entry->label) : json(nullptr)},
        {"redoLabel", redo_entry ? json(redo_entry->label) : json(nullptr)},
        {"undoEntries", std::move(undo)}, {"redoEntries", std::move(redo)},
        {"cursor", cursor},
        {"savedCheckpoint", saved == std::numeric_limits<std::size_t>::max() ? json(nullptr) : json(saved)},
        {"savedCheckpointEvicted", state.history.saved_checkpoint_evicted()},
        {"dirty", state.history.project_modified()},
        {"bytesUsed", state.history.bytes_used()}, {"byteBudget", state.history.byte_budget()},
        {"optionalBytesReleased", resources.optional_bytes_released},
        {"evictedEntryCount", resources.evicted_entry_count},
        {"lastEvictedEntryId", resources.last_evicted_entry_id == 0
            ? json(nullptr) : json(history_entry_id(resources.last_evicted_entry_id))},
        {"oldestRetainedEntryId", state.history.entries().empty()
            ? json(nullptr) : json(history_entry_id(resources.oldest_retained_entry_id))},
        {"oversizedEntryRetained", resources.oversized_entry_retained},
        {"disabled", state.history_disabled},
        {"activeTransactionId", state.active_history_transaction ? json(state.active_history_transaction->id) : json(nullptr)},
        {"revision", state.history_revision},
    };
}

std::uint64_t advance_history_epoch(BridgeState& state)
{
    return ++state.history_revision;
}

bool commit_history_entry(BridgeState& state, const std::function<bool()>& append)
{
    if (!append()) return false;
    advance_history_epoch(state);
    return true;
}

json restore_diagnostics_json(const BridgeState& state)
{
    json out = {
        {"minimalMutableRestoreCount", state.history_minimal_mutable_restore_count},
        {"fullPresetBundleCopyCount", state.full_preset_bundle_copy_count},
    };
    if (!state.history.entries().empty()) {
        const auto& current = state.history.current();
        std::size_t retained_model_bytes = current.model.serialized.size();
        for (const auto& object : current.model.mutable_objects)
            retained_model_bytes += object.data.size();
        for (const auto& mesh : current.model.immutable_meshes) {
            if (mesh.resident) retained_model_bytes += mesh.resident->size();
            else if (mesh.deferred) retained_model_bytes += mesh.deferred->size();
            else if (mesh.native) retained_model_bytes += mesh.native_bytes;
        }
        out["currentContextBytes"] = current.context.size();
        out["currentModelBytes"] = retained_model_bytes;
        out["currentDirectFrameBytes"] = current.direct_frame ? current.direct_frame->bytes : 0;
        out["currentDirectFrameKind"] = current.direct_frame
            ? (current.direct_frame->kind == History::RestoreState::DirectFrame::Kind::PrimeTower ? "primeTower" :
               current.direct_frame->kind == History::RestoreState::DirectFrame::Kind::AddPlate ? "addPlate" :
               current.direct_frame->kind == History::RestoreState::DirectFrame::Kind::Transform ? "transform" : "filament")
            : "none";
    }
    const auto revision = state.plate_input_revisions.find(state.current_plate_id);
    const auto* entry = state.plate_runtime_registry.find(state.current_plate_id);
    const bool publishable = revision != state.plate_input_revisions.end() && entry != nullptr &&
        PlateRuntimeRegistry::is_publishable(*entry, revision->second);
    out["previewPlateId"] = publishable ? state.current_plate_id : std::string{};
    out["previewPlateRevision"] = publishable ? revision->second : 0;
    out["previewResultId"] = publishable ? entry->result_generation : 0;
    return out;
}

} // namespace Slic3r::Neo::Bridge::HistoryMetadata

namespace Slic3r::Neo::Bridge::HistoryRuntime {

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_history_begin(const char* label_cstr, const char* category_cstr,
                                                   const char* before_context_cstr, const char* options_cstr)
{
    try {
        const double profile_started_at = Neo::Bridge::Performance::now_ms();
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        const std::string label = label_cstr ? label_cstr : "";
        const std::string category = category_cstr ? category_cstr : "";
        if (label.empty()) return error_json("history label is required");
        if (category != "project") return error_json("history category must be project");
        const json before_context = canonical_history_context(runtime, parse_history_context(before_context_cstr));
        json options = json::object();
        if (options_cstr && *options_cstr) options = json::parse(options_cstr);
        const bool coalesce = options.is_object() && options.value("coalesce", false);
        const std::string parent_id = options.is_object() && options.contains("parentTransactionId") &&
            options["parentTransactionId"].is_string() ? options["parentTransactionId"].get<std::string>() : std::string{};
        if (state().active_history_transaction) {
            const std::string parent_target = state().nested_history_transactions.empty()
                ? state().active_history_transaction->id : state().nested_history_transactions.back().id;
            if (!coalesce || parent_id != parent_target) return error_json("history transaction is already active");
            const std::string id = std::string("tx-") + std::to_string(state().next_history_transaction_id++);
            state().nested_history_transactions.push_back({id, label,
                Neo::History::Category::Project,
                before_context, capture_model_state(
                    state().model, state().mesh_capture_cache, state().mutable_object_capture_cache), true, parent_target,
            state().history_revision, false, false, std::nullopt, std::nullopt,
                false, false, false, {}, state().plate_runtime_registry.capture_lifecycle()});
            state().nested_history_transactions.back().before_plate_input_revisions =
                state().plate_input_revisions;
            return duplicate_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
        }
        const bool add_plate_delta = label == "Add Plate" && category == "project";
        const bool transform_delta = label == "Move" && category == "project";
        if (add_plate_delta && state().history.entries().empty())
            return error_json("add plate history requires an established baseline");
        if (state().history.entries().empty()) {
            const std::string text = before_context.dump();
            state().history.commit("", Neo::History::Category::Project,
                                   capture_model_state(
                                       state().model, state().mesh_capture_cache, state().mutable_object_capture_cache),
                                   Neo::History::Bytes(text.begin(), text.end()));
        }
        const std::string id = std::string("tx-") + std::to_string(state().next_history_transaction_id++);
        const double capture_started_at = Neo::Bridge::Performance::now_ms();
        Neo::History::Codec::CaptureTimings capture_timings;
        Neo::History::ModelState before_model;
        if (!add_plate_delta && !transform_delta) {
            // Transform edits touch ModelObject::config, but imported
            // projects can carry a timestamp equal to the last baseline.
            // Never let the timestamp-gated archive cache turn the live
            // pre-gesture capture into an older retained version.
            state().mutable_object_capture_cache.clear();
            before_model = capture_model_state(
                state().model, state().mesh_capture_cache, state().mutable_object_capture_cache,
                &capture_timings);
        }
        const double capture_finished_at = Neo::Bridge::Performance::now_ms();
        state().active_history_transaction = BridgeState::HistoryTransaction{
            id, label, Neo::History::Category::Project,
            before_context, std::move(before_model), false, {}, state().history_revision,
            add_plate_delta};
        state().active_history_transaction->transform_delta_candidate = transform_delta;
        state().active_history_transaction->before_plate_runtime_lifecycle =
            state().plate_runtime_registry.capture_lifecycle();
        state().active_history_transaction->before_plate_input_revisions =
            state().plate_input_revisions;
        Neo::Bridge::Performance::Timings begin_stages{
            {"total", Neo::Bridge::Performance::now_ms() - profile_started_at}};
        if (add_plate_delta || transform_delta) {
            begin_stages.push_back({"delta_record", capture_finished_at - capture_started_at});
        } else {
            begin_stages.push_back({"capture_collection_cache", capture_timings.collection_cache_ms});
            begin_stages.push_back({"capture_mutable_object_archive", capture_timings.mutable_object_archive_ms});
            begin_stages.push_back({"capture_immutable_mesh_retention", capture_timings.immutable_mesh_retention_ms});
            begin_stages.push_back({"capture_model_state", capture_timings.total_ms});
        }
        Neo::Bridge::Performance::record("history_begin", std::move(begin_stages));
        return duplicate_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
    } catch (const std::exception& e) {
        state().mutable_object_capture_cache.clear();
        return error_json(e.what());
    }
    catch (...) {
        state().mutable_object_capture_cache.clear();
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_commit(const char* transaction_id_cstr, const char* after_context_cstr)
{
    try {
        const double profile_started_at = Neo::Bridge::Performance::now_ms();
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        const std::string requested = transaction_id_cstr ? transaction_id_cstr : "";
        if (!state().active_history_transaction) return error_json("history transaction is not active");
        if (!state().nested_history_transactions.empty()) {
            auto& nested = state().nested_history_transactions.back();
            if (requested != nested.id) return error_json("history transaction is stale or belongs to another writer");
            state().nested_history_transactions.pop_back();
            return duplicate_json(history_status_json().dump());
        }
        if (requested != state().active_history_transaction->id)
            return error_json("history transaction is stale or belongs to another writer");
        const json after_context = canonical_history_context(runtime, parse_history_context(after_context_cstr));
        const auto tx = *state().active_history_transaction;
        const std::string text = after_context.dump();
        const Neo::History::Bytes bytes(text.begin(), text.end());
        const std::string before_text = tx.before_context.dump();
        const Neo::History::Bytes before_bytes(before_text.begin(), before_text.end());
        const double capture_started_at = Neo::Bridge::Performance::now_ms();
        Neo::History::Codec::CaptureTimings capture_timings;
        std::optional<Neo::History::RestoreState::DirectFrame> add_plate_frame;
        std::optional<Neo::History::RestoreState::DirectFrame> transform_frame;
        Neo::History::ModelState after_model;
        if (tx.add_plate_delta) {
            if (!tx.add_plate_mutated)
                return error_json("Add Plate history transaction did not add a plate");
            auto payload = std::make_shared<const AddPlateHistoryFrame>(AddPlateHistoryFrame{
                tx.add_plate_before_transforms, tx.add_plate_after_transforms});
            std::size_t frame_bytes = sizeof(AddPlateHistoryFrame);
            if (payload->before_transforms) frame_bytes += payload->before_transforms->dump().size();
            if (payload->after_transforms) frame_bytes += payload->after_transforms->dump().size();
            add_plate_frame = Neo::History::RestoreState::DirectFrame{
                Neo::History::RestoreState::DirectFrame::Kind::AddPlate,
                std::static_pointer_cast<const void>(payload), frame_bytes};
        } else if (tx.transform_delta_candidate && tx.transform_delta_mutated &&
                   !tx.transform_delta_invalidated && !tx.transform_records.empty()) {
            auto payload = std::make_shared<const TransformHistoryFrame>(TransformHistoryFrame{
                tx.transform_records, tx.base_history_revision, tx.base_history_revision + 1});
            const std::size_t frame_bytes = sizeof(TransformHistoryFrame) +
                payload->records.size() * sizeof(TransformHistoryRecord);
            transform_frame = Neo::History::RestoreState::DirectFrame{
                Neo::History::RestoreState::DirectFrame::Kind::Transform,
                std::static_pointer_cast<const void>(payload), frame_bytes};
        } else {
            after_model = capture_model_state(
                state().model, state().mesh_capture_cache, state().mutable_object_capture_cache,
                &capture_timings);
            // The transaction capture is the authoritative pre-mutation
            // model. Refresh the retained predecessor before appending the
            // post-mutation entry so the first Undo after a project load
            // restores exactly the live pre-drag state.
            if (!tx.transform_delta_candidate && !state().history.refresh_current_model(tx.before_model))
                return error_json("history predecessor model is unavailable");
        }
        const double capture_finished_at = Neo::Bridge::Performance::now_ms();
        const bool direct_transform = bool(transform_frame);
        const double commit_started_at = Neo::Bridge::Performance::now_ms();
        bool committed = false;
        if (tx.add_plate_delta) {
            committed = HistoryMetadata::commit_history_entry(state(), [&]() {
                return state().history.commit_reusing_current_model(tx.label, tx.category, bytes,
                                                                    std::move(add_plate_frame), std::nullopt,
                                                                    before_bytes);
            });
        } else if (transform_frame) {
            committed = HistoryMetadata::commit_history_entry(state(), [&]() {
                return state().history.commit_reusing_current_model(tx.label, tx.category, bytes,
                                                                    std::move(transform_frame), std::nullopt,
                                                                    before_bytes);
            });
        } else {
            committed = HistoryMetadata::commit_history_entry(state(), [&]() {
                return state().history.commit(tx.label, tx.category, after_model, bytes,
                                              std::nullopt, std::nullopt, before_bytes);
            });
        }
        if (!committed) return error_json("history commit rejected");
        const double commit_finished_at = Neo::Bridge::Performance::now_ms();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        Neo::Bridge::Performance::Timings commit_stages{
            {"history_store", commit_finished_at - commit_started_at},
            {"total", Neo::Bridge::Performance::now_ms() - profile_started_at},
        };
        if (tx.add_plate_delta || direct_transform) {
            commit_stages.push_back({"delta_record", capture_finished_at - capture_started_at});
        } else {
            commit_stages.push_back({"capture_collection_cache", capture_timings.collection_cache_ms});
            commit_stages.push_back({"capture_mutable_object_archive", capture_timings.mutable_object_archive_ms});
            commit_stages.push_back({"capture_immutable_mesh_retention", capture_timings.immutable_mesh_retention_ms});
            commit_stages.push_back({"capture_model_state", capture_timings.total_ms});
        }
        Neo::Bridge::Performance::record("history_commit", std::move(commit_stages));
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) {
        state().mutable_object_capture_cache.clear();
        return error_json(e.what());
    }
    catch (...) {
        state().mutable_object_capture_cache.clear();
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_take_performance_profile()
{
    return duplicate_json(Neo::Bridge::Performance::take().dump());
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_abort(const char* transaction_id_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        const std::string requested = transaction_id_cstr ? transaction_id_cstr : "";
        if (!state().active_history_transaction) return error_json("history transaction is not active");
        if (!state().nested_history_transactions.empty()) {
            auto tx = state().nested_history_transactions.back();
            if (requested != tx.id) return error_json("history transaction is stale or belongs to another writer");
            restore_history_transaction_state(tx.before_context, tx.before_model);
            state().plate_input_revisions = tx.before_plate_input_revisions;
            state().mutable_object_capture_cache.clear();
            state().nested_history_transactions.pop_back();
            Neo::Bridge::PlateSession::reconcile_plate_runtime_registry();
            state().plate_runtime_registry.restore_lifecycle(tx.before_plate_runtime_lifecycle);
            Neo::Bridge::PrimeTower::invalidate_projection_cache();
            if (runtime.invalidate_preview) runtime.invalidate_preview();
            HistoryMetadata::advance_history_epoch(state());
            return duplicate_json(json{{"ok", true}, {"context", tx.before_context}, {"status", history_status_json()}}.dump());
        }
        if (requested != state().active_history_transaction->id)
            return error_json("history transaction is stale or belongs to another writer");
        const auto tx = *state().active_history_transaction;
        if (tx.transform_delta_candidate) {
            restore_transform_transaction_state(tx);
            state().plate_input_revisions = tx.before_plate_input_revisions;
            Neo::Bridge::PlateSession::reconcile_plate_runtime_registry();
            state().plate_runtime_registry.restore_lifecycle(tx.before_plate_runtime_lifecycle);
            state().mutable_object_capture_cache.clear();
            state().active_history_transaction.reset();
            state().nested_history_transactions.clear();
            Neo::Bridge::PrimeTower::invalidate_projection_cache();
            if (runtime.invalidate_preview) runtime.invalidate_preview();
            if (tx.transform_delta_mutated) HistoryMetadata::advance_history_epoch(state());
            return duplicate_json(json{{"ok", true}, {"context", tx.before_context},
                                       {"status", history_status_json()}}.dump());
        }
        if (tx.add_plate_delta) {
            if (tx.add_plate_mutated) {
                apply_add_plate_transforms(tx.add_plate_before_transforms);
                if (!tx.before_context.contains("plateSession"))
                    throw std::runtime_error("add plate history is missing plate session");
                restore_history_plate_session(tx.before_context["plateSession"], state().model);
                if (!valid_project_config_overlay(tx.before_context.value("projectConfigOverlay", empty_project_config_overlay())))
                    throw std::runtime_error("invalid add plate project configuration overlay");
                state().project_config_overlay = tx.before_context["projectConfigOverlay"];
                apply_plate_overlay_to_configs(state().plate_session_plates, state().project_config_overlay);
                Neo::Bridge::PlateSession::normalize_coordinate_arrays(
                    state().presets.project_config, state().plate_session_plates.size());
            }
            state().plate_input_revisions = tx.before_plate_input_revisions;
            Neo::Bridge::PlateSession::reconcile_plate_runtime_registry();
            state().plate_runtime_registry.restore_lifecycle(tx.before_plate_runtime_lifecycle);
            state().active_history_transaction.reset();
            state().nested_history_transactions.clear();
            Neo::Bridge::PrimeTower::invalidate_projection_cache();
            if (runtime.invalidate_preview) runtime.invalidate_preview();
            if (tx.add_plate_mutated) HistoryMetadata::advance_history_epoch(state());
            return duplicate_json(json{{"ok", true}, {"context", tx.before_context},
                                       {"status", history_status_json()}}.dump());
        }
        const bool model_changed = !Neo::History::Codec::model_state_equal(
            capture_model_state(
                state().model, state().mesh_capture_cache, state().mutable_object_capture_cache), tx.before_model);
        restore_history_transaction_state(tx.before_context, tx.before_model);
        state().plate_input_revisions = tx.before_plate_input_revisions;
        Neo::Bridge::PlateSession::reconcile_plate_runtime_registry();
        state().plate_runtime_registry.restore_lifecycle(tx.before_plate_runtime_lifecycle);
        state().mutable_object_capture_cache.clear();
        Neo::Bridge::PrimeTower::invalidate_projection_cache();
        if (runtime.invalidate_preview) runtime.invalidate_preview();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        if (model_changed) HistoryMetadata::advance_history_epoch(state());
        return duplicate_json(json{{"ok", true}, {"context", tx.before_context}, {"status", history_status_json()}}.dump());
    } catch (const std::exception& e) {
        state().mutable_object_capture_cache.clear();
        return error_json(e.what());
    }
    catch (...) {
        state().mutable_object_capture_cache.clear();
        return error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_undo()
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        Neo::History::RestorePlan plan;
        if (!state().history.prepare_undo(plan)) return error_json("no undo history");
        rebase_stale_sparse_restore(plan);
        std::optional<std::string> serialized_full_response;
        const json result = restore_result(runtime, plan, &serialized_full_response);
        return duplicate_json(serialized_full_response ? *serialized_full_response : result.dump());
    } catch (const std::exception& e) { return restore_failure(e.what()); }
    catch (...) { return restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_redo()
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        Neo::History::RestorePlan plan;
        if (!state().history.prepare_redo(plan)) return error_json("no redo history");
        rebase_stale_sparse_restore(plan);
        std::optional<std::string> serialized_full_response;
        const json result = restore_result(runtime, plan, &serialized_full_response);
        return duplicate_json(serialized_full_response ? *serialized_full_response : result.dump());
    } catch (const std::exception& e) { return restore_failure(e.what()); }
    catch (...) { return restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_jump(const char* entry_id_cstr, const char* direction_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        std::uint64_t entry_id = 0;
        if (!parse_history_entry_id(entry_id_cstr, entry_id)) return error_json("invalid history entry id");
        Neo::History::JumpDirection direction;
        if (!parse_history_jump_direction(direction_cstr, direction)) return error_json("invalid history jump direction");
        Neo::History::RestorePlan plan;
        if (state().history.prepare_jump(entry_id, direction, plan)) {
            rebase_stale_sparse_restore(plan);
            std::optional<std::string> serialized_full_response;
            const json result = restore_result(runtime, plan, &serialized_full_response);
            return duplicate_json(serialized_full_response ? *serialized_full_response : result.dump());
        }

        // Sparse Add Plate and Transform receipts describe one adjacent
        // transition.  A directional menu item may cross several such frames,
        // so resolve the opaque entry ID once and execute its adjacent path
        // synchronously inside this Worker call.  No intermediate response is
        // published to React; the final response deliberately requests a full
        // renderer projection because one narrow receipt cannot summarize the
        // complete path.
        std::vector<std::size_t> path;
        if (!state().history.resolve_jump_path(entry_id, direction, path))
            return error_json("history entry is stale, unavailable, or outside the requested direction");

        const std::size_t original_cursor = state().history.cursor();
        const auto original_entries = state().history.entries();
        const std::uint64_t rollback_entry_id = direction == Neo::History::JumpDirection::Undo
            ? original_entries[original_cursor].id : original_entries[original_cursor + 1].id;
        const Neo::History::JumpDirection rollback_direction = direction == Neo::History::JumpDirection::Undo
            ? Neo::History::JumpDirection::Redo : Neo::History::JumpDirection::Undo;
        Model original_model = state().model;
        const auto original_plates = state().plate_session_plates;
        const auto original_overlay = state().project_config_overlay;
        const auto original_membership = state().instance_plate_ids;
        const auto original_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto original_parked = state().parked_instance_ids;
        const auto original_pending = state().pending_membership_instance_ids;
        const std::string original_current_plate = state().current_plate_id;
        const std::uint64_t original_revision = state().history_revision;
        const auto original_plate_revisions = state().plate_input_revisions;
        const std::uint64_t original_next_plate_stamp = state().next_plate_input_stamp;
        const auto original_registry_lifecycle = state().plate_runtime_registry.capture_lifecycle();
        const auto original_prime_tower_cache = state().prime_tower_projection_cache;
        const std::uint64_t original_minimal_restore_count = state().history_minimal_mutable_restore_count;
        json result;
        std::size_t completed = 0;
        bool runtime_ids_stable = true;
        try {
            for (const auto target_cursor : path) {
                Neo::History::RestorePlan step;
                const bool prepared = direction == Neo::History::JumpDirection::Undo
                    ? state().history.prepare_undo(step) : state().history.prepare_redo(step);
                if (!prepared || step.target_cursor != target_cursor)
                    throw std::runtime_error("multi-step history jump became stale");
                if (runtime_ids_stable) rebase_stale_sparse_restore(step);
                if (!runtime_ids_stable && sparse_restore(step) &&
                    !state().history.rebase_sparse_restore(step))
                    throw std::runtime_error("multi-step sparse history restore became stale");
                const bool preserves_runtime_ids = step.direct_frame_transition &&
                    (!sparse_restore(step) || !step.model_state_present);
                std::optional<std::string> ignored_serialized_response;
                result = restore_result(runtime, step, &ignored_serialized_response);
                runtime_ids_stable = runtime_ids_stable && preserves_runtime_ids;
                ++completed;
            }
        } catch (...) {
            const auto failure = std::current_exception();
            bool rolled_back = true;
            try {
                if (completed > 0) {
                    std::vector<std::size_t> rollback_path;
                    if (!state().history.resolve_jump_path(rollback_entry_id, rollback_direction, rollback_path))
                        throw std::runtime_error("multi-step history rollback is unavailable");
                    for (const auto target_cursor : rollback_path) {
                        Neo::History::RestorePlan rollback;
                        const bool prepared = rollback_direction == Neo::History::JumpDirection::Undo
                            ? state().history.prepare_undo(rollback) : state().history.prepare_redo(rollback);
                        if (!prepared || rollback.target_cursor != target_cursor)
                            throw std::runtime_error("multi-step history rollback became stale");
                        if (sparse_restore(rollback) && !state().history.rebase_sparse_restore(rollback))
                            throw std::runtime_error("multi-step sparse history rollback became stale");
                        std::optional<std::string> ignored_serialized_response;
                        (void) restore_result(runtime, rollback, &ignored_serialized_response);
                    }
                }
                rolled_back = state().history.cursor() == original_cursor;
            } catch (...) {
                rolled_back = false;
            }
            if (!rolled_back) {
                state().history_disabled = true;
                return restore_failure("multi-step history jump failed and could not be rolled back");
            }
            // Reverse navigation restores logical history state. Restore the
            // exact pre-jump model copy as well so an archive stage cannot
            // leave the renderer holding instance IDs that changed during a
            // failed, unpublished command.
            state().model = std::move(original_model);
            state().plate_session_plates = original_plates;
            state().project_config_overlay = original_overlay;
            state().instance_plate_ids = original_membership;
            state().plate_out_of_bounds_ids = original_out_of_bounds;
            state().parked_instance_ids = original_parked;
            state().pending_membership_instance_ids = original_pending;
            state().current_plate_id = original_current_plate;
            state().mutable_object_capture_cache.clear();
            state().history_revision = original_revision;
            state().plate_input_revisions = original_plate_revisions;
            state().next_plate_input_stamp = original_next_plate_stamp;
            state().plate_runtime_registry.restore_lifecycle(original_registry_lifecycle);
            state().prime_tower_projection_cache = original_prime_tower_cache;
            state().history_minimal_mutable_restore_count = original_minimal_restore_count;
            std::rethrow_exception(failure);
        }

        // A direct jump is one published native revision even when sparse
        // storage required several internal adjacent applications.
        state().history_revision = original_revision + 1;
        result.erase("direct");
        result.erase("narrow");
        result.erase("instance_transforms");
        result.erase("transform_receipt");
        result.erase("prime_tower_receipt");
        result["status"] = history_status_json();
        result["impact"] = {{"version", 1}, {"model", "full"}, {"plateSession", true},
                            {"filamentRack", true}, {"projectOverlay", true},
                            {"selectionContext", true}, {"primeTower", true},
                            {"preview", "all"}};
        return duplicate_json(result.dump());
    } catch (const std::exception& e) { return restore_failure(e.what()); }
    catch (...) { return restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_status()
{
    try { return duplicate_json(history_status_json().dump()); }
    catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_restore_diagnostics()
{
    return duplicate_json(Neo::Bridge::HistoryMetadata::restore_diagnostics_json(state()).dump());
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_reset(const char* context_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        const json context = canonical_history_context(runtime, parse_history_context(context_cstr));
        state().history.clear();
        state().mesh_capture_cache.clear();
        state().mutable_object_capture_cache.clear();
        state().active_history_transaction.reset();
        state().history_disabled = false;
        const std::string text = context.dump();
        const Neo::History::Bytes bytes(text.begin(), text.end());
        if (!HistoryMetadata::commit_history_entry(state(), [&]() {
            return state().history.commit("", Neo::History::Category::Project,
                                          capture_model_state(state().model, state().mesh_capture_cache, state().mutable_object_capture_cache), bytes);
        }))
            return error_json("could not establish history baseline");
        state().history.mark_current_as_saved();
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_mark_saved(const char* context_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history.entries().empty() && context_cstr && *context_cstr) {
            const json context = canonical_history_context(runtime, parse_history_context(context_cstr));
            const std::string text = context.dump();
            const Neo::History::Bytes bytes(text.begin(), text.end());
            if (!state().history.commit("", Neo::History::Category::Project,
                                        capture_model_state(state().model, state().mesh_capture_cache, state().mutable_object_capture_cache), bytes))
                return error_json("could not establish history baseline");
        }
        state().history.mark_current_as_saved();
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

} // extern "C"

} // namespace Slic3r::Neo::Bridge::HistoryRuntime
