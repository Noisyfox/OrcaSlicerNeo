// ----------------------------------------------------------------
// Native scoped configuration commands for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_scoped_config.hpp"

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

namespace Slic3r::Neo::Bridge::ScopedConfig {

using Neo::Bridge::BridgeState;
using Neo::Bridge::state;
using Neo::Bridge::Filament::State::config_metadata_json;
using Neo::Bridge::ModelOperations::find_object_by_id;
using Neo::Bridge::ModelOperations::find_volume_by_id;
using namespace Neo::Bridge::PlateSession;

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
void apply_native_values_generic(Config& config, const json& values)
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

json empty_native_scoped_config_snapshot()
{
    return json{{"project", json::object()}, {"objects", json::object()},
                {"parts", json::object()}, {"plates", json::object()}};
}

bool valid_native_scoped_config_snapshot(const json& snapshot)
{
    if (!snapshot.is_object() || snapshot.size() != 4) return false;
    for (const char* scope : {"project", "objects", "parts", "plates"})
        if (!snapshot.contains(scope) || !snapshot[scope].is_object()) return false;
    for (const char* scope : {"project", "objects", "parts", "plates"}) {
        for (auto it = snapshot[scope].begin(); it != snapshot[scope].end(); ++it) {
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

void apply_native_config_values(DynamicPrintConfig& config, const json& values)
{
    apply_native_values_generic(config, values);
}

void apply_native_config_values(ModelConfig& config, const json& values)
{
    apply_native_values_generic(config, values);
}

void apply_plate_metadata_to_configs(std::vector<BridgeState::PlateSessionPlate>& plates)
{
    for (auto& plate : plates) {
        apply_native_config_values(plate.settings, plate.settings_metadata);
        plate.settings.erase("wipe_tower_x");
        plate.settings.erase("wipe_tower_y");
        if (plate.settings_metadata.is_object()) {
            plate.settings_metadata.erase("wipe_tower_x");
            plate.settings_metadata.erase("wipe_tower_y");
        }
        plate.settings_metadata = config_metadata_json(plate.settings);
    }
}

json native_scoped_config_snapshot()
{
    json snapshot = empty_native_scoped_config_snapshot();
    const auto append_config = [](json& destination, const ConfigBase& config) {
        for (const std::string& key : config.keys()) {
            const auto* option = config.option(key);
            if (option == nullptr) continue;
            try { destination[key] = option->serialize(); }
            catch (...) { /* retain only values the native config can serialize */ }
        }
    };

    append_config(snapshot["project"], state().presets.project_config);
    for (const auto* object : state().model.objects) {
        if (object == nullptr) continue;
        json object_values = json::object();
        append_config(object_values, object->config.get());
        if (!object_values.empty())
            snapshot["objects"][std::to_string(object->id().id)] = std::move(object_values);
        for (const auto* volume : object->volumes) {
            if (volume == nullptr) continue;
            json volume_values = json::object();
            append_config(volume_values, volume->config.get());
            if (!volume_values.empty())
                snapshot["parts"][std::to_string(volume->id().id)] = std::move(volume_values);
        }
    }
    for (const auto& plate : state().plate_session_plates) {
        json plate_values = json::object();
        append_config(plate_values, plate.settings);
        plate_values.erase("wipe_tower_x");
        plate_values.erase("wipe_tower_y");
        if (!plate_values.empty()) snapshot["plates"][plate.id] = std::move(plate_values);
    }
    return snapshot;
}

json native_scoped_config_result()
{
    return json{{"ok", true}, {"native_scoped_config", native_scoped_config_snapshot()}};
}

} // namespace Slic3r::Neo::Bridge::ScopedConfig

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_native_scoped_config() {
    try {
        return Slic3r::Neo::Bridge::ScopedConfig::duplicate_json(
            Slic3r::Neo::Bridge::ScopedConfig::native_scoped_config_result().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::ScopedConfig::error_json(e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::ScopedConfig::error_json("unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_set_native_scoped_config(const char* scope_cstr,
                                                               const char* id_cstr,
                                                               const char* option_key_cstr,
                                                               const char* value_cstr) {
    using namespace Slic3r::Neo::Bridge;
    using ScopedConfig::native_configuration_status;
    using ScopedConfig::native_configuration_error_json;
    using ScopedConfig::native_scoped_config_result;
    std::string scope;
    std::string id;
    std::optional<ScopedConfig::ModelMutationSnapshot> before_model;
    std::optional<DynamicPrintConfig> before_project_config;
    std::optional<std::vector<BridgeState::PlateSessionPlate>> before_plates;
    std::optional<std::map<std::string, std::uint64_t>> before_revisions;
    std::optional<std::map<std::string, std::set<std::size_t>>> before_out_of_bounds;
    std::optional<std::set<std::size_t>> before_pending;
    std::optional<PlateRuntimeRegistry::LifecycleSnapshots> before_lifecycle;
    const auto rollback = [&]() noexcept {
        if (!before_model || !before_project_config || !before_plates ||
            !before_revisions || !before_out_of_bounds || !before_pending || !before_lifecycle) return;
        try {
            ScopedConfig::restore_model_mutation_snapshot(*before_model);
            state().mutable_object_capture_cache.clear();
            state().presets.project_config = std::move(*before_project_config);
            state().plate_session_plates = std::move(*before_plates);
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
            return ScopedConfig::native_configuration_error_json(code, message);
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
        before_model.emplace(ScopedConfig::capture_model_mutation_snapshot(state().model));
        before_project_config.emplace(state().presets.project_config);
        before_plates.emplace(state().plate_session_plates);
        before_revisions.emplace(state().plate_input_revisions);
        before_out_of_bounds.emplace(state().plate_out_of_bounds_ids);
        before_pending.emplace(state().pending_membership_instance_ids);
        before_lifecycle.emplace(state().plate_runtime_registry.capture_lifecycle());

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
        json result = native_scoped_config_result();
        result["plate_session"] = mutation;
        if (configuration_status.has_value()) result["configuration_status"] = *configuration_status;
        return ScopedConfig::duplicate_json(result.dump());
    } catch (const Slic3r::BadOptionValueException& e) {
        rollback();
        return ScopedConfig::native_configuration_error_json("native_validation_failure", e.what());
    } catch (const std::exception& e) {
        rollback();
        return ScopedConfig::native_configuration_error_json("native_validation_failure", e.what());
    } catch (...) {
        rollback();
        return ScopedConfig::native_configuration_error_json("native_validation_failure", "unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_revalidate_native_scoped_config() {
    using namespace Slic3r::Neo::Bridge::ScopedConfig;
    try {
        return duplicate_json(native_scoped_config_result().dump());
    } catch (const std::exception& e) { return error_json(e.what()); }
    catch (...) { return error_json("unknown C++ exception"); }
}

} // extern "C"
