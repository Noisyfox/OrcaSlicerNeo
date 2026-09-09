// ----------------------------------------------------------------
// Native profile/config domain for the Neo bridge.
// ----------------------------------------------------------------
#include "bridge_profiles.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include "libslic3r/AppConfig.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/PresetBundle.hpp"
#include "libslic3r/Utils.hpp"

using namespace Slic3r;

namespace Slic3r::Neo::Bridge::Profiles {

namespace {

const char* dup_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    if (!out) std::abort();
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}

const char* make_error_json(const std::string& message)
{
    return dup_json(json{{"error", message}}.dump());
}

std::string option_type_name(const ConfigOptionDef& def)
{
    switch (def.type) {
        case coFloat:            return "float";
        case coInt:              return "int";
        case coString:           return "string";
        case coBool:             return "bool";
        case coPercent:          return "percent";
        case coFloats:           return "floats";
        case coInts:             return "ints";
        case coStrings:          return "strings";
        case coBools:            return "bools";
        case coEnum:             return "enum";
        case coFloatOrPercent:   return "float_or_percent";
        case coPercents:         return "percents";
        case coPoint:            return "point";
        case coPoints:           return "points";
        case coPoint3:           return "point3";
        // Drift at the pinned SHA: ConfigOptionType has no coVec3d (the enum
        // ends at coPointsGroups/coIntsGroups, Config.hpp:166-203), so the
        // planned coVec3d case is dropped; such types hit default: "unknown".
        default:                 return "unknown";
    }
}

json option_def_to_json(const ConfigOptionDef& def)
{
    json result;
    result["type"] = option_type_name(def);
    if (!def.label.empty()) result["label"] = def.label;
    if (!def.full_label.empty()) result["full_label"] = def.full_label;
    if (!def.tooltip.empty()) result["tooltip"] = def.tooltip;
    if (!def.category.empty()) result["category"] = def.category;
    result["mode"] = int(def.mode);
    if (!def.enum_values.empty()) result["enum_values"] = def.enum_values;
    if (!def.enum_labels.empty()) result["enum_labels"] = def.enum_labels;
    if (def.min != 0.0 || def.max != 0.0) {
        result["min"] = def.min;
        result["max"] = def.max;
    }
    if (def.default_value) result["default"] = def.default_value->serialize();
    return result;
}

// The profile config is populated through public AppConfig setters because
// AppConfig::load() requires a file-backed loading path. The renderer remains
// the owner of this JSON and persists it through the existing client contract.
bool apply_app_config(const json& config)
{
    AppConfig& app_config = state().profile_config;
    bool has_models = false;
    for (auto it = config.begin(); it != config.end(); ++it) {
        if (it.key() == "models" && it.value().is_array()) {
            has_models = true;
            for (const auto& model : it.value()) {
                if (!model.is_object()) continue;
                std::string vendor, name;
                if (model.contains("vendor") && model["vendor"].is_string())
                    vendor = model["vendor"].get<std::string>();
                if (model.contains("model") && model["model"].is_string())
                    name = model["model"].get<std::string>();
                std::vector<std::string> variants;
                if (vendor.empty() || name.empty() || !model.contains("nozzle_diameter"))
                    continue;
                // Accept both the escaped on-disk representation and a plain
                // array for hand-written configs and deterministic fixtures.
                if (model["nozzle_diameter"].is_array()) {
                    for (const auto& value : model["nozzle_diameter"])
                        if (value.is_string()) variants.push_back(value.get<std::string>());
                } else if (model["nozzle_diameter"].is_string()) {
                    if (!unescape_strings_cstyle(model["nozzle_diameter"].get<std::string>(), variants))
                        continue;
                } else {
                    continue;
                }
                if (variants.empty()) continue;
                for (const auto& variant : variants)
                    app_config.set_variant(vendor, name, variant, true);
            }
        } else if (it.key() == "presets" && it.value().is_object()) {
            for (auto preset = it.value().begin(); preset != it.value().end(); ++preset)
                if (preset.value().is_string())
                    app_config.set("presets", preset.key(), preset.value().get<std::string>());
        } else if (it.key() == "filaments" && it.value().is_array()) {
            std::map<std::string, std::string> installed;
            for (const auto& filament : it.value())
                if (filament.is_string()) installed[filament.get<std::string>()] = "true";
            app_config.set_section("filaments", installed);
        }
    }
    return has_models;
}

void install_all_filaments()
{
    AppConfig& app_config = state().profile_config;
    for (const Preset& preset : state().presets.filaments)
        if (preset.is_system)
            app_config.set(AppConfig::SECTION_FILAMENTS, preset.name, "true");
}

void install_all_printers()
{
    AppConfig& app_config = state().profile_config;
    for (const Preset& preset : state().presets.printers) {
        if (preset.vendor == nullptr) continue;
        const std::string model = preset.config.opt_string("printer_model");
        const std::string variant = preset.config.opt_string("printer_variant");
        if (model.empty() || variant.empty()) continue;
        app_config.set_variant(preset.vendor->id, model, variant, true);
    }
    install_all_filaments();
    state().presets.load_selections(app_config);
}

void reselect_after_app_config()
{
    const std::string initial = state().profile_config.get("presets", PRESET_PRINTER_NAME);
    bool selected = !initial.empty() &&
                    state().presets.printers.select_preset_by_name(initial, true);
    if (!selected) {
        size_t selected_index = 0;
        for (auto it = state().presets.printers.lbegin();
             it != state().presets.printers.end(); ++it, ++selected_index) {
            if (it->is_default) continue;
            state().presets.printers.select_preset(selected_index);
            break;
        }
    }
    state().presets.update_compatible(PresetSelectCompatibleType::Always);
    state().presets.update_multi_material_filament_presets();
}

void reset_app_config()
{
    AppConfig& app_config = state().profile_config;
    app_config.set_vendors({});
    app_config.clear_section("presets");
    app_config.clear_section("filaments");
}

json preset_entry_json(const Preset& preset, const PresetCollection& collection,
                       bool include_selection = true)
{
    json entry{{"name", preset.name},
               {"is_visible", preset.is_visible},
               {"is_default", preset.is_default}};
    if (include_selection)
        entry["selected"] = preset.name == collection.get_selected_preset_name();
    entry["vendor_id"] = preset.vendor ? preset.vendor->id : "";
    entry["model"] = preset.config.opt_string("printer_model");
    entry["variant"] = preset.config.opt_string("printer_variant");
    return entry;
}

json preset_candidates_json(const PresetCollection& collection, bool require_compatible,
                            bool include_selection = true)
{
    json candidates = json::array();
    for (auto it = collection.begin(); it != collection.end(); ++it) {
        if (!it->is_visible || (require_compatible && !it->is_compatible)) continue;
        candidates.push_back(preset_entry_json(*it, collection, include_selection));
    }
    return candidates;
}

json preset_selection_json(const PresetCollection& collection)
{
    return json{{"name", collection.get_selected_preset_name()},
                {"idx", collection.get_selected_idx()}};
}

json selected_printer_printable_area_json()
{
    json points = json::array();
    const Preset& printer = state().presets.printers.get_selected_preset();
    const ConfigOptionPoints* area = printer.config.opt<ConfigOptionPoints>("printable_area");
    if (area == nullptr || area->values.size() < 3) return points;
    for (const Vec2d& point : area->values) {
        if (!std::isfinite(point.x()) || !std::isfinite(point.y())) return json::array();
        points.push_back({point.x(), point.y()});
    }
    return points;
}

} // namespace

