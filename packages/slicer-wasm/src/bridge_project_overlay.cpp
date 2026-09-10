// ----------------------------------------------------------------
// Project configuration overlay for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_project_overlay.hpp"

#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>

#include <emscripten/emscripten.h>

#include "bridge_filament.hpp"
#include "bridge_model_operations.hpp"
#include "bridge_plate.hpp"
#include "bridge_prime_tower.hpp"
#include "libslic3r/Exception.hpp"

using namespace Slic3r;
using nlohmann::json;

namespace Slic3r::Neo::Bridge::ProjectOverlay {

using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::Filament::State::config_metadata_json;
using Neo::Bridge::ModelOperations::find_object_by_id;
using Neo::Bridge::ModelOperations::find_volume_by_id;
using Neo::Bridge::PlateCommands::plate_configuration_mutation_snapshot;
using namespace Neo::Bridge::PlateSession;

static constexpr const char* kNeoConfigOverlaySchema = "org.orcaslicerneo.config-overlay";

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

const char* native_configuration_error_json(const std::string& code,
                                            const std::string& message)
{
    return duplicate_json(json{{"ok", false}, {"error", message}, {"error_code", code},
                               {"status", {{"state", "error"}, {"error", message}}}}.dump());
}

template <typename Config>
json native_configuration_status(const Config& config,
                                  const std::string& key,
                                  const std::string& requested)
{
    json corrections = json::array();
    const ConfigOption* option = config.option(key);
    if (option != nullptr) {
        const std::string effective = option->serialize();
        if (effective != requested)
            corrections.push_back({{"key", key}, {"requested", requested}, {"effective", effective}});
    }
    return json{{"state", "ready"}, {"corrections", std::move(corrections)},
                {"warnings", json::array()}, {"errors", json::array()}};
}

template <class Config>
void apply_overlay_generic(Config& config, const json& values)
{
    if (!values.is_object()) return;
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = values.begin(); it != values.end(); ++it) {
        if (!it.value().is_string()) continue;
        try { config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions); }
        catch (...) { /* invalid retained values are ignored at slice time */ }
    }
}

} // namespace

json empty_project_config_overlay()
{
    return json{{"project", json::object()}, {"objects", json::object()},
                {"parts", json::object()}, {"plates", json::object()}};
}

bool valid_project_config_overlay(const json& overlay)
{
    if (!overlay.is_object() || overlay.size() != 4) return false;
    for (const char* scope : {"project", "objects", "parts", "plates"})
        if (!overlay.contains(scope) || !overlay[scope].is_object()) return false;
    for (const char* scope : {"project", "objects", "parts", "plates"}) {
        for (auto it = overlay[scope].begin(); it != overlay[scope].end(); ++it) {
            if (scope == std::string("project")) {
                if (!it.value().is_string()) return false;
                continue;
            }
            if (!it.value().is_object()) return false;
            for (auto option = it.value().begin(); option != it.value().end(); ++option)
                if (!option.value().is_string()) return false;
        }
    }
    return true;
}

void strip_plate_coordinate_overrides(json& overlay)
{
    if (!overlay.is_object() || !overlay.contains("plates") || !overlay["plates"].is_object()) return;
    for (auto& values : overlay["plates"]) {
        if (!values.is_object()) continue;
        values.erase("wipe_tower_x");
        values.erase("wipe_tower_y");
    }
}

void apply_overlay_to_config(DynamicPrintConfig& config, const json& values)
{
    apply_overlay_generic(config, values);
}

void apply_overlay_to_config(ModelConfig& config, const json& values)
{
    apply_overlay_generic(config, values);
}

