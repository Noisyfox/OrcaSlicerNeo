// ----------------------------------------------------------------
// Native scoped configuration commands for the Neo WASM bridge.
// ----------------------------------------------------------------
#include "bridge_scoped_config.hpp"

#include <algorithm>
#include <cfloat>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/emscripten.h>

#include "bridge_filament.hpp"
#include "bridge_history.hpp"
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

bool is_editable_plate_override_key(const std::string& key)
{
    // This is Neo's generic scoped-API surface: native plate override keys
    // that the BBS reader/writer can round-trip. It intentionally differs
    // from Orca's dedicated GUI Tab::plate_keys helper list. Native BBS also
    // carries structural and derived PlateData fields; those remain native
    // state but are not generic scoped mutation targets.
    static const std::set<std::string> keys = {
        "curr_bed_type",
        "print_sequence",
        "first_layer_print_sequence",
        "other_layers_print_sequence",
        "other_layers_print_sequence_nums",
        "spiral_mode",
        "filament_map_mode",
        "filament_map",
        "filament_volume_map",
    };
    return keys.find(key) != keys.end();
}

bool is_native_project_config_key(const std::string& key)
{
    // Keep this boundary aligned with PresetBundle::s_project_options in the
    // pinned native core. Project-scoped print options outside this set belong
    // to the edited Print preset; they are projected from its parent diff.
    static const std::set<std::string> keys = {
        "flush_volumes_vector",
        "flush_volumes_matrix",
        "filament_colour",
        "filament_colour_type",
        "filament_multi_colour",
        "wipe_tower_x",
        "wipe_tower_y",
        "wipe_tower_rotation_angle",
        "curr_bed_type",
        "flush_multiplier",
        "flush_multiplier_fast",
        "prime_volume_mode",
        "nozzle_volume_type",
        "filament_map_mode",
        "filament_map",
        "filament_volume_map",
        "filament_nozzle_map",
        "has_filament_switcher",
        "enable_filament_dynamic_map",
    };
    return keys.find(key) != keys.end() || is_bridge_owned_project_routing_key(key);
}

bool is_bridge_owned_project_routing_key(const std::string& key)
{
    // These existing native routing slots are a deliberately narrow bridge
    // extension to PresetBundle::s_project_options. They remain authoritative
    // in project_config, history, and effective slicing, but are not generic
    // Project/Scoped preset overrides and must be changed only by the typed
    // filament-routing commands (never via different_settings_to_system).
    static const std::set<std::string> keys = {
        "wipe_tower_filament",
        "support_filament",
        "support_interface_filament",
        "outer_wall_filament_id",
        "inner_wall_filament_id",
        "sparse_infill_filament_id",
        "internal_solid_filament_id",
        "top_surface_filament_id",
        "bottom_surface_filament_id",
    };
    return keys.find(key) != keys.end();
}

