#include "bridge_filament.hpp"

#include <stdexcept>

#include "libslic3r/PrintConfig.hpp"

namespace Slic3r::Neo::Bridge::Filament::State {

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
        History::RestoreState::DirectFrame::Kind::Filament,
        std::static_pointer_cast<const void>(std::move(frame)), bytes};
}

std::shared_ptr<const Model> current_direct_frame_model(const BridgeState& bridge)
{
    const auto& current = bridge.history.current();
    if (!current.direct_frame || !current.direct_frame->payload) return {};
    if (current.direct_frame->kind != History::RestoreState::DirectFrame::Kind::Filament) return {};
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

} // namespace Slic3r::Neo::Bridge::Filament::State



#include <emscripten/emscripten.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <sstream>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "bridge_history.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_slicing_pipeline.hpp"
#include "libslic3r/FlushVolCalc.hpp"
#include "libslic3r/PrintConfig.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::Filament::Commands {

using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::Filament::State::config_metadata_json;
using Neo::Bridge::Filament::State::current_direct_frame_model;
using Neo::Bridge::Filament::State::history_state_json;
using Neo::Bridge::Filament::State::make_direct_frame;
using Neo::Bridge::HistoryMetadata::default_history_context;
using Neo::Bridge::PlateSession::all_plate_ids;
using Neo::Bridge::PlateSession::ensure_plate_session_state;
using Neo::Bridge::PlateSession::member_plate_ids_for_instances;
using Neo::Bridge::PlateSession::plate_id_array;
using Neo::Bridge::PlateSession::plate_revisions_json;
using Neo::Bridge::PlateSession::plate_session_snapshot_json;
using Neo::Bridge::ProjectOverlay::valid_project_config_overlay;
using Neo::Bridge::SlicingPipeline::invalidate_preview_source;
using Neo::History::Codec::capture_model_state;

namespace {
thread_local const Runtime* active_runtime = nullptr;
struct RuntimeScope {
    const Runtime* previous;
    explicit RuntimeScope(const Runtime& runtime) : previous(active_runtime) { active_runtime = &runtime; }
    ~RuntimeScope() { active_runtime = previous; }
};
json filament_snapshot_json()
{
    if (active_runtime == nullptr || !active_runtime->filament_snapshot)
        throw std::runtime_error("filament command runtime is unavailable");
    return active_runtime->filament_snapshot();
}
const char* duplicate_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}
json default_command_history_context()
{
    return Neo::Bridge::HistoryMetadata::default_history_context(
        state(), plate_session_snapshot_json(), history_state_json(state().presets));
}
std::vector<double> config_floats(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionFloats>(key)) return option->values;
    return {};
}
}
json command_error(const char* code, const std::string& message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

struct FilamentCommandFailure : std::runtime_error {
    const char* code;
    FilamentCommandFailure(const char* failure_code, const std::string& message)
        : std::runtime_error(message), code(failure_code) {}
};

std::optional<std::size_t> filament_command_slot(const json& request, const char* key,
                                                  std::size_t count, std::string& error)
{
    if (!request.contains(key) || !request[key].is_number_integer()) {
        error = std::string(key) + " is required";
        return std::nullopt;
    }
    const auto one_based = request[key].get<std::int64_t>();
    if (one_based < 1 || static_cast<std::uint64_t>(one_based) > count) {
        error = std::string(key) + " is outside the ordered filament slots";
        return std::nullopt;
    }
    return static_cast<std::size_t>(one_based - 1);
}

bool valid_filament_colour(const std::string& colour)
{
    if (colour.size() != 7 && colour.size() != 9 || colour.front() != '#') return false;
    return std::all_of(colour.begin() + 1, colour.end(), [](const char value) {
        return std::isxdigit(static_cast<unsigned char>(value)) != 0;
    });
}

std::string filament_preset_colour(const PresetBundle& bundle, const std::size_t slot)
{
    if (slot >= bundle.filament_presets.size()) return "#26A69A";
    const Preset* preset = bundle.filaments.find_preset(bundle.filament_presets[slot], false);
    if (preset != nullptr) {
        if (const auto* colours = preset->config.opt<ConfigOptionStrings>("filament_colour");
            colours != nullptr && !colours->values.empty()) return colours->values.front();
        if (const auto* colours = preset->config.opt<ConfigOptionStrings>("default_filament_colour");
            colours != nullptr && !colours->values.empty()) return colours->values.front();
    }
    return "#26A69A";
}

std::optional<std::string> user_filament_colour_override(const PresetBundle& bundle, const std::size_t slot)
{
    const auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour");
    if (colours == nullptr || slot >= colours->values.size() || !valid_filament_colour(colours->values[slot]))
        return std::nullopt;
    const std::string native = filament_preset_colour(bundle, slot);
    return colours->values[slot] == native ? std::nullopt : std::optional<std::string>(colours->values[slot]);
}

int remap_filament_reference(const int value, const std::size_t removed,
                             const std::optional<std::size_t>& replacement)
{
    if (value <= 0) return value;
    const std::size_t current = static_cast<std::size_t>(value - 1);
    if (current == removed)
        return replacement.has_value() ? static_cast<int>(*replacement + 1) : 1;
    return static_cast<int>((current > removed ? current - 1 : current) + 1);
}

bool is_filament_slot_reference_key(const std::string& key)
{
    // Audited one-based slot references.  Do not infer references from a
    // substring: filament temperatures, purge settings, shrinkage, and other
    // numeric material properties must survive slot deletion unchanged.
    static const std::set<std::string> keys = {
        "extruder", "support_filament", "support_interface_filament", "wipe_tower_filament",
        "outer_wall_filament_id", "inner_wall_filament_id", "sparse_infill_filament_id",
        "internal_solid_filament_id", "top_surface_filament_id", "bottom_surface_filament_id",
    };
    return keys.find(key) != keys.end();
}

int remap_filament_config_reference(const std::string& key, const int value,
                                    const std::size_t removed,
                                    const std::optional<std::size_t>& replacement)
{
    // Support/raft and feature routing use native zero as Default.  A plain
    // slot Delete therefore clears a deleted explicit route to Default, while
    // ordinary object/part assignments retain Orca's slot-1 fallback.
    if (!replacement.has_value() && value == static_cast<int>(removed + 1) &&
        (key == "support_filament" || key == "support_interface_filament" ||
         key == "outer_wall_filament_id" || key == "inner_wall_filament_id" ||
         key == "sparse_infill_filament_id" || key == "internal_solid_filament_id" ||
         key == "top_surface_filament_id" || key == "bottom_surface_filament_id"))
        return 0;
    return remap_filament_reference(value, removed, replacement);
}

template <typename Config>
void remap_config_filament_references(Config& config, const std::size_t removed,
                                      const std::optional<std::size_t>& replacement)
{
    const auto keys = config.keys();
    for (const std::string& key : keys) {
        if (!is_filament_slot_reference_key(key)) continue;
        const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key));
        if (option == nullptr) continue;
        config.set_key_value(key, new ConfigOptionInt(remap_filament_config_reference(key, option->value, removed, replacement)));
    }
}

void remap_overlay_filament_references(json& overlay, const std::size_t removed,
                                       const std::optional<std::size_t>& replacement)
{
    if (!valid_project_config_overlay(overlay))
        throw FilamentCommandFailure("unsupported_reference", "invalid project configuration overlay");
    auto remap_values = [&](json& values) {
        if (!values.is_object()) return;
        for (auto option = values.begin(); option != values.end(); ++option) {
            if (!is_filament_slot_reference_key(option.key()) || !option.value().is_string()) continue;
            try {
                const int old_value = std::stoi(option.value().get<std::string>());
                option.value() = std::to_string(remap_filament_config_reference(option.key(), old_value, removed, replacement));
            } catch (...) {
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            }
        }
    };
    remap_values(overlay["project"]);
    for (const char* scope : {"objects", "parts"})
        for (auto it = overlay[scope].begin(); it != overlay[scope].end(); ++it)
            remap_values(it.value());
}

