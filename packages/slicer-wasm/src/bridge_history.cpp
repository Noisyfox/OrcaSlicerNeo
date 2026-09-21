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
#include <type_traits>
#include <utility>
#include <vector>

#include "bridge_history.hpp"
#include "bridge_performance.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate.hpp"
#include "bridge_scoped_config.hpp"
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
using Neo::Bridge::Filament::Commands::validate_filament_candidate_components;
using Neo::Bridge::Filament::State::apply_mutable;
using Neo::Bridge::Filament::State::history_state_json;
using Neo::Bridge::Filament::State::stage_mutable;
using Neo::Bridge::HistoryMetadata::history_entry_id;
using Neo::Bridge::HistoryMetadata::parse_history_context;
using Neo::Bridge::HistoryMetadata::parse_history_entry_id;
using Neo::Bridge::HistoryMetadata::parse_history_jump_direction;
using Neo::Bridge::PlateSession::plate_session_snapshot_json;
using Neo::Bridge::ScopedConfig::empty_native_scoped_config_snapshot;
using Neo::Bridge::ScopedConfig::native_scoped_config_snapshot;
using Neo::Bridge::ScopedConfig::native_scoped_config_removed_targets;
using Neo::Bridge::ScopedConfig::native_scoped_config_affected_transport;
using Neo::Bridge::ScopedConfig::native_scoped_config_full_transport;
using Neo::Bridge::SlicingPipeline::invalidate_preview_source;
using Neo::History::Codec::capture_model_state;
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
    json context = state().history_live_context;
    if (!context.is_object() || context.empty())
        context = Neo::Bridge::HistoryMetadata::default_history_context(
            state(), plate_session_snapshot_json(), runtime.filament_history_state());
    return canonical_history_context(runtime, std::move(context));
}

void restore_transaction_runtime_snapshot(const BridgeState::HistoryTransaction& transaction)
{
    state().plate_input_revisions = transaction.before_plate_input_revisions;
    state().plate_runtime_registry.restore_lifecycle(transaction.before_lifecycle);
    if (state().history_live_context.is_object() && state().history_live_context.contains("plateSession"))
        state().history_live_context["plateSession"]["input_revisions"] =
            Neo::Bridge::PlateSession::plate_revisions_json();
}

Neo::History::Bytes json_bytes(const json& value)
{
    const std::string text = value.dump();
    return Neo::History::Bytes(text.begin(), text.end());
}

json bytes_json(const Neo::History::Bytes& value)
{
    return json::parse(std::string(value.begin(), value.end()));
}

json config_values(const Slic3r::ConfigBase& config)
{
    json values = json::object();
    for (const std::string& key : config.keys()) {
        const auto* option = config.option(key);
        if (option) values[key] = option->serialize();
    }
    return values;
}

json plate_scoped_projection(const json& values)
{
    json projected = json::object();
    if (!values.is_object()) return projected;
    for (auto it = values.begin(); it != values.end(); ++it)
        if (Neo::Bridge::ScopedConfig::is_editable_plate_override_key(it.key())) projected[it.key()] = it.value();
    return projected;
}

json native_scoped_config_from_history_roots(const Neo::History::TimestampedRoots& roots,
                                             const Model& model,
                                             const std::vector<BridgeState::PlateSessionPlate>& plates)
{
    json snapshot = empty_native_scoped_config_snapshot();
    snapshot["project"] = bytes_json(roots.project_config);
    if (!snapshot["project"].is_object())
        throw std::runtime_error("invalid history project configuration root");
    for (const auto* object : model.objects) {
        const json object_values = config_values(object->config.get());
        if (!object_values.empty()) snapshot["objects"][std::to_string(object->id().id)] = object_values;
        for (const auto* volume : object->volumes) {
            const json part_values = config_values(volume->config.get());
            if (!part_values.empty()) snapshot["parts"][std::to_string(volume->id().id)] = part_values;
        }
    }
    // History retains the complete native plate metadata in its plate-session
    // root.  Only the explicitly editable Plate keys belong in this disposable
    // scoped-config projection.
    for (const auto& plate : plates) {
        const json projected = plate_scoped_projection(plate.settings_metadata);
        if (!projected.empty()) snapshot["plates"][plate.id] = projected;
    }
    return snapshot;
}

json context_from_history_roots(const Neo::History::TimestampedRoots& roots,
                                const Model& model,
                                const std::vector<BridgeState::PlateSessionPlate>& plates)
{
    json context = bytes_json(roots.session.history_context);
    context["plateSession"] = bytes_json(roots.session.plate_session);
    context["nativeScopedConfig"] = native_scoped_config_from_history_roots(roots, model, plates);
    return context;
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
        Neo::Bridge::ScopedConfig::apply_native_config_values(plate.settings, plate.settings_metadata);
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


void validate_filament_history_candidate(
    PresetBundle& catalog, const std::vector<std::string>& filament_presets,
    Model& model, const std::vector<BridgeState::PlateSessionPlate>& plates, const json& snapshot)
{
    const auto& printer = catalog.printers.get_edited_preset().config;
    DynamicPrintConfig project_config = catalog.project_config;
    const json project_values = snapshot.value("project", json::object());
    for (const std::string& key : project_config.keys())
        if (Neo::Bridge::ScopedConfig::is_native_project_config_key(key)) project_config.erase(key);
    if (!project_values.is_object()) throw std::runtime_error("invalid history project configuration root");
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = project_values.begin(); it != project_values.end(); ++it)
        if (Neo::Bridge::ScopedConfig::is_native_project_config_key(it.key())) {
            if (!it.value().is_string()) throw std::runtime_error("invalid history project configuration value");
            project_config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions);
        }
    validate_filament_candidate_components(filament_presets, project_config, printer,
        std::max(1, catalog.get_printer_extruder_count()),
        printer.opt_bool("single_extruder_multi_material") || catalog.is_bbl_vendor(),
        model, plates, snapshot);
}

// A history archive includes configuration and painting state in addition to
// renderer geometry. Compare the live native graphs for this one restore;
// configuration-only and transform edits do not require retransferring unchanged
// meshes. Authoritative transforms arrive in the same committed response.
bool renderer_object_unchanged(const ModelObject& before, const ModelObject& after)
{
    if (before.id() != after.id() || before.name != after.name || before.printable != after.printable ||
        before.volumes.size() != after.volumes.size() || before.instances.size() != after.instances.size())
        return false;
    for (std::size_t i = 0; i < before.volumes.size(); ++i) {
        const auto& left = *before.volumes[i];
        const auto& right = *after.volumes[i];
        if (left.id() != right.id() || left.name != right.name || left.type() != right.type() ||
            left.get_mesh_shared_ptr() != right.get_mesh_shared_ptr() || left.extruder_id() != right.extruder_id() ||
            !left.mmu_segmentation_facets.equals(right.mmu_segmentation_facets) ||
            !left.supported_facets.equals(right.supported_facets) ||
            !left.seam_facets.equals(right.seam_facets) || !left.fuzzy_skin_facets.equals(right.fuzzy_skin_facets))
            return false;
    }
    for (std::size_t i = 0; i < before.instances.size(); ++i)
        if (before.instances[i]->id() != after.instances[i]->id() ||
            before.instances[i]->printable != after.instances[i]->printable)
            return false;
    return true;
}

