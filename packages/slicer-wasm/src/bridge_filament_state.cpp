#include "bridge_filament_state.hpp"

#include <stdexcept>

#include "libslic3r/PrintConfig.hpp"

namespace Slic3r::Neo::Bridge::FilamentState {

json config_metadata_json(const DynamicPrintConfig& config)
{
    json out = json::object();
    for (const std::string& key : config.keys()) {
        try { out[key] = config.opt_serialize(key); }
        catch (...) { /* unknown future options remain opaque */ }
    }
    return out;
}

json history_state_json(const PresetBundle& bundle)
{
    return json{
        {"version", 1},
        {"filament_presets", bundle.filament_presets},
        {"project_config", config_metadata_json(bundle.project_config)},
        {"edited_filament_config", config_metadata_json(bundle.filaments.get_edited_preset().config)},
        {"ams_multi_colour_filment", bundle.ams_multi_color_filment},
    };
}

std::size_t direct_frame_bytes(const DirectHistoryFrame& frame,
                               const History::ModelState& model_state)
{
    // ModelState is already the authoritative archive budget proxy. Charge
    // the opaque frame once so this acceleration cannot become an unbudgeted
    // cache.
    std::size_t bytes = sizeof(DirectHistoryFrame);
    const auto add_string = [&bytes](const std::string& value) {
        bytes += value.capacity() + 1;
    };
    for (const auto& value : frame.filament_presets) add_string(value);
    for (const auto& row : frame.ams_multi_colour_filment)
        for (const auto& value : row) add_string(value);
    const std::string edited = frame.edited_filament
        ? config_metadata_json(frame.edited_filament->config).dump() : std::string{};
    const std::string project = config_metadata_json(frame.project_config).dump();
    const std::string overlay = frame.overlay.dump();
    bytes += edited.capacity() + project.capacity() + overlay.capacity();
    for (const auto& plate : frame.plates) {
        bytes += sizeof(BridgeState::PlateSessionPlate) + plate.id.capacity() + plate.name.capacity() + 2;
        bytes += plate.settings_metadata.dump().capacity() + plate.opaque_metadata.dump().capacity() +
            plate.future_metadata.dump().capacity();
    }
    for (const auto& object : model_state.mutable_objects) bytes += object.data.capacity();
    for (const auto& mesh : model_state.immutable_meshes) {
        bytes += mesh.key.capacity() + 1;
        if (mesh.resident) bytes += mesh.resident->capacity();
        if (mesh.deferred) bytes += mesh.deferred->capacity();
    }
    return bytes;
}

std::optional<History::RestoreState::DirectFrame>
make_direct_frame(BridgeState& bridge, std::shared_ptr<const Model> model,
                  const History::ModelState& model_state)
{
    if (!model) return std::nullopt;
    auto frame = std::make_shared<DirectHistoryFrame>();
    frame->filament_presets = bridge.presets.filament_presets;
    frame->edited_filament.emplace(bridge.presets.filaments.get_edited_preset());
    frame->project_config = bridge.presets.project_config;
    frame->ams_multi_colour_filment = bridge.presets.ams_multi_color_filment;
    frame->model = std::move(model);
    frame->plates = bridge.plate_session_plates;
    frame->overlay = bridge.project_config_overlay;
    frame->plate_input_revisions = bridge.plate_input_revisions;
    frame->instance_plate_ids = bridge.instance_plate_ids;
    frame->plate_out_of_bounds_ids = bridge.plate_out_of_bounds_ids;
    frame->parked_instance_ids = bridge.parked_instance_ids;
    frame->pending_membership_instance_ids = bridge.pending_membership_instance_ids;
    frame->current_plate_id = bridge.current_plate_id;
    frame->next_filament_colour_index = bridge.next_filament_colour_index;
    const std::size_t bytes = direct_frame_bytes(*frame, model_state);
    return History::RestoreState::DirectFrame{
        std::static_pointer_cast<const void>(std::move(frame)), bytes};
}

std::shared_ptr<const Model> current_direct_frame_model(const BridgeState& bridge)
{
    const auto& current = bridge.history.current();
    if (!current.direct_frame || !current.direct_frame->payload) return {};
    const auto frame = std::static_pointer_cast<const DirectHistoryFrame>(
        current.direct_frame->payload);
    return frame ? frame->model : std::shared_ptr<const Model>{};
}

void apply_project_sidecar(PresetBundle& bundle, const json& encoded)
{
    if (!encoded.is_object() || encoded.value("version", 0) != 1 ||
        !encoded.contains("filament_presets") || !encoded["filament_presets"].is_array() ||
        encoded["filament_presets"].empty() || encoded["filament_presets"].size() > 64 ||
        !encoded.contains("project_config") || !encoded["project_config"].is_object())
        throw std::runtime_error("invalid project filament sidecar state");

    std::vector<std::string> names;
    names.reserve(encoded["filament_presets"].size());
    for (const auto& value : encoded["filament_presets"]) {
        if (!value.is_string() || value.get<std::string>().empty())
            throw std::runtime_error("invalid history filament preset name");
        const std::string name = value.get<std::string>();
        if (bundle.filaments.find_preset(name, false, true) == nullptr)
            throw std::runtime_error("history filament preset is unavailable");
        names.push_back(name);
    }
    bundle.set_num_filaments(static_cast<unsigned int>(names.size()));
    bundle.filament_presets = names;
    for (std::size_t index = 0; index < names.size(); ++index)
        bundle.set_filament_preset(index, names[index]);
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = encoded["project_config"].begin(); it != encoded["project_config"].end(); ++it) {
        if (!it.value().is_string()) throw std::runtime_error("invalid history project config value");
        try { bundle.project_config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions); }
        catch (const std::exception& e) {
            throw std::runtime_error(std::string("invalid history project config: ") + e.what());
        }
    }
}