void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates)
{
    for (auto& plate : plates) {
        apply_overlay_to_config(plate.settings, plate.settings_metadata);
        plate.settings.erase("wipe_tower_x");
        plate.settings.erase("wipe_tower_y");
        if (plate.settings_metadata.is_object()) {
            plate.settings_metadata.erase("wipe_tower_x");
            plate.settings_metadata.erase("wipe_tower_y");
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

void apply_plate_overlay_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates,
                                    const json& overlay)
{
    if (!overlay.is_object() || !overlay.contains("plates") || !overlay["plates"].is_object()) return;
    for (std::size_t index = 0; index < plates.size(); ++index) {
        auto& plate = plates[index];
        const json* values = nullptr;
        if (const auto exact = overlay["plates"].find(plate.id); exact != overlay["plates"].end()) {
            values = &exact.value();
        } else {
            const std::string suffix = "-plate-" + std::to_string(index + 1);
            for (auto it = overlay["plates"].begin(); it != overlay["plates"].end(); ++it) {
                if (it.key().size() >= suffix.size() &&
                    it.key().compare(it.key().size() - suffix.size(), suffix.size(), suffix) == 0) {
                    values = &it.value();
                    break;
                }
            }
        }
        if (values == nullptr || !values->is_object()) continue;
        json candidate = *values;
        candidate.erase("wipe_tower_x");
        candidate.erase("wipe_tower_y");
        apply_overlay_to_config(plate.settings, candidate);
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

json project_config_overlay_metadata()
{
    return json{{"schema", kNeoConfigOverlaySchema}, {"version", 1},
                {"overlay", state().project_config_overlay}};
}

json project_config_overlay_result()
{
    json overlay = state().project_config_overlay;
    json& plates = overlay["plates"];
    if (!plates.is_object()) plates = json::object();
    const auto* x = state().presets.project_config.opt<ConfigOptionFloats>("wipe_tower_x");
    const auto* y = state().presets.project_config.opt<ConfigOptionFloats>("wipe_tower_y");
    for (std::size_t index = 0; index < state().plate_session_plates.size(); ++index) {
        const auto& plate = state().plate_session_plates[index];
        json values = plates[plate.id].is_object() ? plates[plate.id] : json::object();
        if (x != nullptr && index < x->values.size() && std::isfinite(x->values[index]))
            values["wipe_tower_x"] = ConfigOptionFloat(x->values[index]).serialize();
        if (y != nullptr && index < y->values.size() && std::isfinite(y->values[index]))
            values["wipe_tower_y"] = ConfigOptionFloat(y->values[index]).serialize();
        plates[plate.id] = std::move(values);
    }
    return json{{"ok", true}, {"overlay", std::move(overlay)}};
}

} // namespace Slic3r::Neo::Bridge::ProjectOverlay

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_project_config_overlay() {
    try {
        return Slic3r::Neo::Bridge::ProjectOverlay::duplicate_json(
            Slic3r::Neo::Bridge::ProjectOverlay::project_config_overlay_result().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::ProjectOverlay::error_json(e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::ProjectOverlay::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_project_config_override(const char* scope_cstr,
                                                                  const char* id_cstr,
                                                                  const char* option_key_cstr,
                                                                  const char* value_cstr) {
    using namespace Slic3r::Neo::Bridge;
    using ProjectOverlay::apply_overlay_to_config;
    using ProjectOverlay::native_configuration_status;
    using ProjectOverlay::native_configuration_error_json;
    using ProjectOverlay::project_config_overlay_result;
    std::string scope;
    std::string id;
    try {
        PlateSession::ensure_plate_session_state();
        scope = scope_cstr ? scope_cstr : "";
        id = id_cstr ? id_cstr : "";
        const std::string key = option_key_cstr ? option_key_cstr : "";
        const std::string value = value_cstr ? value_cstr : "";
        const auto configuration_error = [](const std::string& code, const std::string& message) {
            return ProjectOverlay::native_configuration_error_json(code, message);
        };
        if (scope != "project" && scope != "object" && scope != "part" && scope != "plate")
            return configuration_error("invalid_command", "invalid project configuration scope");
        if (key.empty()) return configuration_error("invalid_command", "option key is required");
        if (Slic3r::print_config_def.options.find(key) == Slic3r::print_config_def.options.end())
            return configuration_error("unsupported_reference", "unsupported project configuration option: " + key);
        if (scope != "project" && id.empty()) return configuration_error("invalid_command", "scope id is required");
        Slic3r::ConfigSubstitutionContext substitutions{Slic3r::ForwardCompatibilitySubstitutionRule::Disable};
        Slic3r::DynamicPrintConfig project_candidate;
        std::optional<json> configuration_status;
        std::string effective_value;
        const auto effective_for = [&key](const auto& config) {
            const Slic3r::ConfigOption* option = config.option(key);
            if (option == nullptr) throw Slic3r::BadOptionValueException("native option is unavailable: " + key);
            return option->serialize();
        };
        if (scope == "project") {
            project_candidate = state().presets.project_config;
            apply_overlay_to_config(project_candidate, state().project_config_overlay["project"]);
            project_candidate.set_deserialize(key, value, substitutions);
            if ((key == "wipe_tower_x" || key == "wipe_tower_y") &&
                !PlateSession::coordinate_arrays_match_plate_count(
                    project_candidate, state().plate_session_plates.size()))
                return configuration_error("native_validation_failure", "prime tower coordinate arrays must match plate count");
            configuration_status = native_configuration_status(project_candidate, key, value);
            effective_value = effective_for(project_candidate);
        } else if (scope == "object") {
            auto* object = ModelOperations::find_object_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!object) return configuration_error("unsupported_reference", "object not found");
            Slic3r::DynamicPrintConfig candidate = object->config.get();
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            object->config.assign_config(candidate);
        } else if (scope == "part") {
            auto* volume = ModelOperations::find_volume_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!volume) return configuration_error("unsupported_reference", "part not found");
            Slic3r::DynamicPrintConfig candidate = volume->config.get();
            candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(candidate, key, value);
            effective_value = effective_for(candidate);
            volume->config.assign_config(candidate);
        } else {
            if (key != "wipe_tower_x" && key != "wipe_tower_y")
                return configuration_error("unsupported_reference", "plate scope only supports prime tower coordinates");
            auto* plate = PlateSession::find_plate_mutable(id);
            if (plate == nullptr) return configuration_error("unsupported_reference", "plate not found");
            if (!PlateSession::coordinate_arrays_match_plate_count(
                    state().presets.project_config, state().plate_session_plates.size()))
                return configuration_error("native_validation_failure", "prime tower coordinate array invariant failed");
            ConfigOptionFloat parsed;
            if (!parsed.deserialize(value) || !std::isfinite(parsed.value))
                return configuration_error("native_validation_failure", "prime tower coordinate must be finite");
            project_candidate = state().presets.project_config;
            const auto plate_it = std::find_if(state().plate_session_plates.begin(), state().plate_session_plates.end(),
                [&](const auto& candidate) { return candidate.id == id; });
            const auto plate_index = static_cast<std::size_t>(
                std::distance(state().plate_session_plates.begin(), plate_it));
            PrimeTower::set_coordinate_option_value(project_candidate, key.c_str(), plate_index, parsed.value, 0.);
            effective_value = parsed.serialize();
            json corrections = json::array();
            if (effective_value != value)
                corrections.push_back({{"key", key}, {"requested", value}, {"effective", effective_value}});
            configuration_status = json{{"state", "ready"}, {"corrections", std::move(corrections)},
                                        {"warnings", json::array()}, {"errors", json::array()}};
        }
        if (scope != "plate") {
            json& bucket = scope == "project" ? state().project_config_overlay["project"]
                : scope == "object" ? state().project_config_overlay["objects"][id]
                : state().project_config_overlay["parts"][id];
            bucket[key] = effective_value;
        }
        if (scope == "project" || scope == "plate")
            state().presets.project_config = std::move(project_candidate);
        const auto mutation = scope == "plate"
            ? PlateCommands::plate_configuration_mutation_snapshot(id, "prime-tower-position")
            : PlateSession::shared_configuration_mutation_snapshot();
        json result = project_config_overlay_result();
        result["plate_session"] = mutation;
        if (configuration_status.has_value()) result["configuration_status"] = *configuration_status;
        return ProjectOverlay::duplicate_json(result.dump());
    } catch (const Slic3r::BadOptionValueException& e) {
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (const std::exception& e) {
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (...) {
        return native_configuration_error_json("native_validation_failure", "unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_revalidate_project_config_overlay() {
    using namespace Slic3r::Neo::Bridge::ProjectOverlay;
    try {
        for (const char* scope : {"project", "objects", "parts"}) {
            auto& values = state().project_config_overlay[scope];
            for (auto it = values.begin(); it != values.end();) {
                if (scope == std::string("project")) {
                    if (print_config_def.options.find(it.key()) == print_config_def.options.end()) it = values.erase(it);
                    else ++it;
                } else {
                    if (!it.value().is_object()) { it = values.erase(it); continue; }
                    for (auto option = it.value().begin(); option != it.value().end();) {
                        if (!option.value().is_string() || print_config_def.options.find(option.key()) == print_config_def.options.end()) option = it.value().erase(option);
                        else ++option;
                    }
                    ++it;
                }
            }
        }
        return duplicate_json(project_config_overlay_result().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

} // extern "C"
