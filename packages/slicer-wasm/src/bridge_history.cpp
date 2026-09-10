#define CEREAL_FUTURE_EXPERIMENTAL

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "bridge_history.hpp"
#include "bridge_filament.hpp"
#include "bridge_plate_session.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_slicing_pipeline.hpp"
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
using Neo::Bridge::ProjectOverlay::valid_project_config_overlay;
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
            object_index >= model.objects.size() || instance_index >= model.objects[object_index]->instances.size())
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
    if (saved_instances.size() != model_instance_ids.size())
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
    state().plate_input_revisions.clear();
    for (const auto& instance : session["instances"]) {
        const auto object_index = instance["object_index"].get<std::size_t>();
        const auto instance_index = instance["instance_index"].get<std::size_t>();
        const auto restored_id = restored_model.objects[object_index]->instances[instance_index]->id().id;
        const std::string plate_id = instance["plate_id"].get<std::string>();
        if (!plate_id.empty()) state().instance_plate_ids[restored_id] = plate_id;
        if (instance["parked"].get<bool>()) state().parked_instance_ids.insert(restored_id);
        if (instance["out_of_bounds"].get<bool>()) state().plate_out_of_bounds_ids[plate_id].insert(restored_id);
    }
    for (const auto& [plate_id, revision] : session["input_revisions"].items())
        state().plate_input_revisions[plate_id] = revision.get<std::uint64_t>();
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
    auto staged_model = Neo::History::Codec::model_state_equal(capture_model_state(state().model), model)
        ? Model(state().model) : Neo::History::Codec::stage_model(state().model, {model, {}, {}});
    auto staged_plates = state().plate_session_plates;
    if (context.contains("plateSession")) staged_plates = build_history_plate_session(context["plateSession"], staged_model);
    validate_filament_history_mutable_state(state().presets, staged_filament_state, staged_model, staged_plates,
                                            context.value("projectConfigOverlay", empty_project_config_overlay()));
    auto before_filament_state = stage_mutable(state().presets, history_state_json(state().presets));
    const auto before_model = state().model;
    const auto before_plates = state().plate_session_plates;
    const auto before_overlay = state().project_config_overlay;
    apply_mutable(state(), state().presets, std::move(staged_filament_state));
    state().model = std::move(staged_model);
    try {
        if (context.contains("plateSession")) restore_history_plate_session(context["plateSession"], state().model);
        if (valid_project_config_overlay(context["projectConfigOverlay"]))
            state().project_config_overlay = context["projectConfigOverlay"];
    } catch (...) {
        apply_mutable(state(), state().presets, std::move(before_filament_state));
        state().model = before_model;
        state().plate_session_plates = before_plates;
        state().project_config_overlay = before_overlay;
        throw;
    }
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
    if (!plan.state.direct_frame || !plan.state.direct_frame->payload || plan.state.direct_frame->bytes == 0)
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
    auto staged_plate_revisions = frame->plate_input_revisions;
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
        state().plate_session_plates = std::move(staged_plates);
        state().project_config_overlay = std::move(staged_overlay);
        state().plate_input_revisions = std::move(staged_plate_revisions);
        state().instance_plate_ids = std::move(staged_membership);
        state().plate_out_of_bounds_ids = std::move(staged_out_of_bounds);
        state().parked_instance_ids = std::move(staged_parked);
        state().pending_membership_instance_ids = std::move(staged_pending);
        state().current_plate_id = staged_current_plate;
        state().next_filament_colour_index = staged_colour_index;
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
        ++state().history_minimal_mutable_restore_count;
    } catch (...) {
        state().presets.filament_presets = before_filament_presets;
        state().presets.project_config = before_project_config;
        state().presets.ams_multi_color_filment = before_ams_colours;
        state().presets.filaments.get_edited_preset() = before_edited;
        state().model = std::move(before_model);
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
    state().print.clear();
    if (runtime.invalidate_preview) runtime.invalidate_preview();
    ++state().history_revision;
    return json{{"ok", true}, {"context", context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}, {"direct", true}};
}