static void apply_overlay_to_config(DynamicPrintConfig& config, const json& values)
{
    if (!values.is_object()) return;
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = values.begin(); it != values.end(); ++it) {
        if (!it.value().is_string()) continue;
        try { config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions); }
        catch (...) { /* invalid retained values are ignored at slice time */ }
    }
}

StagedMutableState stage_mutable(const PresetBundle& catalog, const json& encoded)
{
    if (!encoded.is_object() || encoded.value("version", 0) != 1 ||
        !encoded.contains("filament_presets") || !encoded["filament_presets"].is_array() ||
        encoded["filament_presets"].empty() || encoded["filament_presets"].size() > 64 ||
        !encoded.contains("project_config") || !encoded["project_config"].is_object())
        throw std::runtime_error("invalid history filament state");
    StagedMutableState staged {
        {}, catalog.project_config, catalog.ams_multi_color_filment,
        catalog.filaments.get_edited_preset() };
    staged.names.reserve(encoded["filament_presets"].size());
    for (const auto& value : encoded["filament_presets"]) {
        if (!value.is_string() || value.get<std::string>().empty())
            throw std::runtime_error("invalid history filament preset name");
        const auto name = value.get<std::string>();
        if (catalog.filaments.find_preset(name, false) == nullptr)
            throw std::runtime_error("history filament preset is unavailable");
        staged.names.push_back(name);
    }
    apply_overlay_to_config(staged.project_config, encoded["project_config"]);
    if (const auto edited = encoded.find("edited_filament_config"); edited != encoded.end()) {
        if (!edited->is_object()) throw std::runtime_error("invalid history edited filament config");
        apply_overlay_to_config(staged.edited_filament.config, *edited);
    }
    if (const auto ams = encoded.find("ams_multi_colour_filment"); ams != encoded.end()) {
        if (!ams->is_array()) throw std::runtime_error("invalid history AMS colours");
        staged.ams_multi_colour_filment = ams->get<std::vector<std::vector<std::string>>>();
    }
    return staged;
}

void apply_mutable(BridgeState& bridge, PresetBundle& bundle,
                   StagedMutableState&& staged)
{
    bundle.set_num_filaments(static_cast<unsigned int>(staged.names.size()));
    bundle.filament_presets = std::move(staged.names);
    for (std::size_t index = 0; index < bundle.filament_presets.size(); ++index)
        bundle.set_filament_preset(index, bundle.filament_presets[index]);
    bundle.project_config = std::move(staged.project_config);
    bundle.ams_multi_color_filment = std::move(staged.ams_multi_colour_filment);
    bundle.filaments.get_edited_preset() = std::move(staged.edited_filament);
    ++bridge.history_minimal_mutable_restore_count;
}

} // namespace Slic3r::Neo::Bridge::FilamentState