json restore_timestamped_result(const Runtime& runtime,
                                const Neo::History::TimestampedRestore& restored,
                                const std::uint64_t entry_id)
{
    const double restore_started_at = Neo::Bridge::Performance::now_ms();
    Neo::History::Codec::RestoreTimings restore_timings;
    const auto live_model_state = capture_model_state(
        state().model, state().mesh_capture_cache, state().mutable_object_capture_cache);
    const bool model_matches_target = Neo::History::Codec::model_state_equal(live_model_state, restored.roots.model);
    Model staged_model = model_matches_target
        ? Model(state().model)
        : Neo::History::Codec::stage_model(state().model, restored.roots.model, &restore_timings,
                                          &live_model_state);
    const json plate_session = bytes_json(restored.roots.session.plate_session);
    auto staged_plates = build_history_plate_session(plate_session, staged_model);
    const json context = context_from_history_roots(restored.roots, staged_model, staged_plates);
    if (!context.contains("filamentState"))
        throw std::runtime_error("history context is missing filament state");
    const bool filament_changed = history_state_json(state().presets) != context["filamentState"];
    std::optional<Neo::Bridge::Filament::State::StagedMutableState> staged_filament_state;
    if (filament_changed) staged_filament_state.emplace(stage_mutable(state().presets, context["filamentState"]));
    const json staged_snapshot = context["nativeScopedConfig"];
    validate_filament_history_candidate(
        state().presets,
        staged_filament_state ? staged_filament_state->names : state().presets.filament_presets,
        staged_model, staged_plates, staged_snapshot);

    std::optional<Neo::Bridge::Filament::State::StagedMutableState> before_filament_state;
    if (filament_changed) before_filament_state.emplace(stage_mutable(state().presets, history_state_json(state().presets)));
    Model before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_project_config = state().presets.project_config;
    const auto before_print_config = state().presets.prints.get_edited_preset().config;
    const auto before_plate_revisions = state().plate_input_revisions;
    const auto before_membership = state().instance_plate_ids;
    const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
    const auto before_parked = state().parked_instance_ids;
    const auto before_pending = state().pending_membership_instance_ids;
    const auto before_current_plate = state().current_plate_id;
    const auto before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
    const auto before_live_context = state().history_live_context;
    const auto before_native_scoped_config = native_scoped_config_snapshot();
    const auto before_native_print_preset = Neo::Bridge::ScopedConfig::native_print_preset_history_state();
    const double roots_restore_started_at = Neo::Bridge::Performance::now_ms();
    try {
        if (staged_filament_state) apply_mutable(state(), state().presets, std::move(*staged_filament_state));
        state().model = std::move(staged_model);
        state().mutable_object_capture_cache.clear();
        restore_history_plate_session(plate_session, state().model);
        Neo::Bridge::ScopedConfig::restore_native_print_preset_history_state(
            context.at("nativePrintPreset"));
        // The Project history root is an exact owner-aware replacement:
        // native project options restore to project_config, while ordinary
        // Print options restore as edited-preset differences from its parent.
        Neo::Bridge::ScopedConfig::apply_project_scoped_config_snapshot(
            staged_snapshot.value("project", json::object()));
        Neo::Bridge::PlateSession::normalize_coordinate_arrays(
            state().presets.project_config, state().plate_session_plates.size());
        Neo::Bridge::PlateSession::reconcile_plate_runtime_registry();
        // A history restore publishes only the plates whose native input
        // changed.  Project/filament roots and model topology still fan out
        // to every plate; a plate-local root stays local, while object/part
        // roots use the restored instance membership.
        std::set<std::string> affected_plates;
        const auto all_plate_ids = [&]() {
            std::set<std::string> ids;
            for (const auto& plate : state().plate_session_plates) ids.insert(plate.id);
            return ids;
        };
        const auto add_instance_plates = [](const std::map<std::size_t, std::string>& membership,
                                            const std::size_t instance_id,
                                            std::set<std::string>& destination) {
            const auto found = membership.find(instance_id);
            if (found != membership.end() && !found->second.empty()) destination.insert(found->second);
        };
        std::set<std::string> model_transform_affected_plates;
        bool model_shape_or_transform_changed = before_model.objects.size() != state().model.objects.size();
        for (std::size_t index = 0; !model_shape_or_transform_changed && index < before_model.objects.size(); ++index) {
            const auto* before_object = before_model.objects[index];
            const auto* after_object = state().model.objects[index];
            if (before_object->id() != after_object->id() ||
                before_object->volumes.size() != after_object->volumes.size() ||
                before_object->instances.size() != after_object->instances.size()) {
                model_shape_or_transform_changed = true;
                break;
            }
            for (std::size_t volume_index = 0; volume_index < before_object->volumes.size(); ++volume_index) {
                if (before_object->volumes[volume_index]->id() != after_object->volumes[volume_index]->id()) {
                    model_shape_or_transform_changed = true;
                    break;
                }
                if (before_object->volumes[volume_index]->get_transformation() !=
                    after_object->volumes[volume_index]->get_transformation()) {
                    for (const auto* instance : before_object->instances)
                        add_instance_plates(before_membership, instance->id().id, model_transform_affected_plates);
                    for (const auto* instance : after_object->instances)
                        add_instance_plates(state().instance_plate_ids, instance->id().id, model_transform_affected_plates);
                }
            }
            for (std::size_t instance_index = 0; !model_shape_or_transform_changed &&
                                                   instance_index < before_object->instances.size(); ++instance_index) {
                const auto* before_instance = before_object->instances[instance_index];
                const auto* after_instance = after_object->instances[instance_index];
                if (before_instance->id() != after_instance->id()) {
                    model_shape_or_transform_changed = true;
                    break;
                }
                if (before_instance->get_transformation() != after_instance->get_transformation()) {
                    add_instance_plates(before_membership, before_instance->id().id, model_transform_affected_plates);
                    add_instance_plates(state().instance_plate_ids, after_instance->id().id, model_transform_affected_plates);
                }
            }
        }
        const auto normalized_out_of_bounds = [](const auto& values) {
            std::map<std::string, std::set<std::size_t>> normalized;
            for (const auto& [plate_id, instance_ids] : values)
                if (!instance_ids.empty()) normalized.emplace(plate_id, instance_ids);
            return normalized;
        };
        const bool project_changed = before_project_config != state().presets.project_config ||
            before_print_config != state().presets.prints.get_edited_preset().config;
        const bool membership_changed = before_membership != state().instance_plate_ids ||
            before_parked != state().parked_instance_ids ||
            normalized_out_of_bounds(before_out_of_bounds) != normalized_out_of_bounds(state().plate_out_of_bounds_ids);
        if (filament_changed || model_shape_or_transform_changed || project_changed) {
            affected_plates = all_plate_ids();
        } else {
            affected_plates.insert(model_transform_affected_plates.begin(), model_transform_affected_plates.end());
            if (membership_changed) {
                std::set<std::size_t> membership_ids;
                for (const auto& [instance_id, plate_id] : before_membership) membership_ids.insert(instance_id);
                for (const auto& [instance_id, plate_id] : state().instance_plate_ids) membership_ids.insert(instance_id);
                for (const auto& [plate_id, instance_ids] : before_out_of_bounds)
                    membership_ids.insert(instance_ids.begin(), instance_ids.end());
                for (const auto& [plate_id, instance_ids] : state().plate_out_of_bounds_ids)
                    membership_ids.insert(instance_ids.begin(), instance_ids.end());
                for (const auto instance_id : membership_ids) {
                    add_instance_plates(before_membership, instance_id, affected_plates);
                    add_instance_plates(state().instance_plate_ids, instance_id, affected_plates);
                }
            }
            for (const auto& plate : state().plate_session_plates) {
                const auto before = std::find_if(before_plates.begin(), before_plates.end(),
                    [&](const auto& candidate) { return candidate.id == plate.id; });
                if (before == before_plates.end() || before->settings != plate.settings)
                    affected_plates.insert(plate.id);
            }
            for (const auto* object : state().model.objects) {
                const auto before = std::find_if(before_model.objects.begin(), before_model.objects.end(),
                    [&](const auto* candidate) { return candidate->id() == object->id(); });
                if (before == before_model.objects.end() || (*before)->config.get() == object->config.get())
                    continue;
                std::set<std::size_t> instance_ids;
                for (const auto* instance : object->instances) instance_ids.insert(instance->id().id);
                const auto plates = Neo::Bridge::PlateSession::member_plate_ids_for_instances(instance_ids);
                affected_plates.insert(plates.begin(), plates.end());
            }
            for (const auto* object : state().model.objects) {
                const auto before = std::find_if(before_model.objects.begin(), before_model.objects.end(),
                    [&](const auto* candidate) { return candidate->id() == object->id(); });
                if (before == before_model.objects.end()) continue;
                for (const auto* volume : object->volumes) {
                    const auto before_volume = std::find_if((*before)->volumes.begin(), (*before)->volumes.end(),
                        [&](const auto* candidate) { return candidate->id() == volume->id(); });
                    if (before_volume == (*before)->volumes.end() || (*before_volume)->config.get() == volume->config.get())
                        continue;
                    std::set<std::size_t> instance_ids;
                    for (const auto* instance : object->instances) instance_ids.insert(instance->id().id);
                    const auto plates = Neo::Bridge::PlateSession::member_plate_ids_for_instances(instance_ids);
                    affected_plates.insert(plates.begin(), plates.end());
                }
            }
        }
        std::map<std::string, std::uint64_t> restored_plate_revisions;
        for (const auto& plate : state().plate_session_plates) {
            const auto before_revision = before_plate_revisions.find(plate.id);
            const auto revision = affected_plates.find(plate.id) != affected_plates.end() ||
                before_revision == before_plate_revisions.end()
                ? allocate_plate_input_stamp(state())
                : before_revision->second;
            restored_plate_revisions.emplace(plate.id, revision);
        }
        state().plate_input_revisions = std::move(restored_plate_revisions);
        state().plate_runtime_registry.invalidate_presentations(affected_plates);
        state().history_live_context = context;
        state().history_live_context["plateSession"]["input_revisions"] =
            Neo::Bridge::PlateSession::plate_revisions_json();
        if (!Neo::History::Codec::prime_model_capture_cache(
                state().model, restored.roots.model, state().mutable_object_capture_cache))
            state().mutable_object_capture_cache.clear();
        restore_timings.plate_session_native_config_restore_ms =
            Neo::Bridge::Performance::now_ms() - roots_restore_started_at;
    } catch (...) {
        if (before_filament_state) apply_mutable(state(), state().presets, std::move(*before_filament_state));
        state().model = std::move(before_model);
        state().plate_session_plates = before_plates;
        state().presets.project_config = before_project_config;
        state().presets.prints.get_edited_preset().config = before_print_config;
        state().presets.prints.update_dirty();
        Neo::Bridge::ScopedConfig::restore_native_print_preset_history_state(before_native_print_preset);
        state().plate_input_revisions = before_plate_revisions;
        state().instance_plate_ids = before_membership;
        state().plate_out_of_bounds_ids = before_out_of_bounds;
        state().parked_instance_ids = before_parked;
        state().pending_membership_instance_ids = before_pending;
        state().current_plate_id = before_current_plate;
        state().plate_runtime_registry.restore_lifecycle(before_lifecycle);
        state().history_live_context = before_live_context;
        state().mutable_object_capture_cache.clear();
        throw;
    }
    // Keep the existing pointer-free usage summaries when their actual native
    // inputs are unchanged. A different object archive may change only layer
    // height or wall count; it does not necessarily change painted filament use.
    // Membership and effective global configuration are checked by the reader.
    bool usage_unchanged = live_model_state.mutable_objects.size() == restored.roots.model.mutable_objects.size();
    for (std::size_t index = 0; usage_unchanged && index < live_model_state.mutable_objects.size(); ++index) {
        const auto& before = live_model_state.mutable_objects[index];
        const auto& after = restored.roots.model.mutable_objects[index];
        usage_unchanged = before.id == after.id &&
            before.volume_ids == after.volume_ids && before.instance_ids == after.instance_ids;
        if (!usage_unchanged || before.data == after.data) continue;
        const auto& old_object = *before_model.objects[index];
        const auto& new_object = *state().model.objects[index];
        for (const char* key : {"extruder", "support_interface_filament", "support_filament", "enable_support",
                               "raft_layers", "outer_wall_filament_id", "inner_wall_filament_id",
                               "sparse_infill_filament_id", "internal_solid_filament_id",
                               "top_surface_filament_id", "bottom_surface_filament_id"}) {
            const auto* old_value = old_object.config.option(key);
            const auto* new_value = new_object.config.option(key);
            if (bool(old_value) != bool(new_value) ||
                (old_value && old_value->serialize() != new_value->serialize())) usage_unchanged = false;
        }
        if (old_object.layer_config_ranges.size() != new_object.layer_config_ranges.size()) usage_unchanged = false;
        auto old_range = old_object.layer_config_ranges.begin();
        auto new_range = new_object.layer_config_ranges.begin();
        for (; usage_unchanged && old_range != old_object.layer_config_ranges.end(); ++old_range, ++new_range)
            if (old_range->first != new_range->first || old_range->second.get() != new_range->second.get())
                usage_unchanged = false;
        for (std::size_t volume_index = 0; usage_unchanged && volume_index < old_object.volumes.size(); ++volume_index) {
            const auto& old_volume = *old_object.volumes[volume_index];
            const auto& new_volume = *new_object.volumes[volume_index];
            usage_unchanged = old_volume.type() == new_volume.type() &&
                old_volume.get_mesh_shared_ptr() == new_volume.get_mesh_shared_ptr() &&
                old_volume.extruder_id() == new_volume.extruder_id() &&
                // ObjectWithTimestamp's archive stores the content timestamp,
                // not its incidental ObjectBase ID. Volume identity above is
                // authoritative; compare painting content as well as timestamp.
                old_volume.mmu_segmentation_facets.equals(new_volume.mmu_segmentation_facets) &&
                old_volume.mmu_segmentation_facets.timestamp() == new_volume.mmu_segmentation_facets.timestamp();
        }
    }
    if (usage_unchanged) {
        std::set<std::string> plates;
        const bool plate_settings_unchanged = !filament_changed &&
            before_live_context.value("nativeScopedConfig", json::object()).value("project", json::object()) ==
                staged_snapshot.value("project", json::object()) &&
            before_live_context.contains("plateSession") &&
            before_live_context["plateSession"].value("plates", json()) == plate_session.value("plates", json());
        if (plate_settings_unchanged) {
            for (std::size_t index = 0; index < live_model_state.mutable_objects.size(); ++index) {
                const auto& before = live_model_state.mutable_objects[index];
                const auto& after = restored.roots.model.mutable_objects[index];
                if (before.volume_transforms == after.volume_transforms &&
                    before.instance_transforms == after.instance_transforms &&
                    before_membership == state().instance_plate_ids &&
                    before_parked == state().parked_instance_ids &&
                    before_out_of_bounds == state().plate_out_of_bounds_ids)
                    continue;
                for (const auto id : after.instance_ids) {
                    const auto old_plate = before_membership.find(id);
                    if (old_plate != before_membership.end()) plates.insert(old_plate->second);
                    const auto new_plate = state().instance_plate_ids.find(id);
                    if (new_plate != state().instance_plate_ids.end()) plates.insert(new_plate->second);
                }
            }
        } else {
            for (const auto& plate : state().plate_session_plates) plates.insert(plate.id);
        }
        Neo::Bridge::PrimeTower::invalidate_projection_cache(plates);
    } else {
        Neo::Bridge::PrimeTower::invalidate_projection_cache();
    }
    HistoryMetadata::advance_history_epoch(state());
    json response_context = state().history_live_context;
    json restored_instance_transforms = json::array();
    for (const auto& ref : Neo::Bridge::PlateSession::plate_instance_refs())
        restored_instance_transforms.push_back(Neo::Bridge::PlateSession::instance_transform_record(ref));
    response_context["plateSession"]["instance_transforms"] = std::move(restored_instance_transforms);
    std::vector<Neo::History::ObjectID> retained_renderer_object_ids;
    json retained_volume_transforms = json::array();
    for (const auto id : restored.scene_delta.object_ids) {
        const auto before = std::find_if(before_model.objects.begin(), before_model.objects.end(),
            [id](const auto* object) { return object->id().id == id; });
        const auto after = std::find_if(state().model.objects.begin(), state().model.objects.end(),
            [id](const auto* object) { return object->id().id == id; });
        if (before != before_model.objects.end() && after != state().model.objects.end() &&
            renderer_object_unchanged(**before, **after)) {
            retained_renderer_object_ids.push_back(id);
            for (const auto* volume : (*after)->volumes)
                retained_volume_transforms.push_back(json{{"volume_id", volume->id().id},
                    {"transform", Neo::Bridge::PlateSession::session_transform_json(volume->get_transformation())}});
        }
    }
    // Rack contents and per-entity material assignment are separate native
    // roots, but both change the renderer's filament-session projection.
    const auto material_assignments = [](const json& snapshot) {
        json result = json::object();
        // Exact project inputs read by filament_session_snapshot_json:
        // slot colours, mappings, flushing and inherited routing.
        const auto project = snapshot.value("project", json::object());
        for (const char* key : {"filament_colour", "filament_map", "filament_volume_map", "filament_nozzle_map",
                               "filament_map_2", "flush_volumes_matrix", "flush_volumes_vector",
                               "support_filament", "support_interface_filament", "outer_wall_filament_id",
                               "inner_wall_filament_id", "sparse_infill_filament_id", "internal_solid_filament_id",
                               "top_surface_filament_id", "bottom_surface_filament_id"})
            if (project.contains(key)) result["project"][key] = project[key];
        for (const auto* scope : {"objects", "parts"}) {
            const auto found = snapshot.find(scope);
            if (found == snapshot.end() || !found->is_object()) continue;
            for (const auto& [id, values] : found->items()) {
                for (const char* key : {"extruder", "support_filament", "support_interface_filament",
                                       "outer_wall_filament_id", "inner_wall_filament_id", "sparse_infill_filament_id",
                                       "internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id"})
                    if (values.contains(key)) result[scope][id][key] = values[key];
            }
        }
        return result;
    };
    const bool filament_projection_changed = filament_changed ||
        retained_renderer_object_ids.size() != restored.scene_delta.object_ids.size() ||
        material_assignments(before_native_scoped_config) != material_assignments(staged_snapshot);
    json scene_delta{{"version", 1},
                     {"object_ids", restored.scene_delta.object_ids},
                     {"retained_renderer_object_ids", retained_renderer_object_ids},
                     {"retained_volume_transforms", retained_volume_transforms},
                     {"volume_ids", restored.scene_delta.volume_ids},
                     {"instance_ids", restored.scene_delta.instance_ids},
                     {"plate_ids", restored.scene_delta.plate_ids}};
    if (restored.scene_delta.object_order.empty()) {
        scene_delta["object_order"] = json::array();
        for (const auto& object : restored.roots.model.mutable_objects)
            scene_delta["object_order"].push_back(object.id);
    } else {
        scene_delta["object_order"] = restored.scene_delta.object_order;
    }
    json result{{"ok", true}, {"context", response_context}, {"status", history_status_json()},
                {"native_scoped_config", Neo::Bridge::ScopedConfig::native_scoped_config_full_transport(
                    state().history_revision,
                    native_scoped_config_removed_targets(
                        before_native_scoped_config, native_scoped_config_snapshot()))},
                {"entryId", history_entry_id(entry_id)},
                {"scene_delta", std::move(scene_delta)},
                {"impact", {{"version", 1}, {"model", "delta"}, {"plateSession", true},
                            {"filamentRack", filament_projection_changed}, {"nativeScopedConfig", true}, {"selectionContext", true},
                            {"primeTower", true}, {"preview", "all"}}}};
    Neo::Bridge::Performance::record("history_restore", {
        {"model_staging_deserialization", restore_timings.model_staging_deserialization_ms},
        {"immutable_mesh_reconnect", restore_timings.immutable_mesh_reconnect_ms},
        {"plate_session_native_config_restore", restore_timings.plate_session_native_config_restore_ms},
        {"total", Neo::Bridge::Performance::now_ms() - restore_started_at},
    });
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
// mesh bytes are retained once by TimestampedHistory's immutable data store.
struct NeoHistoryArchiveContext {
    std::map<const Slic3r::TriangleMesh*, std::string> output_mesh_keys;
    std::map<std::string, std::shared_ptr<const Slic3r::TriangleMesh>> input_meshes;
    // Borrowed cursors for this one synchronous decode, never retained. The
    // manifest and live graph already own every ID, mesh and optional hull.
    const Slic3r::ModelObject* input_live_object = nullptr;
    const std::vector<Slic3r::Neo::History::ObjectID>* input_volume_ids = nullptr;
    std::size_t input_volume_index = 0;
    const Slic3r::ModelVolume* input_live_volume = nullptr;
    const Slic3r::ModelVolume* input_loading_volume = nullptr;
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
    if constexpr (std::is_same_v<T, Slic3r::ModelVolume>) {
        auto& context = cereal::get_user_data<NeoHistoryArchiveContext>(archive);
        context.input_live_volume = nullptr;
        context.input_loading_volume = object;
        if (object && context.input_live_object && context.input_volume_ids &&
            context.input_volume_index < context.input_volume_ids->size()) {
            const auto id = (*context.input_volume_ids)[context.input_volume_index];
            for (const auto* volume : context.input_live_object->volumes)
                if (volume->id().id == id) { context.input_live_volume = volume; break; }
        }
        ++context.input_volume_index;
    }
    if (object) archive(*object);
    if constexpr (std::is_same_v<T, Slic3r::ModelVolume>) {
        auto& context = cereal::get_user_data<NeoHistoryArchiveContext>(archive);
        context.input_live_volume = nullptr;
        context.input_loading_volume = nullptr;
    }
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
    else {
        value.reset();
        if constexpr (std::is_same_v<T, Slic3r::TriangleMesh>) {
            const auto& context = cereal::get_user_data<NeoHistoryArchiveContext>(archive);
            // Reuse only the hull ALREADY owned by this exact live volume and
            // immutable mesh. A missing/mismatched identity follows native
            // ModelVolume::load's full rebuild path. No additional owner,
            // cache entry, key, or lifetime is introduced.
            if (context.input_live_volume && context.input_loading_volume &&
                context.input_live_volume->get_mesh_shared_ptr() == context.input_loading_volume->get_mesh_shared_ptr())
                value = context.input_live_volume->get_convex_hull_shared_ptr();
        }
    }
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

std::array<double, 16> transform_fingerprint(const Transform3d& transform)
{
    std::array<double, 16> result {};
    std::copy_n(transform.data(), result.size(), result.data());
    return result;
}

Geometry::Transformation transformation_from_overlay(const MutableObject::Transform& values)
{
    Transform3d transform;
    std::copy(values.begin(), values.end(), transform.data());
    return Geometry::Transformation(transform);
}

template<class... T> std::string metadata_fingerprint(const T&... values)
{
    std::ostringstream stream(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive archive(stream);
    archive(values...);
    return stream.str();
}

MutableObjectCaptureCache::MutationFingerprint mutation_fingerprint(const ModelObject& object)
{
    MutableObjectCaptureCache::MutationFingerprint result;
    result.object_config_timestamp = static_cast<const ModelConfig&>(object.config).timestamp();
    result.name = object.name;
    result.module_name = object.module_name;
    result.input_file = object.input_file;
    result.printable = object.printable;
    // Native fields without a mutation timestamp still participate exactly.
    // Derived bounding-box caches are deliberately excluded; restore
    // invalidates them after applying the authoritative transform overlay.
    result.metadata = metadata_fingerprint(object.layer_config_ranges,
        object.layer_height_profile, object.sla_support_points, object.sla_points_status,
        object.sla_drain_holes, object.origin_translation, object.brim_points,
        object.cut_connectors, object.cut_id);
    result.volumes.reserve(object.volumes.size());
    for (const ModelVolume* volume : object.volumes) {
        MutableObjectCaptureCache::VolumeFingerprint fingerprint;
        fingerprint.transform = transform_fingerprint(volume->get_transformation().get_matrix());
        fingerprint.config_timestamp = static_cast<const ModelConfig&>(volume->config).timestamp();
        fingerprint.facet_timestamps = {
            volume->supported_facets.timestamp(), volume->seam_facets.timestamp(),
            volume->mmu_segmentation_facets.timestamp(), volume->fuzzy_skin_facets.timestamp()};
        fingerprint.name = volume->name;
        fingerprint.material_id = volume->material_id();
        fingerprint.type = static_cast<int>(volume->type());
        fingerprint.metadata = metadata_fingerprint(volume->source, volume->cut_info);
        // These complex, unversioned payloads have no cheap identity proof.
        // Conservatively capture such volumes rather than assuming they are
        // unchanged. They are not present in the ordinary mesh Move path.
        fingerprint.reusable = !volume->text_configuration && !volume->emboss_shape;
        result.volumes.push_back(std::move(fingerprint));
    }
    result.instances.reserve(object.instances.size());
    for (const ModelInstance* instance : object.instances) {
        MutableObjectCaptureCache::InstanceFingerprint fingerprint;
        fingerprint.transform = transform_fingerprint(instance->get_transformation().get_matrix());
        fingerprint.assemble_transform = transform_fingerprint(instance->get_assemble_transformation().get_matrix());
        fingerprint.printable = instance->printable;
        fingerprint.auto_drop = instance->auto_drop;
        fingerprint.print_volume_state = static_cast<int>(instance->print_volume_state);
        fingerprint.arrange_order = instance->arrange_order;
        fingerprint.loaded_id = instance->loaded_id;
        const auto assembly_offset = instance->get_offset_to_assembly();
        std::copy_n(assembly_offset.data(), 3, fingerprint.assembly_offset.data());
        fingerprint.assemble_initialized = const_cast<ModelInstance*>(instance)->is_assemble_initialized();
        result.instances.push_back(std::move(fingerprint));
    }
    return result;
}

} // namespace

bool prime_model_capture_cache(const Model& model, const ModelState& roots,
                               MutableObjectCaptureCache& object_cache)
{
    object_cache.invalidate_all();
    const auto fail = [&object_cache]() {
        object_cache.invalidate_all();
        return false;
    };
    if (model.objects.size() != roots.mutable_objects.size()) return fail();
    for (std::size_t index = 0; index < model.objects.size(); ++index) {
        const ModelObject& object = *model.objects[index];
        const MutableObject& root = roots.mutable_objects[index];
        const auto fingerprint = mutation_fingerprint(object);
        if (root.id != object.id().id ||
            root.timestamp != static_cast<const ModelConfig&>(object.config).timestamp() ||
            root.volume_ids.size() != object.volumes.size() ||
            root.instance_ids.size() != object.instances.size() ||
            root.volume_transforms.size() != fingerprint.volumes.size() ||
            root.instance_transforms.size() != fingerprint.instances.size())
            return fail();
        std::vector<MutableObjectCaptureCache::MeshPtr> meshes;
        meshes.reserve(object.volumes.size());
        for (std::size_t child = 0; child < object.volumes.size(); ++child) {
            if (root.volume_ids[child] != object.volumes[child]->id().id ||
                root.volume_transforms[child] != fingerprint.volumes[child].transform)
                return fail();
            meshes.push_back(object.volumes[child]->get_mesh_shared_ptr());
        }
        for (std::size_t child = 0; child < object.instances.size(); ++child)
            if (root.instance_ids[child] != object.instances[child]->id().id ||
                root.instance_transforms[child] != fingerprint.instances[child].transform)
                return fail();
        object_cache.prime(root.id, root.timestamp, root.data, meshes, root.volume_ids,
                           root.instance_ids, fingerprint);
    }
    return true;
}

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
        auto fingerprint = mutation_fingerprint(*object);
        std::vector<MutableObject::Transform> volume_transforms;
        volume_transforms.reserve(fingerprint.volumes.size());
        for (const auto& volume : fingerprint.volumes)
            volume_transforms.push_back(volume.transform);
        std::vector<MutableObject::Transform> instance_transforms;
        instance_transforms.reserve(fingerprint.instances.size());
        for (const auto& instance : fingerprint.instances)
            instance_transforms.push_back(instance.transform);
        const auto* cached = object_cache.find(
            object->id().id, timestamp, object_meshes, volume_ids, instance_ids, fingerprint);
        if (timings) timings->collection_cache_ms += Neo::Bridge::Performance::now_ms() - object_iteration_started_at;
        const double mutable_archive_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
        std::shared_ptr<const Bytes> object_bytes;
        if (cached) {
            object_bytes = cached->bytes;
            object_cache.record_reuse();
        } else {
            // Keep a complete native archive as the base. Its embedded
            // transforms are superseded by the root's exact transform
            // overlay, allowing transform-only successors to share it.
            std::ostringstream stream(std::ios::binary | std::ios::out);
            NeoHistoryOutputArchive archive(archive_context, stream);
            archive(*object);
            const std::string encoded = stream.str();
            object_bytes = std::make_shared<const Bytes>(encoded.begin(), encoded.end());
            object_cache.insert(object->id().id, timestamp, object_bytes, object_meshes,
                                volume_ids, instance_ids, std::move(fingerprint));
        }
        result.mutable_objects.push_back({
            object->id().id, timestamp, std::move(object_bytes), std::move(volume_ids),
            std::move(instance_ids), std::move(volume_transforms), std::move(instance_transforms)});
        if (timings) timings->mutable_object_archive_ms += Neo::Bridge::Performance::now_ms() - mutable_archive_started_at;
    }
    const double immutable_result_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    result.immutable_meshes.reserve(native_meshes_by_key.size());
    for (auto& [key, mesh] : native_meshes_by_key) {
        const std::size_t native_bytes = mesh ? mesh->memsize() : 0;
        result.immutable_meshes.push_back({std::move(key), std::move(mesh), native_bytes});
    }
    if (timings) {
        timings->immutable_mesh_retention_ms += Neo::Bridge::Performance::now_ms() - immutable_result_started_at;
        timings->total_ms = Neo::Bridge::Performance::now_ms() - total_started_at;
    }
    return result;
}