json restore_result(const Runtime& runtime, const Neo::History::RestorePlan& plan)
{
    const auto parsed = json::parse(std::string(plan.state.context.begin(), plan.state.context.end()));
    const json context = parse_history_context(parsed.dump().c_str());
    if (plan.state.direct_frame) return restore_direct_frame(runtime, plan, context);
    const auto live_model_state = capture_model_state(state().model);
    Model staged_model = Neo::History::Codec::model_state_equal(live_model_state, plan.state.model)
        ? Model(state().model) : Neo::History::Codec::stage_model(state().model, plan.state);
    if (!context.contains("filamentState")) throw std::runtime_error("history context is missing filament state");
    const bool filament_changed = history_state_json(state().presets) != context["filamentState"];
    std::optional<Neo::Bridge::Filament::State::StagedMutableState> staged_filament_state;
    if (filament_changed) staged_filament_state.emplace(stage_mutable(state().presets, context["filamentState"]));
    auto staged_plates = state().plate_session_plates;
    if (context.contains("plateSession")) staged_plates = build_history_plate_session(context["plateSession"], staged_model);
    if (staged_filament_state)
        validate_filament_history_mutable_state(state().presets, *staged_filament_state, staged_model, staged_plates,
                                                context.value("projectConfigOverlay", empty_project_config_overlay()));
    else
        validate_filament_candidate(state().presets, staged_model, staged_plates,
                                    context.value("projectConfigOverlay", empty_project_config_overlay()));
    if (!state().history.can_commit_restore(plan)) throw std::runtime_error("history restore became stale");
    std::optional<Neo::Bridge::Filament::State::StagedMutableState> before_filament_state;
    if (filament_changed) before_filament_state.emplace(stage_mutable(state().presets, history_state_json(state().presets)));
    Model before_model = state().model;
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
    try {
        if (context.contains("plateSession")) restore_history_plate_session(context["plateSession"], state().model);
        if (valid_project_config_overlay(context["projectConfigOverlay"])) state().project_config_overlay = context["projectConfigOverlay"];
        if (!state().history.commit_restore(plan)) throw std::runtime_error("history restore became stale");
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
        throw;
    }
    state().print.clear();
    if (runtime.invalidate_preview) runtime.invalidate_preview();
    ++state().history_revision;
    return json{{"ok", true}, {"context", context}, {"status", history_status_json()},
                {"entryId", history_entry_id(plan.state.entry.id)}};
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

void record_active_plate_context(const Runtime& runtime)
{
    const auto model_state = capture_model_state(state().model);
    Neo::Bridge::HistoryMetadata::record_active_plate_context(
        state(), plate_session_snapshot_json(), runtime.filament_history_state(), model_state);
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

Bytes mesh_bytes(const TriangleMesh& mesh)
{
    std::ostringstream stream(std::ios::binary | std::ios::out);
    cereal::BinaryOutputArchive archive(stream);
    archive(mesh);
    const std::string encoded = stream.str();
    return Bytes(encoded.begin(), encoded.end());
}

std::string mesh_key(const Bytes& bytes)
{
    std::uint64_t hash = 1469598103934665603ULL;
    for (const auto byte : bytes) {
        hash ^= byte;
        hash *= 1099511628211ULL;
    }
    return std::string("mesh-") + std::to_string(hash) + "-" + std::to_string(bytes.size());
}

} // namespace

ModelState capture_model_state(const Model& model)
{
    NeoHistoryArchiveContext archive_context;
    std::map<std::string, Bytes> mesh_bytes_by_key;
    for (const auto* object : model.objects) {
        for (const auto* volume : object->volumes) {
            const auto mesh = volume->get_mesh_shared_ptr();
            if (!mesh) continue;
            if (archive_context.output_mesh_keys.count(mesh.get())) continue;
            auto bytes = mesh_bytes(*mesh);
            const auto key = mesh_key(bytes);
            archive_context.output_mesh_keys.emplace(mesh.get(), key);
            mesh_bytes_by_key.emplace(key, std::move(bytes));
        }
    }

    ModelState result;
    // Restoration is driven entirely by ObjectID-keyed mutable records and
    // shared immutable mesh records. No complete-model archive is retained as
    // a per-entry equality or restore payload.
    result.mutable_objects.reserve(model.objects.size());
    for (const auto* object : model.objects) {
        std::ostringstream stream(std::ios::binary | std::ios::out);
        NeoHistoryOutputArchive archive(archive_context, stream);
        archive(*object);
        const std::string encoded = stream.str();
        result.mutable_objects.push_back({
            object->id().id, object->timestamp(),
            Bytes(encoded.begin(), encoded.end())});
    }
    result.immutable_meshes.reserve(mesh_bytes_by_key.size());
    for (auto& [key, bytes] : mesh_bytes_by_key)
        result.immutable_meshes.push_back({std::move(key), std::make_shared<const Bytes>(std::move(bytes)), {}, false});
    return result;
}

Model stage_model(const Model& model_template, const RestoreState& restored)
{
    NeoHistoryArchiveContext archive_context;
    for (const auto& mesh : restored.model.immutable_meshes) {
        const auto& encoded = mesh.resident ? *mesh.resident : (mesh.deferred ? *mesh.deferred : Bytes{});
        if (encoded.empty()) throw std::runtime_error("history mesh data is unavailable");
        std::string bytes(encoded.begin(), encoded.end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        auto native_mesh = std::make_shared<TriangleMesh>();
        cereal::BinaryInputArchive archive(stream);
        archive(*native_mesh);
        archive_context.input_meshes.emplace(mesh.key, std::move(native_mesh));
    }

    // Deserialize into a transient model and let Model's copy assignment
    // rebuild ModelObject-owned volume/instance links. The transient is not
    // retained by history; ProjectHistory owns only the keyed byte versions.
    Model rebuilt_model = model_template;
    rebuilt_model.clear_objects();
    for (const auto& object : restored.model.mutable_objects) {
        if (object.data.empty()) throw std::runtime_error("history object data is unavailable");
        std::string bytes(object.data.begin(), object.data.end());
        std::istringstream stream(bytes, std::ios::binary | std::ios::in);
        ModelObject* native_object = rebuilt_model.add_object();
        NeoHistoryInputArchive archive(archive_context, stream);
        archive(*native_object);

        // Native ModelInstance deserialization intentionally constructs with
        // an invalid ObjectID because Orca restores into an existing object
        // graph. Neo stages a fresh Model instead, so materialize each decoded
        // instance through ModelObject::add_instance() to allocate a valid
        // runtime identity before the plate-session membership map is applied.
        const std::size_t decoded_instance_count = native_object->instances.size();
        for (std::size_t index = 0; index < decoded_instance_count; ++index) {
            ModelInstance* decoded = native_object->instances[index];
            ModelInstance* materialized = native_object->add_instance();
            materialized->set_transformation(decoded->get_transformation());
            if (decoded->is_assemble_initialized())
                materialized->set_assemble_transformation(decoded->get_assemble_transformation());
            materialized->set_offset_to_assembly(decoded->get_offset_to_assembly());
            materialized->print_volume_state = decoded->print_volume_state;
            materialized->printable = decoded->printable;
            materialized->auto_drop = decoded->auto_drop;
            materialized->use_loaded_id_for_label = decoded->use_loaded_id_for_label;
            materialized->arrange_order = decoded->arrange_order;
            materialized->loaded_id = decoded->loaded_id;
        }
        for (std::size_t index = 0; index < decoded_instance_count; ++index)
            native_object->delete_instance(0);
    }
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
        if (left.id != right.id || left.timestamp != right.timestamp || left.data != right.data)
            return false;
    }
    for (std::size_t index = 0; index < lhs.immutable_meshes.size(); ++index) {
        const auto& left = lhs.immutable_meshes[index];
        const auto& right = rhs.immutable_meshes[index];
        const auto bytes_equal = [](const auto& a, const auto& b) {
            return (!a && !b) || (a && b && *a == *b);
        };
        if (left.key != right.key || left.optional != right.optional ||
            !bytes_equal(left.resident, right.resident) || !bytes_equal(left.deferred, right.deferred))
            return false;
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

void record_history_context(BridgeState& state,
                            const std::string& label,
                            const json& requested,
                            const json& plate_session,
                            const json& filament_state,
                            const History::ModelState& model_state)
{
    if (state.active_history_transaction) return;
    const json context = canonical_history_context(state, requested, plate_session, filament_state);
    if (state.history.entries().empty()) {
        const json baseline = default_history_context(state, plate_session, filament_state);
        const std::string encoded = baseline.dump();
        const History::Bytes context_bytes(encoded.begin(), encoded.end());
        state.history.commit("", History::Category::Project, model_state, context_bytes);
        state.history.mark_current_as_saved();
    }
    const std::string encoded = context.dump();
    const History::Bytes context_bytes(encoded.begin(), encoded.end());
    // Context-only records intentionally do not advance history_revision: the
    // model, filament rack, and slice inputs remain unchanged.
    state.history.commit(label, History::Category::Context, model_state, context_bytes);
}

void record_active_plate_context(BridgeState& state,
                                 const json& plate_session,
                                 const json& filament_state,
                                 const History::ModelState& model_state)
{
    json context = default_history_context(state, plate_session, filament_state);
    if (!state.history.entries().empty()) {
        try {
            const auto& current = state.history.current();
            context = json::parse(std::string(current.context.begin(), current.context.end()));
        } catch (...) { context = default_history_context(state, plate_session, filament_state); }
    }
    context["activePlateId"] = state.current_plate_id.empty()
        ? json(nullptr) : json(state.current_plate_id);
    record_history_context(state, "Active Plate", context, plate_session, filament_state, model_state);
}

json history_status_json(const BridgeState& state)
{
    const auto entries = state.history.entries();
    const std::size_t cursor = state.history.cursor();
    json undo = json::array();
    json redo = json::array();
    for (std::size_t i = cursor; i > 0; --i) {
        const auto& entry = entries[i];
        if (entry.category != History::Category::Project || entry.id == 0) continue;
        undo.push_back(json{{"id", history_entry_id(entry.id)}, {"label", entry.label},
                            {"category", entry.category == History::Category::Project ? "project" : "context"}});
    }
    for (std::size_t i = cursor + 1; i < entries.size(); ++i) {
        const auto& entry = entries[i];
        if (entry.category != History::Category::Project || entry.id == 0) continue;
        redo.push_back(json{{"id", history_entry_id(entry.id)}, {"label", entry.label},
                            {"category", entry.category == History::Category::Project ? "project" : "context"}});
    }
    const auto* undo_entry = state.history.undo_entry();
    const auto* redo_entry = state.history.redo_entry();
    const auto saved = state.history.saved_checkpoint();
    const auto resources = state.history.resource_diagnostics();
    return json{
        {"canUndo", state.history.can_undo()}, {"canRedo", state.history.can_redo()},
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

json restore_diagnostics_json(const BridgeState& state)
{
    return json{
        {"minimalMutableRestoreCount", state.history_minimal_mutable_restore_count},
        {"fullPresetBundleCopyCount", state.full_preset_bundle_copy_count},
    };
}

} // namespace Slic3r::Neo::Bridge::HistoryMetadata

namespace Slic3r::Neo::Bridge::HistoryRuntime {

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_history_begin(const char* label_cstr, const char* category_cstr,
                                                   const char* before_context_cstr, const char* options_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        const std::string label = label_cstr ? label_cstr : "";
        const std::string category = category_cstr ? category_cstr : "";
        if (label.empty()) return error_json("history label is required");
        if (category != "project" && category != "context") return error_json("history category must be project or context");
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
                category == "project" ? Neo::History::Category::Project : Neo::History::Category::Context,
                before_context, capture_model_state(state().model), true, parent_target});
            return duplicate_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
        }
        if (state().history.entries().empty()) {
            const std::string text = before_context.dump();
            state().history.commit("", Neo::History::Category::Project, capture_model_state(state().model),
                                   Neo::History::Bytes(text.begin(), text.end()));
        }
        const std::string id = std::string("tx-") + std::to_string(state().next_history_transaction_id++);
        state().active_history_transaction = BridgeState::HistoryTransaction{
            id, label, category == "project" ? Neo::History::Category::Project : Neo::History::Category::Context,
            before_context, capture_model_state(state().model), false, {}};
        return duplicate_json(json{{"ok", true}, {"transactionId", id}, {"status", history_status_json()}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_commit(const char* transaction_id_cstr, const char* after_context_cstr)
{
    try {
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
        if (state().history.commit(tx.label, tx.category, capture_model_state(state().model), bytes))
            ++state().history_revision;
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
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
            state().nested_history_transactions.pop_back();
            state().print.clear();
            if (runtime.invalidate_preview) runtime.invalidate_preview();
            ++state().history_revision;
            return duplicate_json(json{{"ok", true}, {"context", tx.before_context}, {"status", history_status_json()}}.dump());
        }
        if (requested != state().active_history_transaction->id)
            return error_json("history transaction is stale or belongs to another writer");
        const auto tx = *state().active_history_transaction;
        restore_history_transaction_state(tx.before_context, tx.before_model);
        state().print.clear();
        if (runtime.invalidate_preview) runtime.invalidate_preview();
        state().active_history_transaction.reset();
        state().nested_history_transactions.clear();
        ++state().history_revision;
        return duplicate_json(json{{"ok", true}, {"context", tx.before_context}, {"status", history_status_json()}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_undo()
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        Neo::History::RestorePlan plan;
        if (!state().history.prepare_undo(plan)) return error_json("no undo history");
        return duplicate_json(restore_result(runtime, plan).dump());
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
        return duplicate_json(restore_result(runtime, plan).dump());
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
        if (!state().history.prepare_jump(entry_id, direction, plan)) return error_json("history entry is stale, unavailable, or outside the requested direction");
        return duplicate_json(restore_result(runtime, plan).dump());
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
        state().active_history_transaction.reset();
        state().history_disabled = false;
        const std::string text = context.dump();
        const Neo::History::Bytes bytes(text.begin(), text.end());
        if (!state().history.commit("", Neo::History::Category::Project, capture_model_state(state().model), bytes))
            return error_json("could not establish history baseline");
        state().history.mark_current_as_saved();
        ++state().history_revision;
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
            if (!state().history.commit("", Neo::History::Category::Project, capture_model_state(state().model), bytes))
                return error_json("could not establish history baseline");
        }
        state().history.mark_current_as_saved();
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_history_record_context(const char* label_cstr, const char* context_cstr)
{
    try {
        const Runtime runtime = HistoryRuntime::runtime();
        if (state().history_disabled) return error_json("history is disabled");
        if (state().active_history_transaction) return error_json("history transaction is active");
        const std::string label = label_cstr ? label_cstr : "";
        if (label.empty()) return error_json("history label is required");
        const json context = canonical_history_context(runtime, parse_history_context(context_cstr));
        const auto model_state = capture_model_state(state().model);
        Neo::Bridge::HistoryMetadata::record_history_context(
            state(), label, context, plate_session_snapshot_json(), runtime.filament_history_state(), model_state);
        return duplicate_json(history_status_json().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

} // extern "C"

} // namespace Slic3r::Neo::Bridge::HistoryRuntime