void remap_plate_filament_references(std::vector<BridgeState::PlateSessionPlate>& plates,
                                     const std::size_t removed,
                                     const std::optional<std::size_t>& replacement,
                                     const std::size_t old_count)
{
    for (auto& plate : plates) {
        remap_config_filament_references(plate.settings, removed, replacement);

        // PartPlate stores these arrays as per-filament values.  They are not
        // slot references: deletion removes the selected element, while a
        // merge first redirects the selected element's sequence users to the
        // (post-delete) destination.  Keep this equivalent to
        // PartPlate::on_filament_deleted instead of treating every integer
        // containing "filament" as a reference.
        for (const char* key : {"filament_map", "filament_nozzle_map", "filament_volume_map"}) {
            if (auto* values = plate.settings.option<ConfigOptionInts>(key)) {
                if (values->values.size() != old_count)
                    throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
                values->values.erase(values->values.begin() + static_cast<std::ptrdiff_t>(removed));
            }
        }

        if (auto* first = plate.settings.option<ConfigOptionInts>("first_layer_print_sequence")) {
            if (!first->values.empty() && first->values.front() != 0) {
                for (const int value : first->values)
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
                first->values.erase(std::remove(first->values.begin(), first->values.end(),
                                                static_cast<int>(removed + 1)), first->values.end());
                for (int& value : first->values)
                    if (value > static_cast<int>(removed + 1)) --value;
            }
        }

        auto* other = plate.settings.option<ConfigOptionInts>("other_layers_print_sequence");
        auto* other_count = plate.settings.option<ConfigOptionInt>("other_layers_print_sequence_nums");
        if ((other == nullptr) != (other_count == nullptr))
            throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
        if (other != nullptr) {
            if (other_count->value <= 0 || other->values.empty() ||
                other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
            if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence) {
                for (std::size_t offset = 2; offset < width; ++offset) {
                    int& value = other->values[sequence * width + offset];
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
                    if (value == static_cast<int>(removed + 1)) {
                        value = replacement ? static_cast<int>(*replacement + 1) : 1;
                    } else if (value > static_cast<int>(removed + 1)) {
                        --value;
                    }
                }
            }
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void validate_plate_filament_state(const BridgeState::PlateSessionPlate& plate,
                                   const std::size_t count,
                                   const int nozzle_count)
{
    for (const char* key : {"filament_map", "filament_nozzle_map", "filament_volume_map"}) {
        if (const auto* values = plate.settings.opt<ConfigOptionInts>(key)) {
            if (values->values.size() != count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            for (const int value : values->values)
                if (value < 0 || value > nozzle_count)
                    throw FilamentCommandFailure("unsupported_reference", "per-plate filament map is out of range");
        }
    }
    if (const auto* first = plate.settings.opt<ConfigOptionInts>("first_layer_print_sequence")) {
        if (!first->values.empty() && first->values.front() != 0)
            for (const int value : first->values)
                if (value < 1 || value > static_cast<int>(count))
                    throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
    }
    const auto* other = plate.settings.opt<ConfigOptionInts>("other_layers_print_sequence");
    const auto* other_count = plate.settings.opt<ConfigOptionInt>("other_layers_print_sequence_nums");
    if ((other == nullptr) != (other_count == nullptr))
        throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
    if (other != nullptr) {
        if (other_count->value <= 0 || other->values.empty() ||
            other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
            throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
        const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
        if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
        for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence)
            for (std::size_t offset = 2; offset < width; ++offset) {
                const int value = other->values[sequence * width + offset];
                if (value < 1 || value > static_cast<int>(count))
                    throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            }
    }
}

void add_plate_filament_references(std::vector<BridgeState::PlateSessionPlate>& plates,
                                   const PresetBundle& bundle,
                                   const std::size_t old_count)
{
    int volume_type = 0;
    if (const auto* volumes = bundle.project_config.opt<ConfigOptionEnumsGeneric>("nozzle_volume_type");
        volumes != nullptr && !volumes->values.empty())
        volume_type = volumes->values.front() == 2 ? 0 : volumes->values.front(); // Hybrid is stored as Standard.
    for (auto& plate : plates) {
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(1);
        }
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_nozzle_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(0);
        }
        if (auto* values = plate.settings.option<ConfigOptionInts>("filament_volume_map")) {
            if (values->values.size() != old_count)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate filament map");
            values->values.push_back(volume_type);
        }

        // Native Plater::on_filament_count_change calls
        // PartPlate::update_first_layer_print_sequence after on_filament_added.
        if (auto* first = plate.settings.option<ConfigOptionInts>("first_layer_print_sequence")) {
            if (!first->values.empty() && first->values.front() != 0) {
                for (const int value : first->values)
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed first-layer filament sequence");
                for (std::size_t slot = first->values.size(); slot < old_count + 1; ++slot)
                    first->values.push_back(static_cast<int>(slot + 1));
            }
        }
        auto* other = plate.settings.option<ConfigOptionInts>("other_layers_print_sequence");
        auto* other_count = plate.settings.option<ConfigOptionInt>("other_layers_print_sequence_nums");
        if ((other == nullptr) != (other_count == nullptr))
            throw FilamentCommandFailure("unsupported_reference", "incomplete per-plate layer sequence");
        if (other != nullptr) {
            if (other_count->value <= 0 || other->values.empty() ||
                other->values.size() % static_cast<std::size_t>(other_count->value) != 0)
                throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            const std::size_t width = other->values.size() / static_cast<std::size_t>(other_count->value);
            if (width < 3) throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
            std::vector<int> rebuilt;
            rebuilt.reserve(other->values.size() + static_cast<std::size_t>(other_count->value));
            for (std::size_t sequence = 0; sequence < static_cast<std::size_t>(other_count->value); ++sequence) {
                const auto begin = other->values.begin() + static_cast<std::ptrdiff_t>(sequence * width);
                rebuilt.insert(rebuilt.end(), begin, begin + 2);
                for (std::size_t offset = 2; offset < width; ++offset) {
                    const int value = *(begin + static_cast<std::ptrdiff_t>(offset));
                    if (value < 1 || value > static_cast<int>(old_count))
                        throw FilamentCommandFailure("unsupported_reference", "malformed per-plate layer sequence");
                    rebuilt.push_back(value);
                }
                const std::size_t orders = width - 2;
                for (std::size_t slot = orders; slot < old_count + 1; ++slot)
                    rebuilt.push_back(static_cast<int>(slot + 1));
            }
            other->values = std::move(rebuilt);
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void remap_model_filament_references(Model& model, const std::size_t removed,
                                     const std::optional<std::size_t>& replacement,
                                     const std::size_t new_count)
{
    for (ModelObject* object : model.objects) {
        remap_config_filament_references(object->config, removed, replacement);
        for (ModelVolume* volume : object->volumes) {
            remap_config_filament_references(volume->config, removed, replacement);
            // The native MM painting selector stores 1-based enforcer IDs and
            // has its own deletion/remap operation.  Keep it in the staged
            // model so imported painting cannot retain a dangling reference.
            volume->update_extruder_count_when_delete_filament(
                new_count, removed + 1,
                replacement.has_value() ? static_cast<int>(*replacement + 1) : 0);
        }
    }
    for (auto& [plate, info] : model.plates_custom_gcodes) {
        (void)plate;
        auto& gcodes = info.gcodes;
        for (auto it = gcodes.begin(); it != gcodes.end();) {
            if (it->extruder <= 0) { ++it; continue; }
            if (static_cast<std::size_t>(it->extruder - 1) == removed && !replacement.has_value()) {
                it = gcodes.erase(it);
                continue;
            }
            it->extruder = remap_filament_reference(it->extruder, removed, replacement);
            ++it;
        }
    }
}

struct FlushColour { unsigned char a = 255, r = 0, g = 0, b = 0; };

std::optional<FlushColour> parse_flush_colour(const std::string& value)
{
    if (!valid_filament_colour(value)) return std::nullopt;
    auto hex = [](const char c) -> unsigned char {
        if (c >= '0' && c <= '9') return static_cast<unsigned char>(c - '0');
        if (c >= 'a' && c <= 'f') return static_cast<unsigned char>(c - 'a' + 10);
        return static_cast<unsigned char>(c - 'A' + 10);
    };
    auto byte = [&](const std::size_t offset) -> unsigned char {
        return static_cast<unsigned char>((hex(value[offset]) << 4) | hex(value[offset + 1]));
    };
    FlushColour colour;
    if (value.size() == 9) {
        colour.a = byte(1); colour.r = byte(3); colour.g = byte(5); colour.b = byte(7);
    } else {
        colour.r = byte(1); colour.g = byte(3); colour.b = byte(5);
    }
    return colour;
}

std::vector<FlushColour> flush_colours_for_slot(const std::string& base,
                                                const std::string& multi)
{
    std::vector<FlushColour> result;
    std::istringstream stream(multi.empty() ? base : multi);
    std::string item;
    while (stream >> item)
        if (const auto colour = parse_flush_colour(item)) result.push_back(*colour);
    if (result.empty())
        if (const auto colour = parse_flush_colour(base)) result.push_back(*colour);
    if (result.empty()) result.push_back({});
    return result;
}

std::vector<std::vector<int>> min_flush_volumes_for_config(const DynamicPrintConfig& full,
                                                           const std::size_t filament_count,
                                                           const std::size_t nozzle_count)
{
    std::vector<std::vector<int>> result(nozzle_count, std::vector<int>(filament_count, 0));
    const auto* nozzle_volume = full.opt<ConfigOptionFloatsNullable>("nozzle_volume");
    const auto* machine_level = full.opt<ConfigOptionInt>("enable_long_retraction_when_cut");
    const auto* machine_active = full.opt<ConfigOptionBools>("long_retractions_when_cut");
    const auto* filament_diameter = full.opt<ConfigOptionFloats>("filament_diameter");
    const auto* filament_retraction = full.opt<ConfigOptionFloats>("filament_retraction_distances_when_cut");
    const auto* filament_retraction_nullable = full.opt<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut");
    const auto* printer_retraction = full.opt<ConfigOptionFloats>("retraction_distances_when_cut");
    const auto* filament_active = full.opt<ConfigOptionBools>("filament_long_retractions_when_cut");
    const auto* filament_active_nullable = full.opt<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut");
    const auto at_or = [](const auto* option, const std::size_t index, const auto fallback) {
        return option != nullptr && index < option->values.size() ? option->values[index] : fallback;
    };
    const auto filament_retraction_at = [&](const std::size_t index, const double fallback) {
        if (filament_retraction != nullptr && index < filament_retraction->values.size())
            return filament_retraction->values[index];
        return filament_retraction_nullable != nullptr && index < filament_retraction_nullable->values.size()
            ? filament_retraction_nullable->values[index] : fallback;
    };
    const auto filament_active_at = [&](const std::size_t index, const unsigned char fallback) {
        if (filament_active != nullptr && index < filament_active->values.size())
            return filament_active->values[index];
        return filament_active_nullable != nullptr && index < filament_active_nullable->values.size()
            ? filament_active_nullable->values[index] : fallback;
    };
    constexpr double default_retraction = 18.0;
    constexpr double filament_area = M_PI * 1.75 * 1.75 / 4.0;
    for (std::size_t nozzle = 0; nozzle < nozzle_count; ++nozzle) {
        const double nozzle_value = nozzle_volume != nullptr && nozzle < nozzle_volume->values.size()
            ? nozzle_volume->values[nozzle] : 0.0;
        const int nozzle_volume_value = std::isfinite(nozzle_value) ? static_cast<int>(nozzle_value) : 0;
        const int machine_enabled_level = machine_level == nullptr ? 0 : machine_level->value;
        const bool machine_activated = machine_active != nullptr && nozzle < machine_active->values.size() &&
            machine_active->values[nozzle];
        const double printer_distance = at_or(printer_retraction, nozzle, default_retraction);
        for (std::size_t filament = 0; filament < filament_count; ++filament) {
            int retract_length = machine_enabled_level && machine_activated
                ? static_cast<int>(printer_distance) : 0;
            const unsigned char filament_enabled = filament_active_at(filament, static_cast<unsigned char>(0));
            const double filament_distance = filament_retraction_at(filament, default_retraction);
            if (filament_enabled == 0) {
                retract_length = 0;
            } else if (filament_enabled == 1 && machine_enabled_level == LongRectrationLevel::EnableFilament) {
                retract_length = std::isnan(filament_distance)
                    ? static_cast<int>(printer_distance) : static_cast<int>(filament_distance);
            }
            result[nozzle][filament] = static_cast<int>(
                static_cast<double>(nozzle_volume_value) - filament_area * retract_length);
        }
    }
    return result;
}

std::vector<std::vector<int>> min_flush_volumes_for_bundle(const PresetBundle& bundle,
                                                           const std::size_t filament_count,
                                                           const std::size_t nozzle_count)
{
    return min_flush_volumes_for_config(bundle.full_config(), filament_count, nozzle_count);
}

void recalculate_filament_flush(PresetBundle& bundle)
{
    auto* matrix = bundle.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true);
    if (matrix == nullptr) throw FilamentCommandFailure("native_validation_failure", "native flush matrix is unavailable");
    const std::size_t count = bundle.filament_presets.size();
    const std::size_t nozzles = std::max(1, bundle.get_printer_extruder_count());
    const auto* colours = bundle.project_config.opt<ConfigOptionStrings>("filament_colour");
    if (colours == nullptr || colours->values.size() != count)
        throw FilamentCommandFailure("native_validation_failure", "native filament colours are unavailable");
    const auto* multi = bundle.project_config.opt<ConfigOptionStrings>("filament_multi_colour");
    const auto* support = bundle.project_config.opt<ConfigOptionBools>("filament_is_support");
    const auto* datasets = bundle.project_config.opt<ConfigOptionIntsNullable>("nozzle_flush_dataset");
    const auto min_flush = min_flush_volumes_for_bundle(bundle, count, nozzles);
    const auto colour_sets = [&]() {
        std::vector<std::vector<FlushColour>> sets;
        sets.reserve(count);
        for (std::size_t index = 0; index < count; ++index) {
            const std::string multi_value = multi != nullptr && index < multi->values.size()
                ? multi->values[index] : std::string{};
            sets.push_back(flush_colours_for_slot(colours->values[index], multi_value));
        }
        return sets;
    }();

    matrix->values.assign(count * count * nozzles, 0.0);
    for (std::size_t nozzle = 0; nozzle < nozzles; ++nozzle) {
        const int dataset = datasets != nullptr && !datasets->values.empty()
            ? datasets->get_at(nozzle) : 0;
        const bool has_support = support != nullptr && support->values.size() == count;
        for (std::size_t from = 0; from < count; ++from) {
            for (std::size_t to = 0; to < count; ++to) {
                if (from == to) continue;
                int flushing = 0;
                const bool from_support = has_support && support->get_at(from);
                const bool to_support = has_support && support->get_at(to);
                if (to_support) {
                    flushing = Slic3r::g_flush_volume_to_support;
                } else {
                    FlushVolCalculator calculator(min_flush[nozzle][from], Slic3r::g_max_flush_volume, dataset);
                    for (const auto& source : colour_sets[from])
                        for (const auto& destination : colour_sets[to])
                            flushing = std::max(flushing, calculator.calc_flush_vol(
                                source.a, source.r, source.g, source.b,
                                destination.a, destination.r, destination.g, destination.b));
                    if (from_support)
                        flushing = std::max(flushing, Slic3r::g_min_flush_volume_from_support);
                }
                matrix->values[nozzle * count * count + from * count + to] = flushing;
            }
        }
    }
}

void validate_filament_candidate_components(const std::vector<std::string>& filament_presets,
                                            const DynamicPrintConfig& project,
                                            const DynamicPrintConfig& printer,
                                            const int nozzle_count,
                                            const bool flexible_slots,
                                            Model& model,
                                            const std::vector<BridgeState::PlateSessionPlate>& plates,
                                            const json& overlay,
                                            const bool strict_slot_arrays,
                                            const bool require_all_slot_arrays)
{
    if (filament_presets.empty() || filament_presets.size() > 64)
        throw std::runtime_error("native filament slot count is invalid");
    for (const char* key : {"filament_colour", "filament_multi_colour", "filament_colour_type",
                            "filament_map", "filament_volume_map", "filament_nozzle_map",
                            "filament_map_2", "filament_self_index", "filament_extruder_variant"}) {
        if (strict_slot_arrays || require_all_slot_arrays) if (const auto* option = project.option(key)) {
            const auto* vector_option = dynamic_cast<const ConfigOptionVectorBase*>(option);
            if (vector_option == nullptr) continue;
            const auto size = vector_option->size();
            const bool invalid_size = require_all_slot_arrays
                ? size != filament_presets.size()
                : (flexible_slots && size != 0 && size != filament_presets.size());
            if (invalid_size)
                throw std::runtime_error(std::string("native filament array has invalid length: ") + key);
        }
    }
    if (require_all_slot_arrays) {
        const auto validate_matrix = [&](const DynamicPrintConfig& config) {
            const auto* option = config.option("flush_volumes_matrix");
            if (option == nullptr) return;
            const auto values = config_floats(config, "flush_volumes_matrix");
            const std::size_t plane_size = filament_presets.size() * filament_presets.size();
            if (plane_size == 0 || values.empty() || values.size() % plane_size != 0 ||
                values.size() / plane_size != static_cast<std::size_t>(nozzle_count))
                throw std::runtime_error("native flush matrix has invalid slot dimensions");
            if (std::any_of(values.begin(), values.end(), [](double value) { return !std::isfinite(value); }))
                throw std::runtime_error("native flush matrix contains invalid values");
        };
        validate_matrix(project);
        if (project.option("flush_volumes_matrix") == nullptr)
            validate_matrix(printer);
    }
    const auto validate_config_references = [&](const auto& config) {
        for (const auto& key : config.keys()) {
            if (!is_filament_slot_reference_key(key)) continue;
            const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key));
            if (option != nullptr && (option->value < 0 || option->value > static_cast<int>(filament_presets.size())))
                throw FilamentCommandFailure("unsupported_reference", "model filament reference exceeds slots");
        }
    };
    for (const ModelObject* object : model.objects) {
        validate_config_references(object->config);
        for (const ModelVolume* volume : object->volumes) {
            validate_config_references(volume->config);
            const ConfigOption* extruder = volume->config.option("extruder");
            if (extruder == nullptr || extruder->getInt() == 0)
                extruder = object->config.option("extruder");
            const int effective_extruder = extruder == nullptr ? 1 : extruder->getInt();
            if (effective_extruder > static_cast<int>(filament_presets.size()))
                throw FilamentCommandFailure("unsupported_reference", "model effective filament reference exceeds slots");
        }
    }
    if (!valid_project_config_overlay(overlay))
        throw FilamentCommandFailure("unsupported_reference", "invalid staged project configuration overlay");
    const auto validate_overlay_values = [&](const json& values) {
        if (!values.is_object()) return;
        for (const auto& [key, value] : values.items()) {
            if (!is_filament_slot_reference_key(key)) continue;
            if (!value.is_string())
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            try {
                const int reference = std::stoi(value.get<std::string>());
                if (reference < 0 || reference > static_cast<int>(filament_presets.size()))
                    throw FilamentCommandFailure("unsupported_reference", "project overlay reference exceeds slots");
            } catch (const FilamentCommandFailure&) { throw; }
            catch (...) {
                throw FilamentCommandFailure("unsupported_reference", "invalid filament reference in project overlay");
            }
        }
    };
    validate_overlay_values(overlay["project"]);
    for (const char* scope : {"objects", "parts"})
        for (const auto& [id, values] : overlay[scope].items()) validate_overlay_values(values);
    for (const auto& plate : plates) {
        validate_plate_filament_state(plate, filament_presets.size(), nozzle_count);
        for (const auto& key : plate.settings.keys()) {
            if (!is_filament_slot_reference_key(key)) continue;
            const auto* option = dynamic_cast<const ConfigOptionInt*>(plate.settings.option(key));
            if (option != nullptr && (option->value < 0 || option->value > static_cast<int>(filament_presets.size())))
                throw FilamentCommandFailure("unsupported_reference", "staged plate reference exceeds filament slots");
        }
    }
    (void)nozzle_count;
}

void validate_filament_candidate(PresetBundle& bundle, Model& model,
                                 const std::vector<BridgeState::PlateSessionPlate>& plates,
                                 const json& overlay,
                                 const bool strict_slot_arrays,
                                 const bool require_all_slot_arrays)
{
    const auto& printer = bundle.printers.get_edited_preset().config;
    validate_filament_candidate_components(bundle.filament_presets, bundle.project_config, printer,
        std::max(1, bundle.get_printer_extruder_count()),
        printer.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor(),
        model, plates, overlay, strict_slot_arrays, require_all_slot_arrays);
}

json filament_mutation_result(const json& mutation)
{
    return { {"ok", true}, {"version", 1},
             {"result", {{"snapshot", filament_snapshot_json()}, {"mutation", mutation}}} };
}

template <typename Mutator>
json run_filament_mutation(const json& request, const char* label, Mutator mutator)
{
    const auto before_next_filament_colour_index = state().next_filament_colour_index;
    try {
        if (!request.is_object() || !request.contains("version") ||
            !request["version"].is_number_unsigned() || request["version"].get<unsigned>() != 1)
            return command_error("invalid_command", "unsupported filament command version");
        if (state().active_history_transaction)
            return command_error("history_transaction_active", "filament command cannot run inside another history transaction");
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        const auto before_context = default_command_history_context();
        // The retained current entry is the authoritative pre-command model.
        // Reusing its immutable history representation avoids serializing the
        // entire native model again for every small filament edit; the post-
        // command frame below is still serialized before it is committed.
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !state().history.current().direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model) direct_before_model = std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};
        if (!request.contains("revision") || !request["revision"].is_number_unsigned())
            return command_error("stale_revision", "filament session revision is required");
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return command_error("stale_revision", "filament session revision is stale");

        // The preset catalogue is immutable during a project session.  Never
        // copy PresetBundle in a history-producing mutation: retain only the
        // exact mutable filament fields which may need atomic rollback.
        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        Model before_model = state().model;
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        const auto old_count = state().presets.filament_presets.size();
        bool mutated = false;
        bool history_committed = false;
        const auto rollback_published = [&]() {
            if (!mutated || history_committed) return;
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
            state().model = before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
            state().next_filament_colour_index = before_next_filament_colour_index;
        };
        json mutation;
        try {
            mutated = true;
            mutation = mutator(state().presets, state().model, state().plate_session_plates,
                               state().project_config_overlay, old_count);
            if (request.value("inject_failure", false)) {
                rollback_published();
                return command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, state().model, state().plate_session_plates,
                                        state().project_config_overlay);
            // Filament edits can change the native tower footprint. Clamp in
            // this same mutation before its history context/frame is built so
            // Undo/Redo restores the rack and coordinates atomically.
            Neo::Bridge::PrimeTower::normalize_coordinate_positions();
            // Commit the fieldwise staged native session as one Worker
            // operation. The projection is the final validation, so malformed
            // native arrays can never be published to the client.
            // Filament configuration is shared by every plate.  Invalidate all
            // plate results in the authoritative Worker state before publishing
            // the post-command snapshot; the renderer must not infer this from
            // whichever plate happens to be selected.
            ensure_plate_session_state();
            for (const auto& plate_id : all_plate_ids()) ++state().plate_input_revisions[plate_id];
            const auto final_snapshot = filament_snapshot_json();
            if (!final_snapshot.value("ok", false)) {
                rollback_published();
                return final_snapshot;
            }
            auto context = default_command_history_context();
            // The model may be unchanged for a pure slot edit.  Include the
            // authoritative filament revision in the history context so ProjectHistory
            // records exactly one semantic project mutation instead of coalescing
            // the command away as an identical model/context snapshot.
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            const auto failure_stage = request.value("inject_failure_stage", "");
            if (failure_stage == "before-history") {
                rollback_published();
                return command_error("native_validation_failure", "injected late native validation failure");
            }
            if (failure_stage == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_frame = make_direct_frame(
                state(), std::make_shared<Model>(state().model), after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(
                    label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) {
                rollback_published();
                return command_error("native_validation_failure", "history commit rejected filament mutation");
            }
            history_committed = true;
        } catch (...) {
            if (!history_committed) rollback_published();
            throw;
        }
        state().history_revision++;
        state().print.clear();
        invalidate_preview_source();
        mutation["history_entry_delta"] = 1;
        mutation["revision_before"] = expected;
        mutation["revision_after"] = state().history_revision;
        mutation["dirty"] = state().history.project_modified();
        mutation["all_plate_results_invalidated"] = true;
        return filament_mutation_result(mutation);
    } catch (const FilamentCommandFailure& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error(e.code, e.what());
    } catch (const std::exception& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", e.what());
    } catch (...) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", "unknown native validation failure");
    }
}

// Add/delete only touch a small, well-defined part of PresetBundle.  The
// generic transaction above intentionally stages the complete installed
// preset graph, which is the right safety boundary for arbitrary commands but
// makes a single slot edit pay for several deep copies.  Keep the same
// validation, snapshot, history, and rollback protocol while applying these
// two mutations in place and retaining only the fields they can change.
template <typename Mutator>
json run_filament_slot_mutation(const json& request, const char* label, const bool model_changes, Mutator mutator)
{
    const auto before_next_filament_colour_index = state().next_filament_colour_index;
    try {
        if (!request.is_object() || !request.contains("version") ||
            !request["version"].is_number_unsigned() || request["version"].get<unsigned>() != 1)
            return command_error("invalid_command", "unsupported filament command version");
        if (state().active_history_transaction)
            return command_error("history_transaction_active", "filament command cannot run inside another history transaction");
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        const auto before_context = default_command_history_context();
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        if (!request.contains("revision") || !request["revision"].is_number_unsigned())
            return command_error("stale_revision", "filament session revision is required");
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return command_error("stale_revision", "filament session revision is stale");

        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        std::shared_ptr<const Model> before_model;
        if (model_changes) before_model = std::make_shared<Model>(state().model);
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        const auto& current_history = state().history.current();
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !current_history.direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model)
            direct_before_model = before_model ? before_model : std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};

        bool mutated = false;
        bool history_committed = false;
        const auto rollback = [&]() {
            if (!mutated || history_committed) return;
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
            if (before_model) state().model = *before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
            state().next_filament_colour_index = before_next_filament_colour_index;
        };

        try {
            mutated = true;
            const auto old_count = state().presets.filament_presets.size();
            json mutation = mutator(state().presets, state().model, state().plate_session_plates,
                                     state().project_config_overlay, old_count);
            if (request.value("inject_failure", false)) {
                rollback();
                return command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, state().model, state().plate_session_plates,
                                        state().project_config_overlay);
            Neo::Bridge::PrimeTower::normalize_coordinate_positions();
            ensure_plate_session_state();
            for (const auto& plate_id : all_plate_ids()) ++state().plate_input_revisions[plate_id];
            const auto final_snapshot = filament_snapshot_json();
            if (!final_snapshot.value("ok", false)) {
                rollback();
                return final_snapshot;
            }
            auto context = default_command_history_context();
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            const auto failure_stage = request.value("inject_failure_stage", "");
            if (failure_stage == "before-history") {
                rollback();
                return command_error("native_validation_failure", "injected late native validation failure");
            }
            if (failure_stage == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_after_model = model_changes
                ? std::make_shared<Model>(state().model) : direct_before_model;
            const auto direct_frame = make_direct_frame(state(), direct_after_model,
                                                        after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(
                    label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) {
                rollback();
                return command_error("native_validation_failure", "history commit rejected filament mutation");
            }
            history_committed = true;
            state().history_revision++;
            state().print.clear();
            invalidate_preview_source();
            mutation["history_entry_delta"] = 1;
            mutation["revision_before"] = expected;
            mutation["revision_after"] = state().history_revision;
            mutation["dirty"] = state().history.project_modified();
            mutation["all_plate_results_invalidated"] = true;
            return filament_mutation_result(mutation);
        } catch (...) {
            rollback();
            throw;
        }
    } catch (const FilamentCommandFailure& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error(e.code, e.what());
    } catch (const std::exception& e) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", e.what());
    } catch (...) {
        state().next_filament_colour_index = before_next_filament_colour_index;
        return command_error("native_validation_failure", "unknown native validation failure");
    }
}