Model stage_model(const Model& model_template, const ModelState& restored,
                  RestoreTimings* timings, const ModelState* live_roots)
{
    NeoHistoryArchiveContext archive_context;
    const double mesh_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    for (const auto& mesh : restored.immutable_meshes) {
        if (!mesh.native) throw std::runtime_error("history mesh data is unavailable");
        archive_context.input_meshes.emplace(mesh.key, mesh.native);
    }
    if (timings)
        timings->immutable_mesh_reconnect_ms += Neo::Bridge::Performance::now_ms() - mesh_started_at;
    // ModelVolume's upstream undo archive omits ObjectBase and its owner link.
    // Restore the separately retained IDs, then use the public volume-copy
    // operation to repair owner links. Encoding painting again is unnecessary.
    for (const auto& [key, mesh] : archive_context.input_meshes)
        archive_context.output_mesh_keys.emplace(mesh.get(), key);

    // Deserialize into a transient model and let Model's copy assignment
    // rebuild ModelObject-owned volume/instance links. The transient is not
    // retained by history; TimestampedHistory owns only keyed object versions.
    const double mutable_started_at = timings ? Neo::Bridge::Performance::now_ms() : 0.0;
    Model rebuilt_model = model_template;
    std::map<ObjectID, ModelObject*> reusable_objects;
    for (ModelObject* object : rebuilt_model.objects)
        reusable_objects.emplace(object->id().id, object);
    std::vector<ModelObject*> restored_order;
    InstanceIdentityGraph instance_identity_graph;
    for (const auto& object : restored.mutable_objects) {
        // Shared archive identity proves all non-transform mutable fields are
        // unchanged. Reuse the native graph without decoding painting or
        // rebuilding its volumes; overlays remain the authoritative matrices.
        const ModelObject* reusable = nullptr;
        if (live_roots != nullptr) {
            for (std::size_t index = 0; index < live_roots->mutable_objects.size(); ++index) {
                const auto& live = live_roots->mutable_objects[index];
                if (live.id == object.id && live.data == object.data &&
                    live.volume_ids == object.volume_ids && live.instance_ids == object.instance_ids &&
                    index < model_template.objects.size() && model_template.objects[index]->id().id == object.id) {
                    reusable = model_template.objects[index];
                    break;
                }
            }
        }
        if (reusable != nullptr) {
#ifdef NEO_PROJECT_HISTORY_TEST
            if (timings) ++timings->reused_objects;
#endif
            if (object.volume_transforms.size() != reusable->volumes.size() ||
                object.instance_transforms.size() != reusable->instances.size())
                throw std::runtime_error("history transform identities are unavailable");
            ModelObject* native_object = reusable_objects.at(object.id);
            restored_order.push_back(native_object);
            for (std::size_t index = 0; index < native_object->volumes.size(); ++index)
                native_object->volumes[index]->set_transformation(transformation_from_overlay(object.volume_transforms[index]));
            for (std::size_t index = 0; index < native_object->instances.size(); ++index)
                native_object->instances[index]->set_transformation(transformation_from_overlay(object.instance_transforms[index]));
            native_object->invalidate_bounding_box();
            continue;
        }
        if (!object.data || object.data->empty()) throw std::runtime_error("history object data is unavailable");
#ifdef NEO_PROJECT_HISTORY_TEST
        if (timings) ++timings->deserialized_objects;
#endif
        std::string bytes(object.data->begin(), object.data->end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        ModelObject* native_object = rebuilt_model.add_object();
        restored_order.push_back(native_object);
        NeoHistoryInputArchive archive(archive_context, stream);
        archive_context.input_live_object = nullptr;
        for (const auto* candidate : model_template.objects)
            if (candidate->id().id == object.id) { archive_context.input_live_object = candidate; break; }
        archive_context.input_volume_ids = &object.volume_ids;
        archive_context.input_volume_index = 0;
        archive(*native_object);
        if (object.id == 0 || native_object->id().id != object.id)
            throw std::runtime_error("history object identity is unavailable");

        const std::size_t decoded_volume_count = native_object->volumes.size();
        if (object.volume_ids.size() != decoded_volume_count ||
            object.volume_transforms.size() != decoded_volume_count ||
            std::any_of(object.volume_ids.begin(), object.volume_ids.end(),
                        [](Neo::History::ObjectID id) { return id == 0; }))
            throw std::runtime_error("history volume identities are unavailable");
        // Retire decoded children through a temporary native owner. Calling
        // delete_volume while replacing them would invoke its user-edit
        // single-volume transform baking and assign a new last-volume ID.
        Model decoded_owner;
        ModelObject* decoded_object = decoded_owner.add_object();
        decoded_object->volumes = std::move(native_object->volumes);
        native_object->volumes.clear();
        for (std::size_t index = 0; index < decoded_volume_count; ++index) {
            ModelVolume* decoded = decoded_object->volumes[index];
            // ModelVolume::load deliberately skips ObjectBase. Feed the
            // separately retained native ID through the base serializer after
            // loading the mutable volume payload.
            std::ostringstream id_output(std::ios::binary | std::ios::out);
            cereal::BinaryOutputArchive id_writer(id_output);
            id_writer(Slic3r::ObjectID(object.volume_ids[index]));
            const std::string id_bytes = id_output.str();
            std::istringstream id_input(id_bytes, std::ios::binary | std::ios::in);
            cereal::BinaryInputArchive id_reader(id_input);
            id_reader(cereal::base_class<ObjectBase>(decoded));
            // add_volume(const ModelVolume&) preserves every native child ID,
            // copies painted vectors directly, and supplies the proper owner.
            // The immutable mesh remains shared; nothing new is retained.
            ModelVolume* materialized = native_object->add_volume(*decoded);
            materialized->set_transformation(
                transformation_from_overlay(object.volume_transforms[index]));
        }

        if (object.instance_transforms.size() != object.instance_ids.size())
            throw std::runtime_error("history instance transforms are unavailable");
        InstanceIDs instance_ids;
        instance_ids.reserve(object.instance_ids.size());
        for (const Neo::History::ObjectID id : object.instance_ids)
            instance_ids.emplace_back(id);
        instance_identity_graph.restore(*native_object, instance_ids);
        for (std::size_t index = 0; index < native_object->instances.size(); ++index)
            native_object->instances[index]->set_transformation(
                transformation_from_overlay(object.instance_transforms[index]));
        native_object->invalidate_bounding_box();
    }
    for (std::size_t index = rebuilt_model.objects.size(); index > 0; --index)
        if (std::find(restored_order.begin(), restored_order.end(), rebuilt_model.objects[index - 1]) == restored_order.end())
            rebuilt_model.delete_object(index - 1);
    rebuilt_model.objects = std::move(restored_order);
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
        const bool data_equal = left.data == right.data ||
            (left.data && right.data && *left.data == *right.data);
        if (left.id != right.id || left.timestamp != right.timestamp || !data_equal ||
            left.volume_ids != right.volume_ids || left.instance_ids != right.instance_ids ||
            left.volume_transforms != right.volume_transforms ||
            left.instance_transforms != right.instance_transforms)
            return false;
    }
    for (std::size_t index = 0; index < lhs.immutable_meshes.size(); ++index) {
        const auto& left = lhs.immutable_meshes[index];
        const auto& right = rhs.immutable_meshes[index];
        const auto native_equal = [](const auto& a, const auto& b) {
            if (!a || !b) return bool(a) == bool(b);
            std::owner_less<std::shared_ptr<const TriangleMesh>> less;
            return !less(a, b) && !less(b, a);
        };
        if (left.key != right.key) return false;
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
        !context.contains("nativeScopedConfig") ||
        !context["nativeScopedConfig"].is_object())
        throw std::runtime_error("invalid history context");
    if (context.contains("filamentState") &&
        (!context["filamentState"].is_object() || context["filamentState"].value("version", 0) != 1))
        throw std::runtime_error("invalid history filament state");
    if (context.contains("nativePrintPreset")) {
        const auto& preset = context["nativePrintPreset"];
        if (!preset.is_object() || !preset.contains("selected") || !preset["selected"].is_string() ||
            !preset.contains("selected_project_embedded") || !preset["selected_project_embedded"].is_boolean() ||
            !preset.contains("project_embedded_names") || !preset["project_embedded_names"].is_array() ||
            !preset.contains("project_embedded_presets") || !preset["project_embedded_presets"].is_array())
            throw std::runtime_error("invalid history native Print preset state");
    }
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
        {"gizmo", nullptr},
        {"nativeScopedConfig", Neo::Bridge::ScopedConfig::native_scoped_config_snapshot()},
        {"nativePrintPreset", Neo::Bridge::ScopedConfig::native_print_preset_history_state()},
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
    context["nativeScopedConfig"] = Neo::Bridge::ScopedConfig::native_scoped_config_snapshot();
    context["nativePrintPreset"] = Neo::Bridge::ScopedConfig::native_print_preset_history_state();
    // Filament presets, colours, routing, and matrices are not part of
    // ModelState. Every authoritative history context must therefore carry
    // the current native filament state; the project config is a dedicated
    // native-scoped history root.
    context["filamentState"] = filament_state;
    return context;
}

