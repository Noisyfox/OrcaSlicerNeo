// ----------------------------------------------------------------
// Project configuration overlay for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_project_overlay.hpp"

#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <cmath>
#include <iterator>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

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

struct ModelMutationSnapshot {
    std::vector<std::pair<ModelObject*, ModelConfig>> object_configs;
    std::vector<std::pair<ModelVolume*, ModelConfig>> volume_configs;
    std::vector<std::pair<ModelInstance*, Geometry::Transformation>> instance_transforms;
};

ModelMutationSnapshot capture_model_mutation_snapshot(Model& model)
{
    ModelMutationSnapshot snapshot;
    snapshot.object_configs.reserve(model.objects.size());
    for (auto* object : model.objects) {
        snapshot.object_configs.emplace_back(object, static_cast<const ModelConfig&>(object->config));
        snapshot.volume_configs.reserve(snapshot.volume_configs.size() + object->volumes.size());
        snapshot.instance_transforms.reserve(snapshot.instance_transforms.size() + object->instances.size());
        for (auto* volume : object->volumes)
            snapshot.volume_configs.emplace_back(volume, static_cast<const ModelConfig&>(volume->config));
        for (auto* instance : object->instances)
            snapshot.instance_transforms.emplace_back(instance, instance->get_transformation());
    }
    return snapshot;
}