const char* apply_remembered_filament_rack_command(const char* request_cstr, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        if (!request.is_object() || request.value("version", 0) != 1 || !request.contains("revision") ||
            !request["revision"].is_number_unsigned() || !request.contains("slots") ||
            !request["slots"].is_array() || request["slots"].empty() || request["slots"].size() > 64)
            return duplicate_json(command_error("invalid_command", "invalid remembered filament rack").dump());
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return duplicate_json(before_snapshot.dump());
        const auto expected = request["revision"].get<std::uint64_t>();
        if (expected != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return duplicate_json(command_error("stale_revision", "filament session revision is stale").dump());

        auto& bundle = state().presets;
        const auto before_names = bundle.filament_presets;
        const auto before_project = bundle.project_config;
        const auto before_ams = bundle.ams_multi_color_filment;
        const auto before_edited = bundle.filaments.get_edited_preset();
        const auto before_revision = state().history_revision;
        try {
            std::vector<std::string> colours;
            colours.reserve(request["slots"].size());
            bundle.set_num_filaments(static_cast<unsigned int>(request["slots"].size()));
            for (std::size_t index = 0; index < request["slots"].size(); ++index) {
                const auto& slot = request["slots"][index];
                if (!slot.is_object() || !slot.contains("preset") || !slot["preset"].is_string() ||
                    slot["preset"].get<std::string>().empty() || !slot.contains("colour") || !slot["colour"].is_string() ||
                    !valid_filament_colour(slot["colour"].get<std::string>()))
                    throw FilamentCommandFailure("invalid_command", "invalid remembered filament slot");
                const std::string preset = slot["preset"].get<std::string>();
                if (bundle.filaments.find_preset(preset, false, true) == nullptr)
                    throw FilamentCommandFailure("incompatible_preset", "remembered filament preset is unavailable: " + preset);
                bundle.set_filament_preset(index, preset);
                colours.push_back(slot["colour"].get<std::string>());
            }
            bundle.project_config.set_key_value("filament_colour", new ConfigOptionStrings(colours));
            recalculate_filament_flush(bundle);
            validate_filament_candidate(bundle, state().model, state().plate_session_plates,
                                        state().project_config_overlay, true, true);
            ++state().history_revision;
            const auto result = filament_snapshot_json();
            if (!result.value("ok", false)) throw std::runtime_error(result.value("error", "invalid remembered filament rack"));
            state().print.clear();
            invalidate_preview_source();
            return duplicate_json(result.dump());
        } catch (...) {
            bundle.filament_presets = before_names;
            bundle.project_config = before_project;
            bundle.ams_multi_color_filment = before_ams;
            bundle.filaments.get_edited_preset() = before_edited;
            state().history_revision = before_revision;
            throw;
        }
    } catch (const FilamentCommandFailure& e) {
        return duplicate_json(command_error(e.code, e.what()).dump());
    } catch (const std::exception& e) {
        return duplicate_json(command_error("invalid_command", e.what()).dump());
    } catch (...) {
        return duplicate_json(command_error("invalid_command", "invalid remembered filament rack").dump());
    }
}