History::TimestampedRoots capture_history_roots(BridgeState& state, const json& context,
                                                History::Codec::CaptureTimings* timings)
{
    if (!context.is_object() || !context.contains("plateSession") ||
        !context.contains("nativeScopedConfig"))
        throw std::runtime_error("history context is missing canonical roots");
    History::TimestampedRoots roots;
    roots.model = History::Codec::capture_model_state(
        state.model, state.mesh_capture_cache, state.mutable_object_capture_cache, timings);
    json plate_session = context["plateSession"];
    // Input stamps identify derived slice/presentation generations, not the
    // editable project. History deliberately archives no derived result, so
    // normalize these counters out of timestamp identity. A successful
    // restore allocates fresh live stamps for every restored plate.
    plate_session["input_revisions"] = json::object();
    for (const auto& plate : plate_session["plates"]) {
        const auto plate_id = plate["plate_id"].get<std::string>();
        plate_session["input_revisions"][plate_id] = 0;
        roots.session.scene_plate_ids.push_back(plate_id);
    }
    roots.session.plate_session = HistoryRuntime::json_bytes(plate_session);
    json editing_context = context;
    editing_context.erase("plateSession");
    editing_context.erase("nativeScopedConfig");
    roots.session.history_context = HistoryRuntime::json_bytes(editing_context);
    roots.project_config = HistoryRuntime::json_bytes(context["nativeScopedConfig"]["project"]);
    return roots;
}