namespace {

const char* duplicate_json(const std::string& value)
{
    char* out = static_cast<char*>(std::malloc(value.size() + 1));
    if (out == nullptr) return nullptr;
    std::memcpy(out, value.data(), value.size());
    out[value.size()] = '\0';
    return out;
}

const char* native_configuration_error_json(const std::string& code,
                                            const std::string& message)
{
    return duplicate_json(json{{"version", 1}, {"ok", false}, {"error", message}, {"error_code", code},
                               {"status", {{"state", "error"}, {"error", message}}}}.dump());
}

struct ModelMutationSnapshot {
    std::vector<std::pair<ModelObject*, ModelConfig>> object_configs;
    std::vector<std::pair<ModelVolume*, ModelConfig>> volume_configs;
    std::vector<std::pair<ModelInstance*, Geometry::Transformation>> instance_transforms;
};

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

struct MutationCommandError : std::runtime_error {
    MutationCommandError(std::string code, std::string message)
        : std::runtime_error(std::move(message)), code(std::move(code)) {}
    std::string code;
};

struct MutationTarget {
    std::string scope;
    std::string id;
};

struct MutationRequest {
    std::string operation;
    std::vector<MutationTarget> targets;
    std::map<std::string, std::string> values;
    std::string category;
};

struct ResolvedTarget {
    MutationTarget target;
    DynamicPrintConfig candidate;
    DynamicPrintConfig project_candidate;
    DynamicPrintConfig print_candidate;
    ModelObject* object = nullptr;
    ModelVolume* part = nullptr;
    BridgeState::PlateSessionPlate* plate = nullptr;
    std::set<std::string> affected_plates;
    bool project_config_changed = false;
    bool print_config_changed = false;
    bool changed = false;
};

// A local edit cannot change unrelated configs or instance transforms. Only
// Project edits can reflow the virtual plate layout.
ModelMutationSnapshot capture_model_mutation_snapshot(
    const std::vector<ResolvedTarget>& targets, bool project_changed)
{
    ModelMutationSnapshot snapshot;
    for (const auto& target : targets) {
        if (!target.changed) continue;
        if (target.object != nullptr)
            snapshot.object_configs.emplace_back(target.object, target.object->config);
        if (target.part != nullptr)
            snapshot.volume_configs.emplace_back(target.part, target.part->config);
    }
    if (project_changed) {
        for (auto* object : state().model.objects)
            for (auto* instance : object->instances)
                snapshot.instance_transforms.emplace_back(instance, instance->get_transformation());
    }
    return snapshot;
}

// Orca stores ordinary Project print edits as a project-embedded Print preset.
// The bridge starts with a selected system/external preset, so materialize a
// project-owned child before applying the first such edit.  This keeps the
// edited-preset diff available to get_current_project_embedded_presets() and
// avoids treating the full effective Print config as project_config.
struct ProjectPrintPresetMaterialization {
    bool created = false;
    bool committed = false;
    std::string previous_name;
    std::string created_name;
    DynamicPrintConfig previous_config;
};

void rollback_project_print_preset_materialization(ProjectPrintPresetMaterialization& materialization) noexcept
{
    if (!materialization.created || materialization.committed) return;
    try {
        auto& prints = state().presets.prints;
        if (prints.get_selected_preset_name() == materialization.created_name)
            prints.delete_current_preset();
        else
            prints.delete_preset(materialization.created_name, true);
        if (!materialization.previous_name.empty())
            prints.select_preset_by_name(materialization.previous_name, true);
        prints.get_edited_preset().config = materialization.previous_config;
        prints.update_dirty();
    } catch (...) {
        // The surrounding mutation error remains authoritative.  A failed
        // cleanup must not mask it with a secondary profile exception.
    }
}

void materialize_project_print_preset(ProjectPrintPresetMaterialization& materialization)
{
    auto& prints = state().presets.prints;
    Preset& edited = prints.get_edited_preset();
    if (edited.is_project_embedded) return;

    materialization.previous_name = prints.get_selected_preset_name();
    materialization.previous_config = edited.config;
    Preset child = edited;
    // Keep the selected preset as the explicit parent even when the upstream
    // profile is marked external and get_selected_preset_parent() is null.
    // That parent is still part of the native catalog and gives BBS the same
    // diff base used by Orca's project-embedded preset path.
    if (!materialization.previous_name.empty())
        child.inherits() = materialization.previous_name;

    const std::string base_name = materialization.previous_name.empty()
        ? "Project Print Settings"
        : materialization.previous_name + " (Project)";
    materialization.created_name = base_name;
    for (std::size_t suffix = 2; prints.find_preset(materialization.created_name, false, true) != nullptr; ++suffix)
        materialization.created_name = base_name + " " + std::to_string(suffix);

    prints.save_current_preset(materialization.created_name, false, true, &child);
    Preset* saved = prints.find_preset(materialization.created_name, false, true);
    if (saved == nullptr || !saved->is_project_embedded)
        throw std::runtime_error("could not materialize the project Print preset");
    materialization.created = true;
}

bool is_numeric_type(const ConfigOptionType type)
{
    return type == coFloat || type == coFloats || type == coInt || type == coInts ||
           type == coPercent || type == coPercents || type == coFloatOrPercent ||
           type == coFloatsOrPercents;
}

std::vector<std::string> split_numeric_tokens(const std::string& value)
{
    std::vector<std::string> tokens;
    std::size_t start = 0;
    while (start <= value.size()) {
        const std::size_t comma = value.find(',', start);
        tokens.push_back(value.substr(start, comma == std::string::npos ? std::string::npos : comma - start));
        if (comma == std::string::npos) break;
        start = comma + 1;
    }
    return tokens;
}

std::string clamp_numeric_value(const ConfigOptionDef& definition,
                                const std::string& requested)
{
    if (!is_numeric_type(definition.type)) return requested;
    const bool integer = definition.type == coInt || definition.type == coInts;
    const auto tokens = split_numeric_tokens(requested);
    std::ostringstream output;
    output << std::setprecision(17);
    for (std::size_t index = 0; index < tokens.size(); ++index) {
        if (index != 0) output << ',';
        const std::string& token = tokens[index];
        std::size_t parsed = 0;
        double number = 0;
        try { number = std::stod(token, &parsed); }
        catch (...) { return requested; }
        const std::string suffix = token.substr(parsed);
        if (!suffix.empty() && suffix != "%") return requested;
        if (!std::isfinite(number))
            throw BadOptionValueException("non-finite native configuration value");
        if (std::isfinite(definition.min)) number = std::max(number, static_cast<double>(definition.min));
        if (std::isfinite(definition.max)) number = std::min(number, static_cast<double>(definition.max));
        if (integer) output << static_cast<long long>(number);
        else output << number;
        if (!suffix.empty()) output << suffix;
    }
    return output.str();
}

const ConfigOptionDef& require_definition(const std::string& key)
{
    const auto* definition = Slic3r::print_config_def.get(key);
    if (definition == nullptr)
        throw MutationCommandError("unsupported_reference", "unsupported project configuration option: " + key);
    return *definition;
}

bool resettable_key(const std::string& key)
{
    const auto* definition = Slic3r::print_config_def.get(key);
    if (definition == nullptr || key == "extruder") return false;
    // Filament/rack values, layer ranges, and custom G-code are not scoped
    // print settings and must not be erased by category/reset-all requests.
    if (key.find("filament") != std::string::npos || key.find("rack") != std::string::npos ||
        key.find("ams") != std::string::npos ||
        Slic3r::custom_gcode_specific_placeholders().find(key) !=
            Slic3r::custom_gcode_specific_placeholders().end())
        return false;
    return key != "wipe_tower_x" && key != "wipe_tower_y";
}

const Preset* selected_print_parent()
{
    return state().presets.prints.get_selected_preset_parent();
}

bool is_project_print_override_key(const std::string& key)
{
    if (is_native_project_config_key(key)) return false;
    // Preset identity, inheritance, compatibility, and aggregate full-config
    // fields are native preset bookkeeping. They are not editable Print
    // overrides and must never become scoped Project values or history roots.
    static const std::set<std::string> profile_metadata_keys = {
        "inherits",
        "print_settings_id",
        "filament_settings_id",
        "printer_settings_id",
        "sla_print_settings_id",
        "sla_material_settings_id",
        "compatible_printers",
        "compatible_prints",
        "compatible_printers_condition",
        "compatible_prints_condition",
        "compatible_machine_expression_group",
        "compatible_process_expression_group",
        "inherits_group",
        "different_settings_to_system",
        "print_compatible_printers",
        "filament_ids",
    };
    // A Project Print override is stored in the edited Print preset.  Merely
    // being present in the aggregate FFF config is not sufficient: printer
    // and filament options are also present there, but the native full-config
    // assembly applies those presets after the Print preset and would silently
    // overwrite an incorrectly accepted override.  Keep the bridge boundary
    // aligned with Orca's actual Print-preset ownership list.
    const auto& print_options = Preset::print_options();
    return profile_metadata_keys.find(key) == profile_metadata_keys.end() &&
        std::find(print_options.begin(), print_options.end(), key) != print_options.end();
}

std::vector<std::string> edited_print_override_keys()
{
    std::vector<std::string> result;
    for (const std::string& key : state().presets.prints.current_different_from_parent_options(false))
        if (is_project_print_override_key(key)) result.push_back(key);
    return result;
}

void restore_parent_value_or_erase(DynamicPrintConfig& candidate,
                                   const Preset* parent,
                                   const std::string& key)
{
    if (parent != nullptr) {
        const ConfigOption* inherited = parent->config.option(key);
        if (inherited != nullptr) {
            candidate.set_key_value(key, inherited->clone());
            return;
        }
    }
    candidate.erase(key);
}

void clear_edited_print_overrides(DynamicPrintConfig& candidate,
                                  const Preset* parent,
                                  const std::string& category,
                                  bool category_filter)
{
    for (const std::string& key : edited_print_override_keys()) {
        if (is_native_project_config_key(key) || !resettable_key(key)) continue;
        const auto* definition = Slic3r::print_config_def.get(key);
        if (category_filter && (definition == nullptr || definition->category != category)) continue;
        restore_parent_value_or_erase(candidate, parent, key);
    }
}

void apply_project_mutation_to_candidates(const MutationRequest& request,
                                          DynamicPrintConfig& project_candidate,
                                          DynamicPrintConfig& print_candidate)
{
    const Preset* parent = selected_print_parent();
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    if (request.operation == "set") {
        for (const auto& [key, requested] : request.values) {
            const ConfigOptionDef& definition = require_definition(key);
            const std::string effective_request = clamp_numeric_value(definition, requested);
            auto& destination = is_native_project_config_key(key) ? project_candidate : print_candidate;
            destination.set_deserialize(key, effective_request, substitutions);
        }
        return;
    }
    if (request.operation == "reset") {
        const std::string& key = request.values.begin()->first;
        require_definition(key);
        if (key == "wipe_tower_x" || key == "wipe_tower_y")
            throw MutationCommandError("unsupported_reference", "prime tower coordinates are scene-only");
        if (is_native_project_config_key(key))
            project_candidate.erase(key);
        else
            restore_parent_value_or_erase(print_candidate, parent, key);
        return;
    }

    const bool category_filter = request.operation == "reset-category";
    clear_edited_print_overrides(print_candidate, parent, request.category, category_filter);
    for (const std::string& key : project_candidate.keys()) {
        if (!is_native_project_config_key(key) || !resettable_key(key)) continue;
        const auto* definition = Slic3r::print_config_def.get(key);
        if (category_filter && (definition == nullptr || definition->category != request.category)) continue;
        project_candidate.erase(key);
    }
}

bool project_request_requires_embedded_print_preset(const MutationRequest& request)
{
    if (state().presets.prints.get_edited_preset().is_project_embedded ||
        std::none_of(request.targets.begin(), request.targets.end(),
                     [](const MutationTarget& target) { return target.scope == "project"; }))
        return false;

    DynamicPrintConfig project_candidate = state().presets.project_config;
    DynamicPrintConfig print_candidate = state().presets.prints.get_edited_preset().config;
    apply_project_mutation_to_candidates(request, project_candidate, print_candidate);
    return print_candidate != state().presets.prints.get_edited_preset().config;
}

void sync_project_print_preset_storage_impl()
{
    auto& prints = state().presets.prints;
    const Preset& edited = prints.get_edited_preset();
    if (!edited.is_project_embedded || prints.get_selected_idx() == size_t(-1)) return;
    // PresetCollection keeps the edited copy separate from m_presets.  The
    // native BBS exporter enumerates m_presets, so mirror the committed edit
    // into the selected project-embedded record before export/history capture.
    Preset& selected = prints.get_selected_preset();
    if (selected.name == edited.name)
        selected.config = edited.config;
}

std::size_t parse_target_id(const std::string& id, const std::string& scope)
{
    if (id.empty()) throw MutationCommandError("invalid_command", scope + " scope id is required");
    try {
        std::size_t consumed = 0;
        const unsigned long long value = std::stoull(id, &consumed);
        if (consumed != id.size()) throw std::invalid_argument("trailing characters");
        return static_cast<std::size_t>(value);
    } catch (...) {
        throw MutationCommandError("invalid_command", "invalid " + scope + " scope id");
    }
}

MutationRequest parse_request(const char* request_json)
{
    if (request_json == nullptr || *request_json == '\0')
        throw MutationCommandError("invalid_command", "mutation request is required");
    json encoded;
    try { encoded = json::parse(request_json); }
    catch (...) { throw MutationCommandError("invalid_command", "mutation request is not valid JSON"); }
    if (!encoded.is_object() || encoded.value("version", 0) != 1)
        throw MutationCommandError("invalid_command", "unsupported native mutation request version");
    MutationRequest request;
    if (!encoded.contains("operation") || !encoded["operation"].is_string())
        throw MutationCommandError("invalid_command", "mutation operation is required");
    request.operation = encoded["operation"].get<std::string>();
    if (request.operation != "set" && request.operation != "reset" &&
        request.operation != "reset-category" && request.operation != "reset-all")
        throw MutationCommandError("invalid_command", "unsupported native mutation operation");
    if (!encoded.contains("targets") || !encoded["targets"].is_array() || encoded["targets"].empty())
        throw MutationCommandError("invalid_command", "at least one mutation target is required");
    std::set<std::pair<std::string, std::string>> seen;
    for (const auto& item : encoded["targets"]) {
        if (!item.is_object() || !item.contains("scope") || !item["scope"].is_string())
            throw MutationCommandError("invalid_command", "invalid mutation target");
        MutationTarget target{item["scope"].get<std::string>(), ""};
        if (target.scope != "project" && target.scope != "object" && target.scope != "part" && target.scope != "plate")
            throw MutationCommandError("invalid_command", "invalid project configuration scope");
        if (item.contains("id")) {
            if (!item["id"].is_string()) throw MutationCommandError("invalid_command", "mutation target id must be a string");
            target.id = item["id"].get<std::string>();
        }
        if (target.scope == "project" && !target.id.empty())
            throw MutationCommandError("invalid_command", "project mutation target must not have an id");
        if (target.scope != "project" && target.id.empty())
            throw MutationCommandError("invalid_command", target.scope + " scope id is required");
        if (!seen.emplace(target.scope, target.id).second)
            throw MutationCommandError("invalid_command", "duplicate mutation target");
        request.targets.push_back(std::move(target));
    }
    if (request.operation == "set") {
        const bool has_key = encoded.contains("key");
        const bool has_value = encoded.contains("value");
        const bool has_values = encoded.contains("values");
        if (has_values == (has_key || has_value))
            throw MutationCommandError("invalid_command", "set requires either key/value or values");
        if (has_values) {
            if (!encoded["values"].is_object() || encoded["values"].empty())
                throw MutationCommandError("invalid_command", "set values must be a non-empty object");
            for (auto it = encoded["values"].begin(); it != encoded["values"].end(); ++it) {
                if (!it.value().is_string())
                    throw MutationCommandError("invalid_command", "native configuration values must be strings");
                request.values.emplace(it.key(), it.value().get<std::string>());
            }
        } else {
            if (!has_key || !encoded["key"].is_string() || !has_value || !encoded["value"].is_string())
                throw MutationCommandError("invalid_command", "set requires string key and value");
            request.values.emplace(encoded["key"].get<std::string>(), encoded["value"].get<std::string>());
        }
    } else if (request.operation == "reset" || request.operation == "reset-category") {
        const char* field = request.operation == "reset" ? "key" : "category";
        if (!encoded.contains(field) || !encoded[field].is_string() || encoded[field].get<std::string>().empty())
            throw MutationCommandError("invalid_command", std::string(field) + " is required");
        if (request.operation == "reset") request.values.emplace(encoded[field].get<std::string>(), "");
        else request.category = encoded[field].get<std::string>();
    }
    return request;
}

void validate_set_keys(const MutationRequest& request)
{
    if (request.operation != "set" && request.operation != "reset") return;
    for (const auto& [key, value] : request.values) {
        const ConfigOptionDef& definition = require_definition(key);
        if (is_bridge_owned_project_routing_key(key))
            throw MutationCommandError(
                "unsupported_reference",
                "filament routing is owned by the dedicated filament-routing commands");
        if (std::any_of(request.targets.begin(), request.targets.end(), [](const MutationTarget& target) {
                return target.scope == "project";
            }) && !is_native_project_config_key(key) && !is_project_print_override_key(key))
            throw MutationCommandError(
                "unsupported_reference",
                "configuration option " + key + " is native preset metadata, not a Project override");
        if (key == "wipe_tower_x" || key == "wipe_tower_y")
            throw MutationCommandError("unsupported_reference", "prime tower coordinates are scene-only");
        if (std::any_of(request.targets.begin(), request.targets.end(), [](const MutationTarget& target) {
                return target.scope == "plate";
            }) && !is_editable_plate_override_key(key))
            throw MutationCommandError("unsupported_reference",
                                       "configuration option " + key + " is not supported for plate scope");
        (void) definition;
        (void) value;
    }
}

void apply_mutation_to_candidate(const MutationRequest& request, DynamicPrintConfig& candidate)
{
    if (request.operation == "set") {
        ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
        for (const auto& [key, requested] : request.values) {
            const ConfigOptionDef& definition = require_definition(key);
            const std::string effective_request = clamp_numeric_value(definition, requested);
            candidate.set_deserialize(key, effective_request, substitutions);
        }
        return;
    }
    if (request.operation == "reset") {
        const std::string& key = request.values.begin()->first;
        require_definition(key);
        if (key == "wipe_tower_x" || key == "wipe_tower_y")
            throw MutationCommandError("unsupported_reference", "prime tower coordinates are scene-only");
        candidate.erase(key);
        return;
    }
    const std::vector<std::string> keys = candidate.keys();
    for (const std::string& key : keys) {
        if (!resettable_key(key)) continue;
        if (request.operation == "reset-category" && Slic3r::print_config_def.get(key)->category != request.category)
            continue;
        candidate.erase(key);
    }
}

void resolve_target(ResolvedTarget& resolved)
{
    const auto& target = resolved.target;
    if (target.scope == "project") {
        resolved.project_candidate = state().presets.project_config;
        resolved.print_candidate = state().presets.prints.get_edited_preset().config;
        return;
    }
    if (target.scope == "object") {
        resolved.object = find_object_by_id(parse_target_id(target.id, target.scope));
        if (resolved.object == nullptr)
            throw MutationCommandError("unsupported_reference", "object not found");
        resolved.candidate = resolved.object->config.get();
        std::set<std::size_t> instance_ids;
        for (const auto* instance : resolved.object->instances) instance_ids.insert(instance->id().id);
        resolved.affected_plates = member_plate_ids_for_instances(instance_ids);
        return;
    }
    if (target.scope == "part") {
        resolved.part = find_volume_by_id(parse_target_id(target.id, target.scope));
        if (resolved.part == nullptr)
            throw MutationCommandError("unsupported_reference", "part not found");
        resolved.candidate = resolved.part->config.get();
        std::set<std::size_t> instance_ids;
        for (const auto* instance : resolved.part->get_object()->instances) instance_ids.insert(instance->id().id);
        resolved.affected_plates = member_plate_ids_for_instances(instance_ids);
        return;
    }
    resolved.plate = find_plate_mutable(target.id);
    if (resolved.plate == nullptr)
        throw MutationCommandError("unsupported_reference", "plate not found");
    resolved.candidate = resolved.plate->settings;
    resolved.affected_plates.insert(target.id);
}

} // namespace