struct FilamentAssignmentTarget {
    std::string kind;
    std::size_t id = 0;
};

static std::vector<FilamentAssignmentTarget> parse_assignment_targets(const json& request)
{
    const json* values = request.contains("targets") ? &request["targets"] : &request["target"];
    if (values == nullptr || (!values->is_array() && !values->is_object()))
        throw FilamentCommandFailure("invalid_command", "assignment targets are required");
    json array = values->is_array() ? *values : json::array({*values});
    std::vector<FilamentAssignmentTarget> result;
    std::set<std::pair<std::string, std::size_t>> seen;
    for (const auto& value : array) {
        if (!value.is_object() || !value.contains("kind") || !value["kind"].is_string() ||
            !value.contains("id") || !value["id"].is_number_unsigned() ||
            value["id"].get<std::uint64_t>() == 0 ||
            value["id"].get<std::uint64_t>() > std::numeric_limits<std::size_t>::max())
            throw FilamentCommandFailure("invalid_command", "invalid assignment target");
        const std::string kind = value["kind"].get<std::string>();
        const std::size_t id = value["id"].get<std::size_t>();
        if (!seen.emplace(kind, id).second) continue;
        result.push_back({kind, id});
    }
    if (result.empty()) throw FilamentCommandFailure("invalid_command", "assignment targets are empty");
    return result;
}

static ModelObject* find_object_by_id_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects) if (object->id().id == id) return object;
    return nullptr;
}

static ModelVolume* find_volume_by_id_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& volume : object->volumes)
            if (volume->id().id == id) return volume;
    return nullptr;
}

static ModelObject* owner_of_volume_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& volume : object->volumes)
            if (volume->id().id == id) return object;
    return nullptr;
}

static ModelObject* owner_of_instance_in(Model& model, const std::size_t id)
{
    for (auto& object : model.objects)
        for (auto& instance : object->instances)
            if (instance->id().id == id) return object;
    return nullptr;
}

static void collect_object_instance_ids(const Model& model, const std::set<std::size_t>& object_ids,
                                        std::set<std::size_t>& instance_ids)
{
    for (const auto* object : model.objects) {
        if (object_ids.find(object->id().id) == object_ids.end()) continue;
        for (const auto* instance : object->instances) instance_ids.insert(instance->id().id);
    }
}

