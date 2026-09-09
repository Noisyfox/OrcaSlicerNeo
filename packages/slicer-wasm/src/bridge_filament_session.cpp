// ----------------------------------------------------------------
// Multi-filament session projection and ABI facade for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_filament_session.hpp"

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

#include "bridge_filament_state.hpp"
#include "bridge_project_overlay.hpp"
#include "bridge_plate_session.hpp"
#include "bridge_state.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/PresetBundle.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::FilamentSession {

using Neo::Bridge::state;
using namespace Neo::Bridge::FilamentCommands;
using namespace Neo::Bridge::PlateSession;
using Neo::Bridge::FilamentState::config_metadata_json;

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

FilamentCommands::Runtime filament_command_runtime()
{
    return {[] { return filament_session_snapshot_json(); }};
}

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_restore_filament_rack(const char* request_cstr)
{
    return Slic3r::Neo::Bridge::FilamentCommands::restore_filament_rack_command(
        request_cstr, Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime());
}

EMSCRIPTEN_KEEPALIVE const char* orc_test_set_filament_reference_fixture(const char* request_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    using namespace FilamentSession;
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
                plate.settings_metadata = FilamentState::config_metadata_json(plate.settings);
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
        FilamentCommands::recalculate_filament_flush(state().presets);
        if (request.contains("imported_matrix")) {
            const auto imported = read_floats(request["imported_matrix"], "imported_matrix");
            const std::size_t count = state().presets.filament_presets.size();
            const std::size_t planes = static_cast<std::size_t>(std::max(1, state().presets.get_printer_extruder_count()));
            if (imported.size() != count * count * planes)
                return error_json("invalid imported flush matrix size");
            state().presets.project_config.option<ConfigOptionFloats>("flush_volumes_matrix", true)->values = imported;
        }
        return duplicate_json(json{{"ok", true}, {"snapshot", filament_session_snapshot_json()},
            {"min_flush_volumes", FilamentCommands::min_flush_volumes_for_config(synthetic_full,
                state().presets.filament_presets.size(),
                std::max(1, state().presets.get_printer_extruder_count()))}}.dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown test flush fixture failure"); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_filament_session_snapshot()
{
    try {
        return duplicate_json(Slic3r::Neo::Bridge::FilamentSession::filament_session_snapshot_json().dump());
    } catch (const std::exception& e) {
        return duplicate_json(Slic3r::Neo::Bridge::FilamentSession::filament_session_error_json("native_exception", e.what()).dump());
    } catch (...) {
        return duplicate_json(Slic3r::Neo::Bridge::FilamentSession::filament_session_error_json("unknown_exception", "unknown C++ exception").dump());
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_filament_slot_preset(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::select_filament_slot_preset_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_slot_colour(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::set_filament_slot_colour_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_add_filament_slot(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::add_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_delete_filament_slot(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::delete_or_merge_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), false,
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_merge_filament_slots(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::delete_or_merge_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(), true,
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_assign_filament(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::assign_filament_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament assignment command").dump()); }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_filament_routing(const char* request_json)
{
    try { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::set_filament_routing_command(
        request_json && *request_json ? json::parse(request_json) : json::object(),
        Slic3r::Neo::Bridge::FilamentSession::filament_command_runtime()).dump()); }
    catch (const std::exception& e) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", e.what()).dump()); }
    catch (...) { return duplicate_json(Slic3r::Neo::Bridge::FilamentCommands::command_error("invalid_command", "invalid filament routing command").dump()); }
}

} // extern "C"

} // namespace Slic3r::Neo::Bridge::FilamentSession