bool begin_timestamped_operation(BridgeState& state, const std::string& label, const json& before_context,
                                 History::Codec::CaptureTimings* timings)
{
    auto roots = capture_history_roots(state, before_context, timings);
    if (!state.history.begin_operation(label, roots)) return false;
    state.history_live_context = before_context;
    return true;
}

bool commit_timestamped_operation(BridgeState& state, const json& after_context)
{
    auto successor = capture_history_roots(state, after_context);
    if (!state.history.commit_operation(successor)) return false;
    state.history_live_context = after_context;
    advance_history_epoch(state);
    return true;
}

void abort_timestamped_operation(BridgeState& state)
{
    if (state.history.operation_active()) (void) state.history.abort_operation();
}

json history_status_json(const BridgeState& state)
{
    const auto& entries = state.history.entries();
    const auto current_timestamp = state.history.current_timestamp();
    json undo = json::array();
    json redo = json::array();
    auto cursor_timestamp = current_timestamp;
    while (true) {
        const auto found = std::find_if(entries.rbegin(), entries.rend(), [cursor_timestamp](const auto& entry) {
            return entry.after_timestamp == cursor_timestamp;
        });
        if (found == entries.rend()) break;
        undo.push_back(json{{"id", history_entry_id(found->id)}, {"label", found->label},
                            {"category", "project"}, {"beforeTimestamp", found->before_timestamp},
                            {"afterTimestamp", found->after_timestamp}});
        cursor_timestamp = found->before_timestamp;
    }
    cursor_timestamp = current_timestamp;
    while (true) {
        const auto found = std::find_if(entries.begin(), entries.end(), [cursor_timestamp](const auto& entry) {
            return entry.before_timestamp == cursor_timestamp;
        });
        if (found == entries.end()) break;
        redo.push_back(json{{"id", history_entry_id(found->id)}, {"label", found->label},
                            {"category", "project"}, {"beforeTimestamp", found->before_timestamp},
                            {"afterTimestamp", found->after_timestamp}});
        cursor_timestamp = found->after_timestamp;
    }
    const json undo_label = undo.empty() ? json(nullptr) : undo.front()["label"];
    const json redo_label = redo.empty() ? json(nullptr) : redo.front()["label"];
    const auto saved = state.history.saved_timestamp();
    const auto resources = state.history.resource_diagnostics();
    return json{
        // The visible navigation list is the filtered project stream. Keep
        // its booleans derived from the same stream so context checkpoints
        // cannot disagree with the entries exposed to the renderer.
        {"canUndo", !undo.empty()}, {"canRedo", !redo.empty()},
        {"undoLabel", undo_label}, {"redoLabel", redo_label},
        {"undoEntries", std::move(undo)}, {"redoEntries", std::move(redo)},
        {"cursor", current_timestamp},
        {"savedCheckpoint", saved ? json(*saved) : json(nullptr)},
        {"savedCheckpointEvicted", state.history.saved_checkpoint_evicted()},
        {"dirty", state.history.project_modified()},
        {"bytesUsed", state.history.bytes_used()}, {"byteBudget", state.history.byte_budget()},
        {"evictedEntryCount", resources.evicted_timestamp_count},
        {"lastEvictedEntryId", resources.last_evicted_timestamp == 0
            ? json(nullptr) : json(std::string("ts-") + std::to_string(resources.last_evicted_timestamp))},
        {"oldestRetainedEntryId", state.history.entries().empty()
            ? json(nullptr) : json(history_entry_id(state.history.entries().front().id))},
        {"oversizedEntryRetained", resources.oversized_nearest_history_retained},
        {"disabled", state.history_disabled},
        {"activeTransactionId", state.active_history_transaction ? json(state.active_history_transaction->id) : json(nullptr)},
        {"revision", state.history_revision},
    };
}