template <typename Mutator>
json run_filament_assignment_mutation(const json& request, const char* label, Mutator mutator,
                                      const bool model_only = false)
{
    try {
        if (!request.is_object() || request.value("version", 0) != 1)
            return command_error("invalid_command", "unsupported filament assignment command version");
        if (state().active_history_transaction)
            return command_error("history_transaction_active", "filament assignment cannot run inside another history transaction");
        const auto before_snapshot = filament_snapshot_json();
        if (!before_snapshot.value("ok", false)) return before_snapshot;
        if (!request.contains("revision") || !request["revision"].is_number_unsigned() ||
            request["revision"].get<std::uint64_t>() != before_snapshot["revisions"]["session"].get<std::uint64_t>())
            return command_error("stale_revision", "filament session revision is stale");
        const auto before_context = default_command_history_context();
        const auto before_history_model = state().history.entries().empty()
            ? Neo::History::Codec::capture_model_state(state().model) : state().history.current().model;
        // Assignment and routing must use the live immutable profile
        // catalogue.  Support routing changes only project_config; preserve
        // that narrow mutable surface rather than cloning PresetBundle.
        const auto before_filament_presets = state().presets.filament_presets;
        const auto before_project_config = state().presets.project_config;
        const auto before_ams_colours = state().presets.ams_multi_color_filment;
        const auto before_edited_filament = state().presets.filaments.get_edited_preset();
        const auto restore_mutable_bundle = [&]() {
            state().presets.filament_presets = before_filament_presets;
            state().presets.project_config = before_project_config;
            state().presets.ams_multi_color_filment = before_ams_colours;
            state().presets.filaments.get_edited_preset() = before_edited_filament;
        };
        Model staged_model = state().model;
        auto staged_plates = state().plate_session_plates;
        auto staged_overlay = state().project_config_overlay;
        std::set<std::size_t> affected_objects;
        json mutation;
        try {
            mutation = mutator(state().presets, staged_model, staged_plates, staged_overlay, affected_objects);
            if (request.value("inject_failure", false) || request.value("inject_failure_stage", "") == "before-history") {
                restore_mutable_bundle();
                return command_error("native_validation_failure", "injected native validation failure");
            }
            validate_filament_candidate(state().presets, staged_model, staged_plates, staged_overlay);
        } catch (...) {
            restore_mutable_bundle();
            throw;
        }

        std::set<std::size_t> affected_instances;
        collect_object_instance_ids(state().model, affected_objects, affected_instances);
        const bool invalidate_all = mutation.value("invalidate_all_plates", false);
        const auto affected_plates = invalidate_all ? all_plate_ids() : member_plate_ids_for_instances(affected_instances);
        Model before_model = state().model;
        const auto before_plates = state().plate_session_plates;
        const auto before_overlay = state().project_config_overlay;
        const auto before_plate_revisions = state().plate_input_revisions;
        const auto before_membership = state().instance_plate_ids;
        const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
        const auto before_parked = state().parked_instance_ids;
        const auto before_pending = state().pending_membership_instance_ids;
        const auto before_current_plate = state().current_plate_id;
        bool history_committed = false;
        const auto rollback = [&]() {
            if (history_committed) return;
            restore_mutable_bundle();
            state().model = before_model;
            state().plate_session_plates = before_plates;
            state().project_config_overlay = before_overlay;
            state().plate_input_revisions = before_plate_revisions;
            state().instance_plate_ids = before_membership;
            state().plate_out_of_bounds_ids = before_out_of_bounds;
            state().parked_instance_ids = before_parked;
            state().pending_membership_instance_ids = before_pending;
            state().current_plate_id = before_current_plate;
        };
        const bool needs_predecessor_direct = state().history.entries().empty() ||
            !state().history.current().direct_frame.has_value();
        std::shared_ptr<const Model> direct_before_model = current_direct_frame_model(state());
        if (!direct_before_model) direct_before_model = std::make_shared<Model>(state().model);
        const auto predecessor_direct = needs_predecessor_direct
            ? make_direct_frame(state(), direct_before_model, before_history_model)
            : std::optional<Neo::History::RestoreState::DirectFrame>{};
        try {
            state().model = std::move(staged_model);
            state().plate_session_plates = std::move(staged_plates);
            state().project_config_overlay = std::move(staged_overlay);
            ensure_plate_session_state();
            Neo::Bridge::PrimeTower::normalize_coordinate_positions();
            for (const auto& plate_id : affected_plates) ++state().plate_input_revisions[plate_id];
            auto context = default_command_history_context();
            context["filamentSessionRevision"] = state().history_revision + 1;
            const auto encoded = context.dump();
            const Neo::History::Bytes bytes(encoded.begin(), encoded.end());
            if (request.value("inject_failure_stage", "") == "during-history")
                throw std::runtime_error("injected history commit failure");
            const auto after_history_model = Neo::History::Codec::capture_model_state(state().model);
            const auto direct_frame = make_direct_frame(
                state(), std::make_shared<Model>(state().model), after_history_model);
            const bool committed = [&]() {
                if (!state().history.entries().empty())
                    return state().history.commit(label, Neo::History::Category::Project,
                                                  after_history_model, bytes, direct_frame,
                                                  predecessor_direct);
                const auto baseline_encoded = before_context.dump();
                const Neo::History::Bytes baseline_bytes(baseline_encoded.begin(), baseline_encoded.end());
                return state().history.commit_with_baseline(label, Neo::History::Category::Project,
                    before_history_model, baseline_bytes, after_history_model, bytes,
                    predecessor_direct, direct_frame);
            }();
            if (!committed) throw std::runtime_error("history commit rejected filament assignment");
            history_committed = true;
        } catch (...) {
            if (!history_committed) rollback();
            throw;
        }
        state().history_revision++;
        if (affected_plates.find(state().current_plate_id) != affected_plates.end()) {
            state().print.clear();
            invalidate_preview_source();
        }
        mutation["history_entry_delta"] = 1;
        mutation["revision_before"] = request["revision"];
        mutation["revision_after"] = state().history_revision;
        mutation["dirty"] = state().history.project_modified();
        mutation["affected_plate_ids"] = affected_plates;
        mutation["all_plate_results_invalidated"] = invalidate_all;
        mutation.erase("invalidate_all_plates");
        return filament_mutation_result(mutation);
    } catch (const FilamentCommandFailure& e) {
        return command_error(e.code, e.what());
    } catch (const std::exception& e) {
        return command_error("native_validation_failure", e.what());
    } catch (...) {
        return command_error("native_validation_failure", "unknown filament assignment failure");
    }
}

static int requested_assignment_slot(const json& request, const std::size_t slot_count, const bool allow_inherit)
{
    if (!request.contains("slot") || !request["slot"].is_number_integer())
        throw FilamentCommandFailure("invalid_command", "slot is required");
    const int slot = request["slot"].get<int>();
    if (slot == 0 && allow_inherit) return 0;
    if (slot < 1 || slot > static_cast<int>(slot_count))
        throw FilamentCommandFailure("unsupported_reference", "assignment slot is outside the ordered filament slots");
    return slot;
}

json assign_filament_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_assignment_mutation(request, "Assign Filament", [&request](PresetBundle& bundle, Model& model,
        auto&, auto&, std::set<std::size_t>& affected_objects) {
        const auto targets = parse_assignment_targets(request);
        const int slot = requested_assignment_slot(request, bundle.filament_presets.size(), true);
        std::vector<FilamentAssignmentTarget> normalized;
        std::set<std::pair<std::string, std::size_t>> seen;
        for (const auto& target : targets) {
            ModelObject* object = nullptr;
            if (target.kind == "object") object = find_object_by_id_in(model, target.id);
            else if (target.kind == "instance" || target.kind == "instance-as-object") object = owner_of_instance_in(model, target.id);
            else if (target.kind == "model-part" || target.kind == "model_part" ||
                     target.kind == "parameter-modifier" || target.kind == "parameter_modifier") {
                const bool model_part_target = target.kind == "model-part" || target.kind == "model_part";
                auto* volume = find_volume_by_id_in(model, target.id);
                if (volume == nullptr || (model_part_target && volume->type() != ModelVolumeType::MODEL_PART) ||
                    (!model_part_target && volume->type() != ModelVolumeType::PARAMETER_MODIFIER))
                    throw FilamentCommandFailure("ineligible_target", "target volume is not eligible for filament assignment");
                object = owner_of_volume_in(model, target.id);
            } else {
                throw FilamentCommandFailure("ineligible_target", "target kind is not eligible for filament assignment");
            }
            if (object == nullptr) throw FilamentCommandFailure("ineligible_target", "assignment target was not found");
            if ((target.kind == "object" || target.kind == "instance" || target.kind == "instance-as-object") && slot == 0)
                throw FilamentCommandFailure("invalid_command", "object assignment cannot inherit");
            const std::string normalized_kind = (target.kind == "instance" || target.kind == "instance-as-object") ? "object" :
                (target.kind == "model_part" ? "model-part" : target.kind == "parameter_modifier" ? "parameter-modifier" : target.kind);
            const std::size_t normalized_id = normalized_kind == "object" ? object->id().id : target.id;
            if (seen.emplace(normalized_kind, normalized_id).second) {
                normalized.push_back({normalized_kind, normalized_id});
                affected_objects.insert(object->id().id);
            }
        }
        // Normalize ownership before mutating.  An owning object (including an
        // instance normalized to that object) dominates all descendant model
        // parts regardless of request order; parameter modifiers remain
        // independent and are preserved unless explicitly targeted.
        std::set<std::size_t> owning_objects;
        for (const auto& target : normalized)
            if (target.kind == "object") owning_objects.insert(target.id);
        std::vector<FilamentAssignmentTarget> effective_targets;
        for (const auto& target : normalized) {
            if (target.kind == "model-part") {
                const auto* owner = owner_of_volume_in(model, target.id);
                if (owner != nullptr && owning_objects.find(owner->id().id) != owning_objects.end()) continue;
            }
            effective_targets.push_back(target);
        }
        std::stable_sort(effective_targets.begin(), effective_targets.end(), [](const auto& left, const auto& right) {
            const auto rank = [](const std::string& kind) { return kind == "object" ? 0 : kind == "model-part" ? 1 : 2; };
            return rank(left.kind) < rank(right.kind);
        });
        json accepted = json::array();
        for (const auto& target : effective_targets) {
            const auto* owner = target.kind == "object" ? find_object_by_id_in(model, target.id) : owner_of_volume_in(model, target.id);
            accepted.push_back({{"kind", target.kind}, {"id", target.id}, {"object_id", owner->id().id}});
            if (target.kind == "object") {
                auto* object = find_object_by_id_in(model, target.id);
                object->config.set_key_value("extruder", new ConfigOptionInt(slot));
                for (auto* volume : object->volumes)
                    if (volume->type() == ModelVolumeType::MODEL_PART) volume->config.erase("extruder");
            } else {
                auto* volume = find_volume_by_id_in(model, target.id);
                if (slot == 0) volume->config.erase("extruder");
                else volume->config.set_key_value("extruder", new ConfigOptionInt(slot));
            }
        }
        return json{{"kind", "assign"}, {"accepted_targets", accepted}, {"slot", slot}};
    });
}

static const char* routing_key_for_selector(const std::string& selector)
{
    static const std::map<std::string, const char*> keys = {
        {"support-base", "support_filament"}, {"support-interface", "support_interface_filament"},
        {"outer-wall", "outer_wall_filament_id"}, {"inner-wall", "inner_wall_filament_id"},
        {"sparse-infill", "sparse_infill_filament_id"}, {"internal-solid-infill", "internal_solid_filament_id"},
        {"top-surface", "top_surface_filament_id"}, {"bottom-surface", "bottom_surface_filament_id"},
    };
    const auto it = keys.find(selector);
    return it == keys.end() ? nullptr : it->second;
}

json set_filament_routing_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    const std::string requested_selector = request.value("selector", "");
    const bool model_only = requested_selector != "support-base" && requested_selector != "support-interface";
    return run_filament_assignment_mutation(request, "Set Filament Routing", [&request](PresetBundle& bundle, Model& model,
        auto&, auto&, std::set<std::size_t>& affected_objects) {
        if (!request.contains("selector") || !request["selector"].is_string())
            throw FilamentCommandFailure("invalid_command", "routing selector is required");
        const std::string selector = request["selector"].get<std::string>();
        const char* key = routing_key_for_selector(selector);
        if (key == nullptr) throw FilamentCommandFailure("invalid_command", "unsupported filament routing selector");
        const bool feature_selector = selector != "support-base" && selector != "support-interface";
        const int slot = request.contains("slot") && request["slot"].is_number_integer() ? request["slot"].get<int>() : -1;
        if (slot < 0 || slot > static_cast<int>(bundle.filament_presets.size()))
            throw FilamentCommandFailure("unsupported_reference", "routing slot is outside the ordered filament slots");
        const auto targets = request.contains("targets") ? request["targets"] : request.value("target", json::object());
        const json array = targets.is_array() ? targets : json::array({targets});
        if (array.empty()) throw FilamentCommandFailure("invalid_command", "routing targets are required");
        json accepted = json::array();
        std::set<std::pair<std::string, std::size_t>> seen;
        bool invalidate_all = false;
        for (const auto& target : array) {
            if (!target.is_object() || !target.contains("kind") || !target["kind"].is_string())
                throw FilamentCommandFailure("invalid_command", "invalid routing target");
            const std::string kind = target["kind"].get<std::string>();
            const bool project_kind = kind == "project";
            if (project_kind) {
                if (target.contains("id") &&
                    (!target["id"].is_number_unsigned() || target["id"].get<std::uint64_t>() != 0))
                    throw FilamentCommandFailure("invalid_command", "project routing target id must be zero");
            } else if (!target.contains("id") || !target["id"].is_number_unsigned() ||
                       target["id"].get<std::uint64_t>() == 0 ||
                       target["id"].get<std::uint64_t>() > std::numeric_limits<std::size_t>::max()) {
                throw FilamentCommandFailure("invalid_command", "routing target id is invalid");
            }
            const std::size_t id = project_kind ? 0 : target["id"].get<std::size_t>();
            bool project_target = false;
            ModelVolume* volume = nullptr;
            ModelObject* owner = nullptr;
            const std::string normalized_kind = kind == "model_part" ? "model-part" : kind;
            if (normalized_kind == "project") {
                if (feature_selector) throw FilamentCommandFailure("ineligible_target", "feature routing does not support project scope");
                project_target = true;
            } else if (normalized_kind == "object") {
                owner = find_object_by_id_in(model, id);
            } else if (normalized_kind == "model-part") {
                if (!feature_selector) throw FilamentCommandFailure("ineligible_target", "support routing does not support model-part scope");
                volume = find_volume_by_id_in(model, id); owner = owner_of_volume_in(model, id);
            } else {
                throw FilamentCommandFailure("ineligible_target", "routing target is not eligible");
            }
            if (!project_target && normalized_kind == "object" && owner == nullptr) throw FilamentCommandFailure("ineligible_target", "routing target was not found");
            if (!project_target && normalized_kind == "model-part" && (owner == nullptr || volume == nullptr || volume->type() != ModelVolumeType::MODEL_PART))
                throw FilamentCommandFailure("ineligible_target", "routing target was not found");
            if (normalized_kind == "object" || normalized_kind == "model-part") affected_objects.insert(owner ? owner->id().id : id);
            if (seen.emplace(normalized_kind, id).second) {
                if (project_target) bundle.project_config.set_key_value(key, new ConfigOptionInt(slot));
                else if (normalized_kind == "object") owner->config.set_key_value(key, new ConfigOptionInt(slot));
                else volume->config.set_key_value(key, new ConfigOptionInt(slot));
                accepted.push_back({{"kind", normalized_kind}, {"id", id}, {"object_id", owner ? owner->id().id : 0}});
                invalidate_all = invalidate_all || project_target;
            }
        }
        // Native support/raft filament selection changes the flushing input.
        // Recalculate only after every target has been accepted into the
        // staged bundle; the assignment transaction then publishes the full
        // matrix atomically with the routing mutation.  Feature-path routing
        // does not affect flushing volumes.
        if (!feature_selector) recalculate_filament_flush(bundle);
        return json{{"kind", "routing"}, {"selector", selector}, {"slot", slot},
                    {"accepted_targets", accepted}, {"invalidate_all_plates", invalidate_all}};
    }, model_only);
}