namespace {

void append_serialized_option(json& destination, const ConfigBase& config, const std::string& key)
{
    const auto* option = config.option(key);
    if (option == nullptr) return;
    try { destination[key] = option->serialize(); }
    catch (...) { /* retain only values the native config can serialize */ }
}

json native_project_scoped_config_snapshot()
{
    json project = json::object();
    for (const std::string& key : state().presets.project_config.keys())
        if (is_native_project_config_key(key)) append_serialized_option(project, state().presets.project_config, key);

    const auto& prints = state().presets.prints;
    const auto& edited = prints.get_edited_preset();
    if (selected_print_parent() != nullptr) {
        for (const std::string& key : edited_print_override_keys()) {
            if (!is_project_print_override_key(key)) continue;
            append_serialized_option(project, edited.config, key);
        }
    }
    return project;
}

} // namespace

void sync_project_print_preset_storage()
{
    sync_project_print_preset_storage_impl();
}

void apply_project_scoped_config_snapshot(const json& values)
{
    if (!values.is_object()) throw std::runtime_error("project scoped configuration must be an object");

    DynamicPrintConfig project_candidate = state().presets.project_config;
    for (const std::string& key : project_candidate.keys())
        if (is_native_project_config_key(key)) project_candidate.erase(key);

    DynamicPrintConfig print_candidate = state().presets.prints.get_edited_preset().config;
    const Preset* parent = selected_print_parent();
    clear_edited_print_overrides(print_candidate, parent, std::string{}, false);
    ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
    for (auto it = values.begin(); it != values.end(); ++it) {
        if (!it.value().is_string()) throw std::runtime_error("project scoped configuration values must be strings");
        if (!is_native_project_config_key(it.key()) && !is_project_print_override_key(it.key())) continue;
        auto& destination = is_native_project_config_key(it.key()) ? project_candidate : print_candidate;
        destination.set_deserialize(it.key(), it.value().get<std::string>(), substitutions);
    }
    state().presets.project_config = std::move(project_candidate);
    state().presets.prints.get_edited_preset().config = std::move(print_candidate);
    state().presets.prints.update_dirty();
}