const char* duplicate_json(const std::string& value)
{
    return dup_json(value);
}

const char* error_json(const std::string& message)
{
    return make_error_json(message);
}

json option_metadata_json()
{
    const auto& defs = print_config_def.options;
    json output = json::object();
    for (const auto& [key, def] : defs) output[key] = option_def_to_json(def);
    return output;
}

json preset_snapshot_json()
{
    return json{{"ok", true},
                {"printers", preset_candidates_json(state().presets.printers, false)},
                {"prints", preset_candidates_json(state().presets.prints, true)},
                {"filament_catalog", preset_candidates_json(state().presets.filaments, true, false)},
                {"printer", preset_selection_json(state().presets.printers)},
                {"print", preset_selection_json(state().presets.prints)},
                {"printable_area", selected_printer_printable_area_json()}};
}

json serialize_app_config()
{
    const AppConfig& app_config = state().profile_config;
    json result = json::object();
    if (app_config.has_section("presets"))
        for (const auto& pair : app_config.get_section("presets"))
            result["presets"][pair.first] = pair.second;
    if (app_config.has_section("filaments")) {
        json filaments = json::array();
        for (const auto& pair : app_config.get_section("filaments")) filaments.push_back(pair.first);
        result["filaments"] = std::move(filaments);
    }
    for (const auto& vendor : app_config.vendors()) {
        for (const auto& model : vendor.second) {
            if (model.second.empty()) continue;
            const std::vector<std::string> variants(model.second.begin(), model.second.end());
            result["models"].push_back(json{{"vendor", vendor.first},
                                             {"model", model.first},
                                             {"nozzle_diameter", escape_strings_cstyle(variants)}});
        }
    }
    return result;
}