json select_filament_slot_preset_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_mutation(request, "Select Filament Preset", [&request](PresetBundle& bundle, Model&, auto&, auto&, std::size_t count) {
        std::string error;
        const auto slot = filament_command_slot(request, "slot", count, error);
        if (!slot) throw FilamentCommandFailure("unsupported_reference", error);
        if (!request.contains("preset") || !request["preset"].is_string()) throw FilamentCommandFailure("invalid_command", "preset is required");
        const std::string name = request["preset"].get<std::string>();
        const Preset* preset = bundle.filaments.find_preset(name, false, true);
        if (preset == nullptr || !preset->is_visible || !preset->is_compatible)
            throw FilamentCommandFailure("unsupported_reference", "unsupported filament preset reference");
        const auto user_override = user_filament_colour_override(bundle, *slot);
        bundle.set_filament_preset(*slot, name);
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count, "#26A69A");
        colours->values[*slot] = user_override.value_or(filament_preset_colour(bundle, *slot));
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count, "#26A69A");
            multi->values[*slot] = colours->values[*slot];
        }
        recalculate_filament_flush(bundle);
        return json{{"kind", "select-preset"}, {"slot", *slot + 1}, {"preset", name}};
    });
}

json set_filament_slot_colour_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_mutation(request, "Edit Filament Colour", [&request](PresetBundle& bundle, Model&, auto&, auto&, std::size_t count) {
        std::string error;
        const auto slot = filament_command_slot(request, "slot", count, error);
        if (!slot) throw FilamentCommandFailure("unsupported_reference", error);
        if (!request.contains("colour") || !request["colour"].is_string() ||
            !valid_filament_colour(request["colour"].get<std::string>()))
            throw FilamentCommandFailure("native_validation_failure", "native filament colour validation failed");
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count, "#26A69A");
        colours->values[*slot] = request["colour"].get<std::string>();
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count, "#26A69A");
            multi->values[*slot] = colours->values[*slot];
        }
        recalculate_filament_flush(bundle);
        return json{{"kind", "set-colour"}, {"slot", *slot + 1}, {"colour", colours->values[*slot]}};
    });
}

static constexpr std::array<const char*, 16> kNativeFilamentColours = {
    "#00C1AE", "#F4E2C1", "#ED1C24", "#00FF7F",
    "#F26722", "#FFEB31", "#7841CE", "#115877",
    "#ED1E79", "#2EBDEF", "#345B2F", "#800080",
    "#FA8173", "#800000", "#F7B763", "#A4C41E",
};

json add_filament_command(const json& request, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    return run_filament_slot_mutation(request, "Add Filament Slot", false,
        [](PresetBundle& bundle, Model&, auto& plates, auto&, std::size_t count) {
        const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
        if (!flexible || count >= 64) throw FilamentCommandFailure("capability_rejected", "filament slot capacity or capability rejected");
        const std::string colour = kNativeFilamentColours[state().next_filament_colour_index++ % kNativeFilamentColours.size()];
        bundle.set_num_filaments(static_cast<unsigned int>(count + 1), colour);
        auto* colours = bundle.project_config.option<ConfigOptionStrings>("filament_colour", true);
        colours->values.resize(count + 1, "#26A69A");
        colours->values[count] = colour;
        if (auto* multi = bundle.project_config.option<ConfigOptionStrings>("filament_multi_colour", true)) {
            multi->values.resize(count + 1, "#26A69A");
            multi->values[count] = colour;
        }
        add_plate_filament_references(plates, bundle, count);
        recalculate_filament_flush(bundle);
        return json{{"kind", "add"}, {"slot", count + 1}};
        });
}

json delete_or_merge_filament_command(const json& request, const bool merge, const Runtime& runtime)
{
    RuntimeScope scope(runtime);
    if (!merge)
        return run_filament_slot_mutation(request, "Delete Filament Slot", true,
            [request](PresetBundle& bundle, Model& model, auto& plates, auto& overlay, std::size_t count) {
            const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
            if (!flexible || count <= 1) throw FilamentCommandFailure("capability_rejected", "filament slot capability rejected");
            std::string error;
            const auto source = filament_command_slot(request, "slot", count, error);
            if (!source) throw FilamentCommandFailure("unsupported_reference", error);
            bundle.update_num_filaments(*source);
            remap_config_filament_references(bundle.project_config, *source, std::nullopt);
            remap_model_filament_references(model, *source, std::nullopt, count - 1);
            remap_plate_filament_references(plates, *source, std::nullopt, count);
            remap_overlay_filament_references(overlay, *source, std::nullopt);
            recalculate_filament_flush(bundle);
            return json{{"kind", "delete"}, {"source", *source + 1},
                        {"destination", nullptr}, {"slot_count", count - 1}};
        });
    return run_filament_mutation(request, merge ? "Merge Filament Slots" : "Delete Filament Slot",
        [request, merge](PresetBundle& bundle, Model& model, auto& plates, auto& overlay, std::size_t count) {
        const bool flexible = bundle.printers.get_edited_preset().config.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
        if (!flexible || count <= 1) throw FilamentCommandFailure("capability_rejected", "filament slot capability rejected");
        std::string error;
        const auto source = filament_command_slot(request, merge ? "source" : "slot", count, error);
        if (!source) throw FilamentCommandFailure("unsupported_reference", error);
        std::optional<std::size_t> replacement;
        if (merge) {
            const auto destination = filament_command_slot(request, "destination", count, error);
            if (!destination || *destination == *source) throw FilamentCommandFailure("unsupported_reference", "unsupported filament reference");
            replacement = *destination > *source ? *destination - 1 : *destination;
        }
        bundle.update_num_filaments(*source);
        // Project-scoped support/feature routing lives in the native project
        // config rather than the renderer overlay.  Remap it before the
        // projection is rebuilt so Delete yields Default for zero-backed
        // routing and Merge points at the selected survivor.
        remap_config_filament_references(bundle.project_config, *source, replacement);
        remap_model_filament_references(model, *source, replacement, count - 1);
        remap_plate_filament_references(plates, *source, replacement, count);
        remap_overlay_filament_references(overlay, *source, replacement);
        recalculate_filament_flush(bundle);
        return json{{"kind", merge ? "merge" : "delete"}, {"source", *source + 1},
                    {"destination", replacement ? json(*replacement + 1) : json(nullptr)},
                    {"slot_count", count - 1}};
    });
}

} // namespace Slic3r::Neo::Bridge::Filament::Commands



// ----------------------------------------------------------------
// Multi-filament session projection and ABI facade for the Neo WASM bridge.
// ----------------------------------------------------------------

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "bridge_project_overlay.hpp"
#include "bridge_plate.hpp"
#include "bridge_state.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::Filament::Session {

using Neo::Bridge::state;
using namespace Neo::Bridge::Filament::Commands;
using namespace Neo::Bridge::PlateSession;
using Neo::Bridge::Filament::State::config_metadata_json;

namespace {

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

std::vector<std::string> config_strings(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionStrings>(key)) return option->values;
    return {};
}

std::vector<int> config_ints(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionInts>(key)) return option->values;
    return {};
}

std::vector<double> config_floats(const DynamicPrintConfig& config, const char* key)
{
    if (const auto* option = config.opt<ConfigOptionFloats>(key)) return option->values;
    return {};
}

json filament_session_error_json(const char* code, const char* message)
{
    return { {"ok", false}, {"version", 1}, {"error", message}, {"error_code", code},
             {"status", {{"state", "error"}, {"error", message}}} };
}

bool effective_filament_int_map(const DynamicPrintConfig& primary, const char* key,
                                const DynamicPrintConfig& fallback, size_t slot_count,
                                int default_value, std::vector<int>& out)
{
    out = config_ints(primary, key);
    if (out.empty()) out = config_ints(fallback, key);
    if (out.size() > slot_count) return false;
    out.resize(slot_count, default_value);
    return true;
}

} // namespace