json native_print_preset_history_state()
{
    const auto& prints = state().presets.prints;
    json embedded = json::array();
    json embedded_presets = json::array();
    for (const Preset& preset : prints.get_presets()) {
        if (!preset.is_project_embedded) continue;
        embedded.push_back(preset.name);
        json overrides = json::object();
        const Preset* parent = prints.get_preset_parent(preset);
        for (const std::string& key : preset.config.keys()) {
            if (!is_project_print_override_key(key)) continue;
            const ConfigOption* value = preset.config.option(key);
            const ConfigOption* inherited = parent ? parent->config.option(key) : nullptr;
            if (value == nullptr || (inherited != nullptr && value->serialize() == inherited->serialize())) continue;
            overrides[key] = value->serialize();
        }
        embedded_presets.push_back({{"name", preset.name},
                                    {"inherits", preset.inherits()},
                                    {"overrides", std::move(overrides)}});
    }
    return json{{"selected", prints.get_selected_preset_name()},
                {"selected_project_embedded", prints.get_edited_preset().is_project_embedded},
                {"project_embedded_names", std::move(embedded)},
                {"project_embedded_presets", std::move(embedded_presets)}};
}

void restore_native_print_preset_history_state(const json& values)
{
    if (!values.is_object()) throw std::runtime_error("invalid native Print preset history state");
    const std::string selected = values.value("selected", std::string{});
    const bool selected_project_embedded = values.value("selected_project_embedded", false);
    if (!values.contains("project_embedded_names") || !values.contains("project_embedded_presets"))
        throw std::runtime_error("native Print preset history state is incomplete");
    const auto& names_value = values.at("project_embedded_names");
    if (!names_value.is_array()) throw std::runtime_error("invalid native Print preset history state");
    std::set<std::string> desired_names;
    for (const auto& value : names_value) {
        if (!value.is_string()) throw std::runtime_error("invalid native Print preset history state");
        if (!desired_names.insert(value.get<std::string>()).second)
            throw std::runtime_error("duplicate native Print preset history state");
    }

    const auto& records_value = values.at("project_embedded_presets");
    if (!records_value.is_array()) throw std::runtime_error("invalid native Print preset history state");
    std::map<std::string, json> records;
    for (const auto& record : records_value) {
        if (!record.is_object() || !record.contains("name") || !record["name"].is_string() ||
            !record.contains("inherits") || !record["inherits"].is_string() ||
            !record.contains("overrides") || !record["overrides"].is_object())
            throw std::runtime_error("invalid native Print preset history state");
        const std::string name = record["name"].get<std::string>();
        if (desired_names.find(name) == desired_names.end() || records.find(name) != records.end())
            throw std::runtime_error("duplicate native Print preset history state");
        for (auto it = record["overrides"].begin(); it != record["overrides"].end(); ++it)
            if (!it.value().is_string() || !is_project_print_override_key(it.key()))
                throw std::runtime_error("invalid native Print preset history override");
        records.emplace(name, record);
    }
    if (records.size() != desired_names.size())
        throw std::runtime_error("native Print preset history state is incomplete");

    auto& prints = state().presets.prints;
    std::vector<std::string> stale_names;
    for (const Preset& preset : prints.get_presets())
        if (preset.is_project_embedded && desired_names.find(preset.name) == desired_names.end())
            stale_names.push_back(preset.name);
    for (const auto& name : stale_names)
        prints.delete_preset(name, true);

    std::set<std::string> pending_names;
    for (const auto& [name, record] : records)
        if (prints.find_preset(name, false, true) == nullptr) pending_names.insert(name);
    while (!pending_names.empty()) {
        bool progressed = false;
        for (auto it_name = pending_names.begin(); it_name != pending_names.end();) {
            const std::string name = *it_name;
            const auto record = records.at(name);
            const std::string inherits = record["inherits"].get<std::string>();
            // Standard embedded presets may be parentless. Clone the current
            // native selection as their reconstruction base; a non-empty
            // inheritance name remains authoritative when one is recorded.
            const Preset* parent = inherits.empty() ? &prints.get_selected_preset() :
                prints.find_preset(inherits, false, true);
            if (parent == nullptr) {
                ++it_name;
                continue;
            }
            Preset child = *parent;
            child.name = name;
            child.is_project_embedded = true;
            child.is_external = false;
            child.is_system = false;
            child.is_default = false;
            child.inherits() = inherits;
            ConfigSubstitutionContext substitutions{ForwardCompatibilitySubstitutionRule::Disable};
            for (auto it = record["overrides"].begin(); it != record["overrides"].end(); ++it)
                child.config.set_deserialize(it.key(), it.value().get<std::string>(), substitutions);
            prints.save_current_preset(name, false, true, &child);
            Preset* recreated = prints.find_preset(name, false, true);
            if (recreated == nullptr || !recreated->is_project_embedded)
                throw std::runtime_error("native Print preset history preset recreation failed");
            it_name = pending_names.erase(it_name);
            progressed = true;
        }
        if (!progressed)
            throw std::runtime_error("native Print preset history parent is unavailable");
    }

    if (!selected.empty()) {
        Preset* target = prints.find_preset(selected, false, true);
        if (target == nullptr)
            throw std::runtime_error("native Print preset history selection is unavailable");
        if (target->is_project_embedded != selected_project_embedded)
            throw std::runtime_error("native Print preset history selection has an invalid owner");
        if (!prints.select_preset_by_name(selected, true))
            throw std::runtime_error("could not restore native Print preset history selection");
    }
}

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

    snapshot["project"] = native_project_scoped_config_snapshot();
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
        for (const std::string& key : plate.settings.keys()) {
            if (!is_editable_plate_override_key(key)) continue;
            const auto* option = plate.settings.option(key);
            if (option == nullptr) continue;
            try { plate_values[key] = option->serialize(); }
            catch (...) { /* retain only values the native config can serialize */ }
        }
        plate_values.erase("wipe_tower_x");
        plate_values.erase("wipe_tower_y");
        if (!plate_values.empty()) snapshot["plates"][plate.id] = std::move(plate_values);
    }
    return snapshot;
}