std::uint64_t advance_history_epoch(BridgeState& state)
{
    return ++state.history_revision;
}

json restore_diagnostics_json(const BridgeState& state)
{
    json out = {
        {"minimalMutableRestoreCount", state.history_minimal_mutable_restore_count},
        {"fullPresetBundleCopyCount", state.full_preset_bundle_copy_count},
        {"serializedMeshCount", state.mesh_capture_cache.serialized_mesh_count()},
        {"serializedObjectCount", state.mutable_object_capture_cache.serialized_object_count()},
        {"reusedObjectCount", state.mutable_object_capture_cache.reused_object_count()},
    };
    out["currentContextBytes"] = state.history_live_context.dump().size();
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
            BridgeState::HistoryTransaction nested;
            nested.id = id;
            nested.label = label;
            nested.before_context = before_context;
            nested.before_roots = HistoryMetadata::capture_history_roots(state(), before_context);
            nested.before_plate_input_revisions = state().plate_input_revisions;
            nested.before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
            nested.coalesced = true;
            nested.parent_id = parent_target;
            nested.base_history_revision = state().history_revision;
            state().nested_history_transactions.push_back(std::move(nested));
            return duplicate_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
        }
        const std::string id = std::string("tx-") + std::to_string(state().next_history_transaction_id++);
        const double capture_started_at = Neo::Bridge::Performance::now_ms();
        Neo::History::Codec::CaptureTimings capture_timings;
        auto before_roots = HistoryMetadata::capture_history_roots(state(), before_context, &capture_timings);
        if (!state().history.begin_operation(label, before_roots))
            return error_json("could not capture history predecessor");
        const double capture_finished_at = Neo::Bridge::Performance::now_ms();
        BridgeState::HistoryTransaction transaction;
        transaction.id = id;
        transaction.label = label;
        transaction.before_context = before_context;
        transaction.before_roots = std::move(before_roots);
        transaction.before_plate_input_revisions = state().plate_input_revisions;
        transaction.before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
        transaction.base_history_revision = state().history_revision;
        state().active_history_transaction = std::move(transaction);
        state().history_live_context = before_context;
        Neo::Bridge::Performance::Timings begin_stages{
            {"total", Neo::Bridge::Performance::now_ms() - profile_started_at}};
        begin_stages.push_back({"capture_collection_cache", capture_timings.collection_cache_ms});
        begin_stages.push_back({"capture_mutable_object_archive", capture_timings.mutable_object_archive_ms});
        begin_stages.push_back({"capture_immutable_mesh_retention", capture_timings.immutable_mesh_retention_ms});
        begin_stages.push_back({"capture_model_state", capture_timings.total_ms});
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
        const double capture_started_at = Neo::Bridge::Performance::now_ms();
        Neo::History::Codec::CaptureTimings capture_timings;
        const auto after_roots = HistoryMetadata::capture_history_roots(state(), after_context, &capture_timings);
        const double capture_finished_at = Neo::Bridge::Performance::now_ms();
        const bool unchanged = Neo::History::Codec::model_state_equal(tx.before_roots.model, after_roots.model) &&
            tx.before_roots.session.plate_session == after_roots.session.plate_session &&
            tx.before_roots.session.history_context == after_roots.session.history_context &&
            tx.before_roots.project_config == after_roots.project_config;
        if (unchanged) {
            if (!state().history.abort_operation()) return error_json("history no-op cleanup failed");
            state().active_history_transaction.reset();
            state().nested_history_transactions.clear();
            state().history_live_context = after_context;
            return duplicate_json(history_status_json().dump());
        }
        const double commit_started_at = Neo::Bridge::Performance::now_ms();
        if (!state().history.commit_operation(after_roots)) return error_json("history commit rejected");
        HistoryMetadata::advance_history_epoch(state());
        state().history_live_context = after_context;
        const auto removed_native_scoped_config_targets = native_scoped_config_removed_targets(
            tx.before_context.value("nativeScopedConfig", empty_native_scoped_config_snapshot()),
            native_scoped_config_snapshot());
        const double commit_finished_at = Neo::Bridge::Performance::now_ms();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        Neo::Bridge::Performance::Timings commit_stages{
            {"history_store", commit_finished_at - commit_started_at},
            {"total", Neo::Bridge::Performance::now_ms() - profile_started_at},
        };
        commit_stages.push_back({"capture_collection_cache", capture_timings.collection_cache_ms});
        commit_stages.push_back({"capture_mutable_object_archive", capture_timings.mutable_object_archive_ms});
        commit_stages.push_back({"capture_immutable_mesh_retention", capture_timings.immutable_mesh_retention_ms});
        commit_stages.push_back({"capture_model_state", capture_timings.total_ms});
        Neo::Bridge::Performance::record("history_commit", std::move(commit_stages));
        json response = history_status_json();
        if (!tx.native_scoped_config_targets.empty()) {
            std::vector<std::pair<std::string, std::string>> targets(
                tx.native_scoped_config_targets.begin(), tx.native_scoped_config_targets.end());
            response["native_scoped_config"] = native_scoped_config_affected_transport(
                native_scoped_config_snapshot(), targets, state().history_revision,
                removed_native_scoped_config_targets);
        } else {
            // Structural transactions can normalize plate-local settings
            // without submitting a scoped-config command.  Publish one full
            // replacement at the same committed revision so the application
            // never has to infer those changes from a stale pre-commit map.
            response["native_scoped_config"] = native_scoped_config_full_transport(
                state().history_revision, removed_native_scoped_config_targets);
        }
        return duplicate_json(response.dump());
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
        const auto roots_match = [](const Neo::History::TimestampedRoots& left,
                                    const Neo::History::TimestampedRoots& right) {
            return Neo::History::Codec::model_state_equal(left.model, right.model) &&
                left.session.plate_session == right.session.plate_session &&
                left.session.history_context == right.session.history_context &&
                left.project_config == right.project_config;
        };
        if (!state().nested_history_transactions.empty()) {
            auto tx = state().nested_history_transactions.back();
            if (requested != tx.id) return error_json("history transaction is stale or belongs to another writer");
            state().nested_history_transactions.pop_back();
            const json live_context = current_context(runtime);
            const auto live_roots = HistoryMetadata::capture_history_roots(state(), live_context);
            if (roots_match(tx.before_roots, live_roots)) {
                state().history_live_context = live_context;
                return duplicate_json(json{{"ok", true}, {"context", live_context},
                                           {"status", history_status_json()}}.dump());
            }
            const Neo::History::TimestampedRestore predecessor{
                state().history.current_timestamp(), tx.before_roots};
            json result = restore_timestamped_result(runtime, predecessor, 0);
            restore_transaction_runtime_snapshot(tx);
            result["context"] = state().history_live_context;
            result.erase("entryId");
            return duplicate_json(result.dump());
        }
        if (requested != state().active_history_transaction->id)
            return error_json("history transaction is stale or belongs to another writer");
        const auto tx = *state().active_history_transaction;
        const json live_context = current_context(runtime);
        const auto live_roots = HistoryMetadata::capture_history_roots(state(), live_context);
        Neo::History::TimestampedRestore predecessor;
        if (!state().history.abort_operation(&predecessor))
            return error_json("history abort predecessor is unavailable");
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        if (roots_match(tx.before_roots, live_roots)) {
            state().history_live_context = live_context;
            return duplicate_json(json{{"ok", true}, {"context", live_context},
                                       {"status", history_status_json()}}.dump());
        }
        json result = restore_timestamped_result(runtime, predecessor, 0);
        restore_transaction_runtime_snapshot(tx);
        result["context"] = state().history_live_context;
        result.erase("entryId");
        return duplicate_json(result.dump());
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
        const auto original_timestamp = state().history.current_timestamp();
        const auto entry = std::find_if(state().history.entries().rbegin(), state().history.entries().rend(),
            [original_timestamp](const auto& candidate) { return candidate.after_timestamp == original_timestamp; });
        if (entry == state().history.entries().rend()) return error_json("no undo history");
        const std::uint64_t entry_id = entry->id;
        const auto live_roots = HistoryMetadata::capture_history_roots(state(), current_context(runtime));
        Neo::History::TimestampedRestore restored;
        if (!state().history.undo(live_roots, restored)) return error_json("no undo history");
        try {
            return duplicate_json(restore_timestamped_result(runtime, restored, entry_id).dump());
        } catch (...) {
            Neo::History::TimestampedRestore ignored;
            if (!state().history.restore(original_timestamp, nullptr, ignored)) state().history_disabled = true;
            throw;
        }
    } catch (const std::exception& e) { return restore_failure(e.what()); }
    catch (...) { return restore_failure("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_redo()
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        const auto original_timestamp = state().history.current_timestamp();
        const auto entry = std::find_if(state().history.entries().begin(), state().history.entries().end(),
            [original_timestamp](const auto& candidate) { return candidate.before_timestamp == original_timestamp; });
        if (entry == state().history.entries().end()) return error_json("no redo history");
        const std::uint64_t entry_id = entry->id;
        Neo::History::TimestampedRestore restored;
        if (!state().history.redo(restored)) return error_json("no redo history");
        try {
            return duplicate_json(restore_timestamped_result(runtime, restored, entry_id).dump());
        } catch (...) {
            Neo::History::TimestampedRestore ignored;
            if (!state().history.restore(original_timestamp, nullptr, ignored)) state().history_disabled = true;
            throw;
        }
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
        const json status = history_status_json();
        const char* side = direction == Neo::History::JumpDirection::Undo ? "undoEntries" : "redoEntries";
        const std::string encoded_id = history_entry_id(entry_id);
        if (std::none_of(status.at(side).begin(), status.at(side).end(), [&](const json& item) {
                return item.value("id", "") == encoded_id;
            }))
            return error_json("history entry is stale, unavailable, or outside the requested direction");
        const auto original_timestamp = state().history.current_timestamp();
        const auto live_roots = HistoryMetadata::capture_history_roots(state(), current_context(runtime));
        Neo::History::TimestampedRestore restored;
        const bool prepared = direction == Neo::History::JumpDirection::Undo
            ? state().history.restore_before(entry_id, &live_roots, restored)
            : state().history.restore_after(entry_id, &live_roots, restored);
        if (!prepared)
            return error_json("history entry is stale, unavailable, or outside the requested direction");
        try {
            return duplicate_json(restore_timestamped_result(runtime, restored, entry_id).dump());
        } catch (...) {
            Neo::History::TimestampedRestore ignored;
            if (!state().history.restore(original_timestamp, nullptr, ignored)) state().history_disabled = true;
            throw;
        }
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
        state().nested_history_transactions.clear();
        state().history_disabled = false;
        state().history_live_context = context;
        (void) HistoryMetadata::capture_history_roots(state(), context);
        state().history.mark_current_as_saved();
        HistoryMetadata::advance_history_epoch(state());
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_mark_saved(const char* context_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (context_cstr && *context_cstr) {
            const json context = canonical_history_context(runtime, parse_history_context(context_cstr));
            state().history_live_context = context;
        }
        state().history.mark_current_as_saved();
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

} // extern "C"

} // namespace Slic3r::Neo::Bridge::HistoryRuntime