json filament_session_snapshot_json()
{
    PresetBundle& bundle = state().presets;
    const DynamicPrintConfig& project = bundle.project_config;
    const DynamicPrintConfig& printer = bundle.printers.get_edited_preset().config;
    const DynamicPrintConfig& filament = bundle.filaments.get_edited_preset().config;

    std::vector<std::string> preset_names = bundle.filament_presets;
    std::vector<std::string> colours = config_strings(project, "filament_colour");
    if (colours.empty()) colours = config_strings(filament, "filament_colour");
    if (preset_names.empty())
        return filament_session_error_json("filament_slots_missing", "filament rack has no slots");
    const size_t slot_count = std::max<size_t>(1, std::max(preset_names.size(), colours.size()));
    if (preset_names.size() < slot_count)
        return filament_session_error_json("filament_slots_mismatched", "filament rack slots and colours differ");

    std::vector<std::string> preset_colours(slot_count);
    const auto native_default_colours = state().profile_config.get_filament_colors();
    constexpr const char* native_filament_colour_fallback = "#26A69A";
    for (size_t i = 0; i < slot_count; ++i) {
        if (const Preset* real_preset = bundle.filaments.find_preset(preset_names[i], false, true)) {
            const auto native_colours = config_strings(real_preset->config, "filament_colour");
            if (!native_colours.empty()) preset_colours[i] = native_colours.front();
            else {
                const auto default_colours = config_strings(real_preset->config, "default_filament_colour");
                if (!default_colours.empty()) preset_colours[i] = default_colours.front();
            }
        }
        if (preset_colours[i].empty() && i < native_default_colours.size())
            preset_colours[i] = native_default_colours[i];
        if (preset_colours[i].empty()) preset_colours[i] = native_filament_colour_fallback;
    }
    if (colours.size() < slot_count) {
        const auto defaults = state().profile_config.get_filament_colors();
        for (size_t i = colours.size(); i < slot_count; ++i)
            colours.push_back(!preset_colours[i].empty() ? preset_colours[i] :
                              (i < defaults.size() ? defaults[i] : std::string("#000000")));
    }

    json slots = json::array();
    for (size_t i = 0; i < slot_count; ++i) {
        const std::string& name = preset_names[i];
        const bool preset_equivalent = !preset_colours[i].empty() && colours[i] == preset_colours[i];
        slots.push_back({
            {"slot", i + 1},
            {"preset", {{"id", name}, {"name", name}}},
            {"colour", {{"effective", colours[i]}, {"provenance", preset_equivalent ? "preset" : "user"}}},
        });
    }

    std::vector<int> filament_map;
    std::vector<int> volume_map;
    std::vector<int> nozzle_map;
    std::vector<int> filament_map_2;
    if (!effective_filament_int_map(project, "filament_map", printer, slot_count, 1, filament_map))
        return filament_session_error_json("filament_map_too_long", "filament_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_volume_map", printer, slot_count, 0, volume_map))
        return filament_session_error_json("filament_volume_map_too_long", "filament_volume_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_nozzle_map", printer, slot_count, 1, nozzle_map))
        return filament_session_error_json("filament_nozzle_map_too_long", "filament_nozzle_map exceeds slot count");
    if (!effective_filament_int_map(project, "filament_map_2", printer, slot_count, 1, filament_map_2))
        return filament_session_error_json("filament_map_2_too_long", "filament_map_2 exceeds slot count");

    const int printer_nozzles = std::max(1, bundle.get_printer_extruder_count());
    std::vector<int> physical_map;
    if (!effective_filament_int_map(printer, "physical_extruder_map", printer,
                                     static_cast<size_t>(printer_nozzles), 0, physical_map))
        return filament_session_error_json("physical_extruder_map_too_long", "physical_extruder_map exceeds nozzle count");
    json mappings = {
        {"filament", filament_map}, {"volume", volume_map}, {"nozzle", nozzle_map},
        {"filament2", filament_map_2}, {"physical_extruder", physical_map},
    };

    auto matrix = config_floats(project, "flush_volumes_matrix");
    if (matrix.empty()) matrix = config_floats(printer, "flush_volumes_matrix");
    const bool matrix_is_native = !matrix.empty();
    size_t matrix_dimension = slot_count;
    size_t matrix_plane_count = 1;
    if (matrix.empty()) {
        matrix_plane_count = static_cast<size_t>(printer_nozzles);
        matrix.assign(matrix_dimension * matrix_dimension * matrix_plane_count, 0.0);
    } else {
        const size_t plane_size = matrix_dimension * matrix_dimension;
        if (plane_size == 0 || matrix.size() % plane_size != 0)
            return filament_session_error_json("flush_matrix_malformed", "flush_volumes_matrix is not a whole native plane");
        matrix_plane_count = matrix.size() / plane_size;
        if (matrix_plane_count == 0 || matrix_plane_count != static_cast<size_t>(printer_nozzles))
            return filament_session_error_json("flush_matrix_plane_count_mismatch", "flush_volumes_matrix plane count does not match nozzle count");
        if (std::any_of(matrix.begin(), matrix.end(), [](double value) { return !std::isfinite(value); }))
            return filament_session_error_json("flush_matrix_malformed", "flush_volumes_matrix contains invalid values");
    }
    auto flush_vector = config_floats(project, "flush_volumes_vector");
    if (flush_vector.empty()) flush_vector = config_floats(printer, "flush_volumes_vector");
    json flushing = {{"matrix", matrix}, {"vector", flush_vector},
                     {"matrix_dimension", matrix_dimension}, {"plane_count", matrix_plane_count},
                     {"source", matrix_is_native ? "native" : "default"}};

    const bool flexible_slots = printer.opt_bool("single_extruder_multi_material") || bundle.is_bbl_vendor();
    const int min_slots = flexible_slots ? 1 : printer_nozzles;
    json capabilities = {
        {"min_slots", min_slots}, {"max_slots", 64}, {"nozzle_count", printer_nozzles},
        {"flexible", flexible_slots},
        {"can_add", flexible_slots && slot_count < 64},
        {"can_delete", flexible_slots && slot_count > 1},
        {"can_merge", flexible_slots && slot_count > 1},
    };

    struct Assignment { std::string target; uint32_t id; uint32_t object_id; int explicit_slot; int effective_slot; bool inherited; };
    std::vector<Assignment> objects;
    std::vector<Assignment> parts;
    std::vector<Assignment> modifiers;
    auto explicit_extruder = [](const auto& config) {
        if (const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option("extruder")))
            return std::max(0, option->value);
        return 0;
    };
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        const int object_explicit = std::max(1, explicit_extruder(object->config));
        const int object_effective = object_explicit;
        if (object_effective > static_cast<int>(slot_count))
            return filament_session_error_json("assignment_slot_out_of_range", "object assignment exceeds slot count");
        objects.push_back({"object", static_cast<uint32_t>(object->id().id), static_cast<uint32_t>(object->id().id), object_explicit, object_effective, false});
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr) continue;
            const auto type = volume->type();
            if (type != ModelVolumeType::MODEL_PART && type != ModelVolumeType::PARAMETER_MODIFIER) continue;
            const int explicit_slot = explicit_extruder(volume->config);
            const int effective_slot = std::max(1, explicit_slot == 0 ? object_explicit : explicit_slot);
            const bool inherited = explicit_slot == 0;
            if (explicit_slot > static_cast<int>(slot_count) || effective_slot > static_cast<int>(slot_count) ||
                (!inherited && effective_slot != explicit_slot))
                return filament_session_error_json("assignment_slot_out_of_range", "volume assignment exceeds slot count");
            Assignment item{type == ModelVolumeType::MODEL_PART ? "model-part" : "parameter-modifier",
                            static_cast<uint32_t>(volume->id().id), static_cast<uint32_t>(object->id().id), explicit_slot, effective_slot, inherited};
            (type == ModelVolumeType::MODEL_PART ? parts : modifiers).push_back(item);
        }
    }
    auto assignment_json = [](const std::vector<Assignment>& values) {
        json out = json::array();
        for (const Assignment& item : values)
            out.push_back({{"target", item.target}, {"id", item.id}, {"object_id", item.object_id},
                           {"explicit_slot", item.explicit_slot}, {"effective_slot", item.effective_slot},
                           {"inherited", item.inherited}});
        return out;
    };
    std::sort(objects.begin(), objects.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });
    std::sort(parts.begin(), parts.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });
    std::sort(modifiers.begin(), modifiers.end(), [](const Assignment& a, const Assignment& b) { return a.id < b.id; });

    json revisions = {{"session", state().history_revision}, {"project", state().history_revision},
                      {"result", state().preview_result_id}, {"plates", plate_revisions_json()}};
    json routing = json::array();
    const std::array<std::pair<const char *, const char *>, 8> routing_keys = {{
        {"support-base", "support_filament"}, {"support-interface", "support_interface_filament"},
        {"outer-wall", "outer_wall_filament_id"}, {"inner-wall", "inner_wall_filament_id"},
        {"sparse-infill", "sparse_infill_filament_id"}, {"internal-solid-infill", "internal_solid_filament_id"},
        {"top-surface", "top_surface_filament_id"}, {"bottom-surface", "bottom_surface_filament_id"},
    }};
    auto option_value = [](const auto& config, const char* key) {
        if (const auto* option = dynamic_cast<const ConfigOptionInt*>(config.option(key))) return option->value;
        return 0;
    };
    auto routing_values = [&](const auto& config) {
        std::vector<int> values;
        values.reserve(routing_keys.size());
        for (const auto& [selector, key] : routing_keys) values.push_back(option_value(config, key));
        return values;
    };
    auto append_routing = [&](const char* target, std::size_t id, std::size_t object_id,
                              const auto& config, const std::vector<int>& parent_values,
                              int assignment_slot, const bool support_only, const bool feature_only) {
        const auto own_values = routing_values(config);
        for (std::size_t index = 0; index < routing_keys.size(); ++index) {
            const auto& [selector, key] = routing_keys[index];
            const bool feature = std::string(selector) != "support-base" && std::string(selector) != "support-interface";
            if ((support_only && feature) || (feature_only && !feature)) continue;
            const int own = own_values[index];
            const int parent = parent_values.empty() ? 0 : parent_values[index];
            const int effective = own > 0 ? own : (parent > 0 ? parent : (feature ? assignment_slot : 0));
            const bool inherited = own == 0 && !parent_values.empty();
            const bool defaulted = effective == 0;
            routing.push_back({{"target", target}, {"id", id}, {"object_id", object_id},
                               {"selector", selector}, {"explicit_slot", own},
                               {"effective_slot", effective}, {"inherited", inherited},
                               {"defaulted", defaulted}});
        }
    };
    append_routing("project", 0, 0, bundle.project_config, {}, 0, true, false);
    for (const ModelObject* object : state().model.objects) {
        if (object == nullptr) continue;
        const int object_slot = std::max(1, explicit_extruder(object->config));
        append_routing("object", object->id().id, object->id().id, object->config,
                       routing_values(bundle.project_config), object_slot, false, false);
        for (const ModelVolume* volume : object->volumes) {
            if (volume == nullptr || volume->type() != ModelVolumeType::MODEL_PART) continue;
            const int explicit_slot = explicit_extruder(volume->config);
            const int assignment_slot = std::max(1, explicit_slot == 0 ? object_slot : explicit_slot);
            append_routing("model-part", volume->id().id, object->id().id, volume->config,
                           routing_values(object->config), assignment_slot, false, true);
        }
    }
    return {{"ok", true}, {"version", 1}, {"slots", slots}, {"mappings", mappings},
            {"flushing", flushing}, {"capabilities", capabilities}, {"routing", routing},
            {"assignments", {{"objects", assignment_json(objects)}, {"parts", assignment_json(parts)},
                             {"modifiers", assignment_json(modifiers)}}},
            {"revisions", revisions}, {"status", {{"state", "ready"}, {"error", nullptr}}}};
}

Filament::Commands::Runtime filament_command_runtime()
{
    return {[] { return filament_session_snapshot_json(); }};
}

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_apply_remembered_filament_rack(const char* request_cstr)
{
    return Slic3r::Neo::Bridge::Filament::Commands::apply_remembered_filament_rack_command(
        request_cstr, Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime());
}

EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_reference_fixture(const char* request_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    using namespace Filament::Session;
    using namespace PlateSession;
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        ensure_plate_session_state();
        if (request.contains("plate_settings")) {
            if (!request["plate_settings"].is_object()) return error_json("invalid test plate settings");
            for (auto& plate : state().plate_session_plates) {
                auto it = request["plate_settings"].find(plate.id);
                if (it == request["plate_settings"].end()) continue;
                if (!it.value().is_object()) return error_json("invalid test plate settings");
                ProjectOverlay::apply_overlay_to_config(plate.settings, it.value());
                plate.settings_metadata = Filament::State::config_metadata_json(plate.settings);
            }
        }
        if (request.contains("custom_gcodes")) {
            if (!request["custom_gcodes"].is_array()) return error_json("invalid test custom gcodes");
            state().model.plates_custom_gcodes.clear();
            for (const auto& record : request["custom_gcodes"]) {
                if (!record.is_object() || !record.contains("plate") || !record["plate"].is_number_integer() ||
                    !record.contains("mode") || !record["mode"].is_string() ||
                    !record.contains("items") || !record["items"].is_array())
                    return error_json("invalid test custom gcode record");
                CustomGCode::Info info;
                const std::string mode = record["mode"].get<std::string>();
                info.mode = mode == "MultiExtruder" ? CustomGCode::MultiExtruder
                    : mode == "MultiAsSingle" ? CustomGCode::MultiAsSingle : CustomGCode::SingleExtruder;
                for (const auto& item : record["items"]) {
                    if (!item.is_object() || !item.contains("print_z") || !item["print_z"].is_number() ||
                        !item.contains("extruder") || !item["extruder"].is_number_integer())
                        return error_json("invalid test custom gcode item");
                    CustomGCode::Item event;
                    event.print_z = item["print_z"].get<double>();
                    event.type = CustomGCode::ToolChange;
                    event.extruder = item["extruder"].get<int>();
                    event.color = item.value("color", std::string{});
                    event.extra = item.value("extra", std::string{});
                    info.gcodes.push_back(std::move(event));
                }
                state().model.plates_custom_gcodes[record["plate"].get<int>()] = std::move(info);
            }
        }
        json custom = json::array();
        for (const auto& [plate, info] : state().model.plates_custom_gcodes)
            for (const auto& item : info.gcodes)
                custom.push_back({{"plate", plate}, {"extruder", item.extruder}, {"print_z", item.print_z}});
        return duplicate_json(json{{"ok", true}, {"plate_session", plate_session_snapshot_json()}, {"custom_gcodes", custom}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test fixture failure"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_flush_fixture(const char* request_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        const json request = request_cstr && *request_cstr ? json::parse(request_cstr) : json::object();
        if (!request.is_object()) return error_json("invalid test flush fixture");
        state().presets.update_multi_material_filament_presets();
        auto& printer = state().presets.printers.get_edited_preset().config;
        auto& project = state().presets.project_config;
        const auto filament_count = state().presets.filament_presets.size();
        auto* fixture_colours = project.option<ConfigOptionStrings>("filament_colour", true);
        fixture_colours->values.resize(filament_count, "#26A69A");
        for (std::size_t index = 0; index < filament_count; ++index)
            fixture_colours->values[index] = index % 2 == 0 ? "#FF0000" : "#00FF00";
        if (auto* multi = project.option<ConfigOptionStrings>("filament_multi_colour", true))
            multi->values = fixture_colours->values;
        for (const auto& name : state().presets.filament_presets) {
            if (auto* preset = state().presets.filaments.find_preset(name, true, true)) {
                auto* colours = preset->config.option<ConfigOptionStrings>("filament_colour", true);
                colours->values.resize(filament_count, "#26A69A");
                for (std::size_t index = 0; index < filament_count; ++index)
                    colours->values[index] = index % 2 == 0 ? "#FF0000" : "#00FF00";
                if (auto* multi = preset->config.option<ConfigOptionStrings>("filament_multi_colour", true))
                    multi->values = colours->values;
            }
        }
        const auto read_floats = [](const json& value, const char* name) {
            if (!value.is_array()) throw std::runtime_error(std::string("invalid test flush ") + name);
            std::vector<double> result;
            result.reserve(value.size());
            for (const auto& item : value) {
                if (item.is_null()) result.push_back(std::numeric_limits<double>::quiet_NaN());
                else if (item.is_number()) result.push_back(item.get<double>());
                else throw std::runtime_error(std::string("invalid test flush ") + name);
            }
            return result;
        };
        const auto read_bools = [](const json& value, const char* name) {
            if (!value.is_array() || !std::all_of(value.begin(), value.end(), [](const json& item) {
                    return item.is_boolean() || item.is_number_integer(); }))
                throw std::runtime_error(std::string("invalid test flush ") + name);
            std::vector<unsigned char> result;
            result.reserve(value.size());
            for (const auto& item : value) result.push_back(static_cast<unsigned char>(item.get<int>() != 0));
            return result;
        };
        DynamicPrintConfig synthetic_full = state().presets.full_config();
        if (request.contains("nozzle_volume"))
            synthetic_full.option<ConfigOptionFloatsNullable>("nozzle_volume", true)->values = read_floats(request["nozzle_volume"], "nozzle_volume");
        if (request.contains("enable_long_retraction_when_cut"))
            synthetic_full.option<ConfigOptionInt>("enable_long_retraction_when_cut", true)->value = request["enable_long_retraction_when_cut"].get<int>();
        if (request.contains("long_retractions_when_cut"))
            synthetic_full.option<ConfigOptionBools>("long_retractions_when_cut", true)->values = read_bools(request["long_retractions_when_cut"], "long_retractions_when_cut");
        if (request.contains("retraction_distances_when_cut"))
            synthetic_full.option<ConfigOptionFloats>("retraction_distances_when_cut", true)->values = read_floats(request["retraction_distances_when_cut"], "retraction_distances_when_cut");
        if (request.contains("filament_diameter"))
            synthetic_full.option<ConfigOptionFloats>("filament_diameter", true)->values = read_floats(request["filament_diameter"], "filament_diameter");
        if (request.contains("filament_long_retractions_when_cut"))
            synthetic_full.option<ConfigOptionBoolsNullable>("filament_long_retractions_when_cut", true)->values = read_bools(request["filament_long_retractions_when_cut"], "filament_long_retractions_when_cut");
        if (request.contains("filament_retraction_distances_when_cut"))
            synthetic_full.option<ConfigOptionFloatsNullable>("filament_retraction_distances_when_cut", true)->values = read_floats(request["filament_retraction_distances_when_cut"], "filament_retraction_distances_when_cut");
        const auto set_floats = [&](const char* key, const std::vector<double>& values) {
            printer.option<ConfigOptionFloats>(key, true)->values = values;
            project.option<ConfigOptionFloats>(key, true)->values = values;
        };
        const auto set_nullable_floats = [&](const char* key, const std::vector<double>& values) {
            printer.option<ConfigOptionFloatsNullable>(key, true)->values = values;
            project.option<ConfigOptionFloatsNullable>(key, true)->values = values;
        };
        const auto set_bools = [&](const char* key, const std::vector<unsigned char>& values) {
            printer.option<ConfigOptionBools>(key, true)->values = values;
            project.option<ConfigOptionBools>(key, true)->values = values;
        };
        const auto set_int = [&](const char* key, const int value) {
            printer.option<ConfigOptionInt>(key, true)->value = value;
            project.option<ConfigOptionInt>(key, true)->value = value;
        };
        const auto set_filament_floats = [&](const char* key, const std::vector<double>& values) {
            for (const auto& name : state().presets.filament_presets)
                if (auto* preset = state().presets.filaments.find_preset(name, true, true))
                    preset->config.option<ConfigOptionFloatsNullable>(key, true)->values = values;
        };
        const auto set_filament_bools = [&](const char* key, const std::vector<unsigned char>& values) {
            for (const auto& name : state().presets.filament_presets)
                if (auto* preset = state().presets.filaments.find_preset(name, true, true))
                    preset->config.option<ConfigOptionBoolsNullable>(key, true)->values = values;
        };
        if (request.contains("nozzle_volume"))
            set_nullable_floats("nozzle_volume", read_floats(request["nozzle_volume"], "nozzle_volume"));
        if (request.contains("enable_long_retraction_when_cut"))
            set_int("enable_long_retraction_when_cut", request["enable_long_retraction_when_cut"].get<int>());
        if (request.contains("long_retractions_when_cut"))
            set_bools("long_retractions_when_cut", read_bools(request["long_retractions_when_cut"], "long_retractions_when_cut"));
        if (request.contains("retraction_distances_when_cut"))
            set_floats("retraction_distances_when_cut", read_floats(request["retraction_distances_when_cut"], "retraction_distances_when_cut"));
        if (request.contains("nozzle_flush_dataset"))
            printer.option<ConfigOptionIntsNullable>("nozzle_flush_dataset", true)->values = request["nozzle_flush_dataset"].get<std::vector<int>>();
        if (request.contains("flush_multiplier"))
            set_floats("flush_multiplier", read_floats(request["flush_multiplier"], "flush_multiplier"));
        if (request.contains("filament_diameter"))
            set_floats("filament_diameter", read_floats(request["filament_diameter"], "filament_diameter"));
        if (request.contains("filament_long_retractions_when_cut"))
            set_filament_bools("filament_long_retractions_when_cut", read_bools(request["filament_long_retractions_when_cut"], "filament_long_retractions_when_cut"));
        if (request.contains("filament_retraction_distances_when_cut"))
            set_filament_floats("filament_retraction_distances_when_cut", read_floats(request["filament_retraction_distances_when_cut"], "filament_retraction_distances_when_cut"));
        Filament::Commands::recalculate_filament_flush(state().presets);
        if (request.contains("imported_matrix")) {
            const auto imported = read_floats(request["imported_matrix"], "imported_matrix");
            const std::size_t count = state().presets.filament_presets.size();
            const std::size_t planes = static_cast<std::size_t>(std::max(1, state().presets.get_printer_extruder_count()));
            if (imported.size() != count * count * planes)
                return error_json("invalid imported flush matrix size");
            state().presets.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values = imported;
        }
        return duplicate_json(json{{"ok", true}, {"snapshot", filament_session_snapshot_json()},
            {"min_flush_volumes", Filament::Commands::min_flush_volumes_for_config(synthetic_full,
                state().presets.filament_presets.size(),
                std::max(1, state().presets.get_printer_extruder_count()))}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test flush fixture failure"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_filament_session_snapshot()
{
    try {
        return duplicate_json(Slic3r::Neo::Bridge::Filament::Session::filament_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return duplicate_json(Slic3r::Neo::Bridge::Filament::Session::filament_session_error_json("native_exception", e.what()).dump());
    } catch (...) {
        return duplicate_json(Slic3r::Neo::Bridge::Filament::Session::filament_session_error_json("unknown_exception", "unknown C++ exception").dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_filament_slot_preset(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::select_filament_slot_preset_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_slot_colour(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::set_filament_slot_colour_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_filament_slot(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::add_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_filament_slot(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::delete_or_merge_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), false,
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_merge_filament_slots(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::delete_or_merge_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), true,
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_assign_filament(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::assign_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament assignment command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_routing(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::set_filament_routing_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::Filament::Session::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::Filament::Commands::command_error("invalid_command", "invalid filament routing command").dump()); }
}

} // extern "C"

} // namespace Slic3r::Neo::Bridge::Filament::Session