json native_scoped_config_target_identity(const NativeScopedConfigTarget& target)
{
    json identity{{"scope", target.first}};
    if (target.first != "project") identity["id"] = target.second;
    return identity;
}

json native_scoped_config_removed_targets_json(const NativeScopedConfigTargets& targets)
{
    json removed = json::array();
    for (const auto& target : targets) removed.push_back(native_scoped_config_target_identity(target));
    return removed;
}

NativeScopedConfigTargets native_scoped_config_removed_targets(
    const json& before_snapshot, const json& after_snapshot)
{
    NativeScopedConfigTargets removed;
    if (!valid_native_scoped_config_snapshot(before_snapshot) ||
        !valid_native_scoped_config_snapshot(after_snapshot))
        return removed;
    for (const char* scope : {"objects", "parts", "plates"}) {
        for (auto it = before_snapshot.at(scope).begin(); it != before_snapshot.at(scope).end(); ++it)
            if (!after_snapshot.at(scope).contains(it.key()))
                removed.emplace_back(scope == std::string("objects") ? "object" :
                                         scope == std::string("parts") ? "part" : "plate",
                                     it.key());
    }
    return removed;
}

json native_scoped_config_full_transport(std::uint64_t revision)
{
    return native_scoped_config_full_transport(revision, {});
}