const char* init_with_app_config(const json& config)
{
    reset_app_config();
    const bool has_models = apply_app_config(config);
    set_data_dir("/");
    set_resources_dir("/");
    state().presets.setup_directories();
    state().presets.load_presets(state().profile_config, ForwardCompatibilitySubstitutionRule::Enable);
    if (!has_models) {
        install_all_printers();
        reselect_after_app_config();
    }
    return dup_json(json{{"ok", true},
                         {"prints", state().presets.prints.size()},
                         {"filaments", state().presets.filaments.size()},
                         {"printers", state().presets.printers.size()}}.dump());
}

} // namespace Slic3r::Neo::Bridge::Profiles

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_preset_snapshot()
{
    try {
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(
            Slic3r::Neo::Bridge::Profiles::preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::Profiles::error_json(e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::Profiles::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_select_preset(const char* kind_cstr, const char* name_cstr)
{
    using namespace Slic3r::Neo::Bridge;
    try {
        const std::string kind = kind_cstr ? kind_cstr : "";
        const std::string name = name_cstr ? name_cstr : "";
        if (name.empty()) return Profiles::error_json("preset name required");
        PresetCollection* collection = nullptr;
        if (kind == "print") collection = &state().presets.prints;
        else if (kind == "printer") collection = &state().presets.printers;
        else return Profiles::error_json("kind must be print|printer");
        Preset* requested = collection->find_preset(name);
        if (requested == nullptr) return Profiles::error_json("preset not found: " + name);
        if (!requested->is_visible) return Profiles::error_json("preset is not visible: " + name);
        if (kind != "printer" && !requested->is_compatible)
            return Profiles::error_json("preset is incompatible: " + name);
        if (!collection->select_preset_by_name(name, true))
            return Profiles::error_json("could not select preset: " + name);
        if (kind == "printer") {
            state().presets.update_compatible(PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        } else if (kind == "print") {
            state().presets.update_compatible(PresetSelectCompatibleType::Never,
                                               PresetSelectCompatibleType::Always);
            state().presets.update_multi_material_filament_presets();
        }
        return Profiles::duplicate_json(Profiles::preset_snapshot_json().dump());
    } catch (const std::exception& e) {
        return Profiles::error_json(e.what());
    } catch (...) {
        return Profiles::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_get_option_metadata()
{
    try {
        return Slic3r::Neo::Bridge::Profiles::duplicate_json(
            Slic3r::Neo::Bridge::Profiles::option_metadata_json().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::Profiles::error_json(e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::Profiles::error_json("unknown C++ exception");
    }
}

} // extern "C"