void restore_model_mutation_snapshot(ModelMutationSnapshot& snapshot) noexcept
{
    try {
        for (auto& [object, config] : snapshot.object_configs) {
            object->config.assign_config(std::move(config));
            object->invalidate_bounding_box();
        }
        for (auto& [volume, config] : snapshot.volume_configs)
            volume->config.assign_config(std::move(config));
        for (auto& [instance, transform] : snapshot.instance_transforms)
            instance->set_transformation(transform);
    } catch (...) {}
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
    // Coordinates are one native project-level array pair. Never recreate a
    // plate bucket projection: it would become a second authoritative store
    // and would make generic overlay/history callers appear to own X/Y.
    for (auto& values : plates)
        if (values.is_object()) {
            values.erase("wipe_tower_x");
            values.erase("wipe_tower_y");
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
    std::optional<ProjectOverlay::ModelMutationSnapshot> before_model;
    std::optional<DynamicPrintConfig> before_project_config;
    std::optional<std::vector<BridgeState::PlateSessionPlate>> before_plates;
    std::optional<json> before_overlay;
    std::optional<std::map<std::string, std::uint64_t>> before_revisions;
    std::optional<std::map<std::string, std::set<std::size_t>>> before_out_of_bounds;
    std::optional<std::set<std::size_t>> before_pending;
    std::optional<PlateRuntimeRegistry::LifecycleSnapshots> before_lifecycle;
    const auto rollback = [&]() noexcept {
        if (!before_model || !before_project_config || !before_plates || !before_overlay ||
            !before_revisions || !before_out_of_bounds || !before_pending || !before_lifecycle) return;
        try {
            ProjectOverlay::restore_model_mutation_snapshot(*before_model);
            state().mutable_object_capture_cache.clear();
            state().presets.project_config = std::move(*before_project_config);
            state().plate_session_plates = std::move(*before_plates);
            state().project_config_overlay = std::move(*before_overlay);
            state().plate_input_revisions = std::move(*before_revisions);
            state().plate_out_of_bounds_ids = std::move(*before_out_of_bounds);
            state().pending_membership_instance_ids = std::move(*before_pending);
            state().plate_runtime_registry.restore_lifecycle(*before_lifecycle);
            PrimeTower::invalidate_projection_cache();
        } catch (...) {}
    };
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
        if (key == "wipe_tower_x" || key == "wipe_tower_y")
            return configuration_error("unsupported_reference", "prime tower coordinates are scene-only");
        if (Slic3r::print_config_def.options.find(key) == Slic3r::print_config_def.options.end())
            return configuration_error("unsupported_reference", "unsupported project configuration option: " + key);
        if (scope != "project" && id.empty()) return configuration_error("invalid_command", "scope id is required");
        Slic3r::ConfigSubstitutionContext substitutions{Slic3r::ForwardCompatibilitySubstitutionRule::Disable};
        Slic3r::DynamicPrintConfig project_candidate;
        Slic3r::DynamicPrintConfig scoped_candidate;
        ModelObject* object_target = nullptr;
        ModelVolume* part_target = nullptr;
        BridgeState::PlateSessionPlate* plate_target = nullptr;
        std::set<std::string> affected_plates;
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
            configuration_status = native_configuration_status(project_candidate, key, value);
            effective_value = effective_for(project_candidate);
            affected_plates = PlateSession::all_plate_ids();
        } else if (scope == "object") {
            object_target = ModelOperations::find_object_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!object_target) return configuration_error("unsupported_reference", "object not found");
            scoped_candidate = object_target->config.get();
            scoped_candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(scoped_candidate, key, value);
            effective_value = effective_for(scoped_candidate);
            std::set<std::size_t> instance_ids;
            for (const auto* instance : object_target->instances) instance_ids.insert(instance->id().id);
            affected_plates = PlateSession::member_plate_ids_for_instances(instance_ids);
        } else if (scope == "part") {
            part_target = ModelOperations::find_volume_by_id(static_cast<std::size_t>(std::stoull(id)));
            if (!part_target) return configuration_error("unsupported_reference", "part not found");
            scoped_candidate = part_target->config.get();
            scoped_candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(scoped_candidate, key, value);
            effective_value = effective_for(scoped_candidate);
            std::set<std::size_t> instance_ids;
            for (const auto* instance : part_target->get_object()->instances) instance_ids.insert(instance->id().id);
            affected_plates = PlateSession::member_plate_ids_for_instances(instance_ids);
        } else {
            plate_target = PlateSession::find_plate_mutable(id);
            if (!plate_target) return configuration_error("unsupported_reference", "plate not found");
            scoped_candidate = plate_target->settings;
            scoped_candidate.set_deserialize(key, value, substitutions);
            configuration_status = native_configuration_status(scoped_candidate, key, value);
            effective_value = effective_for(scoped_candidate);
            affected_plates.insert(id);
        }

        // From this point onward the command publishes native state. Keep one
        // exact rollback image so a late allocation/validation failure cannot
        // advance stamps, move plate origins, or withdraw a valid result.
        before_model.emplace(ProjectOverlay::capture_model_mutation_snapshot(state().model));
        before_project_config.emplace(state().presets.project_config);
        before_plates.emplace(state().plate_session_plates);
        before_overlay.emplace(state().project_config_overlay);
        before_revisions.emplace(state().plate_input_revisions);
        before_out_of_bounds.emplace(state().plate_out_of_bounds_ids);
        before_pending.emplace(state().pending_membership_instance_ids);
        before_lifecycle.emplace(state().plate_runtime_registry.capture_lifecycle());

        json& bucket = scope == "project" ? state().project_config_overlay["project"]
            : scope == "object" ? state().project_config_overlay["objects"][id]
            : scope == "part" ? state().project_config_overlay["parts"][id]
            : state().project_config_overlay["plates"][id];
        bucket[key] = effective_value;
        if (scope == "project") {
            state().presets.project_config = std::move(project_candidate);
        } else if (scope == "object") {
            object_target->config.assign_config(scoped_candidate);
        } else if (scope == "part") {
            part_target->config.assign_config(scoped_candidate);
        } else {
            plate_target->settings = std::move(scoped_candidate);
            plate_target->settings_metadata = Filament::State::config_metadata_json(plate_target->settings);
        }
        const auto mutation = scope == "project"
            ? PlateSession::shared_configuration_mutation_snapshot()
            : PlateSession::configuration_mutation_snapshot(
                affected_plates, {scope + "-configuration"});
        json result = project_config_overlay_result();
        result["plate_session"] = mutation;
        if (configuration_status.has_value()) result["configuration_status"] = *configuration_status;
        return ProjectOverlay::duplicate_json(result.dump());
    } catch (const Slic3r::BadOptionValueException& e) {
        rollback();
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (const std::exception& e) {
        rollback();
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (...) {
        rollback();
        return native_configuration_error_json("native_validation_failure", "unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_revalidate_project_config_overlay() {
    using namespace Slic3r::Neo::Bridge::ProjectOverlay;
    try {
        for (const char* scope : {"project", "objects", "parts", "plates"}) {
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