json native_scoped_config_full_transport(
    std::uint64_t revision, const NativeScopedConfigTargets& removed_targets)
{
    return json{{"version", 1}, {"revision", revision}, {"kind", "full"},
                {"snapshot", native_scoped_config_snapshot()},
                {"removed_targets", native_scoped_config_removed_targets_json(removed_targets)}};
}

json native_scoped_config_affected_transport(
    const json& snapshot,
    const NativeScopedConfigTargets& targets,
    std::uint64_t revision)
{
    return native_scoped_config_affected_transport(snapshot, targets, revision, {});
}

json native_scoped_config_affected_transport(
    const json& snapshot,
    const NativeScopedConfigTargets& targets,
    std::uint64_t revision,
    const NativeScopedConfigTargets& removed_targets)
{
    json replacements = json::array();
    std::set<std::pair<std::string, std::string>> seen;
    const std::set<std::pair<std::string, std::string>> removed(
        removed_targets.begin(), removed_targets.end());
    for (const auto& [scope, id] : targets) {
        if (!seen.emplace(scope, id).second) continue;
        if (removed.find({scope, id}) != removed.end()) continue;
        json values = json::object();
        const json* bucket = nullptr;
        if (scope == "project") bucket = &snapshot.at("project");
        else if (scope == "object") {
            const auto it = snapshot.at("objects").find(id);
            if (it != snapshot.at("objects").end()) bucket = &it.value();
        } else if (scope == "part") {
            const auto it = snapshot.at("parts").find(id);
            if (it != snapshot.at("parts").end()) bucket = &it.value();
        } else {
            const auto it = snapshot.at("plates").find(id);
            if (it != snapshot.at("plates").end()) bucket = &it.value();
        }
        if (bucket != nullptr) values = *bucket;
        json replacement = {{"scope", scope}, {"values", std::move(values)}};
        if (scope != "project") replacement["id"] = id;
        replacements.push_back(std::move(replacement));
    }
    return json{{"version", 1}, {"revision", revision}, {"kind", "affected"},
                {"replacements", std::move(replacements)},
                {"removed_targets", native_scoped_config_removed_targets_json(removed_targets)}};
}

json native_scoped_config_affected_transport(
    const NativeScopedConfigTargets& targets, std::uint64_t revision)
{
    std::map<std::string, const ConfigBase*> configs;
    std::set<std::string> object_ids, part_ids;
    for (const auto& [scope, id] : targets) {
        if (scope == "object") object_ids.insert(id);
        if (scope == "part") part_ids.insert(id);
    }
    if (!object_ids.empty() || !part_ids.empty()) {
        for (const auto* object : state().model.objects) {
            const auto id = std::to_string(object->id().id);
            if (object_ids.count(id)) configs.emplace("object:" + id, &object->config.get());
            if (!part_ids.empty()) {
                for (const auto* volume : object->volumes) {
                    const auto volume_id = std::to_string(volume->id().id);
                    if (part_ids.count(volume_id)) configs.emplace("part:" + volume_id, &volume->config.get());
                }
            }
        }
    }
    json snapshot = empty_native_scoped_config_snapshot();
    for (const auto& [scope, id] : targets) {
        if (scope == "project") {
            snapshot["project"] = native_project_scoped_config_snapshot();
            continue;
        }
        const ConfigBase* config = nullptr;
        if (scope == "plate") {
            const auto* plate = find_plate(id);
            if (plate != nullptr) config = &plate->settings;
        } else {
            const auto found = configs.find(scope + ":" + id);
            if (found != configs.end()) config = found->second;
        }
        if (config == nullptr) throw std::runtime_error("scoped projection target disappeared");
        json values = json::object();
        for (const auto& key : config->keys()) {
            if (scope == "plate" && !is_editable_plate_override_key(key)) continue;
            append_serialized_option(values, *config, key);
        }
        snapshot[scope == "object" ? "objects" : scope == "part" ? "parts" : "plates"][id] = std::move(values);
    }
    return native_scoped_config_affected_transport(snapshot, targets, revision);
}

json native_scoped_config_result()
{
    return json{{"ok", true}, {"native_scoped_config", native_scoped_config_full_transport(state().history_revision)}};
}

} // namespace Slic3r::Neo::Bridge::ScopedConfig

extern "C" {

EMSCRIPTEN_KEEPALIVE const char* orc_get_native_scoped_config() {
    try {
        return Slic3r::Neo::Bridge::ScopedConfig::duplicate_json(
            Slic3r::Neo::Bridge::ScopedConfig::native_scoped_config_result().dump());
    } catch (const std::exception& e) {
        return Slic3r::Neo::Bridge::ScopedConfig::native_configuration_error_json(
            "native_validation_failure", e.what());
    } catch (...) {
        return Slic3r::Neo::Bridge::ScopedConfig::native_configuration_error_json(
            "native_validation_failure", "unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_mutate_native_scoped_config(const char* request_cstr) {
    using namespace Slic3r::Neo::Bridge;
    using ScopedConfig::native_configuration_error_json;
    using ScopedConfig::native_scoped_config_result;
    ScopedConfig::ProjectPrintPresetMaterialization materialization;
    try {
        PlateSession::ensure_plate_session_state();
        const ScopedConfig::MutationRequest request = ScopedConfig::parse_request(request_cstr);
        ScopedConfig::validate_set_keys(request);
        if (ScopedConfig::project_request_requires_embedded_print_preset(request))
            ScopedConfig::materialize_project_print_preset(materialization);

        std::vector<ScopedConfig::ResolvedTarget> resolved;
        resolved.reserve(request.targets.size());
        for (const auto& target : request.targets) {
            ScopedConfig::ResolvedTarget resolved_target;
            resolved_target.target = target;
            resolved.push_back(std::move(resolved_target));
            ScopedConfig::resolve_target(resolved.back());
            if (target.scope == "project") {
                ScopedConfig::apply_project_mutation_to_candidates(
                    request, resolved.back().project_candidate, resolved.back().print_candidate);
                resolved.back().project_config_changed =
                    resolved.back().project_candidate != state().presets.project_config;
                resolved.back().print_config_changed =
                    resolved.back().print_candidate != state().presets.prints.get_edited_preset().config;
                resolved.back().changed = resolved.back().project_config_changed ||
                    resolved.back().print_config_changed;
                if (resolved.back().changed)
                    resolved.back().affected_plates = PlateSession::all_plate_ids();
            } else {
                ScopedConfig::apply_mutation_to_candidate(request, resolved.back().candidate);
                if (target.scope == "object") {
                resolved.back().changed = resolved.back().candidate != resolved.back().object->config.get();
                } else if (target.scope == "part") {
                resolved.back().changed = resolved.back().candidate != resolved.back().part->config.get();
                } else {
                resolved.back().changed = resolved.back().candidate != resolved.back().plate->settings;
                }
            }
        }

        std::map<std::string, std::string> requested_values;
        if (request.operation == "set") requested_values = request.values;
        json result{{"ok", true}};
        json configuration_status;
        if (!requested_values.empty()) {
            json corrections = json::array();
            for (const auto& [key, requested] : requested_values) {
                const ConfigOption* option = nullptr;
                for (const auto& target : resolved) {
                    if (!target.changed) continue;
                    if (target.target.scope == "project") {
                        option = (ScopedConfig::is_native_project_config_key(key)
                            ? target.project_candidate.option(key) : target.print_candidate.option(key));
                    } else {
                        option = target.candidate.option(key);
                    }
                    if (option != nullptr) break;
                }
                if (option == nullptr) continue;
                const std::string effective = option->serialize();
                if (effective != requested)
                    corrections.push_back({{"key", key}, {"requested", requested}, {"effective", effective}});
            }
            configuration_status = json{{"state", "ready"}, {"corrections", std::move(corrections)},
                                        {"warnings", json::array()}, {"errors", json::array()}};
        } else {
            configuration_status = json{{"state", "ready"}, {"corrections", json::array()},
                                        {"warnings", json::array()}, {"errors", json::array()}};
        }
        bool project_changed = false;
        bool any_changed = false;
        std::set<std::string> affected_plates;
        std::set<std::string> dirty_reasons;
        for (const auto& target : resolved) {
            if (!target.changed) continue;
            any_changed = true;
            if (target.target.scope == "project") project_changed = true;
            affected_plates.insert(target.affected_plates.begin(), target.affected_plates.end());
            dirty_reasons.insert(target.target.scope + "-configuration");
        }

        if (any_changed) {
            auto before_model = ScopedConfig::capture_model_mutation_snapshot(resolved, project_changed);
            const auto before_project_config = state().presets.project_config;
            const auto before_print_config = state().presets.prints.get_edited_preset().config;
            const auto before_plates = state().plate_session_plates;
            const auto before_revisions = state().plate_input_revisions;
            const auto before_out_of_bounds = state().plate_out_of_bounds_ids;
            const auto before_pending = state().pending_membership_instance_ids;
            const auto before_lifecycle = state().plate_runtime_registry.capture_lifecycle();
            try {
                for (auto& target : resolved) {
                    if (!target.changed) continue;
                    if (target.target.scope == "project") {
                        if (target.project_config_changed)
                            state().presets.project_config = std::move(target.project_candidate);
                        if (target.print_config_changed) {
                            state().presets.prints.get_edited_preset().config = std::move(target.print_candidate);
                            state().presets.prints.update_dirty();
                        }
                    } else if (target.target.scope == "object") {
                        target.object->config.assign_config(std::move(target.candidate));
                    } else if (target.target.scope == "part") {
                        target.part->config.assign_config(std::move(target.candidate));
                    } else {
                        target.plate->settings = std::move(target.candidate);
                        target.plate->settings_metadata = Filament::State::config_metadata_json(target.plate->settings);
                    }
                }
                const std::vector<std::string> reasons(dirty_reasons.begin(), dirty_reasons.end());
                const auto mutation = project_changed
                    ? PlateSession::shared_configuration_mutation_snapshot()
                    : PlateSession::configuration_mutation_snapshot(affected_plates, reasons);
                result["plate_session"] = mutation;
            } catch (...) {
                ScopedConfig::restore_model_mutation_snapshot(before_model);
                state().mutable_object_capture_cache.clear();
                state().presets.project_config = before_project_config;
                state().presets.prints.get_edited_preset().config = before_print_config;
                state().presets.prints.update_dirty();
                state().plate_session_plates = before_plates;
                state().plate_input_revisions = before_revisions;
                state().plate_out_of_bounds_ids = before_out_of_bounds;
                state().pending_membership_instance_ids = before_pending;
                state().plate_runtime_registry.restore_lifecycle(before_lifecycle);
                PrimeTower::invalidate_projection_cache();
                throw;
            }
            // Application transactions advance the shared revision at their
            // history commit. Direct bridge callers have no enclosing
            // transaction, so the native mutation itself is the commit.
            if (!state().active_history_transaction)
                Neo::Bridge::HistoryMetadata::advance_history_epoch(state());
        }
        std::vector<std::pair<std::string, std::string>> targets;
        targets.reserve(request.targets.size());
        for (const auto& target : request.targets)
            targets.emplace_back(target.scope, target.id);
        result["native_scoped_config"] = ScopedConfig::native_scoped_config_affected_transport(
            targets, state().history_revision);
        if (state().active_history_transaction) {
            for (const auto& target : request.targets)
                state().active_history_transaction->native_scoped_config_targets.emplace(target.scope, target.id);
        }
        result["configuration_status"] = std::move(configuration_status);
        materialization.committed = true;
        return ScopedConfig::duplicate_json(result.dump());
    } catch (const ScopedConfig::MutationCommandError& e) {
        ScopedConfig::rollback_project_print_preset_materialization(materialization);
        return native_configuration_error_json(e.code, e.what());
    } catch (const Slic3r::BadOptionValueException& e) {
        ScopedConfig::rollback_project_print_preset_materialization(materialization);
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (const std::exception& e) {
        ScopedConfig::rollback_project_print_preset_materialization(materialization);
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (...) {
        ScopedConfig::rollback_project_print_preset_materialization(materialization);
        return native_configuration_error_json("native_validation_failure", "unknown C++ exception");
    }
}

EMSCRIPTEN_KEEPALIVE const char* orc_revalidate_native_scoped_config() {
    using namespace Slic3r::Neo::Bridge::ScopedConfig;
    try {
        return duplicate_json(native_scoped_config_result().dump());
    } catch (const std::exception& e) {
        return native_configuration_error_json("native_validation_failure", e.what());
    } catch (...) {
        return native_configuration_error_json("native_validation_failure", "unknown C++ exception");
    }
}

} // extern "C"
